import type { ExternalRun } from "pi-subagents/external-runs";
import type { LongJobMilestone, LongJobRecord } from "./model.ts";

const TIMELINE_ITEM_LIMIT = 8;

function bounded(value: string | undefined, max: number): string | undefined {
  const safe = value?.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
  return safe ? safe.slice(0, max) : undefined;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface TimelineItem {
  key: string;
  item: string;
  state: "running" | "completed" | "failed";
  startedAt?: number;
  endedAt?: number;
}

function timelineItems(milestones: readonly LongJobMilestone[]): TimelineItem[] {
  const items = new Map<string, TimelineItem>();
  for (const milestone of milestones) {
    if (!milestone.item || (milestone.kind !== "started_item" && milestone.kind !== "completed_item" && milestone.kind !== "failed_item")) continue;
    const key = `${milestone.current ?? milestone.item}\0${milestone.item}`;
    const previous = items.get(key);
    if (milestone.kind === "started_item") {
      items.set(key, { key, item: milestone.item, state: "running", startedAt: milestone.ts });
      continue;
    }
    items.set(key, {
      key,
      item: milestone.item,
      state: milestone.kind === "failed_item" ? "failed" : "completed",
      ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
      endedAt: milestone.ts,
    });
  }
  return [...items.values()].slice(-TIMELINE_ITEM_LIMIT);
}

function timelinePreview(job: LongJobRecord, milestones: readonly LongJobMilestone[], now: number): string | undefined {
  const lines: string[] = [];
  if (job.failure) lines.push(`Failure: ${bounded(job.failure, 1_024) ?? "Command failed"}`);
  if (job.progress.total !== undefined) lines.push(`Progress: ${job.progress.completed}/${job.progress.total} complete`);
  else if (job.progress.completed > 0) lines.push(`Progress: ${job.progress.completed} items complete`);

  for (const item of timelineItems(milestones)) {
    const marker = item.state === "completed" ? "✓" : item.state === "failed" ? "✗" : "◐";
    const end = item.endedAt ?? (job.endedAt ?? now);
    const elapsed = item.startedAt === undefined ? undefined : duration(end - item.startedAt);
    lines.push(`${marker} ${bounded(item.item, 160) ?? "item"}${elapsed ? ` · ${elapsed}` : ""}`);
  }

  if (lines.length) return bounded(lines.join("\n"), 4_096);
  if (job.state === "completed") return job.exitCode === undefined ? "Completed" : `Completed with exit ${job.exitCode}`;
  if (job.state === "stopped") return "Stopped by request";
  if (job.state === "timed_out") return "Timed out";
  return undefined;
}

export function projectJobForFleet(
  job: LongJobRecord,
  milestones: readonly LongJobMilestone[] = [],
  now = Date.now(),
): ExternalRun {
  const state: ExternalRun["state"] = job.state === "timed_out" ? "failed" : job.state;
  const currentAction = job.stopRequestedAt !== undefined && (job.state === "queued" || job.state === "running")
    ? "Stop requested · stopping process group"
    : bounded(job.progress.currentAction, 160);
  const preview = timelinePreview(job, milestones, now);
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
    ...(preview ? { preview } : {}),
    reportPath: job.eventsPath,
    transcriptPath: job.stdoutPath,
  };
}

export function shouldNotifyOrchestrator(job: LongJobRecord, milestone: Pick<LongJobMilestone, "kind">): boolean {
  if (milestone.kind === "failed_item") return true;
  return milestone.kind === "terminal" && (job.state === "failed" || job.state === "timed_out");
}
