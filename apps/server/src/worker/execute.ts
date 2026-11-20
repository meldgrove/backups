import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { runs, sources } from "../db/schema";
import { logger } from "../logger";
import {
  appendLog,
  anyRunning,
  finishRun,
  isCancelRequested,
  lockClaims,
  type RunOutcome,
} from "../runs/service";
import { backupCommandOutput, backupDirectory, SELF_TAG, sourceTag, type Repository } from "../restic/restic";
import { openRepository } from "../target/target";
import { copyDrive, stagingDir } from "../sources/google-drive";
import { exportPersonio } from "../sources/personio";
import { getSourceRow } from "../sources/service";
import { runMaintenance } from "./maintenance";

type RunRow = typeof runs.$inferSelect;

/** Kinds of source the worker backs up itself (app sources are backed up by their agent). */
const LOCAL_KINDS = ["google_drive", "personio"];

/**
 * Claims the next run the worker executes: the oldest queued Google Drive
 * or Personio backup, this app's own backup, or the upkeep. The upkeep
 * waits while any backup runs (it needs the repository to itself).
 */
export async function claimNextRun(db: Db): Promise<RunRow | null> {
  return db.transaction(async (tx) => {
    await lockClaims(tx);
    const backupsRunning = await anyRunning(tx, ["backup", "self"]);
    const localSources = tx
      .select({ id: sources.id })
      .from(sources)
      .where(inArray(sources.kind, LOCAL_KINDS));
    const [run] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.status, "queued"),
          sql`(
            (${runs.kind} = 'backup' and ${runs.sourceId} in ${localSources})
            or ${runs.kind} = 'self'
            ${backupsRunning ? sql`` : sql`or ${runs.kind} = 'maintenance'`}
          )`,
        ),
      )
      .orderBy(asc(runs.queuedAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!run) return null;
    const [started] = await tx
      .update(runs)
      .set({ status: "running", startedAt: sql`now()` })
      .where(eq(runs.id, run.id))
      .returning();
    return started ?? null;
  });
}

/** Runs that were running when the worker started have lost their process. */
export async function failInterruptedRuns(db: Db) {
  const localSources = db.select({ id: sources.id }).from(sources).where(inArray(sources.kind, LOCAL_KINDS));
  const interrupted = await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, error: "The worker restarted during the run" })
    .where(
      and(
        eq(runs.status, "running"),
        sql`(${runs.kind} in ('self', 'maintenance') or (${runs.kind} = 'backup' and ${runs.sourceId} in ${localSources}))`,
      ),
    )
    .returning({ id: runs.id });
  if (interrupted.length > 0) logger.warn({ count: interrupted.length }, "runs ended by a worker restart");
}

/** libpq's settings from a database URL, so that the password never appears in pg_dump's arguments. */
export function pgEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

async function backupSource(
  db: Db,
  run: RunRow,
  repository: Repository,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const source = await getSourceRow(db, run.sourceId!);
  const log = (line: string) => appendLog(db, run.id, line);
  const copied =
    source.kind === "google_drive"
      ? await copyDrive(source, { signal, log })
      : await exportPersonio(source, { signal, log });
  if (copied.errors.length > 0) await appendLog(db, run.id, ...copied.errors.slice(0, 100));
  await log("Saving the snapshot");
  const result = await backupDirectory(repository, {
    tag: sourceTag(source.id),
    directory: stagingDir(source.id),
    signal,
  });
  if (result.errors.length > 0) await appendLog(db, run.id, ...result.errors.slice(0, 50));
  const warnings = [
    ...copied.warnings,
    ...(result.incomplete ? ["Some files of the local copy could not be read"] : []),
  ];
  await log(`Snapshot ${result.snapshotId.slice(0, 8)} saved`);
  return {
    status: warnings.length > 0 ? "warning" : "succeeded",
    snapshotId: result.snapshotId,
    stats: result.stats,
    warnings,
  };
}

async function backupSelf(
  db: Db,
  run: RunRow,
  repository: Repository,
  signal: AbortSignal,
): Promise<RunOutcome> {
  await appendLog(db, run.id, "Dumping this app's database");
  const result = await backupCommandOutput(repository, {
    tag: SELF_TAG,
    filename: "backups.dump",
    command: [config().PG_DUMP_BINARY, "--format=custom", "--compress=0"],
    env: pgEnv(config().DATABASE_URL),
    signal,
  });
  await appendLog(db, run.id, `Snapshot ${result.snapshotId.slice(0, 8)} saved`);
  return { status: "succeeded", snapshotId: result.snapshotId, stats: result.stats, warnings: [] };
}

/** Executes a claimed run to its end; an admin's cancellation stops it within seconds. */
export async function executeRun(db: Db, run: RunRow) {
  const controller = new AbortController();
  const watcher = setInterval(() => {
    void isCancelRequested(db, run.id).then(
      (cancel) => cancel && controller.abort(),
      () => undefined,
    );
  }, 5_000);
  watcher.unref();
  let outcome: RunOutcome;
  try {
    const repository = await openRepository(db);
    if (run.kind === "maintenance") outcome = await runMaintenance(db, run, repository, controller.signal);
    else if (run.kind === "self") outcome = await backupSelf(db, run, repository, controller.signal);
    else outcome = await backupSource(db, run, repository, controller.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run failed";
    outcome = controller.signal.aborted
      ? { status: "cancelled", error: "Cancelled by an admin" }
      : { status: "failed", error: message };
    if (!controller.signal.aborted) logger.warn({ err: error, runId: run.id, code: run.kind }, "run failed");
  } finally {
    clearInterval(watcher);
  }
  await finishRun(db, run.id, outcome);
  logger.info({ runId: run.id, status: outcome.status, code: run.kind }, "run finished");
}

/** One step of the worker: claim and execute the next run, if any. */
export async function executeNext(db: Db): Promise<boolean> {
  const run = await claimNextRun(db);
  if (!run) return false;
  await executeRun(db, run);
  return true;
}
