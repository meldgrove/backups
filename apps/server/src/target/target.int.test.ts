import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backups/shared/api/schedule";
import { createUser, request, resetDatabase, setUpTarget, TEST_S3 } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("the target", () => {
  beforeEach(resetDatabase);

  it("needs the secret key once, finds no repository, then creates one", async () => {
    const admin = await createUser();
    const empty = await request("GET", "/api/v1/target", { userId: admin.id });
    expect(empty.body).toMatchObject({
      configured: false,
      repository: { state: "unknown", hasPassword: false },
    });

    const body = {
      endpoint: TEST_S3.endpoint,
      region: TEST_S3.region,
      bucket: TEST_S3.bucket,
      prefix: `test/target-${Date.now().toString(36)}`,
      accessKeyId: TEST_S3.accessKeyId,
    };
    const missingSecret = await request("PUT", "/api/v1/target", { userId: admin.id, body });
    expect(missingSecret.status).toBe(422);
    expect(missingSecret.body.error.fields).toHaveProperty("secretAccessKey");

    const saved = await request("PUT", "/api/v1/target", {
      userId: admin.id,
      body: { ...body, secretAccessKey: TEST_S3.secretAccessKey },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      repositoryUrl: `s3:${TEST_S3.endpoint}/${TEST_S3.bucket}/${body.prefix}`,
      secretAccessKeyHint: `…${TEST_S3.secretAccessKey.slice(-4)}`,
    });
    expect(JSON.stringify(saved.body)).not.toContain(TEST_S3.secretAccessKey);

    const tested = await request("POST", "/api/v1/target/test", { userId: admin.id, body: {} });
    expect(tested.body.repository.state).toBe("missing");
    // The bucket of compose.dev.yaml: Object Lock, versioning and lifecycle rules, as on Hetzner.
    expect(tested.body.protection).toMatchObject({
      versioning: "enabled",
      objectLock: { enabled: true, mode: "GOVERNANCE", days: 30 },
      lifecycle: { noncurrentDays: 31, expiredDeleteMarkers: true, abortMultipartDays: 7 },
      error: null,
    });

    const created = await request("POST", "/api/v1/target/initialize", { userId: admin.id, body: {} });
    expect(created.status).toBe(200);
    expect(created.body.repository).toMatchObject({ state: "ready", hasPassword: true });
    expect(created.body.recoveryKitConfirmedAt).toBeNull();
    expect((await request("POST", "/api/v1/target/initialize", { userId: admin.id, body: {} })).status).toBe(
      409,
    );
  });

  it("hands out the recovery kit, which opens the repository again after a reinstall", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Handbook",
        schedule: { type: "daily", time: "02:00" },
        retention: DEFAULT_RETENTION,
      },
    });
    const kit = await request("GET", "/api/v1/target/recovery-kit", { userId: admin.id });
    expect(kit.status).toBe(200);
    expect(kit.headers.get("content-disposition")).toMatch(
      /attachment; filename="meldgrove-backups-recovery-kit-/,
    );
    const text = kit.body as string;
    const password = /RESTIC_PASSWORD=(\S+)/.exec(text)?.[1];
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(text).toContain(`AWS_SECRET_ACCESS_KEY=${TEST_S3.secretAccessKey}`);
    expect(text).toMatch(/source:[0-9a-f-]{36}: Handbook \(app\)/);

    const confirmed = await request("POST", "/api/v1/target/recovery-kit/confirm", {
      userId: admin.id,
      body: {},
    });
    expect(confirmed.body.recoveryKitConfirmedAt).not.toBeNull();

    // A new installation: the same target, the password from the kit.
    const repositoryUrl = (await request("GET", "/api/v1/target", { userId: admin.id })).body
      .repositoryUrl as string;
    const prefix = repositoryUrl.split(`/${TEST_S3.bucket}/`)[1]!;
    await resetDatabase();
    const again = await createUser();
    await request("PUT", "/api/v1/target", {
      userId: again.id,
      body: {
        endpoint: TEST_S3.endpoint,
        region: TEST_S3.region,
        bucket: TEST_S3.bucket,
        prefix,
        accessKeyId: TEST_S3.accessKeyId,
        secretAccessKey: TEST_S3.secretAccessKey,
      },
    });
    const tested = await request("POST", "/api/v1/target/test", { userId: again.id, body: {} });
    expect(tested.body.repository.state).toBe("wrong_password");
    const wrong = await request("POST", "/api/v1/target/connect", {
      userId: again.id,
      body: { password: "nope" },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.fields).toHaveProperty("password");
    const right = await request("POST", "/api/v1/target/connect", { userId: again.id, body: { password } });
    expect(right.body.repository).toMatchObject({ state: "ready", hasPassword: true });

    const actions = (await request("GET", "/api/v1/audit", { userId: again.id })).body.items.map(
      (item: { action: string }) => item.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["target.update", "repository.connect"]));
  });

  it("is for admins only", async () => {
    const person = await createUser({ isAdmin: false });
    expect((await request("GET", "/api/v1/target", {})).status).toBe(401);
    expect((await request("GET", "/api/v1/target", { userId: person.id })).status).toBe(401);
    expect((await request("GET", "/api/v1/target/recovery-kit", { userId: person.id })).status).toBe(401);
  });
});
