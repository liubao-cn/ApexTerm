import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, parseInline } from "../src/markdownLite.ts";

test("标题 / 列表 / 段落分块，分隔线忽略", () => {
  const blocks = parseBlocks("### 新功能\n- 甲\n- 乙\n\n### 修复\n1. 丙\n\n---\n\n一段说明\n接上一行");
  assert.deepEqual(
    blocks.map((b) => b.t),
    ["h", "ul", "h", "ol", "p"],
  );
  assert.equal((blocks[1] as { items: unknown[] }).items.length, 2);
  assert.deepEqual((blocks[4] as { inline: { s: string }[] }).inline[0].s, "一段说明 接上一行");
});

test("行内：code / 粗体 / 斜体 / 链接", () => {
  const parts = parseInline("按 `⌘,` 打开 **设置**，见 [文档](https://example.com) 与 *说明*");
  assert.deepEqual(
    parts.map((p) => p.t),
    ["text", "code", "text", "strong", "text", "link", "text", "em"],
  );
  assert.deepEqual(parts[5], { t: "link", s: "文档", href: "https://example.com" });
});

test("纯文本原样保留，星号不成对不当成强调", () => {
  assert.deepEqual(parseInline("a * b"), [{ t: "text", s: "a * b" }]);
});
