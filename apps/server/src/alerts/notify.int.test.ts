import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backups/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { createUser, request, resetDatabase, setUpTarget } from "../test/helpers";
import { checkAlerts } from "./notify";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** Mailpit of compose.dev.yaml (CI starts the same). */
const MAILPIT = process.env.TEST_MAILPIT_URL ?? "http://localhost:8125";
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? 1035);

async function mails(): Promise<{ Subject: string; To: { Address: string }[] }[]> {
  const response = await fetch(`${MAILPIT}/api/v1/messages`);
  return ((await response.json()) as { messages: { Subject: string; To: { Address: string }[] }[] }).messages;
}

const email = {
  enabled: true,
  host: "localhost",
  port: SMTP_PORT,
  security: "none",
  username: "",
  password: "",
  from: "backups@example.org",
  recipients: ["it@example.org"],
};

describe("alerts", () => {
  beforeEach(async () => {
    await resetDatabase();
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  });

  it("emails once when a backup fails, and when it works again", async () => {
    const admin = await createUser();
    const saved = await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email: { ...email, password: "smtp-pass" }, heartbeatUrl: "", notifyRecovery: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.email).toMatchObject({ passwordHint: "…pass", recipients: ["it@example.org"] });
    expect(JSON.stringify(saved.body)).not.toContain("smtp-pass");
    // Without credentials on this server: a username-less setup.
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email, heartbeatUrl: "", notifyRecovery: true },
    });
    const test = await request("POST", "/api/v1/notifications/test-email", { userId: admin.id, body: {} });
    expect(test.body).toEqual({ ok: true, message: "Sent. Check the recipients' inboxes." });

    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Helpdesk",
        schedule: { type: "daily", time: "02:00" },
        retention: DEFAULT_RETENTION,
      },
    });
    const sourceId = created.body.source.id as string;
    await getDb().insert(runs).values({
      kind: "backup",
      sourceId,
      trigger: "schedule",
      status: "failed",
      finishedAt: new Date(),
      error: "The agent reported: pg_dump failed",
    });
    // The mail server is down: nothing counts as sent, so the next check tries again.
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email: { ...email, port: 1 }, heartbeatUrl: "", notifyRecovery: true },
    });
    await checkAlerts(getDb());
    const [unsent] = await getDb().select().from(sources).where(eq(sources.id, sourceId));
    expect(unsent!.alertState).toBeNull();
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email, heartbeatUrl: "", notifyRecovery: true },
    });
    await checkAlerts(getDb());
    await checkAlerts(getDb());
    const failed = (await mails()).filter((mail) => mail.Subject.includes("Backup failed: Helpdesk"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.To[0]!.Address).toBe("it@example.org");
    const [alerted] = await getDb().select().from(sources).where(eq(sources.id, sourceId));
    expect(alerted!.alertState).toBe("failed");

    await getDb()
      .insert(runs)
      .values({
        kind: "backup",
        sourceId,
        trigger: "manual",
        status: "succeeded",
        finishedAt: new Date(),
        snapshotId: "a".repeat(64),
      });
    await getDb().update(sources).set({ lastSuccessAt: new Date() }).where(eq(sources.id, sourceId));
    await checkAlerts(getDb());
    expect((await mails()).map((mail) => mail.Subject)).toContain(
      "[Backups] Backup back to normal: Helpdesk",
    );
  });

  it("calls the heartbeat only while all is well", async () => {
    const admin = await createUser();
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/abc`;
    try {
      await request("PUT", "/api/v1/notifications", {
        userId: admin.id,
        body: { email: { ...email, enabled: false }, heartbeatUrl: url, notifyRecovery: true },
      });
      // No repository yet: not well.
      await checkAlerts(getDb());
      expect(hits).toEqual([]);
      await setUpTarget(admin);
      await checkAlerts(getDb());
      expect(hits).toEqual(["/ping/abc"]);
      // Not again within 15 minutes.
      await checkAlerts(getDb());
      expect(hits).toHaveLength(1);
      const view = await request("GET", "/api/v1/notifications", { userId: admin.id });
      expect(view.body.heartbeat).toMatchObject({ ok: true, message: null });
    } finally {
      server.close();
    }
  });
});
