import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectJobForFleet, shouldNotifyOrchestrator } from "../src/fleet.ts";
import type { LongJobMilestone, LongJobRecord } from "../src/model.ts";

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
    updatedAt: 8_000,
    lastOutputAt: 8_000,
    milestoneSequence: 3,
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

const milestones: LongJobMilestone[] = [
  { sequence: 1, kind: "started_item", item: "emmanie", current: 1, total: 31, ts: 1_000 },
  { sequence: 2, kind: "completed_item", item: "emmanie", current: 1, total: 31, ts: 7_000 },
  { sequence: 3, kind: "started_item", item: "erikamoi", current: 2, total: 31, ts: 7_000 },
];

describe("Fleet projection and reporting policy", () => {
  it("projects a running timeline through the official external-run shape", () => {
    assert.deepEqual(projectJobForFleet(record(), milestones, 8_000), {
      id: "job-1",
      sessionId: "session-1",
      source: "long-job",
      label: "Msplat batch",
      state: "running",
      startedAt: 1_000,
      updatedAt: 8_000,
      currentAction: "2/31 · erikamoi",
      preview: "Progress: 1/31 complete\n✓ emmanie · 6s\n◐ erikamoi · 1s",
      reportPath: "/tmp/job-1/events.jsonl",
      transcriptPath: "/tmp/job-1/stdout.log",
    });
  });

  it("bounds the timeline to the most recent eight items", () => {
    const many = Array.from({ length: 10 }, (_, index): LongJobMilestone => ({
      sequence: index + 1,
      kind: "completed_item",
      item: `scene-${index + 1}`,
      current: index + 1,
      total: 10,
      ts: (index + 1) * 1_000,
    }));
    const preview = projectJobForFleet(record({ progress: { completed: 10, total: 10, currentAction: "10/10" } }), many, 11_000).preview!;
    assert.doesNotMatch(preview, /scene-1(?:\D|$)/);
    assert.doesNotMatch(preview, /scene-2(?:\D|$)/);
    assert.match(preview, /scene-3/);
    assert.match(preview, /scene-10/);
    assert.ok(preview.split("\n").length <= 9);
  });

  it("projects a monotonic stop request without adding a second lifecycle state", () => {
    const projected = projectJobForFleet(record({ stopRequestedAt: 2_500 }), milestones, 8_000);
    assert.equal(projected.state, "running");
    assert.equal(projected.currentAction, "Stop requested · stopping process group");
  });

  it("maps timeout to failed display state with a bounded terminal summary", () => {
    const projected = projectJobForFleet(record({
      state: "timed_out",
      endedAt: 5_000,
      failure: "Exceeded 1h deadline",
    }), [], 5_000);
    assert.equal(projected.state, "failed");
    assert.equal(projected.endedAt, 5_000);
    assert.match(projected.preview ?? "", /Failure: Exceeded 1h deadline/);
    assert.match(projected.preview ?? "", /Progress: 1\/31 complete/);
  });

  it("wakes the orchestrator only for actionable failures", () => {
    assert.equal(shouldNotifyOrchestrator(record(), { kind: "started_item" }), false);
    assert.equal(shouldNotifyOrchestrator(record(), { kind: "completed_item" }), false);
    assert.equal(shouldNotifyOrchestrator(record(), { kind: "failed_item" }), true);
    assert.equal(shouldNotifyOrchestrator(record({ state: "completed" }), { kind: "terminal" }), false);
    assert.equal(shouldNotifyOrchestrator(record({ state: "stopped" }), { kind: "terminal" }), false);
    assert.equal(shouldNotifyOrchestrator(record({ state: "failed" }), { kind: "terminal" }), true);
    assert.equal(shouldNotifyOrchestrator(record({ state: "timed_out" }), { kind: "terminal" }), true);
  });
});
