import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { LongJobMilestone, LongJobRecord, LongJobSpec, StorageOptions } from "./model.ts";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,158}$/;

export function resolveJobsRoot(options: StorageOptions = {}): string {
  return path.resolve(options.jobsRoot ?? process.env.PI_LONG_JOBS_DIR ?? path.join(homedir(), ".pi", "agent", "long-jobs"));
}

export function jobDirectory(id: string, options: StorageOptions = {}): string {
  assertJobId(id);
  return path.join(resolveJobsRoot(options), id);
}

export function statusPath(id: string, options: StorageOptions = {}): string {
  return path.join(jobDirectory(id, options), "status.json");
}

export function specPath(id: string, options: StorageOptions = {}): string {
  return path.join(jobDirectory(id, options), "spec.json");
}

export function assertJobId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Invalid long-job id '${id}'.`);
}

export async function ensureJobDirectory(id: string, options: StorageOptions = {}): Promise<string> {
  const root = resolveJobsRoot(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => {});
  const directory = jobDirectory(id, options);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  return directory;
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

export async function writeJob(job: LongJobRecord, options: StorageOptions = {}): Promise<void> {
  await writePrivateJson(statusPath(job.id, options), job);
}

export async function writeSpec(spec: LongJobSpec, options: StorageOptions = {}): Promise<void> {
  await writePrivateJson(specPath(spec.id, options), spec);
}

async function readStopRequestedAt(jobDir: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path.join(jobDir, "stop.request"), "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJob(id: string, options: StorageOptions = {}): Promise<LongJobRecord> {
  const parsed = JSON.parse(await readFile(statusPath(id, options), "utf8")) as LongJobRecord;
  const directory = jobDirectory(id, options);
  const expectedPaths = {
    jobDir: directory,
    stdoutPath: path.join(directory, "stdout.log"),
    stderrPath: path.join(directory, "stderr.log"),
    eventsPath: path.join(directory, "events.jsonl"),
  };
  const pathsMatch = Object.entries(expectedPaths).every(([field, expected]) => parsed[field as keyof LongJobRecord] === expected);
  if (parsed.version !== 1 || parsed.id !== id || !parsed.ownerSessionId || !parsed.label || !parsed.progress || !pathsMatch) {
    throw new Error(`Malformed long-job record '${id}'.`);
  }
  if ((parsed.state === "queued" || parsed.state === "running") && parsed.stopRequestedAt === undefined) {
    const stopRequestedAt = await readStopRequestedAt(directory);
    if (stopRequestedAt !== undefined) return { ...parsed, stopRequestedAt };
  }
  return parsed;
}

export async function listJobs(options: StorageOptions = {}): Promise<LongJobRecord[]> {
  const root = resolveJobsRoot(options);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: LongJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    try {
      jobs.push(await readJob(entry.name, options));
    } catch {
      // A malformed record is not executable and is omitted from ordinary history.
    }
  }
  return jobs.sort((left, right) => (right.updatedAt ?? right.startedAt) - (left.updatedAt ?? left.startedAt));
}

export async function readMilestones(job: LongJobRecord): Promise<LongJobMilestone[]> {
  let text: string;
  try {
    text = await readFile(job.eventsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.length > 1_048_576 ? text.slice(-1_048_576).split("\n").slice(1) : text.split("\n");
  const events: LongJobMilestone[] = [];
  for (const line of lines.slice(-2_000)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as LongJobMilestone;
      if (Number.isSafeInteger(event.sequence) && event.sequence > 0 && typeof event.kind === "string" && Number.isSafeInteger(event.ts)) events.push(event);
    } catch {
      // Ignore a concurrently written final line; the next poll will retry it.
    }
  }
  return events;
}

export async function removeJob(id: string, options: StorageOptions = {}): Promise<void> {
  const job = await readJob(id, options);
  if (job.state === "queued" || job.state === "running") throw new Error(`Cannot forget active job '${id}'. Stop it first.`);
  await rm(jobDirectory(id, options), { recursive: true, force: true });
}

export async function assertDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error(`Working directory is not a directory: ${resolved}`);
  return resolved;
}
