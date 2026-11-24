# Coolify

For the person who runs Meldgrove Backups on [Coolify](https://coolify.io)
instead of on a Linux server of its own. Coolify uses `compose.coolify.yaml`:
the services of `compose.yaml`, without a host port, pulling the images at
every deploy, and with an `updater` that calls Coolify's deploy link. The
bucket, alerts, the upkeep, health checks, Sentry, logs and hardening are the
same as on a server: see [Deployment](deployment.md). Every environment
variable is described in [Configuration](configuration.md).

## Setup

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/backups`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml`. Under Advanced, set Auto
   deploy to "Manual deployments only", so that only releases deploy, and
   turn on "Connect To Predefined Network", so that the app reaches the
   database.
3. **Domain:** assign the domain, such as `https://backups.example.org`,
   to `web`, port 3000. Coolify's proxy accepts the agents' 16 MiB parts as
   it is.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc`.
5. **Environment variables** of the resource: `BACKUPS_VERSION` (a series
   such as `0.1`, see [Automatic updates](#automatic-updates)), `APP_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `AUTH_SECRET` and a new `ENCRYPTION_KEY` (each `openssl rand -base64 32`),
   the `OIDC_*` values, the admins in `ADMIN_EMAILS` or `ADMIN_GROUPS`,
   `TZ`, and `UPDATER_TOKEN` (`openssl rand -hex 32`; recommended, see
   [Protect the update service](#protect-the-update-service)).
6. **Deploy**, open `APP_URL`, sign in, and set up the target
   ([The bucket](deployment.md#the-bucket)), the alerts and the
   [sources](sources.md), or set them in the terminal
   ([below](#settings-from-the-command-line)).
7. **Automatic updates:** set them up as [below](#automatic-updates).

## Settings from the command line

`cli settings` sets the target, the sources and the alerts without a
browser, as on a server
([Deployment](deployment.md#settings-from-the-command-line)). On Coolify,
open the Terminal of the resource, choose the `web` container and run
`cli settings list`.

- `cli settings apply <name>` in the terminal turns the echo off and asks
  for the body: paste it, press Enter, then Ctrl-D. Nothing pasted is shown.
  A terminal line holds at most 4,095 bytes: paste a long body (such as a
  Google service account key) over several lines.
- `cli target recovery-kit` writes the kit only into a file, never onto the
  terminal. A file in the container is no place for it: download the kit on
  the **Target** page instead.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then change `BACKUPS_VERSION` in the resource's
   environment variables to the new series and redeploy. Coolify reads
   `compose.coolify.yaml` from `stable`, which is at the newest release.

## Automatic updates

On Coolify, the image tag in `BACKUPS_VERSION` decides what installs: a
series such as `0.1` gets its releases, `latest` every release (also those
with upgrade steps), `preview` every preview. Admins see the update button
as on a server, but cannot switch the channel in the app.

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the Backups resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

### Protect the update service

With `UPDATER_TOKEN` set, `compose.coolify.yaml` gives the same token to
the app and to the updater, and the updater's API takes only requests that
carry it. Without it, everything works as before, but anything on the
resource's Docker network can install versions through the API. The token is
recommended, not required. From updater 0.2.4, admins see a warning under
**Settings → Updates** while it is missing.

For a resource that runs without it:

1. Make sure `BACKUPS_VERSION` selects the newest release: its series, or
   the release itself. An older version does not send the token, and its
   update button would stop working. For an older series, take the
   [upgrade](#upgrades) steps first.
2. In the resource's environment variables, add `UPDATER_TOKEN` with a new
   token from `openssl rand -hex 32`, then redeploy. The deploy reads the
   newest release's `compose.coolify.yaml` from `stable` and pulls the
   images again.
