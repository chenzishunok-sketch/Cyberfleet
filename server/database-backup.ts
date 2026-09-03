import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function backupWorkflowDatabase(options: {
  sourcePath?: string;
  backupDirectory?: string;
  now?: Date;
} = {}): Promise<string | undefined> {
  const sourcePath = resolve(options.sourcePath ?? process.env.WORKFLOW_DATABASE?.trim() ?? ".data/workflows.sqlite");
  if (!existsSync(sourcePath)) return undefined;
  const backupDirectory = resolve(options.backupDirectory ?? join(dirname(sourcePath), "backups"));
  mkdirSync(backupDirectory, { recursive: true });
  const date = localDateKey(options.now ?? new Date());
  const targetPath = join(backupDirectory, `workflows-${date}.sqlite`);
  if (existsSync(targetPath)) return targetPath;
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(database, targetPath);
    chmodSync(targetPath, 0o600);
    return targetPath;
  } finally {
    database.close();
  }
}
