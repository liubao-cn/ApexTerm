import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileUrlDecoder, decodeFileUrls, decodePercentRun } from "../src/outputFilters.ts";

const ENC = "file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C%E7%AC%94%E8%AE%B0/mka-delivery/%E6%94%BE%E8%A1%8C_20260910.md";
const DEC = "file:///Users/liubao/AI/工作笔记/mka-delivery/放行_20260910.md";

test("file:// 链接里的百分号编码还原成中文，其它文字不动", () => {
  const line = `• 放行判定书 (${ENC}) 共 2 件，进度 100%`;
  assert.equal(decodeFileUrls(line), `• 放行判定书 (${DEC}) 共 2 件，进度 100%`);
});

test("非 file:// 的 %XX 不处理；无编码的 file:// 原样", () => {
  assert.equal(decodeFileUrls("printf %E5 http://x/%E5%B7%A5"), "printf %E5 http://x/%E5%B7%A5");
  assert.equal(decodeFileUrls("see file:///tmp/a.txt"), "see file:///tmp/a.txt");
});

test("末尾不完整的多字节序列保留编码，前面完整的照常解码", () => {
  // 工 = E5 B7 A5；作 的前两个字节 E4 BD 缺最后一个
  assert.equal(decodePercentRun("%E5%B7%A5%E4%BD"), "工%E4%BD");
  // 单独一个续字节：整段保留
  assert.equal(decodePercentRun("%A5"), "%A5");
});

test("解出控制字符时保留编码，避免注入转义序列", () => {
  assert.equal(decodePercentRun("%1B%5B"), "%1B%5B");
});

test("OSC 8 参数里的 URL 也会被解码，但不会吞掉终止符", () => {
  const osc = `\x1b]8;;${ENC}\x1b\\放行判定书\x1b]8;;\x1b\\`;
  assert.equal(decodeFileUrls(osc), `\x1b]8;;${DEC}\x1b\\放行判定书\x1b]8;;\x1b\\`);
});

test("流式：URL 被切成两段到达时暂留半截，合并后再解码", () => {
  const d = createFileUrlDecoder();
  const cut = ENC.indexOf("%E4");
  const first = d.push(`附件 (${ENC.slice(0, cut)}`);
  assert.equal(first, "附件 (");
  assert.equal(d.pending, true);
  const second = d.push(`${ENC.slice(cut)}) 完成\r\n`);
  assert.equal(second, `${DEC}) 完成\r\n`);
  assert.equal(d.pending, false);
});

test("流式：没有半截 URL 时全部立刻放行；flush 吐出暂留内容", () => {
  const d = createFileUrlDecoder();
  assert.equal(d.push("hello\r\n"), "hello\r\n");
  d.push("x file:///a/%E5");
  assert.equal(d.flush(), "file:///a/%E5");
});
