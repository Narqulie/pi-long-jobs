import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { readJob } from "../src/storage.ts";
import { reconcileJob, startJob, stopJob, waitForTerminalJob } from "../src/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function jobRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-test-"));
  roots.push(root);
  return root;
}

describe("detached long-job runtime", () => {
  it("returns immediately, persists milestones, and reaches completion", async () => {
    const root = await jobRoot();
    const startedAt = Date.now();
    const started = await startJob({
      label: "Scene batch",
      command: "printf '===== START alpha items=1 =====\\n'; sleep 0.1; printf '===== OK alpha exit=0 elapsed=1s\\n'",
      cwd: root,
      ownerSessionId: "session-test",
      totalItems: 1,
      surface: "direct",
    }, { jobsRoot: root });

    assert.ok(Date.now() - startedAt < 500, "start must not wait for the command");
    assert.match(started.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.ok(started.workerPid && started.workerPid > 0);

    const completed = await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
    assert.equal(completed.state, "completed");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.progress.current, 1);
    assert.equal(completed.progress.total, 1);
    assert.equal(completed.progress.completed, 1);
    assert.equal(completed.progress.item, "alpha");

    const stdout = await readFile(completed.stdoutPath, "utf8");
    assert.match(stdout, /START alpha/);
    assert.match(stdout, /OK alpha/);
    const events = await readFile(completed.eventsPath, "utf8");
    assert.match(events, /started_item/);
    assert.match(events, /completed_item/);
  });

  it("bounds persisted logs without stopping progress supervision", async () => {
    const root = await jobRoot();
    const started = await startJob({
      label: "Log bound",
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(4096))'`,
      cwd: root,
      ownerSessionId: "session-test",
      maxLogBytes: 128,
      surface: "direct",
    }, { jobsRoot: root });
    const completed = await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
    assert.equal(completed.state, "completed");
    const stdout = await readFile(completed.stdoutPath, "utf8");
    assert.ok(Buffer.byteLength(stdout) <= 128);
    assert.match(stdout, /log truncated at 128 bytes/);
  });

  it("terminalizes a job when its detached worker dies", async () => {
    const root = await jobRoot();
    const started = await startJob({
      label: "Worker death probe",
      command: "sleep 30",
      cwd: root,
      ownerSessionId: "session-test",
      surface: "direct",
    }, { jobsRoot: root });
    const running = await waitUntil(started.id, root, (job) => job.state === "running" && Boolean(job.commandPid));
    process.kill(running.workerPid!, "SIGKILL");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(running.workerPid!, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const failed = await reconcileJob(await readJob(started.id, { jobsRoot: root }), { jobsRoot: root });
    assert.equal(failed.state, "failed");
    assert.match(failed.failure ?? "", /Detached worker exited/);
  });

  it("stops the command process group and records a terminal stopped state", async () => {
    const root = await jobRoot();
    const started = await startJob({
      label: "Stop probe",
      command: "printf '===== START sleeping =====\\n'; sleep 30",
      cwd: root,
      ownerSessionId: "session-test",
      surface: "direct",
    }, { jobsRoot: root });

    const running = await waitUntil(started.id, root, (job) => job.state === "running" && Boolean(job.commandPid));
    assert.equal(running.state, "running");
    await stopJob(started.id, { jobsRoot: root });
    const stopping = await readJob(started.id, { jobsRoot: root });
    assert.ok(stopping.stopRequestedAt, "the monotonic stop marker must be projected immediately");

    const stopped = await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
    assert.equal(stopped.state, "stopped");
    assert.ok(stopped.endedAt);
  });
});

async function waitUntil(
  id: string,
  jobsRoot: string,
  predicate: (job: Awaited<ReturnType<typeof readJob>>) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await readJob(id, { jobsRoot });
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${id}`);
}
