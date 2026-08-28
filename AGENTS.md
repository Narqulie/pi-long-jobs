# pi-long-jobs engineering notes

## Purpose

`pi-long-jobs` supervises shell commands that are expected to run for minutes or hours without blocking the parent Pi turn. It owns process execution, durable logs/status, cancellation, and progress parsing. It projects jobs into `pi-subagents` only through the public `external-runs` and background-work APIs; it must not spawn agents or duplicate FleetView.

## Invariants

- `status.json` has one lifecycle writer: `src/worker.mjs`. Control requests use monotonic sidecar artifacts such as `stop.request`; do not introduce a second status writer.
- Persisted job paths are recomputed from the validated job ID before use.
- A stop targets the detached command process group, not only its shell parent.
- Background-provider and external-run registrations are removed on session disposal, including disposal racing an in-flight refresh.
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
