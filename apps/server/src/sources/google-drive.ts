import { spawn } from "node:child_process";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { DriveConfig, SourceTest } from "@backups/shared/api/sources";
import { config } from "../config";
import { redact } from "../restic/restic";
import { parseServiceAccountKey, sourceSecret, type SourceRow } from "./service";

/*
 * Google Drive through rclone: a service account with domain-wide
 * delegation acts as a Workspace user (`subject`) with read-only access
 * (scope drive.readonly) and copies a shared drive or folders into the
 * source's local copy. rclone copies only what changed since the last run,
 * follows Google's rate limits and exports Google Docs, Sheets and Slides
 * as docx, xlsx and pptx. restic then backs up the local copy.
 */

/** Google Docs, Sheets, Slides and Drawings as Office files and SVG. */
const EXPORT_FORMATS = "docx,xlsx,pptx,svg";

type Remote = { env: Record<string, string>; target: string };

/** The rclone remote of each part of the source (the shared drive, or each folder) and its folder in the copy. */
export function remotesOf(source: Pick<SourceRow, "config">, key: string): Remote[] {
  const drive = source.config as DriveConfig;
  const base = {
    RCLONE_CONFIG_GDRIVE_TYPE: "drive",
    RCLONE_CONFIG_GDRIVE_SCOPE: "drive.readonly",
    RCLONE_CONFIG_GDRIVE_SERVICE_ACCOUNT_CREDENTIALS: JSON.stringify(JSON.parse(key)),
    RCLONE_CONFIG_GDRIVE_IMPERSONATE: drive.subject,
    RCLONE_CONFIG_GDRIVE_EXPORT_FORMATS: EXPORT_FORMATS,
    RCLONE_CONFIG_GDRIVE_SKIP_SHORTCUTS: "true",
  };
  if (drive.scope.type === "shared_drive") {
    return [{ env: { ...base, RCLONE_CONFIG_GDRIVE_TEAM_DRIVE: drive.scope.driveId }, target: "" }];
  }
  const used = new Set<string>();
  return drive.scope.folders.map((folder) => {
    let name = folderName(folder.label) || folder.id;
    for (let index = 2; used.has(name.toLowerCase()); index += 1)
      name = `${folderName(folder.label)} ${index}`;
    used.add(name.toLowerCase());
    return { env: { ...base, RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID: folder.id }, target: name };
  });
}

/** A folder name safe on every file system. */
export function folderName(label: string): string {
  return (
    label
      // eslint-disable-next-line no-control-regex -- control characters are what this removes
      .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .slice(0, 100)
      .trim()
  );
}

type RcloneResult = { code: number | null; stdout: string; errors: RcloneError[] };
/** An error rclone logged; `object` names the file or folder, when it is about one. */
export type RcloneError = { message: string; object: string | null };

/** Reads rclone's JSON log (stderr, --use-json-log): the errors. */
export function parseRcloneLog(text: string): RcloneError[] {
  const errors: RcloneError[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { level?: string; msg?: string; object?: string };
      if (entry.level === "error" || entry.level === "critical") {
        errors.push({
          message: redact(String(entry.msg ?? "error")).slice(0, 500),
          object: entry.object || null,
        });
      }
    } catch {
      if (/error|failed/i.test(line)) errors.push({ message: redact(line).slice(0, 500), object: null });
    }
  }
  return errors;
}

function rclone(args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<RcloneResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config().RCLONE_BINARY,
      [...args, "--config", "", "--use-json-log", "--log-level", "NOTICE"],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: path.resolve(config().DATA_DIR),
          TZ: config().TZ,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000_000);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The rclone program is not installed"
            : "rclone could not start",
        ),
      );
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, errors: parseRcloneLog(stderr) });
    });
  });
}

/** Where the source's local copy lives. */
export function stagingDir(sourceId: string) {
  return path.resolve(config().DATA_DIR, "staging", sourceId);
}

export async function freeBytes(directory: string): Promise<number | null> {
  try {
    await mkdir(directory, { recursive: true });
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** What went wrong, in one line: the first error that is not about a single file, else the first. */
function summary(errors: RcloneError[], fallback: string) {
  return (errors.find((error) => !error.object) ?? errors[0])?.message ?? fallback;
}

/** Can the service account reach the drive or folders, and how much is there? */
export async function testDrive(source: SourceRow): Promise<SourceTest> {
  const key = sourceSecret(source, "serviceAccountKey");
  if (!parseServiceAccountKey(key)) {
    return {
      ok: false,
      message: "The stored key is not a service account key",
      items: null,
      bytes: null,
      freeBytes: null,
    };
  }
  let items = 0;
  let bytes = 0;
  for (const remote of remotesOf(source, key)) {
    const access = await rclone(
      ["lsf", "gdrive:", "--max-depth", "1"],
      remote.env,
      AbortSignal.timeout(60_000),
    );
    if (access.code !== 0) {
      return {
        ok: false,
        message: `Google Drive refused: ${summary(access.errors, `rclone exited with ${access.code}`)}`,
        items: null,
        bytes: null,
        freeBytes: null,
      };
    }
    const size = await rclone(
      ["size", "gdrive:", "--json", "--fast-list"],
      remote.env,
      AbortSignal.timeout(180_000),
    );
    if (size.code === 0) {
      const counted = JSON.parse(size.stdout || "{}") as { count?: number; bytes?: number };
      items += counted.count ?? 0;
      bytes += Math.max(0, counted.bytes ?? 0);
    } else {
      return {
        ok: true,
        message: "Google Drive answers. Counting the files took too long; the first backup shows the size.",
        items: null,
        bytes: null,
        freeBytes: await freeBytes(stagingDir(source.id)),
      };
    }
  }
  return {
    ok: true,
    message:
      "Google Drive answers. Google Docs, Sheets and Slides count once exported, so the copy can be larger.",
    items,
    bytes,
    freeBytes: await freeBytes(stagingDir(source.id)),
  };
}

export type CopyResult = { warnings: string[]; errors: string[] };

/**
 * Brings the local copy up to date. Errors about single files become
 * warnings (the backup goes on without them); any other error fails the
 * copy, so a backup never saves an outdated copy as if it were current.
 */
export async function copyDrive(
  source: SourceRow,
  options: { signal: AbortSignal; log: (line: string) => Promise<void> },
): Promise<CopyResult> {
  const key = sourceSecret(source, "serviceAccountKey");
  const root = stagingDir(source.id);
  await mkdir(root, { recursive: true });
  const firstRun = (await readdir(root)).length === 0;
  const remotes = remotesOf(source, key);
  if (firstRun) {
    let needed = 0;
    for (const remote of remotes) {
      const size = await rclone(["size", "gdrive:", "--json", "--fast-list"], remote.env, options.signal);
      if (size.code !== 0)
        throw new Error(`Google Drive refused: ${summary(size.errors, `rclone exited with ${size.code}`)}`);
      needed += Math.max(0, (JSON.parse(size.stdout || "{}") as { bytes?: number }).bytes ?? 0);
    }
    const free = await freeBytes(root);
    if (free !== null && needed > free * 0.9) {
      throw new Error(
        `The first copy needs about ${Math.ceil(needed / 1e9)} GB; ${Math.floor(free / 1e9)} GB are free in the data volume`,
      );
    }
    await options.log(`First copy: about ${Math.ceil(needed / 1e6)} MB in Google Drive`);
  }
  const warnings: string[] = [];
  const errors: string[] = [];
  const active = new Set(remotes.map((remote) => remote.target));
  for (const remote of remotes) {
    const destination = remote.target ? path.join(root, remote.target) : root;
    await options.log(remote.target ? `Copying the folder ${remote.target}` : "Copying the shared drive");
    const args = ["sync", "gdrive:", destination, "--fast-list", "--create-empty-src-dirs", "--stats", "0"];
    // Folders: the copy holds one folder per configured folder; leave the others alone.
    const result = await rclone(args, remote.env, options.signal);
    if (options.signal.aborted) throw new Error("Stopped");
    const general = result.errors.filter((error) => !error.object);
    if (result.code !== 0 && (general.length > 0 || result.errors.length === 0)) {
      throw new Error(
        `Google Drive copy failed: ${summary(result.errors, `rclone exited with ${result.code}`)}`,
      );
    }
    for (const error of result.errors) errors.push(`${error.object ?? ""}: ${error.message}`.slice(0, 500));
    if (result.errors.length > 0) {
      warnings.push(
        `${result.errors.length} item(s) could not be copied${remote.target ? ` from ${remote.target}` : ""}`,
      );
    }
  }
  // Folders that were removed from the source's setup leave the copy too.
  if ((source.config as DriveConfig).scope.type === "folders") {
    for (const entry of await readdir(root)) {
      if (!active.has(entry)) await rm(path.join(root, entry), { recursive: true, force: true });
    }
  }
  return { warnings, errors };
}
