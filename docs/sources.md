# Sources

What Meldgrove Backups backs up, and how to connect it. Add a source under
**Sources → Add source**. Each source has its own schedule (every few
hours, daily or weekly, in the server's time zone `TZ`) and its own
retention (the newest snapshot of each of the last N days, weeks, months and
years; the newest snapshot always stays). **Test** checks the connection,
**Back up now** starts a backup at once.

## Meldgrove apps

The app's server runs the
[backup agent](https://github.com/meldgrove/backup-agent), a sidecar
service in the app's compose file. When a backup is due, the agent dumps the
app's database (`pg_dump`) and reads the app's volumes (read-only), and
streams both as one tar file to Backups, which stores it with restic. The
agent connects out over HTTPS; it opens no port and holds no key of the
bucket.

1. In Backups, add a source of the kind **Meldgrove app**, e.g. "Handbook".
   The app shows the agent's token once, with the two lines for the app's
   `.env`:

   ```sh
   BACKUP_URL=https://backups.example.org
   BACKUP_TOKEN=mgb_…
   ```

2. On the app's server, put the lines into the app's `.env` and make sure
   its compose file has the `backup-agent` service (the app's deployment
   guide shows it; apps without it get it with an update). Then
   `docker compose up -d`.
3. The source page shows when the agent last asked, its version, the app's
   image, and the volumes it sees. **Back up now** runs the first backup.

The token belongs to the source; **New token** replaces it (the old one
stops working at once). Each snapshot holds one file, `backup.tar`:
`manifest.json`, `db.dump` (`pg_dump` custom format) and `volumes/<name>/`.

A backup that the agent does not pick up within 2 hours fails ("The agent did
not ask for the job"), so a stopped agent shows up as a failed or overdue
source.

## Google Drive

For Google Workspace. A service account acts, with domain-wide delegation,
as a Workspace user with read-only access to Drive, and copies a shared
drive or a set of folders into the app's local copy (`/data/staging`). Each
run copies only what changed; restic then saves the copy as a snapshot.
Google Docs, Sheets, Slides and Drawings are saved as `.docx`, `.xlsx`,
`.pptx` and `.svg`.

1. **Service account:** in the [Google Cloud console](https://console.cloud.google.com),
   in a project of your organization, enable the Google Drive API, create a
   service account, and create a JSON key for it.
2. **Domain-wide delegation:** in the
   [Google Admin console](https://admin.google.com) under Security → Access
   and data control → API controls → Manage domain-wide delegation, add the
   service account's client ID with the scope
   `https://www.googleapis.com/auth/drive.readonly`.
3. **The user to act as:** a Workspace user that sees what to back up, for
   example a dedicated `backup@example.org`, a member (Viewer is enough) of
   the shared drive, or with the folders shared with it.
4. In Backups, add a source of the kind **Google Drive**: the user's
   address, either the shared drive's ID or the folders' IDs (the last part
   of their address, `drive.google.com/drive/folders/<id>`) with a name for
   each, and the JSON key.
5. **Test** checks access and counts the files. The first backup checks that
   the data volume has room for the copy, and refuses otherwise.

Files that cannot be copied (for example a Google document larger than
Google's export limit) are listed in the run's log, and the run ends with a
warning; the rest is saved. When Google refuses the whole copy (wrong key,
missing delegation), the run fails and saves nothing, so an old copy is
never saved as if it were new. Whether Google's export limit of 10 MB
applies to rclone's way of exporting is not verified.

Why the local copy: the size of a drive is not known in advance, and the
copy lets each run fetch only what changed. It needs as much disk space as
the drive holds. The copy is not encrypted on the app's server; the
snapshots in the bucket are.

## Personio

Every person with every attribute the API credential may read, and each
person's documents. Each run writes:

| File                                        | Content                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `employees.json`                            | Every person as Personio sends them                                                 |
| `employees.csv`                             | One row per person, one column per attribute (UTF-8, opens in spreadsheet programs) |
| `attributes.json`                           | The attributes the credential may read                                              |
| `documents/<id> <last name>, <first name>/` | The person's documents and `documents.json` (their list)                            |
| `document-categories.json`, `export.json`   | Document categories; when and how much was exported                                 |

1. In Personio, create API credentials (Marketplace → Connected
   integrations → Create custom integration; it needs the Core Pro plan)
   with **read** access to the employee attributes to back up and to
   documents. Personio sends only the attributes ticked for the credential.
2. In Backups, add a source of the kind **Personio**: the client ID and
   secret, and whether to back up documents.
3. **Test** counts the people and checks that documents can be listed.

People come from Personio's API v1, documents from its Document Management
API v2, which Personio calls beta. Documents already in the copy are not
downloaded again. Documents that cannot be downloaded (for example marked
unsafe by Personio's virus scan) are listed in the run's log, and the run
ends with a warning. Documents of Personio Payroll and DATEV are not
available through the API.

**Privacy:** these are personnel records under the GDPR. Only admins can
see or download them, and every download is in the audit log. The
retention decides how long the data of people who left stays in the
backups; choose and document that period. A deleted source can take its
snapshots with it (**Delete → Forget its snapshots**); the next upkeep then
removes the data, and the bucket's lifecycle rules remove the old versions
once their lock ends.

## This app

The app backs up its own database every day during the upkeep (tag
`source:self`), so the sources, schedules and run history can be restored
too. Its secrets are encrypted with `ENCRYPTION_KEY`: keep a copy of `.env`
with the recovery kit.
