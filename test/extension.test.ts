import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import longJobsExtension from "../src/index.ts";
import { waitForTerminalJob } from "../src/runtime.ts";

describe("Pi extension integration", () => {
  it("registers its surface and starts a job without a model turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-extension-"));
    const previousRoot = process.env.PI_LONG_JOBS_DIR;
    process.env.PI_LONG_JOBS_DIR = root;
    const events = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const commands = new Set<string>();
    const entries: unknown[] = [];
    const pi = {
      on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string) => commands.add(name),
      registerEntryRenderer: () => {},
      appendEntry: (_type: string, data: unknown) => entries.push(data),
      sendMessage: () => {},
      events: { emit: () => {} },
    };
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionFile: () => path.join(root, "session.jsonl"),
        getSessionId: () => "session-fallback",
      },
      ui: {
        setStatus: () => {},
        notify: () => {},
      },
    };

    try {
      longJobsExtension(pi as any);
      assert.ok(tools.has("long_job"));
      assert.deepEqual([...commands].sort(), ["jobs", "jobs-stop"]);
      await events.get("session_start")?.({}, ctx);
      const tool = tools.get("long_job");
      const before = Date.now();
      const result = await tool.execute("call-1", {
        action: "start",
        label: "Extension probe",
        command: "printf 'PI_JOB_PROGRESS {\"event\":\"completed_item\",\"item\":\"one\",\"current\":1,\"total\":1}\\n'",
        surface: "direct",
      }, undefined, undefined, ctx);
      assert.ok(Date.now() - before < 500, "tool start should return promptly");
      const id = result.details.id as string;
      const terminal = await waitForTerminalJob(id, { jobsRoot: root, timeoutMs: 5_000 });
      assert.equal(terminal.state, "completed");
      assert.ok(entries.length >= 1);
      const status = await tool.execute("call-2", { action: "status", id }, undefined, undefined, ctx);
      assert.match(status.content[0].text, /Extension probe · completed/);
      await events.get("session_shutdown")?.({}, ctx);
    } finally {
      if (previousRoot === undefined) delete process.env.PI_LONG_JOBS_DIR;
      else process.env.PI_LONG_JOBS_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
