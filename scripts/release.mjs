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
// 让 Cargo.lock 里的自身版本跟上（离线，不动其它依赖）
sh("cargo metadata --offline --format-version 1", { cwd: resolve(root, "src-tauri") });

sh("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -q -m "chore(release): 发布 v${version}"`);
sh(`git tag -a v${version} -m "ApexTerm v${version}"`);

console.log(`已提交并打标签 v${version}。推送即触发发布：\n  git push --follow-tags`);
