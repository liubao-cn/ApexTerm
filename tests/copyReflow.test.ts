import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth, reflowSelection } from "../src/copyReflow.ts";

test("displayWidth：CJK 算 2 格", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("你好a"), 5);
});

test("单行原样返回", () => {
  assert.equal(reflowSelection("hello world", 80), "hello world");
});

test("英文段落按词换行 → 接成一行并补空格（TUI 排版宽度 = 最宽行）", () => {
  // 模拟 40 列排版：每行末尾的词因为放不下才换到下一行
  const text = ["The quick brown fox jumps over the lazy", "dog and keeps running through the forest", "until night."].join("\n");
  assert.equal(
    reflowSelection(text, 120),
    "The quick brown fox jumps over the lazy dog and keeps running through the forest until night.",
  );
});

test("中文按字换行（写满行宽）→ 直接相连不补空格", () => {
  const line1 = "这是一段很长的中文回复内容用于测试终端";
  const line2 = "复制时是否会被错误地拆成多行显示。";
  assert.equal(reflowSelection(`${line1}\n${line2}`, displayWidth(line1)), line1 + line2);
});

test("列表项、编号、空行是真换行", () => {
  const text = ["Here is a long enough line to pass the width", "- first item", "- second item", "", "1. numbered"].join("\n");
  assert.equal(reflowSelection(text, 44), text);
});

test("下一行第一个词能放进上一行 → 保留换行", () => {
  // 上一行只有 22 宽，远没写满 60 列，"return" 完全放得下 → 是刻意换行（例如代码）
  const text = ["const a = compute(x);", "return a;", "// trailing comment that is long enough here"].join("\n");
  assert.equal(reflowSelection(text, 60), text);
});

test("单独一行长代码不会把排版宽度带偏", () => {
  const text = ["const result = someFunction(argument1, argument2);", "return result;"].join("\n");
  assert.equal(reflowSelection(text, 120), text);
});

test("带缩进的续行去掉前导空格再拼接", () => {
  const text = ["⏺ This bullet explanation is exactly long", "  enough to wrap onto the next display line"].join("\n");
  assert.equal(
    reflowSelection(text, 41),
    "⏺ This bullet explanation is exactly long enough to wrap onto the next display line",
  );
});

test("表格 / 边框行不合并", () => {
  const text = ["│ a very long table cell content here │", "│ another row of the same table there │"].join("\n");
  assert.equal(reflowSelection(text, 40), text);
});

test("保留 CRLF 换行符风格", () => {
  const text = "first line that is long enough wide\r\n- item";
  assert.equal(reflowSelection(text, 36), text);
});
