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
   the `OIDC_*` values, the admins in `ADMIN_EMAILS` or `ADMIN_GROUPS`, and
   `TZ`.
6. **Deploy**, open `APP_URL`, sign in, and set up the target
   ([The bucket](deployment.md#the-bucket)), the alerts and the
   [sources](sources.md).
7. **Automatic updates:** set them up as [below](#automatic-updates).

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
