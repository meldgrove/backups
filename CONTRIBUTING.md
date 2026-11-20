# Contributing

Meldgrove Backups is a Hono server and a React web app in one repository
(npm workspaces). `AGENTS.md` has the layout and the rules; this file has
the setup and the checks.

## Development setup

Requirements: Node.js 26, Docker with Compose, and
[restic](https://restic.net) 0.19 on the `PATH` (`rclone` too, to try Google
Drive).

```sh
docker compose -f compose.dev.yaml up -d
cp .env.example .env.local
npm ci
npm run dev
```

- Web app: http://localhost:5173 (Vite, passes `/api` and `/-` to the server)
- Server: http://localhost:3000
- Keycloak: http://localhost:8114 (admin / admin), realm `backups`. Test
  users (password `backups-dev`): `ada@example.org` (admin by
  `ADMIN_EMAILS`), `grace@example.org` (admin by the group
  `/backup-admins`), `rita@example.org` (no admin: refused).
- S3 storage (RustFS): endpoint http://localhost:9114, console
  http://localhost:9115, key `backups` / `backups-dev-secret`, bucket
  `backups` with Object Lock and lifecycle rules.
- Mailpit: http://localhost:8125 (SMTP `localhost:1035`, no security).

To try an app source, run the [backup agent](https://github.com/meldgrove/backup-agent)
with `BACKUP_URL=http://localhost:3000` and the token the app shows.

## Checks

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:integration   # PostgreSQL, S3 and Mailpit of compose.dev.yaml, restic
npm run build
```

CI runs these, checks that the migrations match the schema, and builds the
Docker image.

## Database changes

Change the schema in `apps/server/src/db/schema/`, run
`npm run db:generate`, and commit the new file in `apps/server/drizzle/`.

## Tests

Unit tests sit next to the code (`*.test.ts`), integration tests too
(`*.int.test.ts`). Integration tests create a fresh repository in the test
bucket for each test that needs one.

## Pull requests

Write the title as a release-note line. Label a pull request `breaking`
when the people who run the app must act on upgrade, and describe the steps
in it. Update the docs when behavior or configuration changes.

## Releases

A release bundles everything merged to `main` since the previous one.
Maintainers start it by hand with **Actions → Release → Run workflow**
(the shared Meldgrove release workflow): it tags the next `vX.Y.Z` on a
`main` commit that passed CI, publishes `ghcr.io/meldgrove/backups` for
amd64 and arm64, moves the branch `stable`, and writes the release notes from
the pull request titles. No file holds the version.

While the version is below 1.0.0, a **patch** release installs without anyone
acting (fixes, features, automatic migrations), and a **minor** release needs
action (label `breaking`). 1.0.0 is a deliberate decision of the
maintainers.

1. Wait for CI to pass on the latest `main` commit.
2. Run the workflow with **Dry run** to see the version, tags and notes.
3. Run it again without **Dry run**.
4. For a release that needs action, put the steps at the top of its notes.

Release builds upload the source maps to the Sentry project
`meldgrove/backups` with the organization secret `SENTRY_AUTH_TOKEN`
(Dockerfile). Without the secret, the release warns and uploads nothing.

The versions of restic and rclone are build arguments in the `Dockerfile`,
with their SHA-256 checksums; update them by hand (Dependabot does not see
them), together with `RESTIC_VERSION` in `.github/workflows/ci.yml`.

## Data, secrets and privacy

Never commit secrets, real personal data or data from a real organization,
also not in tests and fixtures. Use `example.org` addresses and invented
content.
