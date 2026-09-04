# pi-long-jobs

`pi-long-jobs` supervises shell commands that run for minutes or hours without blocking the main Pi orchestrator.

It does **not** spawn agents and does not replace `pi-subagents`. It publishes process state through the single `pi-subagents/work-provider` contract, so FleetView, waiting, attention routing, and whole-machine Overview all observe the same lifecycle record while execution ownership remains here.

## Why

A normal Pi `bash` tool call blocks the orchestrator until the process exits. During a multi-hour batch, Pi cannot report milestones, inspect a stall, or do other work. `pi-long-jobs` starts the command in a detached worker, returns a durable job ID immediately, and projects progress into FleetView.

## Features

- Detached execution that survives the initiating assistant turn
- Direct background execution by default; visible Herdr raw panes are explicit opt-in
- Persisted status, stdout, stderr, and structured event history
- One work-provider projection for FleetView, waiting, attention, and whole-machine telemetry
- Every active job remains visible; `historyLimit` bounds terminal history only
- Detached-worker liveness reconciliation prevents immortal queued/running records
- Deterministic elapsed/output-age clocks without model-token use
- Failure and inactivity events routed and deduplicated by `pi-subagents`
- Normal milestones stay in FleetView instead of creating chat-message spam
- Process-group stop and timeout handling with SIGKILL escalation
- `/jobs` and `/jobs-stop` interactive commands
- `long_job` tool actions: `start`, `status`, `list`, `stop`, `forget`

## Install

Pin the GitHub release:

```bash
pi install git:github.com/Narqulie/pi-long-jobs@v0.3.0
```

For local development:

```bash
git clone https://github.com/Narqulie/pi-long-jobs.git ~/Developer/pi-long-jobs
cd ~/Developer/pi-long-jobs
npm install
npm run check
pi install ~/Developer/pi-long-jobs
```

Restart Pi after installation. A compatible `pi-subagents` build exposing the version 1 work-provider contract must also be enabled. The package intentionally publishes through Git rather than npm.

## Use

The model-facing tool is intended for commands expected to run longer than roughly two minutes:

```json
{
  "action": "start",
  "label": "Msplat 31-scene batch",
  "command": "python scripts/run_msplat_batch.py",
  "cwd": "/path/to/project",
  "totalItems": 31,
  "timeoutMs": 14400000
}
```

The call returns immediately with the job ID and artifact paths. Direct execution is the default so FleetView remains the primary interface. Pass `"surface": "herdr"` only when a separate visible terminal is useful. Use:

```text
/jobs                 inspect current-session jobs
/jobs-stop            select and stop an active job
/subagents-fleet      inspect agents and long jobs together
```

The model can call `long_job` with `status`, `list`, `stop`, or `forget`. `forget` is accepted only for terminal jobs.

## Progress protocol

### Generic line protocol

The worker recognizes the batch markers already used by the Msplat workflow:

```text
===== START erikamoi images=123 iterations=7000 =====
===== OK erikamoi exit=0 elapsed=510s =====
===== FAIL erikamoi reason=out-of-memory =====
```

`START`, `OK`, and `FAIL` create structured timeline events. `totalItems` supplies the denominator when it cannot be inferred from output.

### Structured protocol

Any command can emit a bounded JSON record prefixed with `PI_JOB_PROGRESS `:

```text
PI_JOB_PROGRESS {"event":"started_item","item":"erikamoi","current":2,"total":31,"message":"123 images"}
PI_JOB_PROGRESS {"event":"progress","item":"erikamoi","current":2,"total":31,"message":"optimizing"}
PI_JOB_PROGRESS {"event":"completed_item","item":"erikamoi","current":2,"total":31}
```

Supported events are `started_item`, `progress`, `completed_item`, and `failed_item`. FleetView's full inspector shows the eight most recent item states and durations; select the job row and press `Enter`. Untrusted labels and messages are stripped of control characters and length-bounded before they reach FleetView or model context.

Routine starts, progress updates, item completions, and successful terminal events remain deterministic Fleet state. They do not trigger model turns. A failed item, failed/timed-out terminal state, or inactivity threshold emits one stable attention event; `pi-subagents` deduplicates and steers that event into the owning main session.

## Persistence

Jobs are stored under:

```text
~/.pi/agent/pi-long-jobs/jobs/<job-id>/
├── spec.json
├── status.json
├── events.jsonl
├── stdout.log
├── stderr.log
├── start.gate
└── stop.request       # present only after a stop request
```

Directories are private (`0700`) and files are private (`0600`). Status writes use atomic rename. The monotonic `stop.request` file prevents a worker status write from erasing a concurrent stop request.

Set `PI_LONG_JOBS_DIR` to override the storage root, primarily for tests.

## Configuration

Copy `config.example.json` to:

```text
~/.pi/agent/extensions/long-jobs/config.json
```

Defaults:

```json
{
  "pollIntervalMs": 1000,
  "historyLimit": 20,
  "inactivityAfterMs": 600000,
  "maxLogBytes": 104857600,
  "preferHerdr": false
}
```

Unknown or invalid fields disable the extension visibly rather than being silently ignored.

## Architecture

```text
Pi tool/command
    │ starts
    ▼
detached worker ──► zsh process group
    │                   │
    │                   └── stdout/stderr
    ├── status.json
    ├── events.jsonl
    └── pi-subagents work-provider registry
            ├── compact and full FleetView
            ├── subagent_wait + headless auto-drain
            ├── deduplicated attention routing
            └── fleet RPC → whole-machine Overview
```

The extension owns process supervision only. `pi-subagents` remains authoritative for agent spawning, contracts, worktrees, lifecycle, steering, and transcripts.

## Operational constraints

- Commands run through `/bin/zsh -lc` with the invoking user's authority. This is not a sandbox.
- A detached job cannot be retrofitted onto an already-blocking `bash` call without interrupting that call.
- Main-session ownership is exact. A replacement Pi session can see artifacts on disk but cannot stop or forget another session's job through the model tool.
- Herdr is optional and never selected by default. `surface: "auto"` uses the configured preference and falls back to direct execution; `surface: "herdr"` fails if Herdr is unavailable.
- History remains on disk until explicitly forgotten. Automatic retention is intentionally deferred until its policy is defined.
- Each stdout/stderr log is capped at `maxLogBytes` (100 MiB by default); progress parsing continues after persisted log truncation.

## Validation

```bash
npm run typecheck
npm test
npm run check
```
