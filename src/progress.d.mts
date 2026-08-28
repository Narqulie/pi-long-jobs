import type { LongJobMilestoneKind, LongJobProgress } from "./model.ts";

export interface AppliedProgress {
  state: LongJobProgress;
  milestone?: {
    kind: Exclude<LongJobMilestoneKind, "terminal">;
    ts: number;
    item?: string;
    current?: number;
    total?: number;
    message?: string;
  };
}

export function createProgressState(totalItems?: number): LongJobProgress;
export function applyProgressLine(previous: LongJobProgress, rawLine: string, now?: number): AppliedProgress;
