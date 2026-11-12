import { test } from "node:test";
import assert from "node:assert/strict";
import { createKittyKeyboard, installKittyKeyboard, type KittyKeyInput } from "../src/kittyKeyboard.ts";

// Node 环境下初始化无头 Terminal 所需的最小浏览器全局桩
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel" },
    configurable: true,
  });
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).document = { createElement: () => ({ style: {} }) };
}
const { Terminal } = (await import("@xterm/xterm")).default;

function key(
  overrides: Partial<KittyKeyInput> & Pick<KittyKeyInput, "key" | "code">,
): KittyKeyInput {
  return {
    type: "keydown",
    repeat: false,
    isComposing: false,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  };
}

function setup(opts: { isMac?: boolean; optionAsMeta?: boolean; buffer?: "normal" | "alternate" } = {}) {
  let buffer: "normal" | "alternate" = opts.buffer ?? "normal";
  let optionAsMeta = opts.optionAsMeta ?? true;
  const replies: string[] = [];
  const kb = createKittyKeyboard({
    isMac: opts.isMac ?? true,
    getOptionAsMeta: () => optionAsMeta,
    getBufferType: () => buffer,
    reply: (d) => replies.push(d),
  });
  return {
    kb,
    replies,
    setBuffer(b: "normal" | "alternate") {
      buffer = b;
    },
    setOptionAsMeta(v: boolean) {
      optionAsMeta = v;
    },
  };
}

test("Devin CLI 真实生命周期：探测 ?u → 压栈 >1u → Cmd+Enter / Ctrl+Enter / Shift+Enter 编码 → 退出 <1u 恢复", () => {
  const { kb, replies } = setup({ isMac: true });
  assert.equal(kb.flags, 0);

  // 未开启协议时，Cmd+Enter 不发 CSI u（避免普通 shell 出现乱字符）
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, metaKey: true })), null);

  // 1. Devin CLI 探测 CSI ? u → 回复 \x1b[?0u
  assert.equal(kb.handleQuery(), true);
  assert.deepEqual(replies, ["\x1b[?0u"]);

  // 2. Devin CLI 开启 CSI > 1 u（DISAMBIGUATE_ESCAPE_CODES）
  assert.equal(kb.handlePush([1]), true);
  assert.equal(kb.flags, 1);
  kb.handleQuery();
  assert.equal(replies.at(-1), "\x1b[?1u");

  // 3. Cmd+Enter（入队）→ \x1b[13;9u；Ctrl+Enter → \x1b[13;5u；Shift+Enter（多行）→ \x1b[13;2u；Alt+Enter → \x1b[13;3u
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, metaKey: true })), "\x1b[13;9u");
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true })), "\x1b[13;5u");
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, shiftKey: true })), "\x1b[13;2u");
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, altKey: true })), "\x1b[13;3u");
  assert.equal(
    kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, metaKey: true, shiftKey: true })),
    "\x1b[13;10u",
  );
  // 小键盘 Enter 配合 Cmd 也能入队（KP_ENTER = 57414，或按规范发 57414;9u，crossterm 同样识别为 Enter+SUPER）
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "NumpadEnter", location: 3, metaKey: true })), "\x1b[57414;9u");

  // 普通不带修饰的 Enter、Tab、Backspace 保持传统单字节（放行给 xterm），确保程序崩溃后仍可敲 reset
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13 })), null);
  assert.equal(kb.encodeKey(key({ key: "Tab", code: "Tab", keyCode: 9 })), null);
  assert.equal(kb.encodeKey(key({ key: "Backspace", code: "Backspace", keyCode: 8 })), null);

  // 4. Devin CLI 退出发送 CSI < 1 u → 恢复到 0
  assert.equal(kb.handlePop([1]), true);
  assert.equal(kb.flags, 0);
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, metaKey: true })), null);
});

test("主屏幕与备用屏幕维护独立模式栈，且支持 =flags;mode u、栈溢出淘汰与 reset 清零", () => {
  const { kb, setBuffer } = setup();
  kb.handlePush([1]);
  assert.equal(kb.flags, 1);

  // 进入备用屏幕（如在 Devin 里打开外部编辑器 vim / less）：备用屏初始为 0，不影响主屏
  setBuffer("alternate");
  assert.equal(kb.flags, 0);
  kb.handleSet([3, 1]); // mode 1: 替换为 3 (0b11)
  assert.equal(kb.flags, 3);
  kb.handleSet([4, 2]); // mode 2: 置位 4 → 7 (0b111)
  assert.equal(kb.flags, 7);
  kb.handleSet([2, 3]); // mode 3: 清位 2 → 5 (0b101)
  assert.equal(kb.flags, 5);

  // 退出备用屏幕回到主屏：主屏仍是 1
  setBuffer("normal");
  assert.equal(kb.flags, 1);

  // 压栈超过上限 64 层时淘汰最旧项，弹空栈后重置为 0
  for (let i = 0; i < 70; i++) kb.handlePush([(i % 15) + 1]);
  kb.handlePop([100]);
  assert.equal(kb.flags, 0);

  // reset 清空双栈
  kb.handlePush([1]);
  setBuffer("alternate");
  kb.handlePush([9]);
  kb.reset();
  assert.equal(kb.flags, 0);
  setBuffer("normal");
  assert.equal(kb.flags, 0);
});

test("中文输入法组词与 macOS 系统剪贴板/窗口快捷键绝不被 Kitty 协议抢占", () => {
  const { kb, setOptionAsMeta } = setup({ isMac: true, optionAsMeta: true });
  kb.handlePush([1 | 8]); // 即使开启最激进的全键上报模式

  // 1. 输入法正在组词（isComposing / keyCode 229 / Process）时按 Enter / Shift+Enter / Esc 律放行
  assert.equal(
    kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 229, isComposing: true, metaKey: true })),
    null,
  );
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", keyCode: 13, isComposing: true })), null);
  assert.equal(kb.encodeKey(key({ key: "Process", code: "KeyA", keyCode: 229 })), null);

  // 2. macOS 编辑与窗口系统级预定义菜单快捷键放行（拷贝/粘贴/剪切/全选/撤销/退出/最小化/隐藏/全屏）
  for (const code of ["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyQ", "KeyM", "KeyH"]) {
    assert.equal(
      kb.encodeKey(key({ key: code.slice(3).toLowerCase(), code, metaKey: true })),
      null,
      `⌘${code.slice(3)} 必须保留给宿主系统/编辑操作`,
    );
  }
  assert.equal(kb.encodeKey(key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true })), null, "⌘⇧Z 重做保留");
  assert.equal(kb.encodeKey(key({ key: "h", code: "KeyH", metaKey: true, altKey: true })), null, "⌘⌥H 隐藏其他保留");
  assert.equal(kb.encodeKey(key({ key: "f", code: "KeyF", metaKey: true, ctrlKey: true })), null, "⌃⌘F 全屏保留");

  // 3. macOS Option 作为 Meta 键时，⌥T（key 为 '†'）与 ⌥N（key 为 'Dead'）按物理键正确编码
  kb.handleSet([1, 1]);
  assert.equal(kb.encodeKey(key({ key: "†", code: "KeyT", altKey: true })), "\x1b[116;3u");
  assert.equal(kb.encodeKey(key({ key: "Dead", code: "KeyN", altKey: true })), "\x1b[110;3u");

  // 关闭 Option 作为 Meta 时，单按 ⌥A 交给 macOS 输入特殊字符 'å'，不拦截
  setOptionAsMeta(false);
  assert.equal(kb.encodeKey(key({ key: "å", code: "KeyA", altKey: true })), null);
});

test("Disambiguate 与渐进增强各标志位：Esc、Shift+Tab、Ctrl+Shift+字母、方向键、事件类型、替代键与关联文本", () => {
  const { kb } = setup({ isMac: true });
  kb.handlePush([1]); // 0b1: Disambiguate

  // 普通无修饰字符与 Shift 大写字符在 0b1 下直接走文本输入（返回 null 交给 xterm）
  assert.equal(kb.encodeKey(key({ key: "a", code: "KeyA" })), null);
  assert.equal(kb.encodeKey(key({ key: "A", code: "KeyA", shiftKey: true })), null);
  assert.equal(kb.encodeKey(key({ key: " ", code: "Space" })), null);

  // Esc、Shift+Tab、Ctrl+C、Ctrl+I、Ctrl+Shift+A（基础码点必须是小写 97！）、Cmd+方向键
  assert.equal(kb.encodeKey(key({ key: "Escape", code: "Escape", keyCode: 27 })), "\x1b[27u");
  assert.equal(kb.encodeKey(key({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true })), "\x1b[9;2u");
  assert.equal(kb.encodeKey(key({ key: "c", code: "KeyC", ctrlKey: true })), "\x1b[99;5u");
  assert.equal(kb.encodeKey(key({ key: "i", code: "KeyI", ctrlKey: true })), "\x1b[105;5u");
  assert.equal(kb.encodeKey(key({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true })), "\x1b[97;6u");
  assert.equal(kb.encodeKey(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true })), "\x1b[1;9D");
  assert.equal(kb.encodeKey(key({ key: "Delete", code: "Delete", shiftKey: true })), "\x1b[3;2~");

  // 0b1 | 0b100 (Report alternate keys)：按住 Shift 时附带大写/上档码点
  kb.handleSet([1 | 4, 1]);
  assert.equal(kb.encodeKey(key({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true })), "\x1b[97:65;6u");
  assert.equal(kb.encodeKey(key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true })), "\x1b[61:43;6u");

  // 0b1 | 0b10 (Report event types)：repeat 报 :2，release 报 :3；未开 0b1000 时 Enter 的 release 不报
  kb.handleSet([1 | 2, 1]);
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter", metaKey: true, repeat: true })), "\x1b[13;9:2u");
  assert.equal(kb.encodeKey(key({ type: "keyup", key: "c", code: "KeyC", ctrlKey: true })), "\x1b[99;5:3u");
  assert.equal(kb.encodeKey(key({ type: "keyup", key: "Enter", code: "Enter", metaKey: true })), null);

  // 0b1000 | 0b10000 (Report all keys + associated text)：普通按键与无修饰 Enter 均报 CSI u
  kb.handleSet([8 | 16, 1]);
  assert.equal(kb.encodeKey(key({ key: "a", code: "KeyA" })), "\x1b[97;;97u");
  assert.equal(kb.encodeKey(key({ key: "A", code: "KeyA", shiftKey: true })), "\x1b[97;2;65u");
  assert.equal(kb.encodeKey(key({ key: "Enter", code: "Enter" })), "\x1b[13u");
});

test("集成真实 xterm.js Parser：收到 \\x1b[?u\\x1b[c 时同步先回 \\x1b[?0u 再回 \\x1b[?1;2c，并正确执行 >1u / <1u", async () => {
  const term = new Terminal({ cols: 80, rows: 24 });
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  const kitty = installKittyKeyboard(term, { isMac: true, getOptionAsMeta: () => true });

  await new Promise<void>((res) => term.write("\x1b[?u\x1b[c\x1b[>1u\x1b[?u", res));
  // 顺序至关重要：crossterm 若先读到 \x1b[?1;2c 会判定终端不支持 Kitty 协议！
  assert.deepEqual(sent, ["\x1b[?0u", "\x1b[?1;2c", "\x1b[?1u"]);
  assert.equal(kitty.flags, 1);

  await new Promise<void>((res) => term.write("\x1b[<1u\x1b[?u", res));
  assert.equal(kitty.flags, 0);
  assert.equal(sent.at(-1), "\x1b[?0u");

  // 验证 RIS (\x1bc) 重置自动清空键盘栈
  await new Promise<void>((res) => term.write("\x1b[>1u\x1bc\x1b[?u", res));
  assert.equal(kitty.flags, 0);
  assert.equal(sent.at(-1), "\x1b[?0u");

  kitty.dispose();
  term.dispose();
});

test("handleDomKeyEvent：接管 Cmd+Enter 时调用 preventDefault 并吞掉紧随其后的 keypress，防止重复发送回车", () => {
  const sent: string[] = [];
  const kb = createKittyKeyboard(
    { isMac: true, getOptionAsMeta: () => true, getBufferType: () => "normal", reply() {} },
    (seq) => sent.push(seq),
  );
  kb.handlePush([1]);

  let downPrevented = false;
  let pressPrevented = false;
  const handledDown = kb.handleDomKeyEvent({
    type: "keydown",
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    preventDefault: () => (downPrevented = true),
    stopPropagation() {},
  } as unknown as KeyboardEvent);
  const handledPress = kb.handleDomKeyEvent({
    type: "keypress",
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    preventDefault: () => (pressPrevented = true),
    stopPropagation() {},
  } as unknown as KeyboardEvent);

  assert.equal(handledDown, true);
  assert.equal(downPrevented, true);
  assert.equal(handledPress, true);
  assert.equal(pressPrevented, true);
  assert.deepEqual(sent, ["\x1b[13;9u"]);
});

