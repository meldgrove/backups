import { notificationsInputSchema } from "@backups/shared/api/notifications";
import {
  NOTIFICATIONS_KEY,
  notificationsView,
  saveNotifications,
  sendTestEmail,
  testHeartbeat,
} from "../alerts/notify";
import { secretHint } from "../core/crypto";
import { readSetting } from "../core/settings";
import { getDb } from "../db/client";
import { parseWith } from "../http/errors";
import { UsageError } from "./io";
import type { Setting } from "./settings";

const TEST_USAGE = "cli settings test notifications --email|--heartbeat";

/** Only the heartbeat URL's host: its path is its secret. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "set";
  }
}

/**
 * What `show` prints: the page's read, with the heartbeat URL as a hint (its
 * address and the last characters of its path, which authorizes the pings).
 */
async function view() {
  const { heartbeatUrl, ...rest } = await notificationsView(getDb());
  let hint: string | null = null;
  if (heartbeatUrl) {
    try {
      const url = new URL(heartbeatUrl);
      hint = `${url.origin}/${secretHint(`${url.pathname}${url.search}`.slice(1))}`;
    } catch {
      hint = "…";
    }
  }
  return { ...rest, heartbeatUrlHint: hint };
}

/** `notifications`: alert emails and the heartbeat (Notifications page, PUT /api/v1/notifications). */
export const notifications: Setting = {
  name: "notifications",
  label: "alert emails over SMTP and the heartbeat URL (Notifications)",
  list: false,
  async rows() {
    const db = getDb();
    if (!(await readSetting(db, NOTIFICATIONS_KEY)))
      return [{ name: "notifications", state: "not set", hints: [] }];
    const { email, heartbeatUrl } = await notificationsView(db);
    const complete = Boolean(email.host && email.from && email.recipients.length > 0);
    const hints = [email.enabled ? "email on" : "email off"];
    if (email.host) hints.push(`server ${email.host}:${email.port}`);
    if (email.from) hints.push(`from ${email.from}`);
    hints.push(`${email.recipients.length} recipient${email.recipients.length === 1 ? "" : "s"}`);
    if (email.passwordHint) hints.push(`password ${email.passwordHint}`);
    hints.push(heartbeatUrl ? `heartbeat ${host(heartbeatUrl)}` : "no heartbeat");
    return [{ name: "notifications", state: email.enabled && !complete ? "incomplete" : "set", hints }];
  },
  show: () => view(),
  async apply(actor, body) {
    const db = getDb();
    // As a secret: a body without heartbeatUrl keeps the saved one; "" turns the heartbeat off.
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value) && !("heartbeatUrl" in value)) {
      Object.assign(value, { heartbeatUrl: (await notificationsView(db)).heartbeatUrl });
    }
    await saveNotifications(db, parseWith(notificationsInputSchema, value), actor);
    return { json: await view() };
  },
  testOptions: { options: { email: { type: "boolean" }, heartbeat: { type: "boolean" } }, usage: TEST_USAGE },
  async test(actor, _id, { email, heartbeat }) {
    if (Boolean(email) === Boolean(heartbeat)) {
      throw new UsageError("Choose one test: --email or --heartbeat.", TEST_USAGE);
    }
    const result = email ? await sendTestEmail(getDb(), actor) : await testHeartbeat(getDb());
    return { result, ok: result.ok, message: result.ok ? undefined : result.message };
  },
};
