import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { LongJobBridge } from "../src/bridge.ts";
import type { LongJobRecord } from "../src/model.ts";
import { startJob, waitForTerminalJob } from "../src/runtime.ts";
import { ensureJobDirectory, writeJob } from "../src/storage.ts";
import { WORK_PROVIDER_REGISTRY_KEY, type WorkItem } from "../src/work-provider.ts";

function workSnapshot(sessionId: string): { items: readonly WorkItem[]; total: number; omitted: number } {
  const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(WORK_PROVIDER_REGISTRY_KEY)] as { providers: Map<string, { snapshot(context: { sessionId: string; nowMs: number }): { items: WorkItem[]; total: number } }> } | undefined;
  const snapshot = registry?.providers.get("pi-long-jobs")?.snapshot({ sessionId, nowMs: Date.now() }) ?? { items: [], total: 0 };
  return { ...snapshot, omitted: Math.max(0, snapshot.total - snapshot.items.length) };
}

function snapshotWork(sessionId: string): readonly WorkItem[] {
  return workSnapshot(sessionId).items;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("long-job Fleet bridge", () => {
  it("publishes successful current-session history without waking the orchestrator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}`;
    const attentions: string[] = [];
    let changes = 0;
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000 },
      callbacks: {
        onAttention: (_job, event) => attentions.push(event.kind),
        onInactivity: () => assert.fail("unexpected inactivity alert"),
        onChange: () => { changes += 1; },
      },
    });
    bridge.start();
    try {
      const started = await startJob({
        label: "Bridge probe",
        command: "printf '===== START alpha =====\\n'; printf '===== OK alpha exit=0 elapsed=0s\\n'",
        cwd: root,
        ownerSessionId,
        totalItems: 1,
        surface: "direct",
      }, { jobsRoot: root });
      bridge.watch(started.id, 0);
      await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
      await bridge.refresh();
      await bridge.refresh();

      assert.equal(changes, 1);
      assert.deepEqual(attentions, []);
      const external = snapshotWork(ownerSessionId);
      assert.equal(external.length, 1);
      assert.equal(external[0]?.state, "completed");
      assert.equal(external[0]?.label, "Bridge probe");
      assert.match(external[0]?.preview ?? "", /Progress: 1\/1 complete/);
      assert.match(external[0]?.preview ?? "", /✓ alpha/);
    } finally {
      bridge.dispose();
    }
    assert.equal(snapshotWork(ownerSessionId).length, 0);
  });

  it("does not replay an item failure when the failed terminal milestone arrives later", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}-failure`;
    const attentions: string[] = [];
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000 },
      callbacks: {
        onAttention: (_job, event) => attentions.push(event.kind),
        onInactivity: () => assert.fail("unexpected inactivity alert"),
        onChange: () => {},
      },
    });
    bridge.start();
    try {
      const started = await startJob({
        label: "Failure probe",
        command: "printf '===== START alpha =====\\n'; printf '===== FAIL alpha reason=probe =====\\n'; sleep 1; exit 3",
        cwd: root,
        ownerSessionId,
        totalItems: 1,
        surface: "direct",
      }, { jobsRoot: root });
      bridge.watch(started.id, 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await bridge.refresh();
      assert.deepEqual(attentions, ["failed_item"]);

      await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
      await bridge.refresh();
      await bridge.refresh();
      assert.deepEqual(attentions, ["failed_item"]);
      const external = snapshotWork(ownerSessionId);
      assert.equal(external[0]?.state, "failed");
      assert.match(external[0]?.preview ?? "", /✗ alpha/);
    } finally {
      bridge.dispose();
    }
  });

  it("restores failed history into FleetView without replaying stale attention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}-restart`;
    const started = await startJob({
      label: "Restart failure probe",
      command: "printf '===== START beta =====\\n'; printf '===== FAIL beta reason=probe =====\\n'; exit 4",
      cwd: root,
      ownerSessionId,
      totalItems: 1,
      surface: "direct",
    }, { jobsRoot: root });
    await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });

    const attentions: string[] = [];
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000 },
      callbacks: {
        onAttention: (_job, event) => attentions.push(event.kind),
        onInactivity: () => assert.fail("unexpected inactivity alert"),
        onChange: () => {},
      },
    });
    bridge.start();
    try {
      await bridge.refresh();
      assert.deepEqual(attentions, []);
      const external = snapshotWork(ownerSessionId);
      assert.equal(external[0]?.state, "failed");
      assert.match(external[0]?.preview ?? "", /✗ beta/);
    } finally {
      bridge.dispose();
    }
  });

  it("does not republish jobs after disposal races an in-flight refresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}-dispose`;
    const started = await startJob({
      label: "Dispose probe",
      command: "sleep 30",
      cwd: root,
      ownerSessionId,
      surface: "direct",
    }, { jobsRoot: root });
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000 },
      callbacks: {
        onAttention: () => {},
        onInactivity: () => {},
        onChange: () => assert.fail("disposed bridge emitted change"),
      },
    });
    bridge.start();
    const refresh = bridge.refresh();
    bridge.dispose();
    await refresh;
    assert.equal(snapshotWork(ownerSessionId).length, 0);
    const { stopJob } = await import("../src/runtime.ts");
    await stopJob(started.id, { jobsRoot: root });
    await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
  });

  it("keeps every active job and limits only terminal history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}-bounds`;
    const now = Date.now();
    for (let index = 0; index < 46; index += 1) {
      const id = `job-${String(index).padStart(2, "0")}`;
      const directory = await ensureJobDirectory(id, { jobsRoot: root });
      const active = index < 21;
      const record: LongJobRecord = {
        version: 1,
        id,
        label: `Job ${index}`,
        commandDigest: `digest-${index}`,
        cwd: root,
        ownerSessionId,
        surface: "direct",
        state: active ? "running" : "completed",
        startedAt: now - index,
        updatedAt: now - index,
        ...(active ? { workerPid: process.pid } : { endedAt: now - index, exitCode: 0 }),
        jobDir: directory,
        stdoutPath: path.join(directory, "stdout.log"),
        stderrPath: path.join(directory, "stderr.log"),
        eventsPath: path.join(directory, "events.jsonl"),
        progress: { completed: 0, currentAction: active ? "Starting process" : "Completed" },
        milestoneSequence: 0,
      };
      await writeJob(record, { jobsRoot: root });
    }
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000 },
      callbacks: { onAttention: () => {}, onInactivity: () => {}, onChange: () => {} },
    });
    bridge.start();
    try {
      await bridge.refresh();
      const snapshot = workSnapshot(ownerSessionId);
      assert.equal(snapshot.total, 46);
      assert.equal(snapshot.items.filter((item) => item.state === "running").length, 21);
      assert.equal(snapshot.items.filter((item) => item.state === "completed").length, 20);
      assert.equal(snapshot.omitted, 5);
      assert.ok(snapshot.items.filter((item) => item.state === "running").every((item) => item.currentAction === "Running command"));
    } finally {
      bridge.dispose();
    }
  });

  it("emits one inactivity alert per unchanged output timestamp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}-idle`;
    const alerts: number[] = [];
    const started = await startJob({
      label: "Idle probe",
      command: "sleep 30",
      cwd: root,
      ownerSessionId,
      surface: "direct",
    }, { jobsRoot: root });
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 10_000 },
      callbacks: {
        onAttention: () => {},
        onInactivity: (_job, inactiveForMs) => alerts.push(inactiveForMs),
        onChange: () => {},
      },
    });
    bridge.start();
    try {
      await bridge.refresh(started.startedAt + 11_000);
      await bridge.refresh(started.startedAt + 20_000);
      assert.equal(alerts.length, 1);
    } finally {
      bridge.dispose();
      const { stopJob } = await import("../src/runtime.ts");
      await stopJob(started.id, { jobsRoot: root });
      await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
    }
  });
});
