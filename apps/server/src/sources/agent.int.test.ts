import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backups/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { resetConfigForTests } from "../config";
import { createUser, eventually, request, resetDatabase, setUpTarget } from "../test/helpers";
import { openUploadCount } from "./agent";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const PART = 1024 * 1024;

/** A stream as an agent sends it; the server does not look inside, restic stores it as backup.tar. */
function stream(bytes: number) {
  const data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) data[index] = (index * 31 + (index >> 10)) & 0xff;
  return data;
}

const report = {
  agent: { version: "0.1.0" },
  app: { name: "handbook", image: "ghcr.io/meldgrove/handbook:0.3.1" },
  database: true,
  volumes: ["files"],
};

async function appSource(adminId: string) {
  const created = await request("POST", "/api/v1/sources", {
    userId: adminId,
    body: {
      kind: "app",
      name: "Handbook",
      schedule: { type: "daily", time: "02:00" },
      retention: DEFAULT_RETENTION,
    },
  });
  expect(created.status).toBe(201);
  return { id: created.body.source.id as string, token: created.body.token as string };
}

async function upload(token: string, jobId: string, data: Buffer) {
  let part = 0;
  for (let offset = 0; offset < data.length; offset += PART, part += 1) {
    const chunk = data.subarray(offset, offset + PART);
    const response = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/${part}`, {
      token,
      raw: chunk,
      headers: { "x-part-sha256": sha(chunk) },
    });
    expect(response.status).toBe(204);
  }
  return part;
}

describe("the agent protocol, with restic and S3", () => {
  beforeAll(() => {
    process.env.AGENT_PART_MB = "1";
    resetConfigForTests();
  });
  afterAll(() => {
    delete process.env.AGENT_PART_MB;
    resetConfigForTests();
  });
  beforeEach(resetDatabase);

  it("refuses wrong tokens", async () => {
    expect((await request("POST", "/api/agent/v1/poll", { body: report })).status).toBe(401);
    const wrong = `mgb_${"A".repeat(43)}`;
    expect((await request("POST", "/api/agent/v1/poll", { token: wrong, body: report })).status).toBe(401);
  });

  it("hands out a job, stores the stream as a snapshot, and serves it back", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);

    const idle = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({ source: { id: source.id, name: "Handbook" }, job: null });
    const [seen] = await getDb().select().from(sources).where(eq(sources.id, source.id));
    expect(seen!.agentInfo).toMatchObject({ version: "0.1.0", appName: "handbook", volumes: ["files"] });

    const queued = await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    expect(queued.status).toBe(202);
    // `check` never takes the job.
    const checked = await request("POST", "/api/agent/v1/poll", {
      token: source.token,
      body: { ...report, check: true },
    });
    expect(checked.body.job).toBeNull();
    const picked = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
    expect(picked.body.job).toEqual({ id: queued.body.id, partBytes: PART });
    const jobId = picked.body.job.id as string;

    expect(
      (
        await request("POST", `/api/agent/v1/jobs/${jobId}/progress`, {
          token: source.token,
          body: { stage: "database", bytes: 10 },
        })
      ).status,
    ).toBe(204);

    const data = stream(Math.round(2.5 * PART));
    const first = data.subarray(0, PART);
    // Out of order, damaged, then the real part and a repeat (lost answer).
    const outOfOrder = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/1`, {
      token: source.token,
      raw: first,
      headers: { "x-part-sha256": sha(first) },
    });
    expect(outOfOrder.status).toBe(409);
    expect(outOfOrder.body.error).toMatchObject({ code: "out_of_order", expected: 0 });
    const damaged = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/0`, {
      token: source.token,
      raw: first,
      headers: { "x-part-sha256": "0".repeat(64) },
    });
    expect(damaged.status).toBe(422);
    const parts = await upload(source.token, jobId, data);
    const again = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/${parts - 1}`, {
      token: source.token,
      raw: data.subarray((parts - 1) * PART),
      headers: { "x-part-sha256": sha(data.subarray((parts - 1) * PART)) },
    });
    expect(again.status).toBe(204);

    const totals = { parts, bytes: data.length, sha256: sha(data), warnings: [] };
    const complete = await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, {
      token: source.token,
      body: totals,
    });
    expect(complete.status).toBe(202);
    // A `fail` after an accepted `complete` (the agent lost the answer and stopped) changes nothing.
    expect(
      (
        await request("POST", `/api/agent/v1/jobs/${jobId}/fail`, {
          token: source.token,
          body: { message: "The agent was stopped" },
        })
      ).status,
    ).toBe(204);
    // A repeated `complete` (lost answer) is accepted again.
    expect(
      (await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, { token: source.token, body: totals }))
        .status,
    ).toBe(202);

    const run = await eventually(async () => {
      const [row] = await getDb().select().from(runs).where(eq(runs.id, jobId));
      return row && row.status !== "running" ? row : undefined;
    }, 60_000);
    expect(run.status).toBe("succeeded");
    expect(run.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(openUploadCount()).toBe(0);

    const view = await request("GET", `/api/v1/sources/${source.id}`, { userId: admin.id });
    expect(view.body).toMatchObject({
      status: "ok",
      lastSnapshot: { id: run.snapshotId!.slice(0, 8), bytes: data.length },
    });

    const list = await request("GET", `/api/v1/sources/${source.id}/snapshots`, { userId: admin.id });
    expect(list.body.items).toHaveLength(1);
    const download = await request(
      "GET",
      `/api/v1/sources/${source.id}/snapshots/${list.body.items[0].id}/download`,
      {
        userId: admin.id,
      },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="Handbook-.*\.tar"$/);
    expect(sha(download.bytes)).toBe(sha(data));

    const audit = await request("GET", "/api/v1/audit", { userId: admin.id });
    expect(audit.body.items.map((item: { action: string }) => item.action)).toContain("snapshot.download");
  });

  it("saves nothing when the totals do not match, and records the agent's failure", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);
    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const job = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body.job;
    const data = stream(PART + 10);
    const parts = await upload(source.token, job.id, data);
    const mismatch = await request("POST", `/api/agent/v1/jobs/${job.id}/complete`, {
      token: source.token,
      body: { parts, bytes: data.length + 1, sha256: sha(data), warnings: [] },
    });
    expect(mismatch.status).toBe(422);
    const [failed] = await getDb().select().from(runs).where(eq(runs.id, job.id));
    expect(failed).toMatchObject({ status: "failed", snapshotId: null });
    // The job is over: more parts are refused.
    const late = await request("PUT", `/api/agent/v1/jobs/${job.id}/parts/${parts}`, {
      token: source.token,
      raw: Buffer.from("x"),
      headers: { "x-part-sha256": sha(Buffer.from("x")) },
    });
    expect(late.status).toBe(410);
    expect(
      (await request("GET", `/api/v1/sources/${source.id}/snapshots`, { userId: admin.id })).body.items,
    ).toEqual([]);

    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const second = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body
      .job;
    const fail = await request("POST", `/api/agent/v1/jobs/${second.id}/fail`, {
      token: source.token,
      body: { message: "pg_dump failed: connection refused" },
    });
    expect(fail.status).toBe(204);
    const [reported] = await getDb().select().from(runs).where(eq(runs.id, second.id));
    expect(reported).toMatchObject({
      status: "failed",
      error: "The agent reported: pg_dump failed: connection refused",
    });
    const view = await request("GET", `/api/v1/sources/${source.id}`, { userId: admin.id });
    expect(view.body.status).toBe("failed");
  });

  it("stops an upload an admin cancels", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);
    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const job = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body.job;
    await upload(source.token, job.id, stream(PART));
    const cancel = await request("POST", `/api/v1/runs/${job.id}/cancel`, { userId: admin.id, body: {} });
    expect(cancel.status).toBe(200);
    const next = stream(10);
    const refused = await request("PUT", `/api/agent/v1/jobs/${job.id}/parts/1`, {
      token: source.token,
      raw: next,
      headers: { "x-part-sha256": sha(next) },
    });
    expect(refused.status).toBe(410);
    const [cancelled] = await getDb().select().from(runs).where(eq(runs.id, job.id));
    expect(cancelled!.status).toBe("cancelled");
  });
});
