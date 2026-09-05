#!/usr/bin/env node
// 从 CHANGELOG.md 取出某个版本的小节，供 GitHub Actions 作为 Release 正文——它同时就是应用内更新弹窗
// 显示的内容，所以只放"改了什么"，不放安装说明（Release 页面下方本来就列着安装包）。
// 用法：node scripts/release-notes.mjs 1.0.1
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("用法：node scripts/release-notes.mjs <版本>");
  process.exit(1);
}
const changelog = readFileSync(resolve(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
const body = sectionOf(changelog, version);
if (!body) {
  console.error(`CHANGELOG.md 里没有 v${version} 的小节`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);

/** 取 `## v<版本>` 到下一个 `## ` 之间的内容（不含标题） */
export function sectionOf(md, version) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## v${version.replace(/\./g, "\\.")}(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}
