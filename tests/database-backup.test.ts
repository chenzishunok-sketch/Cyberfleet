import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupWorkflowDatabase } from "../server/database-backup.ts";

describe("workflow database backup", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-backup-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("creates one readable backup per day", async () => {
    const sourcePath = path.join(directory, "workflows.sqlite");
    const database = new DatabaseSync(sourcePath);
    database.exec("CREATE TABLE checks (value TEXT); INSERT INTO checks VALUES ('ok')");
    database.close();

    const targetPath = await backupWorkflowDatabase({
      sourcePath,
      backupDirectory: path.join(directory, "backups"),
      now: new Date("2026-07-29T08:00:00.000Z"),
    });
    const backup = new DatabaseSync(targetPath!, { readOnly: true });
    expect(backup.prepare("SELECT value FROM checks").get()).toMatchObject({ value: "ok" });
    backup.close();
    expect(await backupWorkflowDatabase({ sourcePath, backupDirectory: path.join(directory, "backups"), now: new Date("2026-07-29T15:00:00.000Z") })).toBe(targetPath);
    expect(await backupWorkflowDatabase({ sourcePath, backupDirectory: path.join(directory, "backups"), now: new Date("2026-07-29T20:00:00.000Z") })).not.toBe(targetPath);
  });
});
