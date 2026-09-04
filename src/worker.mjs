#!/usr/bin/env node
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { applyProgressLine } from "./progress.mjs";

const specPath = process.argv[2];
if (!specPath) throw new Error("Missing long-job spec path.");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (spec.version !== 1) throw new Error("Unsupported long-job spec version.");
const maxLogBytes = Number.isSafeInteger(spec.maxLogBytes) && spec.maxLogBytes > 0 ? spec.maxLogBytes : 100 * 1024 * 1024;

function readStatus() {
  return JSON.parse(readFileSync(spec.statusPath, "utf8"));
}

function writeStatus(status) {
  const temporary = `${spec.statusPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, spec.statusPath);
  try { chmodSync(spec.statusPath, 0o600); } catch {}
}

function appendEvent(event) {
  appendFileSync(spec.eventsPath, `${JSON.stringify({ version: 1, jobId: spec.id, ...event })}\n`, { mode: 0o600 });
}

let recordingFatalError = false;
function recordFatalError(cause) {
  if (recordingFatalError) return;
  recordingFatalError = true;
  const message = cause instanceof Error ? cause.message : String(cause);
  try {
    const current = readStatus();
    if (current.state === "queued" || current.state === "running") {
      const endedAt = Date.now();
      const sequence = current.milestoneSequence + 1;
      try { appendEvent({ kind: "terminal", sequence, ts: endedAt, state: "failed", failure: message }); } catch {}
      writeStatus({ ...current, state: "failed", updatedAt: endedAt, endedAt, failure: message, milestoneSequence: sequence });
    }
  } catch {}
  process.exitCode = 1;
}
process.on("uncaughtException", recordFatalError);
process.on("unhandledRejection", recordFatalError);

const gateDeadline = Date.now() + 10_000;
while (!existsSync(spec.startGatePath)) {
  if (Date.now() >= gateDeadline) throw new Error("Timed out waiting for the long-job start gate.");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

let status = readStatus();
const startedAt = Date.now();
status = { ...status, state: "running", workerPid: process.pid, updatedAt: startedAt };
writeStatus(status);
appendEvent({ kind: "job_started", ts: startedAt, workerPid: process.pid });

let finished = false;
let timedOut = false;
let stopping = false;
let stdoutBytes = 0;
let stderrBytes = 0;
let stdoutTruncated = false;
let stderrTruncated = false;
let pendingStatusWrite = false;
let stdoutLine = "";
let stderrLine = "";
let forceKillTimer;
const killGraceMs = Number.isSafeInteger(Number(process.env.PI_LONG_JOB_KILL_GRACE_MS))
  ? Math.max(100, Math.min(60_000, Number(process.env.PI_LONG_JOB_KILL_GRACE_MS)))
  : 5_000;

function writeLog(file, chunk, stream) {
  let bytes = stream === "stdout" ? stdoutBytes : stderrBytes;
  let truncated = stream === "stdout" ? stdoutTruncated : stderrTruncated;
  if (!truncated) {
    const marker = Buffer.from(`\n[pi-long-jobs log truncated at ${maxLogBytes} bytes]\n`);
    const payloadLimit = Math.max(0, maxLogBytes - marker.length);
    const remaining = payloadLimit - bytes;
    if (remaining > 0) {
      const body = chunk.subarray(0, remaining);
      appendFileSync(file, body, { mode: 0o600 });
      bytes += body.length;
    }
    if (chunk.length > remaining) {
      const boundedMarker = marker.subarray(0, Math.max(0, maxLogBytes - bytes));
      if (boundedMarker.length > 0) appendFileSync(file, boundedMarker, { mode: 0o600 });
      bytes += boundedMarker.length;
      truncated = true;
    }
  }
  if (stream === "stdout") {
    stdoutBytes = bytes;
    stdoutTruncated = truncated;
  } else {
    stderrBytes = bytes;
    stderrTruncated = truncated;
  }
}

function persistOutputHeartbeat(now) {
  status = { ...status, lastOutputAt: now, updatedAt: now };
  pendingStatusWrite = true;
}

function processLine(line, now) {
  const applied = applyProgressLine(status.progress, line, now);
  if (!applied.milestone) return;
  const sequence = status.milestoneSequence + 1;
  status = { ...status, progress: applied.state, milestoneSequence: sequence, lastOutputAt: now, updatedAt: now };
  appendEvent({ ...applied.milestone, sequence });
  writeStatus(status);
  pendingStatusWrite = false;
}

function consumeLines(stream, text, now) {
  let pending = stream === "stdout" ? stdoutLine : stderrLine;
  pending += text;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  for (const line of lines) processLine(line, now);
  if (pending.length > 8192) {
    processLine(pending.slice(0, 8192), now);
    pending = "";
  }
  if (stream === "stdout") stdoutLine = pending;
  else stderrLine = pending;
}

const child = spawn("/bin/zsh", ["-lc", spec.command], {
  cwd: spec.cwd,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
status = { ...status, commandPid: child.pid, updatedAt: Date.now() };
writeStatus(status);

child.stdout.on("data", (value) => {
  const chunk = Buffer.from(value);
  const now = Date.now();
  writeLog(spec.stdoutPath, chunk, "stdout");
  if (process.stdout.isTTY) process.stdout.write(chunk);
  persistOutputHeartbeat(now);
  consumeLines("stdout", chunk.toString("utf8"), now);
});
child.stderr.on("data", (value) => {
  const chunk = Buffer.from(value);
  const now = Date.now();
  writeLog(spec.stderrPath, chunk, "stderr");
  if (process.stderr.isTTY) process.stderr.write(chunk);
  persistOutputHeartbeat(now);
  consumeLines("stderr", chunk.toString("utf8"), now);
});

const heartbeat = setInterval(() => {
  if (existsSync(spec.stopRequestPath) && !stopping) stop();
  if (pendingStatusWrite && !finished) {
    writeStatus(status);
    pendingStatusWrite = false;
  }
}, 1_000);
heartbeat.unref();

const timeout = spec.timeoutMs ? setTimeout(() => {
  timedOut = true;
  terminateChild();
}, spec.timeoutMs) : undefined;
timeout?.unref();

function terminateChild() {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  if (!forceKillTimer) {
    forceKillTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, killGraceMs);
  }
}

function stop() {
  if (finished || stopping) return;
  stopping = true;
  terminateChild();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

child.once("error", (error) => finish(undefined, undefined, error));
child.once("close", (code, signal) => finish(code ?? undefined, signal ?? undefined));

function finish(code, signal, error) {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
  if (timeout) clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (stdoutLine) processLine(stdoutLine, Date.now());
  if (stderrLine) processLine(stderrLine, Date.now());
  let latest;
  try { latest = readStatus(); } catch { latest = status; }
  const stopped = stopping || existsSync(spec.stopRequestPath);
  const state = timedOut ? "timed_out" : stopped ? "stopped" : error || code !== 0 ? "failed" : "completed";
  const endedAt = Date.now();
  const failure = error ? error.message : timedOut ? `Exceeded ${spec.timeoutMs}ms deadline` : state === "failed" ? `Command exited ${code ?? signal ?? "without status"}` : undefined;
  const stopRequestedAt = existsSync(spec.stopRequestPath)
    ? Number.parseInt(readFileSync(spec.stopRequestPath, "utf8"), 10)
    : undefined;
  status = {
    ...latest,
    state,
    updatedAt: endedAt,
    endedAt,
    ...(Number.isSafeInteger(stopRequestedAt) ? { stopRequestedAt } : {}),
    ...(code !== undefined ? { exitCode: code } : {}),
    ...(signal ? { signal } : {}),
    ...(failure ? { failure } : {}),
  };
  const sequence = status.milestoneSequence + 1;
  status.milestoneSequence = sequence;
  appendEvent({ kind: "terminal", sequence, ts: endedAt, state, exitCode: code, signal, failure });
  writeStatus(status);
  process.exitCode = state === "completed" ? 0 : 1;
}
