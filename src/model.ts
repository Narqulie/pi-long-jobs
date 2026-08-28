export const LONG_JOB_RECORD_VERSION = 1 as const;

export type LongJobState = "queued" | "running" | "completed" | "failed" | "stopped" | "timed_out";
export type LongJobSurface = "auto" | "direct" | "herdr";
export type LongJobMilestoneKind = "started_item" | "completed_item" | "failed_item" | "progress" | "terminal";

export interface LongJobProgress {
  current?: number;
  total?: number;
  completed: number;
  item?: string;
  phase?: string;
  message?: string;
  currentAction: string;
}

export interface LongJobRecord {
  version: typeof LONG_JOB_RECORD_VERSION;
  id: string;
  ownerSessionId: string;
  label: string;
  commandDigest: string;
  cwd: string;
  state: LongJobState;
  surface: Exclude<LongJobSurface, "auto">;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  lastOutputAt?: number;
  stopRequestedAt?: number;
  milestoneSequence: number;
  lastReportedSequence?: number;
  lastReportedAt?: number;
  workerPid?: number;
  commandPid?: number;
  paneId?: string;
  exitCode?: number;
  signal?: string;
  failure?: string;
  progress: LongJobProgress;
  jobDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
}

export interface StartLongJobInput {
  label: string;
  command: string;
  cwd: string;
  ownerSessionId: string;
  totalItems?: number;
  timeoutMs?: number;
  maxLogBytes?: number;
  surface?: LongJobSurface;
}

export interface LongJobSpec {
  version: 1;
  id: string;
  label: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxLogBytes: number;
  statusPath: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  startGatePath: string;
  stopRequestPath: string;
}

export interface LongJobMilestone {
  sequence: number;
  kind: LongJobMilestoneKind;
  ts: number;
  item?: string;
  current?: number;
  total?: number;
  message?: string;
}

export interface StorageOptions {
  jobsRoot?: string;
}
