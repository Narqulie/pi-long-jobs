const MAX_ITEM = 160;
const MAX_PHASE = 80;
const MAX_MESSAGE = 240;
const MAX_ACTION = 240;
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

function bounded(value, max) {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(ANSI_RE, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
  if (!safe) return undefined;
  return safe.slice(0, max);
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function action(progress) {
  const parts = [];
  if (progress.current !== undefined) parts.push(progress.total !== undefined ? `${progress.current}/${progress.total}` : `${progress.current}`);
  if (progress.item) parts.push(progress.item);
  if (progress.message) parts.push(progress.message);
  if (parts.length === 0 && progress.phase) parts.push(progress.phase);
  return (parts.join(" · ") || "Running command").slice(0, MAX_ACTION);
}

export function createProgressState(totalItems) {
  return {
    ...(positiveInt(totalItems) !== undefined ? { total: positiveInt(totalItems) } : {}),
    completed: 0,
    currentAction: "Starting process",
  };
}

export function applyProgressLine(previous, rawLine, now = Date.now()) {
  const line = bounded(rawLine, 8192);
  if (!line) return { state: previous };

  if (line.startsWith("PI_JOB_PROGRESS ")) {
    let payload;
    try {
      payload = JSON.parse(line.slice("PI_JOB_PROGRESS ".length));
    } catch {
      return { state: previous };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { state: previous };
    const current = positiveInt(payload.current) ?? previous.current;
    const total = positiveInt(payload.total) ?? previous.total;
    const item = bounded(payload.item, MAX_ITEM) ?? previous.item;
    const phase = bounded(payload.phase, MAX_PHASE) ?? previous.phase;
    const message = bounded(payload.message, MAX_MESSAGE) ?? previous.message;
    const next = {
      ...previous,
      ...(current !== undefined ? { current } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(item ? { item } : {}),
      ...(phase ? { phase } : {}),
      ...(message ? { message } : {}),
    };
    next.currentAction = action(next);
    return {
      state: next,
      milestone: { kind: "progress", ts: now, item, current, total, message },
    };
  }

  const started = /^=+\s*START\s+([^\s=]+)/i.exec(line);
  if (started) {
    const item = bounded(started[1], MAX_ITEM);
    const current = Math.max(previous.completed + 1, previous.current ?? 0, 1);
    const next = { ...previous, current, ...(item ? { item } : {}), message: undefined };
    next.currentAction = action(next);
    return {
      state: next,
      milestone: { kind: "started_item", ts: now, item, current, total: next.total },
    };
  }

  const completed = /^=+\s*OK\s+([^\s=]+)/i.exec(line);
  if (completed) {
    const item = bounded(completed[1], MAX_ITEM);
    const completedCount = Math.max(previous.completed + 1, previous.current ?? 0);
    const next = { ...previous, completed: completedCount, ...(item ? { item } : {}) };
    next.currentAction = action(next);
    return {
      state: next,
      milestone: { kind: "completed_item", ts: now, item, current: next.current, total: next.total, message: bounded(line, MAX_MESSAGE) },
    };
  }

  const failed = /^=+\s*FAIL(?:ED)?\s+([^\s=]+)/i.exec(line);
  if (failed) {
    const item = bounded(failed[1], MAX_ITEM);
    return {
      state: { ...previous, ...(item ? { item } : {}) },
      milestone: { kind: "failed_item", ts: now, item, current: previous.current, total: previous.total, message: bounded(line, MAX_MESSAGE) },
    };
  }

  return { state: previous };
}
