import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface LongJobsConfig {
  pollIntervalMs: number;
  historyLimit: number;
  inactivityAfterMs: number;
  reportMinimumIntervalMs: number;
  maxLogBytes: number;
  preferHerdr: boolean;
}

export const DEFAULT_LONG_JOBS_CONFIG: LongJobsConfig = {
  pollIntervalMs: 1_000,
  historyLimit: 20,
  inactivityAfterMs: 10 * 60_000,
  reportMinimumIntervalMs: 5 * 60_000,
  maxLogBytes: 100 * 1024 * 1024,
  preferHerdr: true,
};

const ALLOWED_FIELDS = new Set(Object.keys(DEFAULT_LONG_JOBS_CONFIG));

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

export async function loadLongJobsConfig(filePath = path.join(homedir(), ".pi", "agent", "extensions", "long-jobs", "config.json")): Promise<LongJobsConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_LONG_JOBS_CONFIG };
    throw error;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("pi-long-jobs config must be a JSON object.");
  const unknown = Object.keys(parsed).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown pi-long-jobs config fields: ${unknown.join(", ")}.`);
  if (parsed.preferHerdr !== undefined && typeof parsed.preferHerdr !== "boolean") throw new Error("preferHerdr must be a boolean.");
  return {
    pollIntervalMs: parsed.pollIntervalMs === undefined ? DEFAULT_LONG_JOBS_CONFIG.pollIntervalMs : integer(parsed.pollIntervalMs, "pollIntervalMs", 250, 60_000),
    historyLimit: parsed.historyLimit === undefined ? DEFAULT_LONG_JOBS_CONFIG.historyLimit : integer(parsed.historyLimit, "historyLimit", 1, 20),
    inactivityAfterMs: parsed.inactivityAfterMs === undefined ? DEFAULT_LONG_JOBS_CONFIG.inactivityAfterMs : integer(parsed.inactivityAfterMs, "inactivityAfterMs", 10_000, 86_400_000),
    reportMinimumIntervalMs: parsed.reportMinimumIntervalMs === undefined ? DEFAULT_LONG_JOBS_CONFIG.reportMinimumIntervalMs : integer(parsed.reportMinimumIntervalMs, "reportMinimumIntervalMs", 0, 86_400_000),
    maxLogBytes: parsed.maxLogBytes === undefined ? DEFAULT_LONG_JOBS_CONFIG.maxLogBytes : integer(parsed.maxLogBytes, "maxLogBytes", 1_048_576, 1_073_741_824),
    preferHerdr: parsed.preferHerdr ?? DEFAULT_LONG_JOBS_CONFIG.preferHerdr,
  };
}
