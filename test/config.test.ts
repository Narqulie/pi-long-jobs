import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_LONG_JOBS_CONFIG, loadLongJobsConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configFile(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-long-jobs-config-"));
  roots.push(root);
  const file = path.join(root, "config.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

describe("long-job configuration", () => {
  it("defaults to direct execution so FleetView remains the primary surface", async () => {
    const config = await loadLongJobsConfig(await configFile({}));
    assert.equal(config.preferHerdr, false);
    assert.equal(config.preferHerdr, DEFAULT_LONG_JOBS_CONFIG.preferHerdr);
  });

  it("uses a bounded 100 MiB default for each persisted log", async () => {
    const config = await loadLongJobsConfig(await configFile({}));
    assert.equal(config.maxLogBytes, 100 * 1024 * 1024);
    assert.equal(config.maxLogBytes, DEFAULT_LONG_JOBS_CONFIG.maxLogBytes);
  });

  it("rejects superseded chat-report configuration", async () => {
    await assert.rejects(
      loadLongJobsConfig(await configFile({ reportMinimumIntervalMs: 300_000 })),
      /Unknown pi-long-jobs config fields: reportMinimumIntervalMs/,
    );
  });

  it("rejects log bounds below one MiB", async () => {
    await assert.rejects(
      loadLongJobsConfig(await configFile({ maxLogBytes: 1024 })),
      /maxLogBytes must be an integer from 1048576 through 1073741824/,
    );
  });
});
