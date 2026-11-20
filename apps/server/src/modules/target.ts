import { Hono } from "hono";
import { maintenanceInputSchema, targetConnectSchema, targetInputSchema } from "@backups/shared/api/target";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { conflict } from "../http/errors";
import { jsonBody, requireAdmin } from "../http/middleware";
import { audit } from "../core/audit";
import { writeSetting } from "../core/settings";
import { listSourceRows } from "../sources/service";
import {
  MAINTENANCE_KEY,
  confirmRecoveryKit,
  connectTarget,
  initializeTarget,
  readTarget,
  recoveryKitText,
  saveTarget,
  targetView,
  testTarget,
} from "../target/target";

const router = new Hono<AppEnv>();

router.get("/target", async (c) => {
  requireAdmin(c);
  return c.json(await targetView(getDb()));
});

router.put("/target", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, targetInputSchema);
  const db = getDb();
  await saveTarget(db, input, actor);
  return c.json(await targetView(db));
});

router.post("/target/test", async (c) => {
  requireAdmin(c);
  const db = getDb();
  await testTarget(db);
  return c.json(await targetView(db));
});

router.post("/target/initialize", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  await initializeTarget(db, actor);
  return c.json(await targetView(db));
});

router.post("/target/connect", async (c) => {
  const actor = requireAdmin(c);
  const { password } = await jsonBody(c, targetConnectSchema);
  const db = getDb();
  await connectTarget(db, password, actor);
  return c.json(await targetView(db));
});

/** The recovery kit as a text file. Every download is in the audit log. */
router.get("/target/recovery-kit", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  const target = await readTarget(db);
  if (!target?.password) throw conflict("Create or connect the repository first", "no_repository");
  const now = new Date();
  const text = recoveryKitText(target, await listSourceRows(db), now);
  await audit(db, actor, {
    action: "recovery_kit.download",
    entityType: "target",
    summary: "Downloaded the recovery kit",
  });
  c.header("content-type", "text/plain; charset=utf-8");
  c.header(
    "content-disposition",
    `attachment; filename="meldgrove-backups-recovery-kit-${now.toISOString().slice(0, 10)}.txt"`,
  );
  c.header("cache-control", "no-store");
  return c.body(text);
});

router.post("/target/recovery-kit/confirm", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  await confirmRecoveryKit(db, actor);
  return c.json(await targetView(db));
});

router.put("/target/maintenance", async (c) => {
  const actor = requireAdmin(c);
  const { maintenanceTime } = await jsonBody(c, maintenanceInputSchema);
  const db = getDb();
  await writeSetting(db, MAINTENANCE_KEY, { time: maintenanceTime });
  await audit(db, actor, {
    action: "maintenance.update",
    entityType: "target",
    summary: `Set the daily upkeep to ${maintenanceTime}`,
  });
  return c.json(await targetView(db));
});

export default router;
