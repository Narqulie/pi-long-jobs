# pi-long-jobs engineering notes

## Purpose

`pi-long-jobs` supervises shell commands that are expected to run for minutes or hours without blocking the parent Pi turn. It owns process execution, durable logs/status, cancellation, and progress parsing. It publishes jobs through the single `pi-subagents/work-provider` contract; it must not spawn agents, inject chat directly, or duplicate FleetView.

## Invariants

- `src/worker.mjs` is the normal `status.json` lifecycle writer. The runtime reconciler may write one fail-closed terminal transition only after re-reading status and proving that no recorded worker process remains alive. Control requests use monotonic sidecars such as `stop.request`.
- Persisted job paths are recomputed from the validated job ID before use.
- A stop targets the detached command process group, not only its shell parent.
- Work-provider registration and cached records are removed on session disposal, including disposal racing an in-flight refresh.
- Output parsing and persisted logs remain bounded. Progress parsing continues after log truncation.
- Jobs are scoped to the Pi session that started them. Cross-session adoption is not implicit.

## Validation

```bash
npm run check           # TypeScript + all deterministic tests
npm audit --omit=dev    # production dependency audit
npm pack --dry-run      # package-content check
```

Use a fresh Pi RPC process with both local extensions for a load smoke test:

```bash
printf '%s\n' '{"type":"get_commands"}' '{"type":"abort"}' \
  | pi --mode rpc --no-session -ne \
      -e ~/Developer/pi-subagents/index.ts \
      -e ~/Developer/pi-long-jobs/src/index.ts
```
