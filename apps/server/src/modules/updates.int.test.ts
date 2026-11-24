import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { resetConfigForTests } from "../config";
import { createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const TOKEN = "0123456789abcdef0123456789abcdef";
let updater: FakeUpdater;

function useUpdater(settings: { UPDATER_URL: string; UPDATER_TOKEN?: string }) {
  process.env.UPDATER_URL = settings.UPDATER_URL;
  if (settings.UPDATER_TOKEN === undefined) delete process.env.UPDATER_TOKEN;
  else process.env.UPDATER_TOKEN = settings.UPDATER_TOKEN;
  resetConfigForTests();
}

/**
 * The routes of the app around the shared handler (@meldgrove/ui, which has
 * the tests of the updater's answers): who may call them, the token and the
 * body reach the updater.
 */
describe("updates API", () => {
  beforeAll(async () => {
    updater = await startFakeUpdater({ token: TOKEN });
  });
  afterAll(async () => {
    await updater.close();
    delete process.env.UPDATER_URL;
    delete process.env.UPDATER_TOKEN;
    resetConfigForTests();
  });
  beforeEach(async () => {
    await resetDatabase();
    useUpdater({ UPDATER_URL: updater.url, UPDATER_TOKEN: TOKEN });
    updater.calls.length = 0;
    updater.respond(() => ({ body: updaterStatus() }));
  });

  it("is only for admins in the web app, and sends them the status with the token", async () => {
    const admin = await createUser({ isAdmin: true });
    const person = await createUser({ isAdmin: false });

    const paths: [string, string, unknown?][] = [
      ["GET", "/api/v1/admin/updates"],
      ["POST", "/api/v1/admin/updates/check", {}],
      ["POST", "/api/v1/admin/updates/install", { version: "0.2.1" }],
      ["POST", "/api/v1/admin/updates/channel", { channel: "preview" }],
    ];
    for (const [method, path, body] of paths) {
      expect((await request(method, path, { body })).status).toBe(401);
      expect((await request(method, path, { userId: person.id, body })).status).toBe(401);
    }
    expect(updater.calls).toEqual([]);

    const status = await request("GET", "/api/v1/admin/updates", { userId: admin.id });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.body).toEqual({
      app: { version: null },
      reachable: true,
      updater: updaterStatus(),
      error: null,
    });
    expect(updater.calls).toEqual([
      { method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("sends an installation with its version, and checks the version first", async () => {
    const admin = await createUser({ isAdmin: true });
    updater.respond(() => ({ status: 202, body: updaterStatus() }));

    const install = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(install.status).toBe(202);
    const wrong = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "latest" },
    });
    expect(wrong.status).toBe(400);

    expect(updater.calls).toEqual([
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" }, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("protects changes against other sites", async () => {
    const admin = await createUser({ isAdmin: true });
    const response = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
      headers: { origin: "https://evil.example.net" },
    });
    expect(response.status).toBe(403);
    expect(updater.calls).toEqual([]);
  });

  it("sends no token without UPDATER_TOKEN, and names it when the updater wants one", async () => {
    const admin = await createUser({ isAdmin: true });
    useUpdater({ UPDATER_URL: updater.url, UPDATER_TOKEN: "" });

    const response = await request("POST", "/api/v1/admin/updates/check", { userId: admin.id, body: {} });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ reachable: true, error: expect.stringContaining("UPDATER_TOKEN") });
    expect(updater.calls.map((call) => call.authorization)).toEqual([null, null]);
  });
});
