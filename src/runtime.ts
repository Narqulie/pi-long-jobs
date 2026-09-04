import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, appendFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createProgressState } from "./progress.mjs";
import type { LongJobRecord, LongJobSpec, StartLongJobInput, StorageOptions } from "./model.ts";
import { assertDirectory, ensureJobDirectory, readJob, resolveJobsRoot, specPath, writeJob, writeSpec } from "./storage.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

function slug(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return safe || "job";
}

function createJobId(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  return `${stamp}-${slug(label)}-${randomBytes(4).toString("hex")}`;
}

function digest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

async function launchDirect(specFile: string, gatePath: string, initial: LongJobRecord, options: StorageOptions): Promise<LongJobRecord> {
  const child = spawn(process.execPath, [WORKER_PATH, specFile], {
    cwd: initial.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_LONG_JOBS_DIR: resolveJobsRoot(options) },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  if (!child.pid) throw new Error("Detached worker started without a process id.");
  const next = { ...initial, workerPid: child.pid, updatedAt: Date.now() };
  await writeJob(next, options);
  await writeFile(gatePath, "start\n", { mode: 0o600 });
  return next;
}

function parsePaneId(stdout: string): string {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const queue: unknown[] = [parsed];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "pane_id" || key === "paneId" || key === "id") && typeof child === "string" && /^[^:]+:p[^:]+$/.test(child)) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  throw new Error("Herdr did not return a pane id.");
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`)));
  });
}

async function launchHerdr(specFile: string, gatePath: string, initial: LongJobRecord, options: StorageOptions): Promise<LongJobRecord> {
  const paneOutput = await runCommand("herdr", ["pane", "split", "--current", "--direction", "down", "--cwd", initial.cwd, "--no-focus"]);
  const paneId = parsePaneId(paneOutput);
  try {
    const next = { ...initial, paneId, surface: "herdr" as const, updatedAt: Date.now() };
    await writeJob(next, options);
    await runCommand("herdr", ["pane", "run", paneId, process.execPath, WORKER_PATH, specFile]);
    await writeFile(gatePath, "start\n", { mode: 0o600 });
    return next;
  } catch (error) {
    await runCommand("herdr", ["pane", "close", paneId]).catch(() => {});
    throw error;
  }
}

export async function startJob(input: StartLongJobInput, options: StorageOptions = {}): Promise<LongJobRecord> {
  const label = input.label.trim();
  const command = input.command.trim();
  const ownerSessionId = input.ownerSessionId.trim();
  if (!label || label.length > 160) throw new Error("Job label must contain 1–160 characters.");
  if (!command || command.length > 1_048_576 || command.includes("\0")) throw new Error("Job command must contain 1–1,048,576 characters without NUL bytes.");
  if (!ownerSessionId || ownerSessionId.length > 4_096) throw new Error("A bounded owner session id is required.");
  if (input.totalItems !== undefined && (!Number.isSafeInteger(input.totalItems) || input.totalItems < 1)) throw new Error("totalItems must be a positive integer.");
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) throw new Error("timeoutMs must be a positive integer.");
  const maxLogBytes = input.maxLogBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1 || maxLogBytes > 1024 * 1024 * 1024) throw new Error("maxLogBytes must be an integer from 1 byte through 1 GiB.");

  const cwd = await assertDirectory(input.cwd);
  const id = createJobId(label);
  const directory = await ensureJobDirectory(id, options);
  const startedAt = Date.now();
  const surface = input.surface === "herdr" || (input.surface !== "direct" && process.env.HERDR_ENV === "1") ? "herdr" : "direct";
  const record: LongJobRecord = {
    version: 1,
    id,
    ownerSessionId,
    label,
    commandDigest: digest(command),
    cwd,
    state: "queued",
    surface,
    startedAt,
    updatedAt: startedAt,
    milestoneSequence: 0,
    progress: createProgressState(input.totalItems),
    jobDir: directory,
    stdoutPath: path.join(directory, "stdout.log"),
    stderrPath: path.join(directory, "stderr.log"),
    eventsPath: path.join(directory, "events.jsonl"),
  };
  const gatePath = path.join(directory, "start.gate");
  const spec: LongJobSpec = {
    version: 1,
    id,
    label,
    command,
    cwd,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    maxLogBytes,
    statusPath: path.join(directory, "status.json"),
    stdoutPath: record.stdoutPath,
    stderrPath: record.stderrPath,
    eventsPath: record.eventsPath,
    startGatePath: gatePath,
    stopRequestPath: path.join(directory, "stop.request"),
  };
  await writeJob(record, options);
  await writeSpec(spec, options);

  if (surface === "herdr") {
    try {
      return await launchHerdr(specPath(id, options), gatePath, record, options);
    } catch (error) {
      if (input.surface === "herdr") {
        await writeJob({ ...record, state: "failed", endedAt: Date.now(), updatedAt: Date.now(), failure: error instanceof Error ? error.message : String(error) }, options);
        throw error;
      }
    }
  }
  try {
    return await launchDirect(specPath(id, options), gatePath, { ...record, surface: "direct" }, options);
  } catch (error) {
    const endedAt = Date.now();
    await writeJob({ ...record, state: "failed", surface: "direct", endedAt, updatedAt: endedAt, failure: error instanceof Error ? error.message : String(error) }, options);
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function reconcileJob(job: LongJobRecord, options: StorageOptions = {}, now = Date.now()): Promise<LongJobRecord> {
  if (job.state !== "queued" && job.state !== "running") return job;
  const startGraceMs = 15_000;
  if (job.workerPid === undefined && now - job.updatedAt < startGraceMs) return job;
  if (job.workerPid !== undefined && processAlive(job.workerPid)) return job;

  const current = await readJob(job.id, options);
  if (current.state !== "queued" && current.state !== "running") return current;
  if (current.workerPid !== undefined && processAlive(current.workerPid)) return current;
  if (current.workerPid === undefined && now - current.updatedAt < startGraceMs) return current;

  if (current.commandPid) {
    try {
      process.kill(-current.commandPid, "SIGTERM");
      const commandPid = current.commandPid;
      const forceKill = setTimeout(() => {
        try { process.kill(-commandPid, "SIGKILL"); } catch {}
      }, 5_000);
      forceKill.unref();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const failure = current.workerPid === undefined
    ? "Detached worker did not start before its supervision deadline."
    : "Detached worker exited before recording a terminal state.";
  const sequence = current.milestoneSequence + 1;
  const reconciled: LongJobRecord = {
    ...current,
    state: "failed",
    updatedAt: now,
    endedAt: now,
    failure,
    milestoneSequence: sequence,
  };
  await appendFile(current.eventsPath, `${JSON.stringify({ version: 1, jobId: current.id, sequence, kind: "terminal", ts: now, state: "failed", failure })}\n`, { mode: 0o600 });
  await writeJob(reconciled, options);
  return reconciled;
}

export async function stopJob(id: string, options: StorageOptions = {}): Promise<LongJobRecord> {
  const job = await readJob(id, options);
  if (job.state !== "queued" && job.state !== "running") return job;
  const stopRequestedAt = Date.now();
  const next = { ...job, stopRequestedAt, updatedAt: stopRequestedAt };
  await writeFile(path.join(job.jobDir, "stop.request"), `${stopRequestedAt}\n`, { mode: 0o600 });
  if (job.commandPid) {
    try {
      process.kill(-job.commandPid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return next;
}

export async function waitForTerminalJob(id: string, options: StorageOptions & { timeoutMs?: number } = {}): Promise<LongJobRecord> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() <= deadline) {
    const job = await reconcileJob(await readJob(id, options), options);
    if (job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for long job '${id}'.`);
}

export async function workerAvailable(): Promise<boolean> {
  try {
    await access(WORKER_PATH);
    return true;
  } catch {
    return false;
  }
}
