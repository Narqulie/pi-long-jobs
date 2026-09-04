import { projectJobForFleet, shouldNotifyOrchestrator } from "./fleet.ts";
import type { LongJobMilestone, LongJobRecord, StorageOptions } from "./model.ts";
import { reconcileJob } from "./runtime.ts";
import { listJobs, readMilestones } from "./storage.ts";
import { registerWorkProvider, type WorkItem } from "./work-provider.ts";

const WORK_PROVIDER_NAME = "pi-long-jobs";

export interface LongJobBridgeConfig {
  historyLimit: number;
  inactivityAfterMs: number;
}

export interface LongJobBridgeCallbacks {
  onAttention(job: LongJobRecord, milestone: LongJobMilestone): void;
  onInactivity(job: LongJobRecord, inactiveForMs: number): void;
  onChange(): void;
}

function active(job: LongJobRecord): boolean {
  return job.state === "queued" || job.state === "running";
}

export class LongJobBridge {
  readonly #sessionId: string;
  readonly #storage: StorageOptions;
  readonly #config: LongJobBridgeConfig;
  readonly #callbacks: LongJobBridgeCallbacks;
  readonly #seenSequences = new Map<string, number>();
  readonly #lastAttentionKind = new Map<string, LongJobMilestone["kind"]>();
  readonly #inactivityBasis = new Map<string, number>();
  #jobs = new Map<string, LongJobRecord>();
  #workItems = new Map<string, WorkItem>();
  #disposeWorkProvider: (() => void) | undefined;
  #started = false;
  #total = 0;
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
    this.#disposeWorkProvider = registerWorkProvider({
      name: WORK_PROVIDER_NAME,
      snapshot: ({ sessionId, nowMs }) => {
        if (sessionId !== this.#sessionId) return { items: [], total: 0 };
        return {
          items: [...this.#workItems.values()].map((item) => {
            const job = this.#jobs.get(item.id);
            if (!job || !active(job) || !this.#inactivityBasis.has(job.id)) return item;
            const basis = this.#inactivityBasis.get(job.id)!;
            return {
              ...item,
              attention: {
                id: `inactivity:${basis}`,
                kind: "inactivity",
                message: `No output for ${Math.max(0, nowMs - basis)}ms`,
                since: basis,
              },
            };
          }),
          total: this.#total,
        };
      },
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
    const owned = (await listJobs(this.#storage)).filter((job) => job.ownerSessionId === this.#sessionId);
    const sessionJobs = await Promise.all(owned.map((job) => reconcileJob(job, this.#storage, now)));
    if (!this.#started) return [];
    const selected = [
      ...sessionJobs.filter(active),
      ...sessionJobs.filter((job) => !active(job)).slice(0, this.#config.historyLimit),
    ];
    const nextIds = new Set(selected.map((job) => job.id));
    for (const id of this.#jobs.keys()) {
      if (nextIds.has(id)) continue;
      this.#seenSequences.delete(id);
      this.#lastAttentionKind.delete(id);
      this.#inactivityBasis.delete(id);
    }

    const workItems = new Map<string, WorkItem>();
    for (const job of selected) {
      if (!this.#started) return [];
      const milestones = await readMilestones(job);
      if (!this.#started) return [];
      this.#consumeMilestones(job, milestones);
      if (!this.#started) return [];
      this.#checkInactivity(job, now);
      workItems.set(job.id, projectJobForFleet(job, milestones, now));
    }

    const signature = JSON.stringify(selected.map((job) => [job.id, job.state, job.updatedAt, job.lastOutputAt, job.milestoneSequence, job.stopRequestedAt]));
    this.#total = sessionJobs.length;
    this.#jobs = new Map(selected.map((job) => [job.id, job]));
    this.#workItems = workItems;
    if (signature !== this.#changeSignature) {
      this.#changeSignature = signature;
      this.#callbacks.onChange();
    }
    return selected;
  }

  dispose(): void {
    this.#started = false;
    this.#disposeWorkProvider?.();
    this.#disposeWorkProvider = undefined;
    this.#jobs.clear();
    this.#workItems.clear();
    this.#seenSequences.clear();
    this.#lastAttentionKind.clear();
    this.#inactivityBasis.clear();
    this.#total = 0;
    this.#changeSignature = "";
  }

  #consumeMilestones(job: LongJobRecord, milestones: readonly LongJobMilestone[]): void {
    const seen = this.#seenSequences.get(job.id);
    if (seen === undefined) {
      this.#seenSequences.set(job.id, job.milestoneSequence);
      return;
    }
    let attention: LongJobMilestone | undefined;
    for (const milestone of milestones.filter((event) => event.sequence > seen).sort((a, b) => a.sequence - b.sequence)) {
      if (shouldNotifyOrchestrator(job, milestone)) attention = milestone;
      this.#seenSequences.set(job.id, milestone.sequence);
    }
    if (attention) {
      const previousKind = this.#lastAttentionKind.get(job.id);
      if (attention.kind !== "terminal" || previousKind !== "failed_item") this.#callbacks.onAttention(job, attention);
      this.#lastAttentionKind.set(job.id, attention.kind);
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
