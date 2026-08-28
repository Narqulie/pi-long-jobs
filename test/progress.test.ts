import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyProgressLine, createProgressState } from "../src/progress.mjs";

describe("long-job progress protocol", () => {
  it("tracks START/OK milestones with inferred item counts", () => {
    let state = createProgressState(3);

    let result = applyProgressLine(state, "===== START emmanie images=44 iterations=7000 =====", 1_000);
    state = result.state;
    assert.equal(result.milestone?.kind, "started_item");
    assert.equal(state.current, 1);
    assert.equal(state.total, 3);
    assert.equal(state.item, "emmanie");
    assert.equal(state.currentAction, "1/3 · emmanie");

    result = applyProgressLine(state, "===== OK emmanie exit=0 elapsed=510s", 2_000);
    state = result.state;
    assert.equal(result.milestone?.kind, "completed_item");
    assert.equal(state.completed, 1);

    result = applyProgressLine(state, "===== START erikamoi images=123 iterations=7000 =====", 3_000);
    state = result.state;
    assert.equal(state.current, 2);
    assert.equal(state.item, "erikamoi");
    assert.equal(state.currentAction, "2/3 · erikamoi");
  });

  it("accepts structured PI_JOB_PROGRESS messages and rejects malformed payloads", () => {
    const state = createProgressState();
    const valid = applyProgressLine(
      state,
      'PI_JOB_PROGRESS {"current":7,"total":31,"item":"scene-07","phase":"training","message":"7000 / 7000"}',
      4_000,
    );
    assert.equal(valid.milestone?.kind, "progress");
    assert.equal(valid.state.current, 7);
    assert.equal(valid.state.total, 31);
    assert.equal(valid.state.item, "scene-07");
    assert.equal(valid.state.phase, "training");
    assert.equal(valid.state.currentAction, "7/31 · scene-07 · 7000 / 7000");

    const invalid = applyProgressLine(valid.state, "PI_JOB_PROGRESS not-json", 5_000);
    assert.equal(invalid.milestone, undefined);
    assert.deepEqual(invalid.state, valid.state);
  });

  it("bounds untrusted display fields", () => {
    const state = createProgressState(1);
    const result = applyProgressLine(state, `===== START ${"x".repeat(1000)} =====`, 1_000);
    assert.ok((result.state.item?.length ?? 0) <= 160);
    assert.ok(result.state.currentAction.length <= 240);
  });
});
