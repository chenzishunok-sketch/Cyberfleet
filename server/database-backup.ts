import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// node:sqlite 的 backup() 直到较新的 Node 版本才导出（22.13 及以下没有）。
// 这里做能力探测，避免静态 import 在低版本 Node 上直接抛
// "does not provide an export named 'backup'" 而让整个服务起不来。
type NativeBackup = (source: DatabaseSync, destination: string) => Promise<unknown>;

async function resolveNativeBackup(): Promise<NativeBackup | undefined> {
  try {
    const sqlite = (await import("node:sqlite")) as { backup?: NativeBackup };
    return typeof sqlite.backup === "function" ? sqlite.backup : undefined;
  } catch {
    return undefined;
  }
}

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

  // 先把 WAL 回写主库再备份。这样备份只依赖单个主库文件，顺带避免 WAL
  // 长期不 checkpoint 而持续增长。
  try {
    const checkpoint = new DatabaseSync(sourcePath);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
  } catch {
    // 源库可能正被其它连接占用，回写失败不阻断备份
  }

  // 备份先落到系统临时目录，再复制进备份目录。实测在部分环境下 SQLite 直接写
  // 项目数据目录会抛 "disk I/O error"，而写系统临时目录正常，故用暂存文件中转。
  // 最终文件先落 .tmp 再原子改名：旧实现直接写目标，一旦中断会留下不完整备份和
  // -journal 残留，且次日因"目标已存在"被跳过，导致当天备份永久缺失。
  const stagingPath = join(tmpdir(), `wf-backup-${date}-${Date.now()}.sqlite`);
  const tempPath = `${targetPath}.tmp`;
  rmSync(stagingPath, { force: true });
  rmSync(tempPath, { force: true });

  const finish = (): string => {
    copyFileSync(stagingPath, tempPath);
    renameSync(tempPath, targetPath);
    chmodSync(targetPath, 0o600);
    return targetPath;
  };

  const nativeBackup = await resolveNativeBackup();
  if (nativeBackup) {
    const database = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await nativeBackup(database, stagingPath);
      return finish();
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    } finally {
      database.close();
      rmSync(stagingPath, { force: true });
    }
  }

  // 低版本 Node 没有 backup()：用 VACUUM INTO 导出一致性快照。
  // VACUUM 需要可写连接，因此这里不以 readOnly 打开。
  const database = new DatabaseSync(sourcePath);
  try {
    database.exec(`VACUUM INTO '${stagingPath.replace(/'/g, "''")}'`);
    return finish();
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  } finally {
    database.close();
    rmSync(stagingPath, { force: true });
  }
}
