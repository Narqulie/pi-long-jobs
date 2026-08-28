import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectJobForFleet, shouldReportMilestone } from "../src/fleet.ts";
import type { LongJobRecord } from "../src/model.ts";

function record(overrides: Partial<LongJobRecord> = {}): LongJobRecord {
  return {
    version: 1,
    id: "job-1",
    ownerSessionId: "session-1",
    label: "Msplat batch",
    commandDigest: "abc",
    cwd: "/tmp",
    state: "running",
    surface: "direct",
    startedAt: 1_000,
    updatedAt: 2_000,
    lastOutputAt: 2_000,
    milestoneSequence: 2,
    progress: {
      current: 2,
      total: 31,
      completed: 1,
      item: "erikamoi",
      currentAction: "2/31 · erikamoi",
    },
    jobDir: "/tmp/job-1",
    stdoutPath: "/tmp/job-1/stdout.log",
    stderrPath: "/tmp/job-1/stderr.log",
    eventsPath: "/tmp/job-1/events.jsonl",
    ...overrides,
  };
}

describe("Fleet projection and reporting policy", () => {
  it("projects a running job through the official external-run shape", () => {
    assert.deepEqual(projectJobForFleet(record()), {
      id: "job-1",
      sessionId: "session-1",
      source: "long-job",
      label: "Msplat batch",
      state: "running",
      startedAt: 1_000,
      updatedAt: 2_000,
      currentAction: "2/31 · erikamoi",
      preview: "1 of 31 complete",
      reportPath: "/tmp/job-1/events.jsonl",
      transcriptPath: "/tmp/job-1/stdout.log",
    });
  });

  it("projects a monotonic stop request without adding a second lifecycle state", () => {
    const projected = projectJobForFleet(record({ stopRequestedAt: 2_500 }));
    assert.equal(projected.state, "running");
    assert.equal(projected.currentAction, "Stop requested · stopping process group");
  });

  it("maps timeout to failed display state with a bounded terminal summary", () => {
    const projected = projectJobForFleet(record({
      state: "timed_out",
      endedAt: 5_000,
      failure: "Exceeded 1h deadline",
    }));
    assert.equal(projected.state, "failed");
    assert.equal(projected.endedAt, 5_000);
    assert.equal(projected.preview, "Exceeded 1h deadline");
  });

  it("reports completed-item milestones subject to a minimum interval", () => {
    assert.equal(shouldReportMilestone({ kind: "started_item", ts: 2_000 }, undefined, 1_000), false);
    assert.equal(shouldReportMilestone({ kind: "completed_item", ts: 2_000 }, undefined, 1_000), true);
    assert.equal(shouldReportMilestone({ kind: "completed_item", ts: 2_500 }, 2_000, 1_000), false);
    assert.equal(shouldReportMilestone({ kind: "failed_item", ts: 2_500 }, 2_000, 1_000), true);
    assert.equal(shouldReportMilestone({ kind: "terminal", ts: 2_500 }, 2_000, 1_000), true);
  });
});
