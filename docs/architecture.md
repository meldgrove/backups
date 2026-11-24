# Architecture

How Meldgrove Backups works inside. Rules for changing it are in
`AGENTS.md`.

```text
app server(s)                                   Meldgrove Backups
┌ app · postgres · volumes ┐                    ┌ web ── agents' uploads ──┐
│ backup-agent ────────────┼── HTTPS (out) ────►│        restic backup ────┼──► S3 bucket
└──────────────────────────┘                    │ worker: schedules        │    (restic repository:
Google Drive ◄── rclone (read-only) ────────────┤  Drive, S3, Personio,    │     encrypted, deduplicated,
S3 bucket ◄───── rclone (read-only) ────────────┤  self, upkeep, alerts    │     Object Lock)
Personio API ◄── fetch (read-only) ─────────────┤                          │
                                                └─ PostgreSQL ─────────────┘
```

## The engine: restic

Everything goes into one restic repository in the target bucket. Each
source's snapshots carry the tag `source:<source id>` (this app's own
database: `source:self`) and the host `meldgrove-backups`; retention groups
snapshots by tag. restic encrypts (AES-256), deduplicates (content-defined
chunks, also across sources), compresses, and checks the repository.

restic runs as a child process with the repository in its environment
(`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_*`), never in its arguments,
and without the app's own environment. Its cache is in `DATA_DIR/cache`.
Backups use `--retry-lock 30m`, the upkeep `--retry-lock 2h`, so the two
wait for each other instead of failing.

## Runs

A run is one backup of a source, one backup of this app's database
(`self`), or one upkeep (`maintenance`). Each has a status (`queued`,
`running`, `succeeded`, `warning`, `failed`, `cancelled`), a log of steps and
problems (at most 400 lines), and on success the snapshot ID and restic's
summary.

- **Planning** (worker, every 30 s): each enabled source whose `nextRunAt`
  passed gets a queued run (unless one is queued or running); its next time
  comes from its schedule (a cron expression in `TZ`). The daily upkeep
  queues `self` and `maintenance`.
- **Executing** (worker, one at a time): Google Drive, S3 bucket and
  Personio backups, `self`, and the upkeep. The upkeep starts only while no
  backup runs.
- **App sources** wait for their agent. A queued run nobody picks up within
  2 hours fails.
- **Cancelling** a queued run ends it at once; a running one stops within
  seconds (its process checks).
- A process that restarts marks the runs it was running as failed.

## App sources: the agent protocol

The protocol is the contract in the
[backup agent's README](https://github.com/meldgrove/backup-agent#protocol);
the server side is `sources/agent.ts`.

1. The agent polls `POST /api/agent/v1/poll` with its token (stored as
   SHA-256). The answer records what it reports and hands out the source's
   oldest queued run, unless the upkeep runs.
2. On pickup, `web` starts `restic backup --stdin --stdin-filename
backup.tar` and keeps an upload session in memory.
3. The agent sends the tar stream in parts (`PUT …/parts/<n>`, 16 MiB, each
   with its SHA-256). Parts are handled one at a time; each is answered only
   after restic took it, so a slow bucket slows the agent down. A repeated
   part (lost answer) is accepted once.
4. `POST …/complete` brings the totals (parts, bytes, SHA-256 of the whole
   stream). Only when they match does restic's input close and the snapshot
   get written; otherwise restic is stopped and nothing is saved.
5. `POST …/progress` keeps a long `pg_dump` alive; `POST …/fail` reports
   that the agent could not produce the stream. No part or progress for 60
   minutes ends the upload.

## Google Drive, S3 buckets and Personio

Each is copied into `DATA_DIR/staging/<source id>` and then backed up with
`restic backup <folder>`. The copy stays between runs, so each run fetches
only what changed.

- **Google Drive:** rclone with a remote defined in its environment
  (`RCLONE_CONFIG_GDRIVE_*`: service account key, `impersonate`, scope
  `drive.readonly`, shared drive or root folder, export formats), `rclone
sync` per shared drive or folder. Errors about single files become
  warnings; any other error fails the run before restic runs.
- **S3 bucket:** `sources/s3-bucket.ts`, rclone with a remote defined in
  its environment (`RCLONE_CONFIG_S3SOURCE_*`: provider `Other`, endpoint,
  region, the key), `rclone sync` of the bucket or one folder in it, with
  the server's upload time as modification time (no extra request per
  object). The same rules for errors as Google Drive.
- **Personio:** `sources/personio.ts`, with the v2 token (which v1
  endpoints accept; the v1 token as a fallback), at most about seven
  requests per second, retries on 429 and 5xx.

## The target

`target/target.ts` stores the bucket's address and keys and the repository
password (encrypted with `ENCRYPTION_KEY`) in the `settings` table. **Test
connection** opens the repository (`restic cat config`: ready, missing, or
wrong password) and reads the bucket's versioning, Object Lock and lifecycle
rules with three signed S3 requests (`target/bucket.ts`). **Create
repository** runs `restic init` with a new random password; **Connect**
takes the password of an existing one. Both run one at a time, also across
processes (the web app and the operator command), under a PostgreSQL
advisory lock. The recovery kit is generated from the stored values on each
download.

## Alerts

The worker compares each source's status with the last alert it sent
(`sources.alert_state`): a new problem (failed, overdue) sends one email,
the way back to OK another. The heartbeat URL is called every 15 minutes
while there is no problem and the repository is ready.

## Access

Only admins sign in (Better Auth, generic OpenID Connect; `auth/sign-in.ts`
checks `ADMIN_EMAILS` and `ADMIN_GROUPS` at every sign-in and keeps none of
the provider's tokens). Every `/api/v1` route requires an admin; changes need
the app's own `Origin`. Changes and downloads are in the audit log.

## The operator command

`cli` in the image runs `dist/cli.mjs` (`src/cli.ts`): `cli settings`
lists, shows, applies, removes and tests the settings of the admin pages
(`target`, `maintenance`, `sources`, `notifications`), and `cli target`,
`cli sources run` and `cli tokens create agent` press the pages' buttons.
Each setting name is a module in `src/cli/` that calls the same service
functions as the routes, with the same shared schemas and `parseJsonBody`
(`http/json.ts`). The actor is an `operator` (`auth/principal.ts`), which
only `src/cli` creates and no request can carry; the audit log shows it as
`operator`, with the command after the summary. The command reads bodies
from stdin, logs to stderr, starts no server or worker, and exits; web and
worker read these settings from the database on each use, so nothing has
to be told.
