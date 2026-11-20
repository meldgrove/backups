# Meldgrove Backups

Self-hosted backups of what an organization cannot lose: the database and
files of every Meldgrove app, Google Drive, Personio, and S3 buckets,
encrypted and deduplicated into one repository in S3-compatible storage such
as Hetzner Object Storage.

- **One dashboard.** Every source with its status (OK, failed, overdue,
  running), its last successful backup, size and next run; the target with
  its size, integrity check and protection; the runs with their logs.
- **Meldgrove apps** through the
  [backup agent](https://github.com/meldgrove/backup-agent), a small
  sidecar in each app's compose file: it streams a `pg_dump` and the app's
  volumes on request, connects out over HTTPS, and opens no port.
- **Google Drive** (Google Workspace): a shared drive or folders, through a
  service account with domain-wide delegation and read-only access. Google
  Docs, Sheets and Slides are saved as Office files.
- **Personio:** every person with every attribute the API credential may
  read (JSON and CSV), and each person's documents.
- **S3 buckets:** the objects of an S3-compatible bucket, or of one folder
  in it, through a read-only key; for example the files Meldgrove Library
  keeps in a bucket.
- **restic does the work:** encryption, deduplication, compression,
  snapshots, retention per source and integrity checks. One schedule and
  one retention per source; a daily upkeep.
- **Restore without the app:** the recovery kit holds the bucket's address,
  keys and the repository password, so the plain restic command line
  restores everything even when this app is gone. In the app, each snapshot
  downloads as a tar or zip file.
- **Alerts** by email when a backup fails or is overdue, and a heartbeat URL
  for an outside monitor, which raises the alarm when the app itself stops.
- **Admins only:** sign-in with any OpenID Connect provider, for the
  addresses in `ADMIN_EMAILS` or the groups in `ADMIN_GROUPS`. An audit log
  records every change and download.

Hono server, React web app, PostgreSQL, restic, rclone, one Docker image.

## Documentation

- [Deployment](docs/deployment.md): the server, the bucket (Hetzner Object
  Storage with Object Lock and lifecycle rules), upgrades, automatic updates.
- [Coolify](docs/coolify.md): running it on Coolify instead.
- [Sources](docs/sources.md): connecting Meldgrove apps, Google Drive,
  Personio and S3 buckets.
- [Restore](docs/restore.md): getting data back, with or without the app.
- [Configuration](docs/configuration.md): every environment variable.
- [Architecture](docs/architecture.md): how it works inside.
- [Contributing](CONTRIBUTING.md): development setup, checks, releases.

## Quick start (development)

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18, Keycloak, S3 storage, Mailpit
cp .env.example .env.local
npm ci
npm run dev
```

The development server needs `restic` on the `PATH` (and `rclone` for Google
Drive and S3 buckets). Open http://localhost:5173 and sign in as
`ada@example.org` (password `backups-dev`). Set the target under
**Settings → Target** with the values in `.env.example`, create the
repository, then add a source.
