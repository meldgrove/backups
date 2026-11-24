# AGENTS.md

Meldgrove Backups backs up an organization's vital data (Meldgrove apps
through their backup agent, Google Drive, Personio, S3 buckets) into one restic
repository in S3-compatible storage. User documentation is in `docs/`;
contributor setup is in `CONTRIBUTING.md`; how it works inside is in
`docs/architecture.md`.

## Stack

npm workspaces, Node.js 26, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`, the agents' protocol under
  `/api/agent/v1`), Better Auth (OIDC sign-in under `/api/auth`), Drizzle ORM
  on PostgreSQL, restic and rclone as child processes, aws4fetch (bucket
  settings), croner (schedules), nodemailer, pino logs, Sentry, Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, Tailwind CSS 4
  with `@meldgrove/ui` (theme, components, the app frame, page layout,
  sign-in page, update button). US English.
- `packages/shared` (`@backups/shared/*`): zod schemas of the API
  (`api/*.ts`), schedules and retention, error-report redaction.

One Docker image runs every process: `APP_ROLE` = `all | web | worker | migrate`;
its command `cli …` runs the operator command (`cli settings`, `cli target`,
`cli sources`, `cli tokens`).
It contains restic, rclone and pg_dump 18.

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes
  cli.ts           entry of the operator command; cli/ has one module per setting name
  config.ts        every environment variable (zod); read only via config()
  db/schema/       Drizzle schema (auth.ts, app.ts)
  auth/            Better Auth, the admin check at sign-in
  restic/          the restic program: backup, snapshots, dump, forget, prune, check
  target/          the bucket and repository (target.ts), the bucket's protection settings
  sources/         sources (service.ts; manage.ts: delete, test, back up now), schedules
                   and status, the agents' uploads
                   (agent.ts), Google Drive and S3 buckets (rclone), Personio (API export)
  runs/            runs: create, log, finish, cancel
  worker/          planning runs, executing them one at a time, the daily upkeep
  alerts/          email alerts and the heartbeat
  http/            app factory, middleware, errors
  modules/         one file per API area: routes
apps/web/src/      web app; modules/<area> holds each area's pages; app/navigation.ts
                   the sidebar, its keys and the breadcrumbs of the frame (AppFrame)
packages/shared/src/  contracts, schedules
```

## Rules

- **Contracts first.** Change a request or response in
  `packages/shared/src/api/` and use it on both sides; routes validate input
  with it (`jsonBody`, `queryOf`).
- **Access:** only admins sign in; every `/api/v1` route starts with
  `requireAdmin`. Agents use only `/api/agent/v1` with their source's token.
- **The agent protocol** is the contract in the
  [backup agent's README](https://github.com/meldgrove/backup-agent#protocol)
  (`sources/agent.ts`, `modules/agent.ts`, `packages/shared/src/api/agent.ts`).
  Change both repositories together.
- **No incomplete snapshots:** restic's input closes only after the agent's
  totals match; otherwise restic is stopped. A Google Drive copy that failed
  as a whole is never backed up as if it were current.
- **Secrets** (S3 keys, the repository password, service account keys,
  client secrets, the SMTP password) are stored with `encryptSecret`
  (`ENCRYPTION_KEY`), never returned (the API shows hints) and never logged.
  Agent tokens are stored as SHA-256. restic and rclone get secrets in their
  environment, never in their arguments, and never the app's own environment.
- **Settings** of the admin pages are saved by service functions that the
  routes and the operator command (`cli/`) both call, with the actor (an
  admin, or the `operator` only `cli/` creates). A new setting gets a module
  in `cli/` too; the command takes secrets only on stdin.
- **Errors:** throw `AppError` helpers (`http/errors.ts`) with short, plain
  messages. Messages from restic and rclone go through `redact`.
- **Logging:** `logger` with ids and codes; never file names, personal data
  or secrets. No `console.*`, no `any`.
- **Sentry** gets no personal data: `redactErrorReport` and `redactLog`
  decide what reports and logs keep; no session replays.

## Database

Change the schema in `apps/server/src/db/schema/`, then run
`npm run db:generate` and commit the migration. CI fails when they differ.

## Tests

- Unit tests next to the code (`*.test.ts`); integration tests
  (`*.int.test.ts`) use the PostgreSQL, S3 storage and Mailpit of
  `compose.dev.yaml`, and the real `restic` (`src/test/helpers.ts`:
  `resetDatabase`, `createUser`, `setUpTarget`, `request`).
- API tests act as admins with
  `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))` and the
  `userId` option; agents send their token (`token` option).

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL (55460), Keycloak (8114), S3 (9114), Mailpit (8125)
cp .env.example .env.local
npm ci
npm run dev                                # web app http://localhost:5173, server :3000

npm run lint && npm run format:check && npm run typecheck && npm test
npm run test:integration                   # needs restic and rclone on the PATH
npm run build
```

Releases: Actions → Release → Run workflow (shared Meldgrove workflow; see
`CONTRIBUTING.md`). No file holds the version.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.org` addresses and invented content.
