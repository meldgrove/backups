import { DEFAULT_RETENTION } from "@backups/shared/api/schedule";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { sources, type runs } from "../db/schema";
import { readSetting, updateSetting, writeSetting } from "../core/settings";
import { appendLog, type RunOutcome } from "../runs/service";
import {
  checkRepository,
  forgetByPolicy,
  forgetSnapshots,
  listSnapshots,
  prune,
  repositoryStats,
  SELF_TAG,
  sourceTag,
  type Repository,
} from "../restic/restic";
import { REPOSITORY_KEY, testTarget, type RepositoryHealth } from "../target/target";

type RunRow = typeof runs.$inferSelect;

/** Tags of deleted sources whose snapshots the next upkeep forgets. */
const FORGET_KEY = "forget_tags";

export async function queueForget(db: DbOrTx, tag: string) {
  await updateSetting<string[]>(db, FORGET_KEY, (tags) => [...new Set([...(tags ?? []), tag])]);
}

/** Forgets the snapshots of deleted sources (`queueForget`); a tag stays queued until that worked. */
export async function forgetDeletedSources(db: DbOrTx, repository: Repository, signal?: AbortSignal) {
  const problems: string[] = [];
  for (const tag of (await readSetting<string[]>(db, FORGET_KEY)) ?? []) {
    try {
      const snapshots = await listSnapshots(repository, tag);
      await forgetSnapshots(
        repository,
        snapshots.map((item) => item.id),
        signal,
      );
      await updateSetting<string[]>(db, FORGET_KEY, (tags) => (tags ?? []).filter((item) => item !== tag));
    } catch (error) {
      problems.push(`Forgetting the snapshots of a deleted source: ${(error as Error).message}`);
    }
  }
  return problems;
}

/** Share of the data read and verified by the weekly check (Sundays); other days check the structure only. */
export const WEEKLY_READ_DATA = "5%";

function isSunday(now: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: config().TZ }).format(now) === "Sun";
}

/**
 * The repository's daily upkeep: each source's retention (and this app's
 * own), prune, an integrity check (on Sundays it also reads a share of the
 * data), the size, and the bucket's protection settings.
 */
export async function runMaintenance(
  db: Db,
  run: RunRow,
  repository: Repository,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const log = (line: string) => appendLog(db, run.id, line);
  const problems: string[] = [];
  const warnings: string[] = [];

  problems.push(...(await forgetDeletedSources(db, repository, signal)));
  signal.throwIfAborted();

  const all = await db
    .select({ id: sources.id, name: sources.name, retention: sources.retention })
    .from(sources);
  await log(`Applying retention to ${all.length} source(s) and this app's own backups`);
  for (const source of [...all, { id: null, name: "this app", retention: DEFAULT_RETENTION }]) {
    try {
      await forgetByPolicy(repository, {
        tag: source.id ? sourceTag(source.id) : SELF_TAG,
        retention: source.retention,
        signal,
      });
    } catch (error) {
      problems.push(`Retention of ${source.name}: ${(error as Error).message}`);
    }
  }
  signal.throwIfAborted();

  await log("Removing data no snapshot uses (prune)");
  try {
    await prune(repository, signal);
  } catch (error) {
    problems.push((error as Error).message);
  }
  signal.throwIfAborted();

  const readData = isSunday(new Date()) ? WEEKLY_READ_DATA : null;
  await log(
    readData ? `Checking the repository and reading ${readData} of its data` : "Checking the repository",
  );
  const check = await checkRepository(repository, { readData: readData ?? undefined, signal });
  if (!check.ok) problems.push(`Integrity check: ${check.message ?? "failed"}`);
  signal.throwIfAborted();

  const health: RepositoryHealth = {
    stats: null,
    lastCheck: { at: new Date().toISOString(), ok: check.ok, readData, message: check.message },
  };
  try {
    health.stats = { checkedAt: new Date().toISOString(), ...(await repositoryStats(repository, signal)) };
  } catch (error) {
    warnings.push((error as Error).message);
  }
  await writeSetting(db, REPOSITORY_KEY, health);

  try {
    await testTarget(db);
  } catch (error) {
    warnings.push(`Bucket settings: ${(error as Error).message}`);
  }

  if (problems.length > 0) {
    await appendLog(db, run.id, ...problems);
    return { status: "failed", error: problems[0]!, warnings: [...problems.slice(1), ...warnings] };
  }
  await log("Upkeep done");
  return { status: warnings.length > 0 ? "warning" : "succeeded", snapshotId: null, stats: null, warnings };
}
