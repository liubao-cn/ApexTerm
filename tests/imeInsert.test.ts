import { test } from "node:test";
import assert from "node:assert/strict";
import { xtermAlreadyHandled } from "../src/imeInsert.ts";

test("空格：xterm 在 keypress 阶段已发数据，input 到来时不再补发", () => {
  const keydown = 1000;
  const sent = 1002; // keypress 里发出
  const input = 1003;
  assert.equal(xtermAlreadyHandled(sent, keydown, input), true);
});

test("输入法被丢的全角标点：上次发送早于本次 Shift keydown，且不在同一击键窗口内 → 补发", () => {
  const lastSent = 800; // 上一个字符
  const shiftKeydown = 1000;
  const input = 1200;
  assert.equal(xtermAlreadyHandled(lastSent, shiftKeydown, input), false);
});

test("输入法被 xterm 接受的标点：数据在 input 事件里刚刚发出 → 不补发", () => {
  const lastKeydown = 1000; // 上一个字符的 keydown(229)
  const input = 1300;
  const sent = 1300; // xterm 的 input 监听先于我们执行
  assert.equal(xtermAlreadyHandled(sent, lastKeydown, input), true);
});

test("按住 Shift 连打：每次补发后 keydown(229) 会刷新时间，下一次仍能补发", () => {
  const ourSend = 1200;
  const keydown229 = 1210;
  const nextInput = 1400;
  assert.equal(xtermAlreadyHandled(ourSend, keydown229, nextInput), false);
});
