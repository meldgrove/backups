import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backups/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { resetConfigForTests } from "../config";
import { listSnapshots, SELF_TAG } from "../restic/restic";
import { openRepository } from "../target/target";
import { createUser, request, resetDatabase, setUpTarget } from "../test/helpers";
import { claimNextRun, executeNext, pgEnv } from "./execute";
import { AGENT_PICKUP_MS, expireAgentRuns, planRuns } from "./scheduler";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("the worker", () => {
  beforeAll(async () => {
    // A stand-in for pg_dump: the plumbing (restic --stdin-from-command, libpq's
    // settings in the environment) is what this test checks.
    const directory = await mkdtemp(path.join(os.tmpdir(), "backups-pgdump-"));
    const script = path.join(directory, "pg_dump");
    await writeFile(script, '#!/bin/sh\nprintf "dump of %s as %s\\n" "$PGDATABASE" "$PGUSER"\n');
    await chmod(script, 0o755);
    process.env.PG_DUMP_BINARY = script;
    resetConfigForTests();
  });
  afterAll(() => {
    delete process.env.PG_DUMP_BINARY;
    resetConfigForTests();
  });
  beforeEach(resetDatabase);

  it("plans a backup when its time comes, once", async () => {
    const admin = await createUser();
    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Logbook",
        schedule: { type: "hourly", every: 1, minute: 0 },
        retention: DEFAULT_RETENTION,
      },
    });
    const id = created.body.source.id as string;
    const next = new Date(created.body.source.nextRunAt as string);
    await planRuns(getDb(), new Date(next.getTime() - 1000));
    expect(await getDb().select().from(runs)).toHaveLength(0);
    await planRuns(getDb(), new Date(next.getTime() + 1000));
    await planRuns(getDb(), new Date(next.getTime() + 2000));
    const planned = await getDb().select().from(runs).where(eq(runs.kind, "backup"));
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ sourceId: id, status: "queued", trigger: "schedule" });
    const [source] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(source!.nextRunAt!.getTime()).toBe(next.getTime() + 3_600_000);

    // The worker never takes an app's job: that is the agent's.
    expect(await claimNextRun(getDb())).toBeNull();
    await expireAgentRuns(getDb(), new Date(Date.now() + AGENT_PICKUP_MS + 60_000));
    const [expired] = await getDb().select().from(runs).where(eq(runs.id, planned[0]!.id));
    expect(expired!.status).toBe("failed");
    expect(expired!.error).toMatch(/did not ask for the job/);
  });

  it("backs up its own database, then runs the upkeep", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const started = await request("POST", "/api/v1/maintenance/run", { userId: admin.id, body: {} });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: "maintenance", status: "queued" });

    expect(await executeNext(getDb())).toBe(true);
    const [self] = await getDb().select().from(runs).where(eq(runs.kind, "self"));
    expect(self).toMatchObject({ status: "succeeded" });
    const repository = await openRepository(getDb());
    const snapshots = await listSnapshots(repository, SELF_TAG);
    expect(snapshots).toHaveLength(1);

    expect(await executeNext(getDb())).toBe(true);
    const [upkeep] = await getDb().select().from(runs).where(eq(runs.kind, "maintenance"));
    expect(upkeep!.error).toBeNull();
    expect(upkeep!.status).toBe("succeeded");
    expect(upkeep!.log.join("\n")).toMatch(/Upkeep done/);
    const target = await request("GET", "/api/v1/target", { userId: admin.id });
    expect(target.body.lastCheck).toMatchObject({ ok: true });
    expect(target.body.stats.snapshots).toBe(1);
    expect(target.body.stats.storedBytes).toBeGreaterThan(0);

    const dashboard = await request("GET", "/api/v1/dashboard", { userId: admin.id });
    expect(dashboard.body.selfBackup).toMatchObject({ status: "succeeded", sourceName: "Meldgrove Backups" });
    expect(dashboard.body.maintenance).toMatchObject({
      status: "succeeded",
      sourceName: "Repository upkeep",
    });
    expect(dashboard.body.attention.map((item: { message: string }) => item.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/recovery kit/)]),
    );
  });

  it("ends a run that was left running, so the next ones start", async () => {
    // As after a database outage at the end of a run: its end was never saved.
    const [stuck] = await getDb()
      .insert(runs)
      .values({ kind: "self", sourceId: null, trigger: "schedule", status: "running", startedAt: new Date() })
      .returning();
    await getDb().insert(runs).values({ kind: "maintenance", sourceId: null, trigger: "schedule" });

    expect(await executeNext(getDb())).toBe(true);
    const [self] = await getDb().select().from(runs).where(eq(runs.id, stuck!.id));
    expect(self).toMatchObject({ status: "failed", error: expect.stringMatching(/could not be saved/) });
    // The upkeep was claimed (it fails here for lack of a target).
    const [upkeep] = await getDb().select().from(runs).where(eq(runs.kind, "maintenance"));
    expect(upkeep!.status).toBe("failed");
    expect(upkeep!.error).toMatch(/Set up the target/);
  });

  it("passes the database settings to pg_dump in the environment, decoded", () => {
    expect(pgEnv("postgres://back%40ups:p%40ss%3Aword@db.example.org:6543/my_db?sslmode=require")).toEqual({
      PGHOST: "db.example.org",
      PGPORT: "6543",
      PGUSER: "back@ups",
      PGPASSWORD: "p@ss:word",
      PGDATABASE: "my_db",
      PGSSLMODE: "require",
    });
  });
});
