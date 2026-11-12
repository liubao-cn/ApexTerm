import type { IDisposable, Terminal } from "@xterm/xterm";

function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
}

/**
 * Kitty 键盘协议（https://sw.kovidgoyal.net/kitty/keyboard-protocol/）。
 *
 * Devin CLI、Claude Code、Neovim、Helix、Yazi 等现代 TUI 启动时会发送 `CSI ? u` + `CSI c` 探测终端是否支持
 * Kitty 键盘协议，收到 `CSI ? <flags> u` 应答后通过 `CSI > 1 u` 开启无歧义按键上报，从而区分：
 * - `Cmd + Enter`（`CSI 13;9u`） / `Ctrl + Enter`（`CSI 13;5u`）：Devin CLI 会话运行中将新消息加入等待队列
 * - `Shift + Enter`（`CSI 13;2u`）：多行输入换行
 * - 单按 `Esc`（`CSI 27u`）、`Ctrl + I` 与 `Tab`、`Ctrl + Shift + 字母` 等传统 VT 无法区分的组合键
 *
 * 主屏幕（normal）与备用屏幕（alternate）按规范各自维护独立的模式栈，退出程序（`CSI < u`）或重连时自动恢复，
 * 普通 shell（flags=0）、中文输入法组词及 macOS 系统剪贴板/窗口快捷键保持原有行为不变。
 */

const FLAG_DISAMBIGUATE = 0b1;
const FLAG_REPORT_EVENTS = 0b10;
const FLAG_REPORT_ALTERNATE = 0b100;
const FLAG_REPORT_ALL_KEYS = 0b1000;
const FLAG_REPORT_TEXT = 0b10000;
const VALID_FLAGS_MASK = 0b11111;
const MAX_STACK_SIZE = 64;

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;
const MOD_SUPER = 8;
const MOD_CAPS_LOCK = 64;
const MOD_NUM_LOCK = 128;

export interface KittyKeyInput {
  type: string;
  key: string;
  code: string;
  location?: number;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  getModifierState?: (keyArg: string) => boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface KittyKeyboardOptions {
  isMac: boolean;
  getOptionAsMeta: () => boolean;
  getBufferType: () => "normal" | "alternate";
  reply: (data: string) => void;
}

export interface KittyKeyboard {
  readonly flags: number;
  handleQuery(): boolean;
  handlePush(params: (number | number[])[]): boolean;
  handlePop(params: (number | number[])[]): boolean;
  handleSet(params: (number | number[])[]): boolean;
  encodeKey(ev: KittyKeyInput): string | null;
  handleDomKeyEvent(ev: KeyboardEvent): boolean;
  reset(): void;
  dispose(): void;
}

interface ScreenModeState {
  flags: number;
  stack: number[];
}

/** PC-101 物理键码 → [基础未上档字符, 美式上档字符] */
const PHYSICAL_TEXT_KEYS: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
};

/** CSI 1 ; mod <letter> 形式的功能键 */
const CSI_LETTER_KEYS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
  F1: "P",
  F2: "Q",
  F4: "S",
};

/** CSI <num> ; mod ~ 形式的功能键 */
const CSI_TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F3: 13,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/** CSI <codepoint> ; mod u 形式的特殊功能键（不含仅在 0b1000 才上报的修饰键本身） */
const CSI_U_FUNCTIONAL_KEYS: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  F13: 57376,
  F14: 57377,
  F15: 57378,
  F16: 57379,
  F17: 57380,
  F18: 57381,
  F19: 57382,
  F20: 57383,
  F21: 57384,
  F22: 57385,
  F23: 57386,
  F24: 57387,
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
};

/** 纯修饰键：仅在开启 REPORT_ALL_KEYS_AS_ESCAPE_CODES (0b1000) 时才上报 */
const MODIFIER_SELF_KEYS: Record<string, number> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
};

const MAC_RESERVED_PLAIN_CMD = new Set(["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyQ", "KeyM", "KeyH"]);

/** macOS 原生编辑菜单与系统窗口快捷键（不能转成 Super+key 发进终端，否则拷贝/粘贴/全选/退出会失效） */
export function isMacSystemShortcut(ev: KittyKeyInput): boolean {
  if (!ev.metaKey) return false;
  if (!ev.ctrlKey && !ev.altKey) {
    if (!ev.shiftKey && MAC_RESERVED_PLAIN_CMD.has(ev.code)) return true;
    if (ev.shiftKey && ev.code === "KeyZ") return true;
  }
  if (!ev.ctrlKey && ev.altKey && !ev.shiftKey && ev.code === "KeyH") return true;
  if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.code === "KeyF") return true;
  return false;
}

function numParam(params: (number | number[])[], idx: number, fallback: number): number {
  const v = params[idx];
  return typeof v === "number" && v > 0 ? v : fallback;
}

function rawParam(params: (number | number[])[], idx: number): number {
  const v = params[idx];
  return typeof v === "number" && v >= 0 ? v : 0;
}

function isPrintableSingleChar(s: string): boolean {
  if (!s) return false;
  const cp = s.codePointAt(0)!;
  const charLen = cp > 0xffff ? 2 : 1;
  return s.length === charLen && cp >= 0x20 && (cp < 0x7f || cp > 0x9f);
}

/** 提取文本按键的 [基础小写码点, 上档码点(若有), PC-101 物理码点(若有)] */
function resolveTextKeyCodes(
  ev: KittyKeyInput,
  macAltProducesSymbol: boolean,
): { code: number; shifted?: number; baseLayout?: number } | null {
  if (/^Key[A-Z]$/.test(ev.code)) {
    const asciiLower = ev.code.charCodeAt(3) + 32;
    const asciiUpper = ev.code.charCodeAt(3);
    // 非拉丁/国际布局：若未按 Alt 特殊符号且 ev.key 是其它单字符字母，以当前布局字符为主码点、PC-101 为 baseLayout
    if (!macAltProducesSymbol && isPrintableSingleChar(ev.key)) {
      const lower = ev.key.toLowerCase();
      const upper = ev.key.toUpperCase();
      const lowerCp = lower.codePointAt(0)!;
      const upperCp = upper.codePointAt(0)!;
      if (lowerCp !== asciiLower && lower.length === [...lower].length) {
        return {
          code: lowerCp,
          shifted: ev.shiftKey && upperCp !== lowerCp ? upperCp : undefined,
          baseLayout: asciiLower,
        };
      }
    }
    return { code: asciiLower, shifted: ev.shiftKey ? asciiUpper : undefined };
  }

  const phys = PHYSICAL_TEXT_KEYS[ev.code];
  if (phys) {
    const baseCp = phys[0].charCodeAt(0);
    const defaultShiftedCp = phys[1].charCodeAt(0);
    const actualShiftedCp =
      !macAltProducesSymbol && ev.shiftKey && isPrintableSingleChar(ev.key)
        ? ev.key.codePointAt(0)!
        : defaultShiftedCp;
    return {
      code: baseCp,
      shifted: ev.shiftKey && actualShiftedCp !== baseCp ? actualShiftedCp : undefined,
    };
  }

  if (!macAltProducesSymbol && isPrintableSingleChar(ev.key)) {
    const lower = ev.key.toLowerCase();
    const cp = lower.codePointAt(0)!;
    const rawCp = ev.key.codePointAt(0)!;
    return { code: cp, shifted: ev.shiftKey && rawCp !== cp ? rawCp : undefined };
  }

  return null;
}

function formatCsiU(
  keyField: string,
  modParam: number,
  eventType: number,
  textCodepoints?: number[],
): string {
  const hasModOrEvent = modParam > 1 || eventType > 1;
  const modField = !hasModOrEvent ? "" : eventType === 1 ? `${modParam}` : `${modParam}:${eventType}`;
  if (textCodepoints && textCodepoints.length > 0) {
    return `\x1b[${keyField};${modField};${textCodepoints.join(":")}u`;
  }
  return modField ? `\x1b[${keyField};${modField}u` : `\x1b[${keyField}u`;
}

export function createKittyKeyboard(
  opts: KittyKeyboardOptions,
  onSendKey?: (seq: string) => void,
): KittyKeyboard {
  const normal: ScreenModeState = { flags: 0, stack: [] };
  const alternate: ScreenModeState = { flags: 0, stack: [] };
  let swallowNextKeypress = false;

  const active = (): ScreenModeState => (opts.getBufferType() === "alternate" ? alternate : normal);

  function encodeKey(ev: KittyKeyInput): string | null {
    const flags = active().flags;
    if (flags === 0) return null;

    const reportEvents = (flags & FLAG_REPORT_EVENTS) !== 0;
    const reportAlternate = (flags & FLAG_REPORT_ALTERNATE) !== 0;
    const reportAll = (flags & FLAG_REPORT_ALL_KEYS) !== 0;
    const reportText = reportAll && (flags & FLAG_REPORT_TEXT) !== 0;
    const disambiguate = (flags & FLAG_DISAMBIGUATE) !== 0 || reportAll;

    if (ev.type === "keyup") {
      if (!reportEvents) return null;
    } else if (ev.type !== "keydown") {
      return null;
    }

    const optionAsMeta = opts.getOptionAsMeta();
    // macOS 开启 Option-as-Meta 时按 ⌥N/⌥E 会产生 key="Dead"，属于合法的 Alt 组合键而非输入法组词
    const macMetaAlt = opts.isMac && optionAsMeta && ev.altKey;
    if (ev.isComposing || ev.keyCode === 229 || ev.key === "Process") return null;
    if (ev.key === "Dead" && !macMetaAlt) return null;

    if (opts.isMac && isMacSystemShortcut(ev)) return null;
    // macOS 关闭 Option-as-Meta 且仅按了 Option（无 Ctrl/Cmd）时，交给系统输入特殊字符（如 å）
    if (opts.isMac && !optionAsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) return null;

    const eventType = ev.type === "keyup" ? 3 : ev.repeat ? (reportEvents ? 2 : 1) : 1;

    // 计算修饰符位掩码（规范：Lock 修饰位仅在 reportAll 模式下附加，避免大写锁定干扰传统快捷键匹配）
    let modMask =
      (ev.shiftKey ? MOD_SHIFT : 0) |
      (ev.altKey ? MOD_ALT : 0) |
      (ev.ctrlKey ? MOD_CTRL : 0) |
      (ev.metaKey ? MOD_SUPER : 0);
    if (reportAll && ev.getModifierState) {
      if (ev.getModifierState("CapsLock")) modMask |= MOD_CAPS_LOCK;
      if (ev.getModifierState("NumLock")) modMask |= MOD_NUM_LOCK;
    }
    const modParam = 1 + modMask;
    const hasActionMod = (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) && modMask > 0;

    // 1. 纯修饰键自身按下/释放：仅在 reportAll 下上报
    const selfModCode = MODIFIER_SELF_KEYS[ev.code];
    if (selfModCode !== undefined) {
      if (!reportAll) return null;
      return formatCsiU(`${selfModCode}`, modParam, eventType);
    }

    // 2. CSI 1 ; mod [ABCDEFHPQS] 功能键（方向键、Home/End、F1/F2/F4）
    const letter = CSI_LETTER_KEYS[ev.code];
    if (letter) {
      if (!hasActionMod && eventType === 1 && !reportAll) return null;
      if (modParam === 1 && eventType === 1) return `\x1b[${letter}`;
      const modField = eventType === 1 ? `${modParam}` : `${modParam}:${eventType}`;
      return `\x1b[1;${modField}${letter}`;
    }

    // 3. CSI num ; mod ~ 功能键（Insert/Delete/PageUp/PageDown/F3/F5..F12）
    const tildeNum = CSI_TILDE_KEYS[ev.code];
    if (tildeNum !== undefined) {
      // 主屏幕下保留 Shift+PageUp/PageDown 滚动终端历史缓冲区的默认操作
      if (
        !reportAll &&
        opts.getBufferType() === "normal" &&
        (ev.code === "PageUp" || ev.code === "PageDown") &&
        ev.shiftKey &&
        !ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey
      ) {
        return null;
      }
      if (!hasActionMod && eventType === 1 && !reportAll) return null;
      if (modParam === 1 && eventType === 1) return `\x1b[${tildeNum}~`;
      const modField = eventType === 1 ? `${modParam}` : `${modParam}:${eventType}`;
      return `\x1b[${tildeNum};${modField}~`;
    }

    // 4. CSI <codepoint> ; mod u 功能键（Enter / Tab / Backspace / Escape / Numpad / F13+）
    const funcCode =
      ev.code === "NumpadEnter" || (ev.key === "Enter" && ev.location === 3)
        ? 57414
        : CSI_U_FUNCTIONAL_KEYS[ev.code] ?? (ev.key === "Enter" ? 13 : undefined);
    if (funcCode !== undefined) {
      const isLegacyTriad = funcCode === 13 || funcCode === 9 || funcCode === 127;
      // 规范特例：未开启 reportAll 时，Enter / Tab / Backspace 不报 keyup，且无修饰按压保持传统单字节
      if (isLegacyTriad && !reportAll) {
        if (eventType === 3) return null;
        if (!hasActionMod && eventType === 1) return null;
      }
      if (!disambiguate && !hasActionMod) return null;
      return formatCsiU(`${funcCode}`, modParam, eventType);
    }

    // 5. 文本字符键
    const nonPlainMod = ev.ctrlKey || ev.altKey || ev.metaKey;
    // 未开启 reportAll 时，不带 Ctrl/Alt/Super 的普通文本输入（含 Shift 大写与空格）直接走 UTF-8 文本流
    if (!reportAll && !nonPlainMod) return null;
    if (!disambiguate && !ev.metaKey) return null;

    const resolved = resolveTextKeyCodes(ev, macMetaAlt);
    if (!resolved) return null;

    let keyField = `${resolved.code}`;
    if (reportAlternate && (resolved.shifted !== undefined || resolved.baseLayout !== undefined)) {
      const s = resolved.shifted !== undefined ? `${resolved.shifted}` : "";
      keyField += resolved.baseLayout !== undefined ? `:${s}:${resolved.baseLayout}` : `:${s}`;
    }

    let textCps: number[] | undefined;
    if (reportText && eventType !== 3 && !ev.ctrlKey && !ev.altKey && !ev.metaKey && isPrintableSingleChar(ev.key)) {
      textCps = [...ev.key].map((ch) => ch.codePointAt(0)!);
    }

    return formatCsiU(keyField, modParam, eventType, textCps);
  }

  return {
    get flags() {
      return active().flags;
    },
    handleQuery() {
      opts.reply(`\x1b[?${active().flags}u`);
      return true;
    },
    handlePush(params) {
      const s = active();
      if (s.stack.length >= MAX_STACK_SIZE) s.stack.shift();
      s.stack.push(s.flags);
      s.flags = rawParam(params, 0) & VALID_FLAGS_MASK;
      return true;
    },
    handlePop(params) {
      const s = active();
      const count = numParam(params, 0, 1);
      if (count >= s.stack.length) {
        s.stack.length = 0;
        s.flags = 0;
      } else {
        s.flags = s.stack.splice(s.stack.length - count, count)[0];
      }
      return true;
    },
    handleSet(params) {
      const s = active();
      const bits = rawParam(params, 0) & VALID_FLAGS_MASK;
      const mode = numParam(params, 1, 1);
      if (mode === 1) s.flags = bits;
      else if (mode === 2) s.flags = (s.flags | bits) & VALID_FLAGS_MASK;
      else if (mode === 3) s.flags &= ~bits;
      return true;
    },
    encodeKey,
    handleDomKeyEvent(ev: KeyboardEvent): boolean {
      if (ev.type === "keypress") {
        if (!swallowNextKeypress) return false;
        swallowNextKeypress = false;
        ev.preventDefault();
        return true;
      }
      swallowNextKeypress = false;
      const seq = encodeKey(ev);
      if (seq === null) return false;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.type === "keydown") swallowNextKeypress = true;
      onSendKey?.(seq);
      return true;
    },
    reset() {
      normal.flags = 0;
      normal.stack.length = 0;
      alternate.flags = 0;
      alternate.stack.length = 0;
      swallowNextKeypress = false;
    },
    dispose() {
      this.reset();
    },
  };
}

export function installKittyKeyboard(
  term: Terminal,
  opts: { isMac?: boolean; getOptionAsMeta?: () => boolean } = {},
): KittyKeyboard & IDisposable {
  const kb = createKittyKeyboard(
    {
      isMac: opts.isMac ?? detectIsMac(),
      getOptionAsMeta: opts.getOptionAsMeta ?? (() => term.options.macOptionIsMeta ?? true),
      getBufferType: () => term.buffer.active.type,
      // 必须走同步的 term.input(data, false)，确保对 `\x1b[?u\x1b[c` 的应答严格排在 DA1 `\x1b[?1;2c` 之前
      reply: (data) => term.input(data, false),
    },
    (seq) => term.input(seq, true),
  );

  const disposables: IDisposable[] = [
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => kb.handleQuery()),
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (p) => kb.handlePush(p)),
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (p) => kb.handlePop(p)),
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (p) => kb.handleSet(p)),
    // RIS 硬重置（ESC c）与 DECSTR 软重置（CSI ! p）时同步清空双栈并继续交给 xterm 默认重置处理
    term.parser.registerEscHandler({ final: "c" }, () => {
      kb.reset();
      return false;
    }),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      kb.reset();
      return false;
    }),
  ];

  return {
    get flags() {
      return kb.flags;
    },
    handleQuery: () => kb.handleQuery(),
    handlePush: (p) => kb.handlePush(p),
    handlePop: (p) => kb.handlePop(p),
    handleSet: (p) => kb.handleSet(p),
    encodeKey: (ev) => kb.encodeKey(ev),
    handleDomKeyEvent: (ev) => kb.handleDomKeyEvent(ev),
    reset: () => kb.reset(),
    dispose() {
      kb.dispose();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
