// Wire-only copy of the public pi-subagents/work-provider v1 contract. Importing a
// nested pi-subagents package here would create competing extension installations;
// the versioned Symbol.for registry and events are the shared runtime boundary.
export const WORK_PROVIDER_PROTOCOL_VERSION = 1;
export const WORK_PROVIDER_REGISTRY_KEY = "pi-subagents.work-providers.v1";
export const WORK_PROVIDER_CHANGED_EVENT = "subagents:work:v1:changed";
export const WORK_PROVIDER_ATTENTION_EVENT = "subagents:work:v1:attention";

export type WorkItemState = "queued" | "running" | "blocked" | "completed" | "failed" | "stopped";

export interface WorkItem {
  id: string;
  parentId?: string;
  sessionId: string;
  kind: "command";
  label: string;
  state: WorkItemState;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  currentAction?: string;
  preview?: string;
  reportPath?: string;
  transcriptPath?: string;
  progress?: { completed: number; total?: number };
  attention?: { id: string; kind: "failure" | "inactivity" | "blocked"; message: string; since: number };
}

export interface WorkProvider {
  name: string;
  snapshot(context: { sessionId: string; nowMs: number }): { items: readonly WorkItem[]; total: number };
  reconcile?(context: { sessionId: string; nowMs: number }): void;
}

interface WorkProviderRegistry {
  version: typeof WORK_PROVIDER_PROTOCOL_VERSION;
  providers: Map<string, WorkProvider>;
}

function registry(): WorkProviderRegistry {
  const key = Symbol.for(WORK_PROVIDER_REGISTRY_KEY);
  const target = globalThis as Record<PropertyKey, unknown>;
  const existing = target[key];
  if (existing === undefined) {
    const created: WorkProviderRegistry = { version: WORK_PROVIDER_PROTOCOL_VERSION, providers: new Map() };
    target[key] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("Malformed pi-subagents work-provider registry.");
  const candidate = existing as Partial<WorkProviderRegistry>;
  if (candidate.version !== WORK_PROVIDER_PROTOCOL_VERSION || !(candidate.providers instanceof Map)) throw new Error("Unsupported pi-subagents work-provider registry version.");
  return candidate as WorkProviderRegistry;
}

export function registerWorkProvider(provider: WorkProvider): () => void {
  const current = registry();
  current.providers.set(provider.name, provider);
  return () => {
    if (current.providers.get(provider.name) === provider) current.providers.delete(provider.name);
  };
}
