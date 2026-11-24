import { Hono } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { logger } from "../logger";

/**
 * Updates of the app, for admins in the web app (never agents or service
 * tokens): the status, a check, an installation and the channel, through
 * the Meldgrove Updater (docs/deployment.md, Automatic updates). The shared
 * handler asks the updater with UPDATER_TOKEN and answers as the update
 * button expects; the API's middleware has already checked the origin of
 * the POSTs and set no-store.
 */
const router = new Hono<AppEnv>();

const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

router.get("/admin/updates", (c) => {
  requireAdmin(c);
  return updates.respond("status");
});

router.post("/admin/updates/check", (c) => {
  requireAdmin(c);
  return updates.respond("check");
});

router.post("/admin/updates/install", (c) => {
  requireAdmin(c);
  return updates.respond("install", c.req.raw);
});

router.post("/admin/updates/channel", (c) => {
  requireAdmin(c);
  return updates.respond("channel", c.req.raw);
});

export default router;
