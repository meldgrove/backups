import { describe, expect, it } from "vitest";
import { folderName, parseRcloneLog, remotesOf } from "./google-drive";

const key = JSON.stringify(
  { type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: "x" },
  null,
  2,
);

describe("Google Drive", () => {
  it("builds one rclone remote for a shared drive, read-only, as the Workspace user", () => {
    const [remote] = remotesOf(
      { config: { subject: "backup@example.org", scope: { type: "shared_drive", driveId: "0ABCdefGHIjk" } } },
      key,
    );
    expect(remote!.target).toBe("");
    expect(remote!.env).toMatchObject({
      RCLONE_CONFIG_GDRIVE_TYPE: "drive",
      RCLONE_CONFIG_GDRIVE_SCOPE: "drive.readonly",
      RCLONE_CONFIG_GDRIVE_IMPERSONATE: "backup@example.org",
      RCLONE_CONFIG_GDRIVE_TEAM_DRIVE: "0ABCdefGHIjk",
      RCLONE_CONFIG_GDRIVE_EXPORT_FORMATS: "docx,xlsx,pptx,svg",
    });
    // The key on one line.
    expect(remote!.env.RCLONE_CONFIG_GDRIVE_SERVICE_ACCOUNT_CREDENTIALS).not.toContain("\n");
  });

  it("gives each folder its own, unique folder in the copy", () => {
    const remotes = remotesOf(
      {
        config: {
          subject: "backup@example.org",
          scope: {
            type: "folders",
            folders: [
              { id: "1aaaaaaaaaaa", label: "Finance/2026" },
              { id: "1bbbbbbbbbbb", label: "finance 2026" },
              { id: "1ccccccccccc", label: "Board" },
            ],
          },
        },
      },
      key,
    );
    expect(remotes.map((remote) => remote.target)).toEqual(["Finance 2026", "finance 2026 2", "Board"]);
    expect(remotes[2]!.env.RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID).toBe("1ccccccccccc");
  });

  it("makes folder names safe", () => {
    expect(folderName("  ../a:b*c?  ")).toBe("a b c");
    expect(folderName("\u0000x")).toBe("x");
  });

  it("reads rclone's errors, with and without the file they are about", () => {
    const log = [
      '{"level":"notice","msg":"hello"}',
      '{"level":"error","msg":"Failed to copy: googleapi: Error 403: rate limit","object":"a/b.pdf"}',
      '{"level":"error","msg":"couldn\'t list directory: token https://user:secret@x invalid"}',
      "",
    ].join("\n");
    expect(parseRcloneLog(log)).toEqual([
      { message: "Failed to copy: googleapi: Error 403: rate limit", object: "a/b.pdf" },
      { message: "couldn't list directory: token https://***@x invalid", object: null },
    ]);
  });
});
