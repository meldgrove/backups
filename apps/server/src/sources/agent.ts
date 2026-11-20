import { createHash, type Hash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AgentComplete, AgentPoll, AgentPollAnswer } from "@backups/shared/api/agent";
import { config } from "../config";
import { getDb, type Db } from "../db/client";
import { runs, sources } from "../db/schema";
import { logger } from "../logger";
import { AppError } from "../http/errors";
import { sourceTag, startStreamBackup, type StreamBackup } from "../restic/restic";
import { openRepository } from "../target/target";
import { anyRunning, appendLog, finishRun, isCancelRequested } from "../runs/service";
import type { SourceRow } from "./service";

/*
 * The server side of the backup-agent protocol (meldgrove/backup-agent,
 * "Protocol"). The web process keeps one upload session per running app
 * backup: a restic process that reads the agent's stream from its input.
 * Parts arrive in order; restic's input closes only after `complete`
 * matched the totals, so an interrupted stream never becomes a snapshot.
 * Run a single web process: sessions live in its memory.
 */

/** No part or progress report for this long after pickup or the last part ends the upload. */
const INACTIVITY_MS = 60 * 60_000;

/** The file name of the stream in every snapshot of an app source. */
export const STREAM_FILENAME = "backup.tar";

type Session = {
  runId: string;
  sourceId: string;
  sourceName: string;
  backup: StreamBackup;
  nextPart: number;
  lastPartSha: string | null;
  total: Hash;
  bytes: number;
  timer: NodeJS.Timeout;
  /** `complete` arrived: restic finishes the snapshot. */
  finishing: boolean;
  /** Parts are handled one after another, also when a retry arrives while the first try is written. */
  queue: Promise<unknown>;
};

const sessions = new Map<string, Session>();
/** Totals of uploads that completed lately, so that a repeated `complete` (lost answer) gets 202 again. */
const completed = new Map<string, { sourceId: string; sha256: string }>();

export const jobEnded = (message = "The job ended on the server") => new AppError(410, "job_ended", message);

export function partBytes() {
  return config().AGENT_PART_MB * 1024 * 1024;
}

function endSession(session: Session) {
  clearTimeout(session.timer);
  sessions.delete(session.runId);
}

/** Stops an upload and ends its run (failed or cancelled) with `message`. */
async function abortSession(session: Session, status: "failed" | "cancelled", message: string) {
  endSession(session);
  session.backup.abort();
  await session.backup.ended.catch(() => undefined);
  await finishRun(getDb(), session.runId, { status, error: message });
  logger.info({ runId: session.runId, sourceId: session.sourceId, status }, "agent upload ended");
}

function armTimer(session: Session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    void abortSession(session, "failed", "The agent stopped sending: no part for 60 minutes").catch(
      (error: unknown) => logger.error({ err: error, runId: session.runId }, "could not end an idle upload"),
    );
  }, INACTIVITY_MS);
  session.timer.unref();
}

async function recordProgress(db: Db, session: Session) {
  await db
    .update(runs)
    .set({
      upload: { parts: session.nextPart, bytes: session.bytes, lastActivityAt: new Date().toISOString() },
    })
    .where(eq(runs.id, session.runId));
}

/** Claims the oldest queued backup of the source; null when there is none. */
async function claimJob(db: Db, sourceId: string) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.sourceId, sourceId), eq(runs.kind, "backup"), eq(runs.status, "queued")))
      .orderBy(asc(runs.queuedAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!run) return null;
    await tx
      .update(runs)
      .set({
        status: "running",
        startedAt: sql`now()`,
        upload: { parts: 0, bytes: 0, lastActivityAt: new Date().toISOString() },
      })
      .where(eq(runs.id, run.id));
    return run.id;
  });
}

/** `POST /poll`: records the agent's report and hands out the source's next job. */
export async function poll(db: Db, source: SourceRow, report: AgentPoll): Promise<AgentPollAnswer> {
  await db
    .update(sources)
    .set({
      agentLastSeenAt: sql`now()`,
      agentInfo: {
        version: report.agent.version,
        appName: report.app.name,
        appImage: report.app.image,
        database: report.database,
        volumes: [...report.volumes].sort(),
      },
    })
    .where(eq(sources.id, source.id));
  const answer: AgentPollAnswer = {
    source: { id: source.id, name: source.name },
    pollSeconds: config().AGENT_POLL_SECONDS,
    job: null,
  };
  // `backup-agent check` asks without taking a job.
  if (report.check) return answer;
  // An agent polls only when it is idle: an open upload of its source was abandoned (the agent restarted).
  for (const session of sessions.values()) {
    if (session.sourceId === source.id && !session.finishing) {
      await abortSession(session, "failed", "The agent restarted during the upload");
    }
  }
  if (await anyRunning(db, ["maintenance"])) return answer;
  const runId = await claimJob(db, source.id);
  if (!runId) return answer;
  try {
    const repository = await openRepository(db);
    const backup = await startStreamBackup(repository, {
      tag: sourceTag(source.id),
      filename: STREAM_FILENAME,
    });
    const session: Session = {
      runId,
      sourceId: source.id,
      sourceName: source.name,
      backup,
      nextPart: 0,
      lastPartSha: null,
      total: createHash("sha256"),
      bytes: 0,
      timer: setTimeout(() => undefined, 0),
      finishing: false,
      queue: Promise.resolve(),
    };
    sessions.set(runId, session);
    armTimer(session);
    await appendLog(db, runId, `The agent ${report.agent.version} picked up the job`);
    logger.info({ runId, sourceId: source.id }, "agent upload started");
    return { ...answer, job: { id: runId, partBytes: partBytes() } };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The backup could not start";
    logger.warn({ err: error, runId }, "agent upload could not start");
    await finishRun(db, runId, { status: "failed", error: message });
    return answer;
  }
}

function sessionOf(runId: string, source: SourceRow): Session {
  const session = sessions.get(runId);
  if (!session || session.sourceId !== source.id || session.finishing) throw jobEnded();
  return session;
}

/** `PUT /jobs/:id/parts/:n` */
export async function receivePart(
  db: Db,
  source: SourceRow,
  runId: string,
  part: number,
  sha256: string | undefined,
  body: Buffer,
): Promise<void> {
  const session = sessionOf(runId, source);
  const digest = createHash("sha256").update(body).digest("hex");
  if (!sha256 || sha256.toLowerCase() !== digest) {
    throw new AppError(422, "checksum_mismatch", "The part arrived damaged; send it again");
  }
  if (body.length > partBytes()) throw new AppError(413, "payload_too_large", "The part is too large");
  const handled = session.queue.then(() => storePart(db, session, part, digest, body));
  session.queue = handled.catch(() => undefined);
  await handled;
}

async function storePart(db: Db, session: Session, part: number, digest: string, body: Buffer) {
  if (!sessions.has(session.runId) || session.finishing) throw jobEnded();
  // The last part again (the agent retried after a timeout): stored already.
  if (part === session.nextPart - 1 && session.lastPartSha === digest) return;
  if (part !== session.nextPart) {
    throw new AppError(409, "out_of_order", `Expected part ${session.nextPart}`, undefined, {
      expected: session.nextPart,
    });
  }
  if (await isCancelRequested(db, session.runId)) {
    await abortSession(session, "cancelled", "Cancelled by an admin");
    throw jobEnded("The job was cancelled");
  }
  try {
    await session.backup.write(body);
  } catch (error) {
    await abortSession(session, "failed", error instanceof Error ? error.message : "restic stopped");
    throw jobEnded("The backup failed on the server");
  }
  session.total.update(body);
  session.bytes += body.length;
  session.nextPart += 1;
  session.lastPartSha = digest;
  armTimer(session);
  await recordProgress(db, session);
}

/** `POST /jobs/:id/complete`: answers at once; restic finishes the snapshot in the background. */
export async function completeJob(db: Db, source: SourceRow, runId: string, totals: AgentComplete) {
  const done = completed.get(runId);
  if (done && done.sourceId === source.id && done.sha256 === totals.sha256) return;
  const session = sessionOf(runId, source);
  await session.queue;
  if (!sessions.has(runId) || session.finishing) throw jobEnded();
  const digest = session.total.copy().digest("hex");
  if (totals.parts !== session.nextPart || totals.bytes !== session.bytes || totals.sha256 !== digest) {
    await abortSession(session, "failed", "The stream arrived incomplete (its totals do not match)");
    throw new AppError(422, "stream_mismatch", "The totals do not match what arrived");
  }
  session.finishing = true;
  clearTimeout(session.timer);
  completed.set(runId, { sourceId: source.id, sha256: digest });
  setTimeout(() => completed.delete(runId), 30 * 60_000).unref();
  void (async () => {
    try {
      const result = await session.backup.finish();
      const warnings = [
        ...totals.warnings,
        ...(result.incomplete ? ["restic could not read everything"] : []),
      ];
      await finishRun(db, runId, {
        status: warnings.length > 0 ? "warning" : "succeeded",
        snapshotId: result.snapshotId,
        stats: result.stats,
        warnings,
      });
      await appendLog(
        db,
        runId,
        `Snapshot ${result.snapshotId.slice(0, 8)} saved (${session.bytes} bytes received)`,
      );
      logger.info({ runId, sourceId: source.id }, "agent upload saved");
    } catch (error) {
      logger.warn({ err: error, runId }, "agent upload could not be saved");
      await finishRun(db, runId, {
        status: "failed",
        error: error instanceof Error ? error.message : "The snapshot could not be saved",
      });
    } finally {
      endSession(session);
    }
  })();
}

/** `POST /jobs/:id/progress`: the agent works on its stream (pg_dump) before the first part. */
export async function recordJobProgress(db: Db, source: SourceRow, runId: string) {
  const session = sessionOf(runId, source);
  if (await isCancelRequested(db, runId)) {
    await abortSession(session, "cancelled", "Cancelled by an admin");
    throw jobEnded("The job was cancelled");
  }
  armTimer(session);
  await recordProgress(db, session);
}

/** `POST /jobs/:id/fail`: the agent could not produce its stream. */
export async function failJob(db: Db, source: SourceRow, runId: string, message: string) {
  const session = sessions.get(runId);
  const text = `The agent reported: ${message.trim() || "an unknown error"}`;
  if (session && session.sourceId === source.id) {
    await abortSession(session, "failed", text);
    return;
  }
  // No session (e.g. after a restart of this app): end the run if it still counts as running.
  await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, error: text.slice(0, 1000) })
    .where(and(eq(runs.id, runId), eq(runs.sourceId, source.id), eq(runs.status, "running")));
}

/** Uploads that were running when this process started have no session any more. */
export async function failOrphanedUploads(db: Db) {
  const orphaned = await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, error: "Backups restarted during the upload" })
    .where(
      and(
        eq(runs.kind, "backup"),
        eq(runs.status, "running"),
        inArray(runs.sourceId, db.select({ id: sources.id }).from(sources).where(eq(sources.kind, "app"))),
      ),
    )
    .returning({ id: runs.id });
  if (orphaned.length > 0) logger.warn({ count: orphaned.length }, "uploads ended by a restart");
}

/** Ends every open upload (shutdown). */
export async function abortAllUploads(reason = "Backups stopped during the upload") {
  await Promise.allSettled([...sessions.values()].map((session) => abortSession(session, "failed", reason)));
}

/** Checks open uploads for cancellations by admins (every few seconds, from the web process). */
export async function sweepCancelledUploads(db: Db) {
  for (const session of [...sessions.values()]) {
    if (session.finishing) continue;
    if (await isCancelRequested(db, session.runId)) {
      await abortSession(session, "cancelled", "Cancelled by an admin");
    }
  }
}

/** Tests only. */
export function openUploadCount() {
  return sessions.size;
}
