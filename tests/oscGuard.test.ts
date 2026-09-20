import { test } from "node:test";
import assert from "node:assert/strict";
import { createOscGuard } from "../src/oscGuard.ts";
import { createFileUrlDecoder, decodeFileUrls } from "../src/outputFilters.ts";

const ST = "\x1b\\";
const CLOSE = `\x1b]8;;${ST}`;
const GRAY = "\x1b[38;2;68;68;68m";
const URL = "https://bugs.nextjs.org/search?category=turbopack-error";

/** Devin 截断工具输出后的真实字节（抓包原文）：OSC 8 没有结束符，直接换行进下一条日志 */
const DEVIN_BROKEN =
  `\x1b[0m 1873:To help make Turbopack better, report this error by \x1b]8;;${URL}\r\n` +
  ` ${GRAY}│\x1b[0m 1920:\x1b[1m\x1b[31mFATAL\x1b[39m\x1b[0m: An unexpected Turbopack error occurred.\r\n` +
  ` ${GRAY}└\x1b[0m \x1b[38;2;124;124;124mExited with code 0\x1b[0m\r\n`;

function run(text: string, size = text.length, forceEach = false): string {
  const g = createOscGuard();
  let out = "";
  for (let i = 0; i < text.length; i += size) {
    out += g.push(text.slice(i, i + size));
    if (forceEach) out += g.flush(true);
  }
  return out + g.flush(true);
}

/** 规范的 OSC 8 序列（开或关） */
const OSC8_RE = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g;
/** 模拟 xterm：顺序处理所有规范 OSC 8 后，链接是否仍开着 */
function linkLeftOpen(text: string): boolean {
  let open = false;
  for (const m of text.matchAll(OSC8_RE)) open = m[2].length > 0;
  return open;
}
/** 去掉所有转义序列后的可见文字 */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");

test("Devin 截断出来的残缺 OSC 8：URL 当文字显示，不开链接，后面的行不受影响", () => {
  const out = run(DEVIN_BROKEN);
  assert.equal(out.includes("\x1b]8;"), false, "不应再有任何 OSC 8 序列");
  assert.equal(out.includes(`report this error by ${URL}\r\n ${GRAY}│`), true, "URL 原文保留、换行和后一行开头保留");
  assert.equal(plain(out), plain(DEVIN_BROKEN.replace("\x1b]8;;", "")));
});

test("规范的链接（ST / BEL 结束）原样放行，一个字节不改", () => {
  const st = `参见 \x1b]8;;${URL}${ST}\x1b[4;34mTurbopack 错误\x1b[0m${CLOSE} 下一步\r\n`;
  const bel = `\x1b]8;id=7;file:///tmp/a.txt\x07a.txt\x1b]8;;\x07 done\r\n`;
  assert.equal(run(st), st);
  assert.equal(run(bel), bel);
  assert.equal(run(st + bel, 1), st + bel);
});

test("链接打开后到了换行还没关：换行前补关闭", () => {
  const dangling = `by \x1b]8;;${URL}${ST}filing an\r\n next line\r\n`;
  const out = run(dangling);
  assert.equal(out, `by \x1b]8;;${URL}${ST}filing an${CLOSE}\r\n next line\r\n`);
  assert.equal(linkLeftOpen(out), false);
});

test("被别的转义序列切断（\\e]8;;url\\e[0m）：URL 当文字，颜色序列保留", () => {
  const out = run(`x \x1b]8;;https://a.b/c\x1b[0m y\r\n`);
  assert.equal(out, `x https://a.b/c\x1b[0m y\r\n`);
});

test("残缺的关闭序列（\\e]8;; 直接换行）仍然把链接关掉", () => {
  const out = run(`\x1b]8;;https://a.b${ST}label\x1b]8;;\r\nrest\r\n`);
  assert.equal(out, `\x1b]8;;https://a.b${ST}label${CLOSE}\r\nrest\r\n`);
});

test("其它 OSC 原样透传：标题、带换行的 OSC 52、超长 OSC 1337，链接开着时也不往里面插关闭", () => {
  const title = "\x1b]0;my title; with ; semicolons\x07";
  const clip = "\x1b]52;c;YWJj\nZGVm\nZ2hp\x07";
  const img = `\x1b]1337;File=inline=1:${"QUJD".repeat(6000)}${ST}`;
  const withLink = `\x1b]8;;https://a.b${ST}L${clip}M\r\n`;
  assert.equal(run(title + clip + img), title + clip + img);
  assert.equal(run(title + clip + img, 7), title + clip + img);
  assert.equal(run(withLink), `\x1b]8;;https://a.b${ST}L${clip}M${CLOSE}\r\n`);
});

test("CSI / DCS / tmux 透传里出现的 \\e\\e]8 不会被误认成 OSC", () => {
  const tmux = `\x1bPtmux;\x1b\x1b]8;;https://a.b\x1b\x1b\\link\x1b\x1b]8;;\x1b\x1b\\${ST}text\r\n`;
  assert.equal(run(tmux), tmux);
  const csi = "\x1b[38;2;1;2;3mcolored\x1b[0m\r\n\x1b[2J\x1b[H";
  assert.equal(run(csi), csi);
});

test("任意切块 + 正常放行：输出与整段处理逐字节一致", () => {
  const sample = DEVIN_BROKEN + `\x1b]8;;${URL}${ST}ok${CLOSE}\r\n` + `by \x1b]8;;${URL}${ST}filing an\r\n` + "\x1b]0;t\x07tail\r\n";
  const whole = run(sample);
  for (let size = 1; size <= 13; size++) assert.equal(run(sample, size), whole, `size=${size}`);
});

test("任意切块 + 每块都强制放行：可见文字不变，且流结束时链接一定是关着的", () => {
  const sample = DEVIN_BROKEN + `\x1b]8;;${URL}${ST}ok${CLOSE}\r\n` + `by \x1b]8;;${URL}${ST}filing an\r\nnext\r\n`;
  for (let size = 1; size <= 13; size++) {
    const out = run(sample, size, true);
    assert.equal(linkLeftOpen(out), false, `size=${size} 链接没关`);
    assert.equal(plain(out).includes("filing an"), true);
    assert.equal(plain(out).includes("next"), true);
  }
});

test("块尾停在半截转义序列上：先暂留，下一块到了再处理", () => {
  const g = createOscGuard();
  assert.equal(g.push("abc\x1b"), "abc");
  assert.equal(g.pending, true);
  assert.equal(g.flush(), "", "非 force 不放半截序列");
  assert.equal(g.push("]8;;https://a.b"), "");
  assert.equal(g.push(`${ST}L${CLOSE}\r\n`), `\x1b]8;;https://a.b${ST}L${CLOSE}\r\n`);
  assert.equal(g.pending, false);
});

test("护栏 + file:// 解码器串联：Devin 正常链接的输出与单用解码器一致", () => {
  const enc = "file:///Users/liubao/AI/%E5%B7%A5%E4%BD%9C/a.md";
  const devin =
    `\x1b]8;;${enc}${ST}\x1b[4m\x1b[38;2;94;196;255ma.md\x1b[0m${CLOSE}\x1b[0m\x1b[38;2;124;124;124m (${enc})\x1b[0m\r\n` +
    DEVIN_BROKEN;
  const guard = createOscGuard();
  const dec = createFileUrlDecoder();
  let out = "";
  for (let i = 0; i < devin.length; i += 5) out += dec.push(guard.push(devin.slice(i, i + 5)));
  out += dec.push(guard.flush(true)) + dec.flush(true);
  assert.equal(out, decodeFileUrls(run(devin)));
  assert.equal(out.includes("工作"), true);
  assert.equal(linkLeftOpen(out), false);
});
