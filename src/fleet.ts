import type { ExternalRun } from "pi-subagents/external-runs";
import type { LongJobMilestone, LongJobRecord } from "./model.ts";

function bounded(value: string | undefined, max: number): string | undefined {
  const safe = value?.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
  return safe ? safe.slice(0, max) : undefined;
}

function preview(job: LongJobRecord): string | undefined {
  if (job.failure) return bounded(job.failure, 4_096);
  if (job.state === "completed") return job.exitCode === undefined ? "Completed" : `Completed with exit ${job.exitCode}`;
  if (job.state === "stopped") return "Stopped by request";
  if (job.state === "timed_out") return "Timed out";
  if (job.progress.total !== undefined) return `${job.progress.completed} of ${job.progress.total} complete`;
  return job.progress.completed > 0 ? `${job.progress.completed} items complete` : undefined;
}

export function projectJobForFleet(job: LongJobRecord): ExternalRun {
  const state: ExternalRun["state"] = job.state === "timed_out" ? "failed" : job.state;
  const currentAction = job.stopRequestedAt !== undefined && (job.state === "queued" || job.state === "running")
    ? "Stop requested · stopping process group"
    : bounded(job.progress.currentAction, 160);
  return {
    id: job.id,
    sessionId: job.ownerSessionId,
    source: "long-job",
    label: bounded(job.label, 160) ?? job.id,
    state,
    startedAt: job.startedAt,
    updatedAt: job.lastOutputAt ?? job.updatedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    currentAction,
    ...(preview(job) ? { preview: preview(job) } : {}),
    reportPath: job.eventsPath,
    transcriptPath: job.stdoutPath,
  };
}

export function shouldReportMilestone(
  milestone: Pick<LongJobMilestone, "kind" | "ts">,
  lastReportedAt: number | undefined,
  minimumIntervalMs: number,
): boolean {
  if (milestone.kind === "terminal" || milestone.kind === "failed_item") return true;
  if (milestone.kind !== "completed_item") return false;
  return lastReportedAt === undefined || milestone.ts - lastReportedAt >= minimumIntervalMs;
}
