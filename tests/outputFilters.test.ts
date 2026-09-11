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
  assert.equal(decodePercentRun("%A5"), "%A5");
});

test("解出控制字符时保留编码，避免注入转义序列", () => {
  assert.equal(decodePercentRun("%1B%5B"), "%1B%5B");
});

test("OSC 8 参数里的 URL 也会被解码，但不会吞掉终止符", () => {
  const osc = `\x1b]8;;${ENC}\x1b\\放行判定书\x1b]8;;\x1b\\`;
  assert.equal(decodeFileUrls(osc), `\x1b]8;;${DEC}\x1b\\放行判定书\x1b]8;;\x1b\\`);
});

test("程序把 URL 折成多行（换行 + 缩进），续行也一起还原，右括号处结束", () => {
  // 模拟 Devin 的排版：在 %E4 前折行、在一个字符的三个 %XX 中间再折一次
  const wrapped =
    "• 附件 (file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C\r\n" +
    "  %E7%AC%94%E8%AE%B0/mka-delivery/%E6%94%BE%E8\r\n" +
    "  %A1%8C_20260910.md)（两批）\r\n" +
    "下一步：发群";
  const out = decodeFileUrls(wrapped);
  assert.equal(
    out,
    "• 附件 (file:///Users/liubao/AI/工作\r\n" +
      "  笔记/mka-delivery/放\r\n" +
      "  行_20260910.md)（两批）\r\n" +
      "下一步：发群",
  );
});

test("Devin 实际排版：行尾先重置颜色再换行缩进再设颜色，续行照样还原（原始字节抓包用例）", () => {
  const GRAY = "\x1b[38;2;124;124;124m";
  const raw =
    `${GRAY} (file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C%E7%AC%94%E8%AE%B0/2026-09-09-\x1b[0m\r\n` +
    `   ${GRAY}%E4%BB%BB%E5%8A%A1%E7%AE%A1%E7%90%86release%E5%88%86%E6%94%AF%E4%B8%8A%E7%BA%BF%E5%AE%A1%E6%9F%A5/\x1b[0m\r\n` +
    `   ${GRAY}%E5%AE%A1%E6%9F%A5%E6%B8%85%E5%8D%95.html)\x1b[0m\r\n` +
    `   ${GRAY}\u2022 \x1b[0m可直接粘贴的转发稿：`;
  assert.equal(
    decodeFileUrls(raw),
    `${GRAY} (file:///Users/liubao/AI/工作笔记/2026-09-09-\x1b[0m\r\n` +
      `   ${GRAY}任务管理release分支上线审查/\x1b[0m\r\n` +
      `   ${GRAY}审查清单.html)\x1b[0m\r\n` +
      `   ${GRAY}\u2022 \x1b[0m可直接粘贴的转发稿：`,
  );
});

test("折行处夹着清行 \\e[K 或光标隐藏 \\e[?25l 也算分隔符；光标移动则不算", () => {
  const GRAY = "\x1b[38;2;124;124;124m";
  const enc = encodeURIComponent;
  const withK = `(file:///a/${enc("供数对接标准汇总版（发这一")}%E4\x1b[0m\x1b[K\r\n   ${GRAY}%BB%BD${enc("就够）")}.html)`;
  assert.equal(decodeFileUrls(withK), `(file:///a/供数对接标准汇总版（发这一\x1b[0m\x1b[K\r\n   ${GRAY}份就够）.html)`);
  const withHide = `(file:///a/%E5%B7%A5%E4\x1b[?25l\r\n  \x1b[?25h%BD%9C.md)`;
  assert.equal(decodeFileUrls(withHide), `(file:///a/工\x1b[?25l\r\n  \x1b[?25h作.md)`);
  // 光标上移：程序在重画别处，不能当续行
  const withMove = `(file:///a/%E5%B7%A5%E4\x1b[2A%BD%9C)`;
  assert.equal(decodeFileUrls(withMove), `(file:///a/工%E4\x1b[2A%BD%9C)`);
});

test("折行时行尾被切断的半个字符（如 %E）搬到下一行开头再解", () => {
  const wrapped = "x (file:///a/%E5%B7%A5%E\r\n  4%BD%9C.md) y";
  assert.equal(decodeFileUrls(wrapped), "x (file:///a/工\r\n  作.md) y");
});

test("URL 后面换行接的是普通文字（不像 URL 续行）时不当成续行", () => {
  const text = "see file:///tmp/%E5%B7%A5.txt\r\n下一步：发群 100%";
  assert.equal(decodeFileUrls(text), "see file:///tmp/工.txt\r\n下一步：发群 100%");
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

test("流式：折行 URL 的续行在下一块数据里也能接上", () => {
  const d = createFileUrlDecoder();
  const first = d.push("• 附件 (file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C\r\n  ");
  assert.equal(first, "• 附件 (");
  const second = d.push("%E7%AC%94%E8%AE%B0/a.md) 完成\r\n");
  assert.equal(second, "file:///Users/liubao/AI/工作\r\n  笔记/a.md) 完成\r\n");
});

test("流式：数据块断在折行处的颜色序列中间，也要暂留等下一块（截图里残留 %E4 的根因）", () => {
  const GRAY = "\x1b[38;2;124;124;124m";
  const d = createFileUrlDecoder();
  // 第一块在 "\x1b[38;2;1" 处被切断
  const first = d.push(`(file:///a/%E4%BE%9B%E6%95%B0%E4\x1b[0m\r\n   \x1b[38;2;1`);
  assert.equal(first, "(");
  assert.equal(d.pending, true);
  const second = d.push(`24;124;124m%BB%BD%E5%B0%B1.html)\x1b[0m\r\n`);
  assert.equal(second, `file:///a/供数\x1b[0m\r\n   ${GRAY}份就.html)\x1b[0m\r\n`);
});

test("流式：数据块恰好断在 ESC 前 / 只剩 ESC 时同样暂留", () => {
  const d = createFileUrlDecoder();
  assert.equal(d.push("(file:///a/%E4%BE%9B%E4"), "(");
  assert.equal(d.push("\x1b"), "");
  assert.equal(d.push("[0m\r\n   \x1b[38;2;124;124;124m%BB%BD.md)"), "file:///a/供\x1b[0m\r\n   \x1b[38;2;124;124;124m份.md)");
});

test("流式：任意切块方式的结果都与整段解码一致（确定性随机切块 200 次）", () => {
  const GRAY = "\x1b[38;2;124;124;124m";
  const sample =
    `正文 100% 进度 profile 无关\r\n` +
    `   ${GRAY}• \x1b[0m审查清单：\x1b]8;;${ENC}\x1b\\\x1b[4m审查清单.html\x1b]8;;\x1b\\\x1b[0m${GRAY} (file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C%E7%AC%94%E8%AE%B0/2026-09-09-\x1b[0m\r\n` +
    `   ${GRAY}%E4%BB%BB%E5%8A%A1%E7%AE%A1%E7%90%86release/\x1b[0m\r\n` +
    `   ${GRAY}%E5%AE%A1%E6%9F%A5%E6%B8%85%E5%8D%95.html)\x1b[0m\r\n` +
    `下一步：发群 (${ENC}) 结束\r\n`;
  const whole = decodeFileUrls(sample);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 200; trial++) {
    const d = createFileUrlDecoder();
    const max = trial % 2 ? 6 : 40;
    let out = "";
    for (let i = 0; i < sample.length; ) {
      const n = 1 + Math.floor(rnd() * max);
      out += d.push(sample.slice(i, i + n));
      i += n;
    }
    out += d.flush();
    assert.equal(out, whole, `trial ${trial}`);
  }
});

test("流式：没有半截 URL 时全部立刻放行；flush 吐出暂留内容", () => {
  const d = createFileUrlDecoder();
  assert.equal(d.push("hello\r\n"), "hello\r\n");
  d.push("x file:///a/%E5");
  assert.equal(d.flush(), "file:///a/%E5");
});
