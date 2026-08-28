import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { snapshotExternalRuns } from "pi-subagents/external-runs";

import { LongJobBridge } from "../src/bridge.ts";
import { startJob, waitForTerminalJob } from "../src/runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("long-job Fleet bridge", () => {
  it("publishes current-session jobs and coalesces adjacent item and terminal reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-bridge-"));
    roots.push(root);
    const ownerSessionId = `session-${Date.now()}`;
    const history: string[] = [];
    const reports: string[] = [];
    let changes = 0;
    const bridge = new LongJobBridge({
      sessionId: ownerSessionId,
      storage: { jobsRoot: root },
      config: { historyLimit: 20, inactivityAfterMs: 60_000, reportMinimumIntervalMs: 0 },
      callbacks: {
        onHistory: (_job, event) => history.push(event.kind),
        onReport: (_job, event) => reports.push(event.kind),
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

      assert.deepEqual(history, ["started_item", "completed_item", "terminal"]);
      assert.equal(changes, 1);
      assert.deepEqual(reports, ["terminal"]);
      const external = snapshotExternalRuns(ownerSessionId);
      assert.equal(external.length, 1);
      assert.equal(external[0]?.state, "completed");
      assert.equal(external[0]?.label, "Bridge probe");
    } finally {
      bridge.dispose();
    }
    assert.equal(snapshotExternalRuns(ownerSessionId).length, 0);
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
      config: { historyLimit: 20, inactivityAfterMs: 60_000, reportMinimumIntervalMs: 0 },
      callbacks: {
        onHistory: () => {},
        onReport: () => {},
        onInactivity: () => {},
        onChange: () => assert.fail("disposed bridge emitted change"),
      },
    });
    bridge.start();
    const refresh = bridge.refresh();
    bridge.dispose();
    await refresh;
    assert.equal(snapshotExternalRuns(ownerSessionId).length, 0);
    const { stopJob } = await import("../src/runtime.ts");
    await stopJob(started.id, { jobsRoot: root });
    await waitForTerminalJob(started.id, { jobsRoot: root, timeoutMs: 5_000 });
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
      config: { historyLimit: 20, inactivityAfterMs: 10_000, reportMinimumIntervalMs: 0 },
      callbacks: {
        onHistory: () => {},
        onReport: () => {},
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
