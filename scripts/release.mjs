#!/usr/bin/env node
// 发布一个版本：同步三处版本号 → 提交 → 打 v<版本> 标签。之后 `git push --follow-tags` 触发 GitHub Actions 构建并发布。
// 用法：pnpm release 1.0.1
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("用法：pnpm release <主.次.补丁>，例如 pnpm release 1.0.1");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "pipe", encoding: "utf8", ...opts }).trim();

if (sh("git status --porcelain")) {
  console.error("工作区有未提交的改动，先提交或暂存再发布。");
  process.exit(1);
}
if (sh(`git tag -l v${version}`)) {
  console.error(`标签 v${version} 已存在。`);
  process.exit(1);
}

const files = {
  "package.json": (s) => s.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
  "src-tauri/tauri.conf.json": (s) => s.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
  "src-tauri/Cargo.toml": (s) => s.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
};
for (const [file, patch] of Object.entries(files)) {
  const p = resolve(root, file);
  const before = readFileSync(p, "utf8");
  const after = patch(before);
  if (after === before) {
    console.error(`${file} 里没找到可替换的版本号`);
    process.exit(1);
  }
  writeFileSync(p, after);
}
// 让 Cargo.lock 里的自身版本跟上（离线，不动其它依赖）；metadata 输出很大，直接丢弃，避免撑爆 execSync 缓冲
execSync("cargo metadata --offline --format-version 1", {
  cwd: resolve(root, "src-tauri"),
  stdio: ["ignore", "ignore", "inherit"],
});

// CHANGELOG：把「未发布」小节变成本版条目；「未发布」为空则按上次标签以来的提交自动归类
const changelogPath = resolve(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const today = new Date().toISOString().slice(0, 10);
const unreleased = unreleasedSection(changelog);
const notes = unreleased || notesFromCommits();
writeFileSync(
  changelogPath,
  changelog.replace(/## 未发布\n[\s\S]*?(?=\n## )/, `## 未发布\n\n## v${version} · ${today}\n\n${notes}\n`),
);

sh("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md");
sh(`git commit -q -m "chore(release): 发布 v${version}"`);
sh(`git tag -a v${version} -m "ApexTerm v${version}"`);

console.log(`已提交并打标签 v${version}，更新说明：\n${notes}\n\n推送即触发发布：\n  git push --follow-tags`);

/** 「未发布」小节里手写的内容（去掉标题），没有则返回空串 */
function unreleasedSection(md) {
  const m = md.match(/## 未发布\n([\s\S]*?)(?=\n## )/);
  return m ? m[1].trim() : "";
}

/** 上次标签以来的提交，按类型前缀归到 新功能 / 修复 / 其它；发布提交与 CI 杂项不列 */
function notesFromCommits() {
  const lastTag = sh("git describe --tags --abbrev=0 2>/dev/null || true");
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const subjects = sh(`git log --format=%s ${range}`).split("\n").filter(Boolean);
  const groups = { 新功能: [], 修复: [], 其它: [] };
  for (const s of subjects) {
    const m = s.match(/^(\w+)(?:\([^)]*\))?:\s*(.+)$/);
    const type = m?.[1] ?? "";
    const text = (m?.[2] ?? s).trim();
    if (type === "chore" && /^发布 v/.test(text)) continue;
    if (type === "ci") continue;
    const bucket = type === "feat" ? "新功能" : type === "fix" ? "修复" : "其它";
    groups[bucket].push(`- ${text}`);
  }
  const out = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([title, items]) => `### ${title}\n${items.join("\n")}`)
    .join("\n\n");
  return out || "- 例行维护";
}
