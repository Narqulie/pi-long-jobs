import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { LongJobBridge } from "./bridge.ts";
import { loadLongJobsConfig, type LongJobsConfig } from "./config.ts";
import { redactWorkText } from "./fleet.ts";
import type { LongJobMilestone, LongJobRecord, LongJobSurface } from "./model.ts";
import { startJob, stopJob } from "./runtime.ts";
import { listJobs, readJob, removeJob } from "./storage.ts";
import { WORK_PROVIDER_ATTENTION_EVENT, WORK_PROVIDER_CHANGED_EVENT, WORK_PROVIDER_PROTOCOL_VERSION } from "./work-provider.ts";

const LongJobParams = Type.Object({
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("status"),
    Type.Literal("list"),
    Type.Literal("stop"),
    Type.Literal("forget"),
  ]),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 1_048_576 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  totalItems: Type.Optional(Type.Integer({ minimum: 1 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  surface: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("herdr"), Type.Literal("direct")])),
}, { additionalProperties: false });

type LongJobInput = Static<typeof LongJobParams>;

function sessionId(ctx: ExtensionContext): string {
  const id = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  if (!id) throw new Error("Current Pi session identity is unavailable.");
  return id;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function milestoneText(job: LongJobRecord, milestone: LongJobMilestone): string {
  const count = milestone.current !== undefined
    ? milestone.total !== undefined ? `${milestone.current}/${milestone.total}` : `${milestone.current}`
    : undefined;
  const item = milestone.item ?? job.progress.item;
  const subject = [count, item].filter(Boolean).join(" · ");
  switch (milestone.kind) {
    case "started_item": return `${job.label}: started ${subject || "next item"}`;
    case "completed_item": return `${job.label}: completed ${subject || "item"}`;
    case "failed_item": return `${job.label}: failed ${subject || "item"}${milestone.message ? ` · ${milestone.message}` : ""}`;
    case "progress": return `${job.label}: ${job.progress.currentAction}`;
    case "terminal": return `${job.label}: ${job.state}${job.failure ? ` · ${job.failure}` : job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""}`;
  }
}

function jobSummary(job: LongJobRecord, now = Date.now()): string {
  const elapsed = duration((job.endedAt ?? now) - job.startedAt);
  const progress = job.progress.currentAction;
  const outputAge = job.lastOutputAt === undefined ? "no output yet" : `output ${duration(now - job.lastOutputAt)} ago`;
  const location = job.paneId ? `pane ${job.paneId}` : `pid ${job.commandPid ?? job.workerPid ?? "pending"}`;
  return `${job.label} · ${job.state} · ${elapsed}\n${progress} · ${outputAge} · ${location}\nID: ${job.id}\nstdout: ${job.stdoutPath}\nstderr: ${job.stderrPath}\nevents: ${job.eventsPath}`;
}

function visibleJobs(jobs: readonly LongJobRecord[], historyLimit: number): LongJobRecord[] {
  const active = jobs.filter((job) => job.state === "queued" || job.state === "running");
  const terminal = jobs.filter((job) => job.state !== "queued" && job.state !== "running").slice(0, historyLimit);
  return [...active, ...terminal];
}

function toolResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function longJobsExtension(pi: ExtensionAPI): void {
  let bridge: LongJobBridge | undefined;
  let config: LongJobsConfig | undefined;
  let currentContext: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let refreshing = false;
  let sessionGeneration = 0;

  const sendAttention = (job: LongJobRecord, milestone: LongJobMilestone) => {
    pi.events.emit(WORK_PROVIDER_ATTENTION_EVENT, {
      version: WORK_PROVIDER_PROTOCOL_VERSION,
      provider: "pi-long-jobs",
      id: job.id,
      sessionId: job.ownerSessionId,
      eventId: `${job.id}:${milestone.kind}:${milestone.sequence}`,
      kind: "failure",
      message: redactWorkText(milestoneText(job, milestone)),
      observedAt: milestone.ts,
    });
  };

  const sendInactivity = (job: LongJobRecord, inactiveForMs: number) => {
    const observedAt = Date.now();
    pi.events.emit(WORK_PROVIDER_ATTENTION_EVENT, {
      version: WORK_PROVIDER_PROTOCOL_VERSION,
      provider: "pi-long-jobs",
      id: job.id,
      sessionId: job.ownerSessionId,
      eventId: `${job.id}:inactivity:${job.lastOutputAt ?? job.startedAt}`,
      kind: "inactivity",
      message: redactWorkText(`${job.label}: no output for ${duration(inactiveForMs)} while process remains ${job.state}`),
      observedAt,
    });
  };

  const refresh = async () => {
    if (!bridge || !currentContext || refreshing) return;
    const generation = sessionGeneration;
    const activeBridge = bridge;
    const context = currentContext;
    refreshing = true;
    try {
      await activeBridge.refresh();
    } catch (error) {
      if (sessionGeneration === generation) context.ui.setStatus("pi-long-jobs", `jobs ⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (sessionGeneration === generation) refreshing = false;
    }
  };

  const disposeSession = () => {
    sessionGeneration += 1;
    refreshing = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    bridge?.dispose();
    bridge = undefined;
    config = undefined;
    currentContext?.ui.setStatus("pi-long-jobs", undefined);
    currentContext = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    disposeSession();
    currentContext = ctx;
    try {
      config = await loadLongJobsConfig();
      bridge = new LongJobBridge({
        sessionId: sessionId(ctx),
        config,
        callbacks: {
          onAttention: sendAttention,
          onInactivity: sendInactivity,
          onChange: () => pi.events.emit(WORK_PROVIDER_CHANGED_EVENT, { sessionId: sessionId(ctx) }),
        },
      });
      bridge.start();
      await refresh();
      timer = setInterval(() => void refresh(), config.pollIntervalMs);
      timer.unref();
    } catch (error) {
      disposeSession();
      ctx.ui.notify(`pi-long-jobs disabled: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    disposeSession();
  });

  pi.registerTool({
    name: "long_job",
    label: "Long job",
    description: "Start and supervise shell commands expected to run for minutes or hours without blocking the main orchestrator. The job runs detached, persists logs and milestones, appears in pi-subagents FleetView, and wakes the parent only for failure or inactivity attention signals. Prefer this over bash for long-running batches. Actions: start, status, list, stop, forget.",
    parameters: LongJobParams,
    async execute(_toolCallId, input: LongJobInput, _signal, _onUpdate, ctx) {
      if (!config || !bridge) throw new Error("pi-long-jobs is not active for this session.");
      const ownerSessionId = sessionId(ctx);
      if (input.action === "start") {
        if (!input.label || !input.command) throw new Error("start requires label and command.");
        const surface: LongJobSurface = input.surface ?? (config.preferHerdr ? "auto" : "direct");
        const job = await startJob({
          label: input.label,
          command: input.command,
          cwd: input.cwd ?? ctx.cwd,
          ownerSessionId,
          ...(input.totalItems !== undefined ? { totalItems: input.totalItems } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          maxLogBytes: config.maxLogBytes,
          surface,
        });
        bridge.watch(job.id, 0);
        await refresh();
        return toolResult(`Started ${jobSummary(job)}\nThe orchestrator remains available.`, job);
      }
      if (input.action === "list") {
        const jobs = visibleJobs((await listJobs()).filter((job) => job.ownerSessionId === ownerSessionId), config.historyLimit);
        return toolResult(jobs.length ? jobs.map((job) => jobSummary(job)).join("\n\n") : "No long jobs for this session.", { jobs });
      }
      if (!input.id) throw new Error(`${input.action} requires id.`);
      const job = await readJob(input.id);
      if (job.ownerSessionId !== ownerSessionId) throw new Error(`Job '${input.id}' belongs to another Pi session.`);
      if (input.action === "status") return toolResult(jobSummary(job), job);
      if (input.action === "stop") {
        const stopped = await stopJob(job.id);
        await refresh();
        return toolResult(`Stop requested for ${stopped.label} (${stopped.id}).`, stopped);
      }
      await removeJob(job.id);
      await refresh();
      return toolResult(`Forgot terminal job ${job.label} (${job.id}).`);
    },
  });

  pi.registerCommand("jobs", {
    description: "Inspect current-session supervised long jobs",
    handler: async (_args, ctx) => {
      const jobs = visibleJobs((await listJobs()).filter((job) => job.ownerSessionId === sessionId(ctx)), config?.historyLimit ?? 20);
      if (jobs.length === 0) {
        ctx.ui.notify("No long jobs for this session.", "info");
        return;
      }
      const labels = jobs.map((job) => `${job.state.padEnd(9)} ${job.label} · ${duration((job.endedAt ?? Date.now()) - job.startedAt)}`);
      const selected = await ctx.ui.select("Long jobs", labels);
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      if (index >= 0) ctx.ui.notify(jobSummary(jobs[index]!), jobs[index]!.state === "failed" || jobs[index]!.state === "timed_out" ? "error" : "info");
    },
  });

  pi.registerCommand("jobs-stop", {
    description: "Stop a current-session supervised long job",
    handler: async (_args, ctx) => {
      const jobs = (await listJobs()).filter((job) => job.ownerSessionId === sessionId(ctx) && (job.state === "queued" || job.state === "running"));
      if (jobs.length === 0) {
        ctx.ui.notify("No active long jobs for this session.", "info");
        return;
      }
      const labels = jobs.map((job) => `${job.label} · ${duration(Date.now() - job.startedAt)}`);
      const selected = await ctx.ui.select("Stop long job", labels);
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      if (index < 0) return;
      const job = jobs[index]!;
      if (!await ctx.ui.confirm("Stop long job?", `${job.label}\n${job.id}`)) return;
      await stopJob(job.id);
      await refresh();
      ctx.ui.notify(`Stop requested for ${job.label}.`, "warning");
    },
  });
}
