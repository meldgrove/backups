# Deployment

For the person who runs Meldgrove Backups on a Linux server, such as a VPS
with Debian or Ubuntu: requirements, [the bucket](#the-bucket),
[setup](#setup), upgrades, automatic updates, and what the app backs up of
itself. Every environment variable is described in
[Configuration](configuration.md). To run it on Coolify instead, see
[Coolify](coolify.md). Connecting sources: [Sources](sources.md).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and a
  domain name that points at it. Preferably its own server, not the one of
  the apps it backs up: then losing that server does not take the backups'
  orchestration with it.
- **PostgreSQL 16 or later:** a database of your own, or the one
  `compose.postgres.yaml` adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS
  and accepts request bodies of 16 MiB (the agents send their streams in
  parts of that size; `AGENT_PART_MB` changes it). Caddy and Traefik accept
  them as they are; nginx needs `client_max_body_size 20m;`.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …).
- **An S3-compatible bucket** for the backups ([below](#the-bucket)).
- **Disk space** in the `data` volume for the local copies of Google Drive
  and Personio (as much as they hold) and restic's cache (a few percent of
  the repository).

## What runs

Each [release](https://github.com/meldgrove/backups/releases) publishes the
image `ghcr.io/meldgrove/backups` for linux/amd64 and linux/arm64, tagged
with its version (`0.1.0`), its series (`0.1`; from 1.0.0 the major version,
`1`) and `latest`. A release that needs manual steps starts a new series, so
the releases within a series install without anyone acting. Every change on
`main` whose checks pass is published as a preview, tagged `0.1.1-preview.3`
(three changes after 0.1.0) and `preview`.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image, with restic, rclone and pg_dump 18. Its command picks the role.         |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |
| `compose.coolify.yaml`  | The same as `compose.yaml`, for [Coolify](coolify.md).                             |

- **`web`** serves the interface and receives the agents' uploads (each
  upload runs a restic process in it). Run exactly one `web`: an upload lives
  in its memory.
- **`worker`** plans the runs, backs up Google Drive, Personio and the app's
  own database one at a time, runs the daily upkeep, and sends alerts.

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`BACKUPS_PORT` changes the host port. `web` and `worker` share the volume
`data` (`/data`).

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data`.

## The bucket

Any S3-compatible storage works: Hetzner Object Storage, AWS S3, Backblaze
B2, Scaleway, OVHcloud, IONOS, MinIO. These steps are for Hetzner Object
Storage. They give the backups three protections:

- **Another place:** the bucket in another location than the servers (servers
  in Falkenstein or Nuremberg, the bucket in Helsinki).
- **Other keys:** the bucket in a Hetzner project of its own. Hetzner's S3
  keys are valid for every bucket of their project, so the apps' projects
  never hold keys that reach the backups.
- **Object Lock:** stored objects cannot be changed or deleted for 30 days,
  not even with the keys. When restic deletes old data, the bucket keeps the
  locked versions, so a stolen key or ransomware cannot wipe the backups
  within that time.

Steps:

1. In the [Hetzner Console](https://console.hetzner.com), create a project,
   for example `backups`.
2. In it, create a bucket under Object Storage: a location other than the
   servers', private, and **Object Lock enabled**. Object Lock can only be
   turned on when the bucket is created; it also turns on versioning.
3. In the same project, create S3 credentials (a key pair) in the Console.
   Copy the secret key: Hetzner shows it once.
4. Set the default retention and the lifecycle rules with the AWS command
   line (Hetzner sets lifecycle rules only through the S3 API, not in the
   Console). With the key in `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`:

   ```sh
   E=https://hel1.your-objectstorage.com   # the bucket's location
   B=acme-backups                          # the bucket's name
   aws s3api put-object-lock-configuration --endpoint-url "$E" --bucket "$B" \
     --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}'
   aws s3api put-bucket-lifecycle-configuration --endpoint-url "$E" --bucket "$B" \
     --lifecycle-configuration '{"Rules":[
       {"ID":"old-versions","Status":"Enabled","Prefix":"",
        "NoncurrentVersionExpiration":{"NoncurrentDays":31},
        "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}},
       {"ID":"delete-markers","Status":"Enabled","Prefix":"",
        "Expiration":{"ExpiredObjectDeleteMarker":true}}]}'
   ```

   - **Old versions** (what restic deleted) are removed 31 days after restic
     deleted them, and never while their lock (30 days from their upload)
     lasts. Without this rule, Hetzner keeps them, and bills them, forever. Hetzner supports only
     `NoncurrentDays` here, no "keep the last N versions".
   - **Delete markers** that are left alone are removed.
   - **Incomplete uploads** are removed after 7 days.

   Deleted data thus stays in the bucket for 31 days after restic deletes
   it. Longer periods protect longer and cost more storage; keep
   `NoncurrentDays` longer than the lock.

5. In the app, under **Settings → Target**: endpoint
   `https://hel1.your-objectstorage.com`, region `hel1`, the bucket, the
   key. **Test connection**, then **Create repository**: the app generates
   the repository password. The page shows what the bucket protects
   (versioning, Object Lock, lifecycle rules), read from the bucket itself.
6. **Download the recovery kit** and store it offline (password manager,
   safe). It holds the bucket's address, the key and the repository
   password: with it, restic restores everything without this app
   ([Restore](restore.md)). Without it, nobody can restore the backups when
   this app and its database are lost.

Governance mode lets someone with the special permission delete locked
objects early; compliance mode (`"Mode":"COMPLIANCE"`) lets nobody, not
even Hetzner's support, until the lock ends. Hetzner deletes all data when
the contract ends, Object Lock or not.

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/backups.git /srv/backups
   cd /srv/backups
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc`.
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `BACKUPS_VERSION` (a series
   such as `0.1`), `APP_URL`, `DATABASE_URL`, a new `AUTH_SECRET` and a new
   `ENCRYPTION_KEY` (each `openssl rand -base64 32`), the `OIDC_*` values,
   the admins in `ADMIN_EMAILS` or `ADMIN_GROUPS`, and `TZ` (the schedules'
   time zone, e.g. `Europe/Berlin`). Remove `NODE_ENV=development`,
   `RUN_MIGRATIONS` and `DATA_DIR`. With an `https` `APP_URL`, the app does
   not start with the example secrets. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://backups:<POSTGRES_PASSWORD>@postgres:5432/backups`.
   Keep a copy of `.env` with the recovery kit: `ENCRYPTION_KEY` opens the
   secrets the database stores.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   backups.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. With `BACKUPS_PORT` set, use that port
   instead of 3000.

7. Open `APP_URL`, sign in, and set up the target as
   [above](#the-bucket), then the alerts (**Settings → Notifications**) and
   the [sources](sources.md).
8. **Automatic updates:** [set them up](#setup-on-the-server).

## Alerts

Under **Settings → Notifications**:

- **Email** over SMTP to the recipients: once when a source's backup fails
  or is overdue (no success for one and a half intervals), once when it works
  again, and when the daily upkeep fails. **Send test email** checks the
  settings.
- **Heartbeat URL:** while every source is fine and the repository is
  ready, the worker calls this URL every 15 minutes. Create a check at a
  monitor (healthchecks.io, Uptime Kuma, Better Stack, …) with a period of
  15 minutes and a grace time of about an hour: it alerts when the calls
  stop, also when this app or its server is down.

## The daily upkeep

At the time set under **Settings → Target** (default 04:30, time zone `TZ`),
the worker backs up the app's own database (`pg_dump`, tag `source:self`,
kept 14 days, 8 weeks, 12 months), then applies each source's retention,
removes data no snapshot needs (`restic prune`), checks the repository's
structure (on Sundays it also reads and verifies a random 5% of the
data), measures its size, and reads the bucket's protection
settings again. A failed upkeep sends an alert.

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should, so the check fails.

The heartbeat URL is the outside check of the backups themselves; set up an
uptime check on `<APP_URL>/-/readyz` too, if you have one.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then move to the new series: in `/srv/backups`, run
   `git pull` (the newest release's `compose.yaml`), change
   `BACKUPS_VERSION` in `.env`, and run `docker compose up -d --pull always`.
   With automatic updates, run only the `git pull` and let the update
   button install it (**Install anyway…**).

The `migrate` service applies database migrations before `web` and `worker`
start. An upload that runs during the restart fails and runs again at its
next time; start it by hand with **Back up now**.

## Automatic updates

The `updater` service ([meldgrove/updater](https://github.com/meldgrove/updater))
keeps the app current, in one of two channels:

- **Stable** (default): releases. A release in the running series installs
  automatically once it has been out for three days (`UPDATE_COOLDOWN`). A
  release with upgrade steps starts a new series: the app shows it, but it
  never installs on its own.
- **Preview**: every change on `main` as soon as its checks pass, before it
  is released. Previews install within the hour.

Set `UPDATE_WINDOW` (such as `05:30-07:00`, in the time zone `TZ`) to keep
installs away from the backup times. Admins see an update icon in the header
and choose the channel under **Settings → Updates**.

### Setup on the server

As root in `/srv/backups`:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The second command writes the setup script from the updater's image; read
it before you run it. It installs a systemd unit that waits for the
updater's requests: for each installation, it writes the exact version into
`BACKUPS_VERSION` in `.env`, pulls the image, runs `docker compose up -d
--wait`, and goes back to the version before when the app does not become
healthy. `journalctl -u meldgrove-updater-backups.service` shows each
installation; `sh updater-setup.sh remove` switches it off.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `backups@<version>`.
Reports never contain file names, names, email addresses, keys, request data
or variables. The worker's alert job checks in as the cron monitor
`backups-alerts`.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (source, run, request), never file names,
personal data or secrets. A run's own log (steps, files that could not be
copied) is on its page in the app.

## Hardening

- Serve the app over HTTPS only. Agents send their token and the backups
  over this connection.
- Keep the admins few: they can download every backup, including the HR
  data from Personio. Every download is in the audit log.
- Keep the recovery kit and a copy of `.env` offline, apart from the server.
- Use a bucket in a project of its own, with Object Lock
  ([The bucket](#the-bucket)).
- Use read-only access for the sources: the service account's Drive scope
  is `drive.readonly`; Personio credentials need only read permissions.
