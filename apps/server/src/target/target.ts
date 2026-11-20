import type { BucketProtection, RepositoryState, Target, TargetInput } from "@backups/shared/api/target";
import type { targetInputSchema } from "@backups/shared/api/target";
import type { z } from "zod";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { audit } from "../core/audit";
import { decryptSecret, encryptSecret, randomSecret, secretHint } from "../core/crypto";
import { readSetting, readSettingForUpdate, writeSetting } from "../core/settings";
import { conflict, validationError } from "../http/errors";
import type { UserPrincipal } from "../auth/principal";
import { initRepository, probeRepository, repositoryUrl, type Repository } from "../restic/restic";
import { readBucketProtection } from "./bucket";

/** The target as stored (key `target`); secrets encrypted. */
export type StoredTarget = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The repository password; null until a repository is created or connected. */
  password: string | null;
  /**
   * The password of a repository being created: stored before `restic init`
   * runs, and promoted to `password` once the repository exists.
   */
  pendingPassword?: string | null;
  repository: { state: RepositoryState; message: string | null; checkedAt: string | null };
  recoveryKitConfirmedAt: string | null;
  protection: BucketProtection | null;
};

/** Written by the upkeep (key `repository`). */
export type RepositoryHealth = {
  stats: { checkedAt: string; storedBytes: number | null; snapshots: number | null } | null;
  lastCheck: { at: string; ok: boolean; readData: string | null; message: string | null } | null;
};

export const TARGET_KEY = "target";
export const REPOSITORY_KEY = "repository";
export const MAINTENANCE_KEY = "maintenance";
export const DEFAULT_MAINTENANCE_TIME = "04:30";

export const readTarget = (db: DbOrTx) => readSetting<StoredTarget>(db, TARGET_KEY);

export async function maintenanceTime(db: DbOrTx): Promise<string> {
  return (await readSetting<{ time: string }>(db, MAINTENANCE_KEY))?.time ?? DEFAULT_MAINTENANCE_TIME;
}

/** The repository to back up into; null while no target with a repository password is set up. */
export function repositoryOf(target: StoredTarget | null): Repository | null {
  if (!target?.password) return null;
  return {
    url: repositoryUrl(target),
    accessKeyId: target.accessKeyId,
    secretAccessKey: decryptSecret(target.secretAccessKey),
    region: target.region,
    password: decryptSecret(target.password),
  };
}

export async function openRepository(db: DbOrTx): Promise<Repository> {
  const repository = repositoryOf(await readTarget(db));
  if (!repository) throw conflict("Set up the target and its repository first", "no_target");
  return repository;
}

export async function targetView(db: DbOrTx): Promise<Target> {
  const target = await readTarget(db);
  const health = await readSetting<RepositoryHealth>(db, REPOSITORY_KEY);
  return {
    configured: target !== null,
    endpoint: target?.endpoint ?? null,
    region: target?.region ?? "",
    bucket: target?.bucket ?? null,
    prefix: target?.prefix ?? "",
    accessKeyId: target?.accessKeyId ?? null,
    secretAccessKeyHint: target ? secretHint(decryptSecretSafe(target.secretAccessKey)) : null,
    repositoryUrl: target ? repositoryUrl(target) : null,
    repository: {
      state: target?.repository.state ?? "unknown",
      message: target?.repository.message ?? null,
      checkedAt: target?.repository.checkedAt ?? null,
      hasPassword: Boolean(target?.password),
    },
    recoveryKitConfirmedAt: target?.recoveryKitConfirmedAt ?? null,
    protection: target?.protection ?? null,
    stats: health?.stats ?? null,
    lastCheck: health?.lastCheck ?? null,
    maintenanceTime: await maintenanceTime(db),
    timezone: config().TZ,
  };
}

function decryptSecretSafe(value: string): string {
  try {
    return decryptSecret(value);
  } catch {
    return "";
  }
}

const sameLocation = (a: StoredTarget, b: { endpoint: string; bucket: string; prefix: string }) =>
  repositoryUrl(a) === repositoryUrl(b);

/** Saves the bucket's address and keys. A new location needs its repository checked (and the kit stored) again. */
export async function saveTarget(
  db: DbOrTx,
  input: z.output<typeof targetInputSchema>,
  actor: UserPrincipal,
): Promise<void> {
  await db.transaction((tx) => saveTargetLocked(tx, input, actor));
}

async function saveTargetLocked(
  db: DbOrTx,
  input: z.output<typeof targetInputSchema>,
  actor: UserPrincipal,
): Promise<void> {
  const current = await readSettingForUpdate<StoredTarget>(db, TARGET_KEY);
  if (!current && !input.secretAccessKey) throw validationError({ secretAccessKey: "Enter the secret key" });
  const endpoint = input.endpoint.replace(/\/+$/, "");
  const moved = !current || !sameLocation(current, { endpoint, bucket: input.bucket, prefix: input.prefix });
  const keysChanged = !current || input.accessKeyId !== current.accessKeyId || Boolean(input.secretAccessKey);
  const next: StoredTarget = {
    endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey ? encryptSecret(input.secretAccessKey) : current!.secretAccessKey,
    password: current?.password ?? null,
    pendingPassword: current?.pendingPassword ?? null,
    repository:
      moved || keysChanged || !current
        ? { state: "unknown", message: null, checkedAt: null }
        : current.repository,
    recoveryKitConfirmedAt: moved || keysChanged ? null : (current?.recoveryKitConfirmedAt ?? null),
    protection: moved || keysChanged ? null : (current?.protection ?? null),
  };
  await writeSetting(db, TARGET_KEY, next);
  await audit(db, actor, {
    action: "target.update",
    entityType: "target",
    summary: moved ? `Set the target to ${repositoryUrl(next)}` : "Changed the target's keys or region",
  });
}

/** The same bucket, keys and password: results of a check of `a` still apply to `b`. */
const sameTarget = (a: StoredTarget, b: StoredTarget | null) =>
  b !== null &&
  repositoryUrl(a) === repositoryUrl(b) &&
  a.accessKeyId === b.accessKeyId &&
  a.secretAccessKey === b.secretAccessKey &&
  a.password === b.password &&
  (a.pendingPassword ?? null) === (b.pendingPassword ?? null);

/**
 * Stores a change made after network calls, on the target as it is now, and
 * only when it is still the target those calls used (an admin may have
 * changed it meanwhile).
 */
async function updateIfUnchanged(
  db: DbOrTx,
  used: StoredTarget,
  change: Partial<StoredTarget>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = await readSettingForUpdate<StoredTarget>(tx, TARGET_KEY);
    if (!sameTarget(used, current)) return false;
    await writeSetting(tx, TARGET_KEY, { ...current!, ...change });
    return true;
  });
}

const changedMeanwhile = () => conflict("The target changed meanwhile. Try again.", "target_changed");

/** Checks the bucket and the repository and stores what it found. */
export async function testTarget(db: DbOrTx): Promise<void> {
  const target = await readTarget(db);
  if (!target) throw conflict("Save the target first", "no_target");
  const secretAccessKey = decryptSecret(target.secretAccessKey);
  const protection = await readBucketProtection({ ...target, secretAccessKey });
  let repository: StoredTarget["repository"];
  const checkedAt = new Date().toISOString();
  // Without a password restic cannot tell a missing repository from one it cannot open:
  // probe with a throwaway password and report "missing" or "exists".
  const stored = target.password ?? target.pendingPassword ?? null;
  const probe = await probeRepository({
    url: repositoryUrl(target),
    accessKeyId: target.accessKeyId,
    secretAccessKey,
    region: target.region,
    password: stored ? decryptSecret(stored) : randomSecret(),
  });
  if (probe.state === "error") repository = { state: "error", message: probe.message, checkedAt };
  else if (probe.state === "wrong_password" && !target.password) {
    repository = {
      state: "wrong_password",
      message: "A repository exists here. Connect it with its password.",
      checkedAt,
    };
  } else repository = { state: probe.state, message: null, checkedAt };
  // A repository an earlier creation made with the pending password: it is this one.
  const created =
    !target.password && target.pendingPassword && probe.state === "ready"
      ? { password: target.pendingPassword, pendingPassword: null, recoveryKitConfirmedAt: null }
      : {};
  await updateIfUnchanged(db, target, { repository, protection, ...created });
}

/** Creates a new repository at the target, with a new password unless one is stored. */
export async function initializeTarget(db: DbOrTx, actor: UserPrincipal): Promise<void> {
  await testTarget(db);
  const target = (await readTarget(db))!;
  if (target.repository.state === "ready")
    throw conflict("The repository exists already", "repository_exists");
  if (target.repository.state === "wrong_password") {
    throw conflict("A repository exists here already. Connect it with its password.", "repository_exists");
  }
  if (target.repository.state === "error") {
    throw conflict(target.repository.message ?? "The bucket cannot be reached", "target_unreachable");
  }
  // The password is stored (as pending) before restic uses it: a repository must
  // never exist without its password being kept. Only a created repository
  // makes it the password that backups and the recovery kit use.
  let used = target;
  if (!target.password && !target.pendingPassword) {
    used = { ...target, pendingPassword: encryptSecret(randomSecret(32)) };
    if (!(await updateIfUnchanged(db, target, { pendingPassword: used.pendingPassword }))) {
      throw changedMeanwhile();
    }
  }
  const stored = used.password ?? used.pendingPassword!;
  const password = decryptSecret(stored);
  await initRepository({
    url: repositoryUrl(target),
    accessKeyId: target.accessKeyId,
    secretAccessKey: decryptSecret(target.secretAccessKey),
    region: target.region,
    password,
  });
  const ready = await updateIfUnchanged(db, used, {
    password: stored,
    pendingPassword: null,
    repository: { state: "ready", message: null, checkedAt: new Date().toISOString() },
    recoveryKitConfirmedAt: null,
  });
  if (!ready) throw changedMeanwhile();
  await audit(db, actor, {
    action: "repository.create",
    entityType: "target",
    summary: `Created the repository at ${repositoryUrl(target)}`,
  });
}

/** Uses an existing repository (e.g. after reinstalling the app) with its password. */
export async function connectTarget(db: DbOrTx, password: string, actor: UserPrincipal): Promise<void> {
  const target = await readTarget(db);
  if (!target) throw conflict("Save the target first", "no_target");
  const probe = await probeRepository({
    url: repositoryUrl(target),
    accessKeyId: target.accessKeyId,
    secretAccessKey: decryptSecret(target.secretAccessKey),
    region: target.region,
    password,
  });
  if (probe.state === "wrong_password")
    throw validationError({ password: "This password does not open the repository" });
  if (probe.state === "missing")
    throw conflict("There is no repository at this location yet", "repository_missing");
  if (probe.state === "error") throw conflict(probe.message, "target_unreachable");
  const connected = await updateIfUnchanged(db, target, {
    password: encryptSecret(password),
    pendingPassword: null,
    repository: { state: "ready", message: null, checkedAt: new Date().toISOString() },
    recoveryKitConfirmedAt: null,
  });
  if (!connected) throw changedMeanwhile();
  await audit(db, actor, {
    action: "repository.connect",
    entityType: "target",
    summary: `Connected the existing repository at ${repositoryUrl(target)}`,
  });
}

export async function confirmRecoveryKit(db: DbOrTx, actor: UserPrincipal) {
  const target = await readTarget(db);
  if (!target?.password) throw conflict("Create or connect the repository first", "no_repository");
  await writeSetting(db, TARGET_KEY, { ...target, recoveryKitConfirmedAt: new Date().toISOString() });
  await audit(db, actor, {
    action: "recovery_kit.confirm",
    entityType: "target",
    summary: "Confirmed that the recovery kit is stored",
  });
}

/**
 * The recovery kit: everything the plain restic command line needs to
 * restore every source without this app, and which tag is which source.
 */
export function recoveryKitText(
  target: StoredTarget,
  sources: { id: string; name: string; kind: string }[],
  createdAt: Date,
): string {
  const repository = repositoryOf(target)!;
  const lines = [
    "MELDGROVE BACKUPS: RECOVERY KIT",
    "",
    `Created: ${createdAt.toISOString()} by ${config().APP_URL}`,
    "",
    "Keep this file offline and private (password manager, safe). With it, anyone",
    "can read every backup. Without it, the backups cannot be restored when this",
    "app and its database are lost.",
    "",
    "Repository",
    `  RESTIC_REPOSITORY=${repository.url}`,
    `  RESTIC_PASSWORD=${repository.password}`,
    `  AWS_ACCESS_KEY_ID=${repository.accessKeyId}`,
    `  AWS_SECRET_ACCESS_KEY=${repository.secretAccessKey}`,
    ...(repository.region ? [`  AWS_DEFAULT_REGION=${repository.region}`] : []),
    "",
    "Restore with restic (https://restic.net), on any computer:",
    "  1. Set the variables above in a shell (export NAME=value).",
    "  2. restic snapshots                       # every snapshot, with its tag",
    "  3. restic snapshots --tag source:<id>     # the snapshots of one source",
    "  4. Meldgrove app:   restic dump <snapshot> /backup.tar > backup.tar",
    "     Other sources:   restic restore <snapshot> --target ./restore",
    "     This app:        restic dump <snapshot> /backups.dump > backups.dump",
    "  5. The restore guide: https://github.com/meldgrove/backups/blob/stable/docs/restore.md",
    "",
    "Sources (tag: name, kind)",
    ...sources.map((source) => `  source:${source.id}: ${source.name} (${source.kind})`),
    "  source:self: this app's own database (pg_dump)",
    "",
  ];
  return lines.join("\n");
}

export type { TargetInput };
