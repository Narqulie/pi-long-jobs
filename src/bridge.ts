import {
  registerExternalRun,
  unregisterExternalRun,
  updateExternalRun,
  type ExternalRun,
} from "pi-subagents/external-runs";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";

import { projectJobForFleet, shouldReportMilestone } from "./fleet.ts";
import type { LongJobMilestone, LongJobRecord, StorageOptions } from "./model.ts";
import { listJobs, readMilestones } from "./storage.ts";

export interface LongJobBridgeConfig {
  historyLimit: number;
  inactivityAfterMs: number;
  reportMinimumIntervalMs: number;
}

export interface LongJobBridgeCallbacks {
  onHistory(job: LongJobRecord, milestone: LongJobMilestone): void;
  onReport(job: LongJobRecord, milestone: LongJobMilestone): void;
  onInactivity(job: LongJobRecord, inactiveForMs: number): void;
  onChange(): void;
}

function active(job: LongJobRecord): boolean {
  return job.state === "queued" || job.state === "running";
}

function updateFields(run: ExternalRun): Omit<ExternalRun, "id" | "sessionId" | "source"> {
  const { id: _id, sessionId: _sessionId, source: _source, ...update } = run;
  return update;
}

export class LongJobBridge {
  readonly #sessionId: string;
  readonly #storage: StorageOptions;
  readonly #config: LongJobBridgeConfig;
  readonly #callbacks: LongJobBridgeCallbacks;
  readonly #registered = new Set<string>();
  readonly #seenSequences = new Map<string, number>();
  readonly #lastReportedAt = new Map<string, number>();
  readonly #inactivityBasis = new Map<string, number>();
  #jobs = new Map<string, LongJobRecord>();
  #disposeBackgroundProvider: (() => void) | undefined;
  #started = false;
  #changeSignature = "";

  constructor(input: {
    sessionId: string;
    storage?: StorageOptions;
    config: LongJobBridgeConfig;
    callbacks: LongJobBridgeCallbacks;
  }) {
    this.#sessionId = input.sessionId;
    this.#storage = input.storage ?? {};
    this.#config = input.config;
    this.#callbacks = input.callbacks;
  }

  start(): void {
    this.#started = true;
    this.#disposeBackgroundProvider = registerBackgroundWorkProvider({
      name: "pi-long-jobs",
      wakeChannels: ["pi-long-jobs:changed"],
      listActiveWork: () => [...this.#jobs.values()].filter(active).map((job) => ({ id: job.id, sessionId: job.ownerSessionId })),
    });
  }

  watch(id: string, sequence = 0): void {
    this.#seenSequences.set(id, sequence);
  }

  jobs(): readonly LongJobRecord[] {
    return [...this.#jobs.values()];
  }

  async refresh(now = Date.now()): Promise<readonly LongJobRecord[]> {
    if (!this.#started) return [];
    const sessionJobs = (await listJobs(this.#storage)).filter((job) => job.ownerSessionId === this.#sessionId);
    if (!this.#started) return [];
    const selected = [
      ...sessionJobs.filter(active),
      ...sessionJobs.filter((job) => !active(job)),
    ].slice(0, this.#config.historyLimit);
    const nextIds = new Set(selected.map((job) => job.id));

    for (const id of this.#registered) {
      if (nextIds.has(id)) continue;
      unregisterExternalRun(this.#sessionId, id);
      this.#registered.delete(id);
      this.#seenSequences.delete(id);
      this.#lastReportedAt.delete(id);
      this.#inactivityBasis.delete(id);
    }

    for (const job of selected) {
      if (!this.#started) return [];
      const projected = projectJobForFleet(job);
      if (this.#registered.has(job.id)) {
        updateExternalRun(this.#sessionId, job.id, updateFields(projected));
      } else {
        try {
          registerExternalRun(projected);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
          updateExternalRun(this.#sessionId, job.id, updateFields(projected));
        }
        this.#registered.add(job.id);
      }
      await this.#consumeMilestones(job);
      if (!this.#started) return [];
      this.#checkInactivity(job, now);
    }

    const signature = JSON.stringify(selected.map((job) => [job.id, job.state, job.updatedAt, job.lastOutputAt, job.milestoneSequence, job.stopRequestedAt]));
    this.#jobs = new Map(selected.map((job) => [job.id, job]));
    if (signature !== this.#changeSignature) {
      this.#changeSignature = signature;
      this.#callbacks.onChange();
    }
    return selected;
  }

  dispose(): void {
    this.#started = false;
    this.#disposeBackgroundProvider?.();
    this.#disposeBackgroundProvider = undefined;
    for (const id of this.#registered) unregisterExternalRun(this.#sessionId, id);
    this.#registered.clear();
    this.#jobs.clear();
    this.#seenSequences.clear();
    this.#lastReportedAt.clear();
    this.#inactivityBasis.clear();
    this.#changeSignature = "";
  }

  async #consumeMilestones(job: LongJobRecord): Promise<void> {
    const seen = this.#seenSequences.get(job.id);
    if (seen === undefined) {
      this.#seenSequences.set(job.id, job.milestoneSequence);
      return;
    }
    const milestones = (await readMilestones(job)).filter((event) => event.sequence > seen).sort((a, b) => a.sequence - b.sequence);
    if (!this.#started) return;
    let report: LongJobMilestone | undefined;
    const lastReportedAt = this.#lastReportedAt.get(job.id);
    for (const milestone of milestones) {
      this.#callbacks.onHistory(job, milestone);
      if (shouldReportMilestone(milestone, lastReportedAt, this.#config.reportMinimumIntervalMs)) report = milestone;
      this.#seenSequences.set(job.id, milestone.sequence);
    }
    if (report) {
      this.#callbacks.onReport(job, report);
      this.#lastReportedAt.set(job.id, report.ts);
    }
  }

  #checkInactivity(job: LongJobRecord, now: number): void {
    if (!active(job)) {
      this.#inactivityBasis.delete(job.id);
      return;
    }
    const basis = job.lastOutputAt ?? job.startedAt;
    const previousBasis = this.#inactivityBasis.get(job.id);
    if (previousBasis !== undefined && previousBasis !== basis) this.#inactivityBasis.delete(job.id);
    if (now - basis < this.#config.inactivityAfterMs || this.#inactivityBasis.has(job.id)) return;
    this.#inactivityBasis.set(job.id, basis);
    this.#callbacks.onInactivity(job, now - basis);
  }
}
