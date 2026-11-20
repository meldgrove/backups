# Configuration

Environment variables of Meldgrove Backups, set in `.env` next to
`compose.yaml` (or in Coolify's environment variables). Blank values count
as unset. Everything else (the target, sources, schedules, retention,
alerts) is set up in the app.

## Required

| Variable                                              | Meaning                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUPS_VERSION`                                     | Compose only: the release to run, e.g. `0.1.0`, or a series such as `0.1`.                                                                                                                                                       |
| `APP_URL`                                             | The public URL, e.g. `https://backups.example.org`. Agents use it too.                                                                                                                                                           |
| `DATABASE_URL`                                        | PostgreSQL, e.g. `postgres://backups:…@postgres:5432/backups`.                                                                                                                                                                   |
| `AUTH_SECRET`                                         | Signs sessions. At least 32 characters: `openssl rand -base64 32`.                                                                                                                                                               |
| `ENCRYPTION_KEY`                                      | Encrypts stored secrets (the bucket's keys, the repository password, service account keys, client secrets, the SMTP password). 32 bytes, base64: `openssl rand -base64 32`. Changing it makes them unreadable: enter them again. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The OpenID Connect provider; redirect URL `<APP_URL>/api/auth/callback/oidc`.                                                                                                                                                    |

## Sign-in and admins

Only admins sign in. A person is an admin when their address is in
`ADMIN_EMAILS` or they are in a group of `ADMIN_GROUPS`; everyone else is
refused. This is checked at every sign-in.

| Variable                      | Default                | Meaning                                                                                                                                     |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_EMAILS`                |                        | Comma-separated addresses. People removed from it lose access when the app restarts.                                                        |
| `ADMIN_GROUPS`                |                        | Comma-separated groups from `OIDC_GROUPS_CLAIM`, e.g. `/backup-admins`. Keycloak group paths include subgroups.                             |
| `OIDC_GROUPS_CLAIM`           | `groups`               | The claim with a person's groups (ID token or userinfo). A dotted name reads a nested claim.                                                |
| `OIDC_PROVIDER_NAME`          | `single sign-on`       | Shown on the sign-in button.                                                                                                                |
| `OIDC_SCOPES`                 | `openid email profile` | Add the scope that brings the groups, if your provider needs one.                                                                           |
| `OIDC_PKCE`                   | `true`                 | Turn off only for providers that reject PKCE.                                                                                               |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | `true`                 | Sign in only with addresses the provider verified (`email_verified`). Turn off only for providers that do not send it (Microsoft Entra ID). |
| `SESSION_HOURS`               | `12`                   | Sessions end this many hours after sign-in.                                                                                                 |
| `APP_NAME`                    | `Backups`              | The name in the browser and on the sign-in page.                                                                                            |

## Backups

| Variable                                           | Default         | Meaning                                                                                                          |
| -------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TZ`                                               | `UTC`           | The time zone of schedules and the daily upkeep, e.g. `Europe/Berlin`.                                           |
| `DATA_DIR`                                         | `/data` (image) | Local copies of Google Drive and Personio (`staging/`) and restic's cache (`cache/`). A volume.                  |
| `AGENT_PART_MB`                                    | `16`            | Size of the parts in which agents send their streams. The reverse proxy must accept request bodies of this size. |
| `AGENT_POLL_SECONDS`                               | `30`            | How often agents ask for work.                                                                                   |
| `RUN_HISTORY_DAYS`                                 | `180`           | Finished runs older than this are deleted (the newest of each source stays). `0` keeps them all.                 |
| `AUDIT_LOG_DAYS`                                   | `730`           | Audit log entries older than this are deleted. `0` keeps them all.                                               |
| `RESTIC_BINARY`, `RCLONE_BINARY`, `PG_DUMP_BINARY` | the image's     | The programs, for development outside the image.                                                                 |

## Processes and server

| Variable                             | Default                         | Meaning                                                                                  |
| ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `APP_ROLE`                           | `all`                           | Set by the image's command: `all`, `web`, `worker`, `migrate`.                           |
| `PORT`, `HOST`                       | `3000`, `0.0.0.0`               | Where `web` listens in the container.                                                    |
| `BACKUPS_PORT`                       | `3000`                          | Compose only: the host port on `127.0.0.1`.                                              |
| `TRUST_PROXY`                        | `true` in Compose               | Reverse proxies in front that set `X-Forwarded-For`: `true` (one), a number, or `false`. |
| `RUN_MIGRATIONS`                     | `false`                         | Apply migrations at start (single-container setups).                                     |
| `DATABASE_POOL_SIZE`                 | `10`                            | Connections per process.                                                                 |
| `DATABASE_STATEMENT_TIMEOUT_SECONDS` | `60`                            | Longest statement; `0`: no limit.                                                        |
| `LOG_LEVEL`                          | `info`                          | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                            |
| `WORKER_HEARTBEAT_FILE`              | `/tmp/worker-heartbeat` (image) | Touched by the worker every few seconds, for health checks.                              |
| `UPDATER_URL`                        | `http://updater:8080`           | The updater's API for the update button; empty switches the button off.                  |

## Automatic updates (Compose only)

| Variable                                               | Default | Meaning                                                                         |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `UPDATE_COOLDOWN`                                      | `3d`    | Stable releases install once out this long.                                     |
| `UPDATE_WINDOW`                                        |         | Automatic installs only between two times, e.g. `05:30-07:00` (time zone `TZ`). |
| `UPDATE_REGISTRY_USERNAME`, `UPDATE_REGISTRY_PASSWORD` |         | Only while the image is private.                                                |
| `UPDATE_DEPLOY_HOOK_URL`, `UPDATE_DEPLOY_HOOK_TOKEN`   |         | Coolify only ([Coolify](coolify.md)).                                           |

## Error reports (Sentry)

| Variable                    | Default                 | Meaning                                                          |
| --------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `SENTRY_DSN`                |                         | Error reports to Sentry or a compatible service; off when unset. |
| `SENTRY_ENVIRONMENT`        | `NODE_ENV`              |                                                                  |
| `SENTRY_RELEASE`            | `backups@<APP_VERSION>` |                                                                  |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`                     | Share of requests and page loads traced, 0 to 1.                 |
