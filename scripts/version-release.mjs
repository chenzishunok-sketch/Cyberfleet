// 版本迭代一键脚本:
//   - npm run version:patch  → 0.1.0 → 0.1.1 (小修小改)
//   - npm run version:minor  → 0.1.0 → 0.2.0 (加新功能)
//   - npm run version:major  → 0.1.0 → 1.0.0 (大版本 / 重大变更)
//   - npm run changelog      → 只生成 CHANGELOG 片段,不改版本号
//
// 脚本会自动:
//   1) 更新 package.json version (通过 npm version 前置命令完成)
//   2) 在 CHANGELOG.md 顶部插入本次版本的条目
//   3) 运行 git commit -m "release: vX.Y.Z"
//   4) 打 git tag vX.Y.Z
//   5) 提示你最后执行: git push && git push --tags
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const pkgPath = path.join(ROOT, "package.json");
const changelogPath = path.join(ROOT, "CHANGELOG.md");

function run(cmd, opts = {}) {
  console.log("$", cmd);
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function todayCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function gatherRecentCommits(limit = 12) {
  try {
    const out = execSync(
      `git log --oneline -n ${limit} --pretty=format:"%s"`,
      { cwd: ROOT, encoding: "utf8" }
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function classify(msgs) {
  const feat = [], fix = [], chore = [], docs = [], other = [];
  for (const m of msgs) {
    const t = m.toLowerCase();
    if (t.startsWith("feat") || /^(新增|添加|加|支持|引入|上线)/.test(m)) feat.push(m);
    else if (t.startsWith("fix") || /^(修复|修|解决|处理)/.test(m)) fix.push(m);
    else if (t.startsWith("chore") || /^(调整|优化|重构|清理|移除|删除)/.test(m)) chore.push(m);
    else if (t.startsWith("docs") || /^(文档|说明|更新.*文档)/.test(m)) docs.push(m);
    else other.push(m);
  }
  return { feat, fix, chore, docs, other };
}

function renderSection(title, items) {
  if (!items.length) return "";
  return `### ${title}\n` + items.map((x) => `- ${x}`).join("\n") + "\n\n";
}

function bump(kind) {
  const pkg = readJson(pkgPath);
  const prev = pkg.version;
  console.log(`准备升级版本: ${prev} → ${kind}`);

  // 先升级版本号
  run(`npm version --no-git-tag-version ${kind}`);
  const npkg = readJson(pkgPath);
  const next = npkg.version;
  console.log(`版本号: ${prev} → ${next}`);

  // 生成 CHANGELOG 条目
  const commits = gatherRecentCommits(15);
  const groups = classify(commits);
  const header = `## [${next}] - ${todayCN()}\n\n`;
  const body =
    renderSection("新增功能", groups.feat) +
    renderSection("问题修复", groups.fix) +
    renderSection("优化 / 调整", groups.chore) +
    renderSection("文档 / 说明", groups.docs) +
    renderSection("其他", groups.other);

  const entry = header + (body || "_暂无变更摘要_\n\n");
  let content = entry;
  if (existsSync(changelogPath)) {
    const old = readFileSync(changelogPath, "utf8");
    // 插入在顶部标题下方
    const lines = old.split(/\r?\n/);
    let insertAt = 0;
    if (lines[0]?.startsWith("# ")) {
      insertAt = lines.findIndex((l, i) => i > 0 && l.trim() !== "") > 0
        ? lines.findIndex((l, i) => i > 0 && l.trim() !== "")
        : 1;
      if (insertAt < 1) insertAt = 1;
    }
    lines.splice(insertAt, 0, "", entry.trimEnd());
    content = lines.join("\n") + "\n";
  } else {
    content =
      "# Changelog\n\n" +
      "所有显著的版本变更都会记录在本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),\n" +
      "版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。\n\n" +
      entry;
  }
  mkdirSync(path.dirname(changelogPath), { recursive: true });
  writeFileSync(changelogPath, content, "utf8");
  console.log(`已写入 ${changelogPath}`);

  // 提交 + 打标签
  run(`git add package.json package-lock.json CHANGELOG.md 2>/dev/null || git add package.json CHANGELOG.md`);
  run(`git commit -m "release: v${next}"`);
  run(`git tag -a v${next} -m "v${next} 版本发布"`);
  console.log("");
  console.log(`✅ v${next} 已就绪。下一步:`);
  console.log(`   git push origin main --tags`);
  console.log(`   (如果是首次上传 GitHub,请先执行一次: git push -u origin main --tags)`);
}

function changelogOnly() {
  const pkg = readJson(pkgPath);
  console.log(`当前版本 ${pkg.version},仅生成 CHANGELOG 预览:`);
  const commits = gatherRecentCommits(20);
  const groups = classify(commits);
  const out =
    renderSection("新增功能", groups.feat) +
    renderSection("问题修复", groups.fix) +
    renderSection("优化 / 调整", groups.chore) +
    renderSection("文档 / 说明", groups.docs) +
    renderSection("其他", groups.other);
  console.log(out || "   (暂无提交)");
}

const args = process.argv.slice(2);
const kind = args[0] || "patch";
if (kind === "changelog-only") changelogOnly();
else bump(kind);
