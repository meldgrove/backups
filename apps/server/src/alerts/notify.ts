import * as Sentry from "@sentry/node";
import nodemailer from "nodemailer";
import { eq, sql } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATIONS,
  type Notifications,
  type NotificationsInput,
} from "@backups/shared/api/notifications";
import type { notificationsInputSchema } from "@backups/shared/api/notifications";
import type { z } from "zod";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { sources } from "../db/schema";
import { logger } from "../logger";
import { decryptSecret, encryptSecret, secretHint } from "../core/crypto";
import { readSetting, writeSetting } from "../core/settings";
import { audit } from "../core/audit";
import type { UserPrincipal } from "../auth/principal";
import { latestRun } from "../runs/service";
import { listSourceRows, sourceViews } from "../sources/service";
import { PROBLEM_STATUSES } from "../sources/schedule";
import { readTarget } from "../target/target";

/*
 * Alerts: an email when a source's backup fails or is overdue (once per
 * problem) and, when wanted, when it is back to normal; the same for the
 * upkeep. The heartbeat URL is called every 15 minutes while all is well.
 */

export const NOTIFICATIONS_KEY = "notifications";
const HEARTBEAT_STATE_KEY = "heartbeat";
const SYSTEM_ALERT_KEY = "system_alert";
const HEARTBEAT_EVERY_MS = 15 * 60_000;

type StoredNotifications = Omit<Notifications, "heartbeat" | "email"> & {
  email: Omit<Notifications["email"], "passwordHint"> & { password: string | null };
};
type HeartbeatState = { at: string; ok: boolean; message: string | null };

async function stored(db: DbOrTx): Promise<StoredNotifications> {
  const value = await readSetting<StoredNotifications>(db, NOTIFICATIONS_KEY);
  if (value) return value;
  const { heartbeat: _heartbeat, email, ...rest } = DEFAULT_NOTIFICATIONS;
  const { passwordHint: _hint, ...emailRest } = email;
  return { ...rest, email: { ...emailRest, password: null } };
}

export async function notificationsView(db: DbOrTx): Promise<Notifications> {
  const value = await stored(db);
  const { password, ...email } = value.email;
  let hint: string | null = null;
  if (password) {
    try {
      hint = secretHint(decryptSecret(password));
    } catch {
      hint = "…";
    }
  }
  return {
    ...value,
    email: { ...email, passwordHint: hint },
    heartbeat: await readSetting<HeartbeatState>(db, HEARTBEAT_STATE_KEY),
  };
}

export async function saveNotifications(
  db: DbOrTx,
  input: z.output<typeof notificationsInputSchema>,
  actor: UserPrincipal,
) {
  const current = await stored(db);
  const { password, ...email } = input.email;
  const next: StoredNotifications = {
    heartbeatUrl: input.heartbeatUrl,
    notifyRecovery: input.notifyRecovery,
    email: { ...email, password: password ? encryptSecret(password) : current.email.password },
  };
  await writeSetting(db, NOTIFICATIONS_KEY, next);
  await audit(db, actor, {
    action: "notifications.update",
    entityType: "notifications",
    summary: "Changed the alerts",
  });
}

export type Mail = { subject: string; text: string };

/** Sends a mail to every recipient; throws a readable error. */
export async function sendMail(db: DbOrTx, mail: Mail, options: { evenWhenOff?: boolean } = {}) {
  const settings = (await stored(db)).email;
  if (!settings.enabled && !options.evenWhenOff) return;
  if (!settings.host || !settings.from || settings.recipients.length === 0) {
    throw new Error("Set the SMTP server, the sender and at least one recipient");
  }
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth: settings.username
      ? { user: settings.username, pass: settings.password ? decryptSecret(settings.password) : "" }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: settings.from,
      to: settings.recipients,
      subject: `[${config().APP_NAME}] ${mail.subject}`,
      text: `${mail.text}\n\n${config().APP_URL}\n`,
    });
  } catch (error) {
    const code =
      (error as { code?: string; responseCode?: number }).responseCode ?? (error as { code?: string }).code;
    throw new Error(`The mail server refused: ${code ?? (error as Error).message}`.slice(0, 300), {
      cause: error,
    });
  } finally {
    transport.close();
  }
}

/** Calls the heartbeat URL. */
export async function callHeartbeat(url: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    // The URL's path is its secret: no trace span (Sentry) records it.
    const response = await Sentry.suppressTracing(() =>
      fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000), redirect: "follow" }),
    );
    await response.body?.cancel();
    return response.ok ? { ok: true, message: null } : { ok: false, message: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      message:
        (error as { name?: string }).name === "TimeoutError"
          ? "No answer within 15 seconds"
          : "Not reachable",
    };
  }
}

const problemText = { failed: "failed", overdue: "is overdue" } as const;

/**
 * Compares each source's status with what the admins were last told and
 * sends what changed; calls the heartbeat while nothing is wrong.
 */
export async function checkAlerts(db: Db, now = new Date()) {
  const settings = await stored(db);
  const rows = await listSourceRows(db);
  const views = await sourceViews(db, rows, now);
  let healthy = true;
  for (const view of views) {
    const row = rows.find((item) => item.id === view.id)!;
    const problem =
      PROBLEM_STATUSES.includes(view.status) && view.enabled ? (view.status as "failed" | "overdue") : null;
    if (problem) healthy = false;
    if (problem && row.alertState !== problem) {
      const detail =
        problem === "failed"
          ? (view.lastRun?.error ?? "See the run in the app.")
          : `The last successful backup: ${view.lastSuccessAt ?? "never"}.`;
      await notify(db, row.id, problem, {
        subject: `Backup ${problemText[problem]}: ${view.name}`,
        text: `The backup of ${view.name} ${problemText[problem]}.\n\n${detail}\n\nSource: ${config().APP_URL}/sources/${view.id}`,
      });
    } else if (!problem && row.alertState && ["ok", "warning"].includes(view.status)) {
      if (settings.notifyRecovery) {
        await notify(db, row.id, null, {
          subject: `Backup back to normal: ${view.name}`,
          text: `The backup of ${view.name} works again.\n\nSource: ${config().APP_URL}/sources/${view.id}`,
        });
      } else {
        await db.update(sources).set({ alertState: null }).where(eq(sources.id, row.id));
      }
    }
  }

  // The upkeep and this app's own backup: one alert per failed run.
  const systemAlert = (await readSetting<Record<string, string | null>>(db, SYSTEM_ALERT_KEY)) ?? {};
  for (const [kind, name] of [
    ["maintenance", "The daily upkeep of the backup repository"],
    ["self", "The backup of this app's own database"],
  ] as const) {
    const run = await latestRun(db, kind);
    if (run?.status !== "failed") continue;
    healthy = false;
    if (systemAlert[kind] === run.id) continue;
    const sent = await sendSafely(db, {
      subject: `${name} failed`,
      text: `${name} failed:\n\n${run.error ?? ""}\n\nRun: ${config().APP_URL}/runs/${run.id}`,
    });
    if (sent) {
      systemAlert[kind] = run.id;
      await writeSetting(db, SYSTEM_ALERT_KEY, systemAlert);
    }
  }

  const target = await readTarget(db);
  if (!target?.password || target.repository.state !== "ready") healthy = false;
  if (healthy && settings.heartbeatUrl) {
    const last = await readSetting<HeartbeatState>(db, HEARTBEAT_STATE_KEY);
    if (!last || now.getTime() - new Date(last.at).getTime() >= HEARTBEAT_EVERY_MS - 30_000) {
      const result = await callHeartbeat(settings.heartbeatUrl);
      await writeSetting(db, HEARTBEAT_STATE_KEY, { at: now.toISOString(), ...result });
      if (!result.ok) logger.warn({ code: result.message }, "heartbeat call failed");
    }
  }
}

/** Sends an alert; false when it could not be sent (it is tried again at the next check). */
async function sendSafely(db: Db, mail: Mail): Promise<boolean> {
  try {
    await sendMail(db, mail);
    return true;
  } catch (error) {
    logger.warn({ err: error }, "alert email not sent");
    return false;
  }
}

/** Sends a source's alert and records it as sent; nothing is recorded when sending failed. */
async function notify(db: Db, sourceId: string, state: "failed" | "overdue" | null, mail: Mail) {
  if (!(await sendSafely(db, mail))) return;
  await db
    .update(sources)
    .set({ alertState: state, alertedAt: sql`now()` })
    .where(eq(sources.id, sourceId));
}

export async function testHeartbeat(db: DbOrTx) {
  const settings = await stored(db);
  if (!settings.heartbeatUrl) return { ok: false, message: "Set a heartbeat URL first" };
  const result = await callHeartbeat(settings.heartbeatUrl);
  await writeSetting(db, HEARTBEAT_STATE_KEY, { at: new Date().toISOString(), ...result });
  return { ok: result.ok, message: result.ok ? "The heartbeat URL answered" : (result.message ?? "Failed") };
}

export type { NotificationsInput };
