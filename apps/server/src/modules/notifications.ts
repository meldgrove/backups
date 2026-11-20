import { Hono } from "hono";
import { notificationsInputSchema, type TestResult } from "@backups/shared/api/notifications";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { jsonBody, requireAdmin } from "../http/middleware";
import { notificationsView, saveNotifications, sendMail, testHeartbeat } from "../alerts/notify";

const router = new Hono<AppEnv>();

router.get("/notifications", async (c) => {
  requireAdmin(c);
  return c.json(await notificationsView(getDb()));
});

router.put("/notifications", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, notificationsInputSchema);
  const db = getDb();
  await saveNotifications(db, input, actor);
  return c.json(await notificationsView(db));
});

router.post("/notifications/test-email", async (c) => {
  const actor = requireAdmin(c);
  let result: TestResult;
  try {
    await sendMail(
      getDb(),
      {
        subject: "Test email",
        text: `${actor.email} sent this test from the notification settings. Alerts about failed and overdue backups arrive the same way.`,
      },
      { evenWhenOff: true },
    );
    result = { ok: true, message: "Sent. Check the recipients' inboxes." };
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : "Not sent" };
  }
  return c.json(result);
});

router.post("/notifications/test-heartbeat", async (c) => {
  requireAdmin(c);
  return c.json(await testHeartbeat(getDb()));
});

export default router;
