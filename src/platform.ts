/** 平台差异集中在这里：快捷键修饰符、标签文案、窗口外观 */
export const isMac =
  /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
export const isWindows = /Win/.test(navigator.platform);

/** 系统文件管理器的叫法，用于按钮文案 */
export const fileManagerName = isMac ? "Finder" : isWindows ? "资源管理器" : "文件管理器";

/** 应用级快捷键（新建/关闭标签、清屏、查找、重载）：mac 用 ⌘，其它平台用 Ctrl+Shift 以避开终端自身的 Ctrl 组合 */
export function appShortcut(key: string): string {
  const shift = key.toLowerCase().startsWith("shift+");
  const k = (shift ? key.slice(6) : key).toUpperCase();
  if (isMac) return `⌘${shift ? "⇧" : ""}${k}`;
  return `Ctrl+Shift+${shift ? "Alt+" : ""}${k}`;
}

/** 切换标签：mac ⌘1–9 / ⌘0，其它平台 Alt+1–9 / Alt+0 */
export const tabSwitchHint = isMac ? "⌘1–9，⌘0 回到主机" : "Alt+1–9，Alt+0 回到主机";

export function tabIndexLabel(i: number): string {
  return isMac ? `⌘${i}` : `Alt+${i}`;
}

/** 判断一个键盘事件是否是"应用级"修饰组合（对应 appShortcut） */
export function isAppModifier(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && e.shiftKey && !e.altKey;
}

/** 判断是否是"切换标签"的修饰组合 */
export function isTabModifier(e: KeyboardEvent): boolean {
  return isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

// ---- 加速键字符串（Tauri 菜单格式，如 "CmdOrCtrl+Shift+D"）的解析 / 匹配 / 显示 ----

export interface Accel {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** KeyboardEvent.code → 加速键里的键名 */
const CODE_TO_KEY: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Backquote: "`",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

export function keyTokenFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return CODE_TO_KEY[code] ?? null;
}

export function parseAccel(accel: string): Accel | null {
  const parts = accel
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const a: Accel = { cmdOrCtrl: false, ctrl: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "cmdorctrl" || l === "commandorcontrol") a.cmdOrCtrl = true;
    else if (l === "cmd" || l === "command" || l === "super" || l === "meta") {
      if (isMac) a.cmdOrCtrl = true;
      else a.ctrl = true;
    } else if (l === "ctrl" || l === "control") {
      if (isMac) a.ctrl = true;
      else a.cmdOrCtrl = true;
    } else if (l === "alt" || l === "option") a.alt = true;
    else if (l === "shift") a.shift = true;
    else a.key = p.length === 1 ? p.toUpperCase() : p;
  }
  return a.key ? a : null;
}

/** 键盘事件是否命中该加速键 */
export function matchesAccel(e: KeyboardEvent, accel: string): boolean {
  const a = parseAccel(accel);
  if (!a) return false;
  const token = keyTokenFromEvent(e);
  if (!token || token.toLowerCase() !== a.key.toLowerCase()) return false;
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  return primary === a.cmdOrCtrl && secondary === a.ctrl && e.altKey === a.alt && e.shiftKey === a.shift;
}

/** 从按键事件生成加速键字符串；只按了修饰键返回 null */
export function accelFromEvent(e: KeyboardEvent): string | null {
  const token = keyTokenFromEvent(e);
  if (!token) return null;
  const mods: string[] = [];
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  if (primary) mods.push("CmdOrCtrl");
  if (secondary) mods.push(isMac ? "Ctrl" : "Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // 功能键可以不带修饰，其它键必须带
  if (mods.length === 0 && !/^F\d+$/.test(token)) return null;
  return [...mods, token].join("+");
}

/** 加速键的显示文案：mac 用符号（⌘⇧D），其它平台用 Ctrl+Shift+D */
export function accelLabel(accel: string | null | undefined): string {
  if (!accel) return "";
  const a = parseAccel(accel);
  if (!a) return accel;
  const key = a.key.length === 1 ? a.key.toUpperCase() : a.key;
  if (isMac) {
    const sym: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↩", Backspace: "⌫", Delete: "⌦", Escape: "⎋", Tab: "⇥", Space: "␣" };
    return `${a.ctrl ? "⌃" : ""}${a.alt ? "⌥" : ""}${a.shift ? "⇧" : ""}${a.cmdOrCtrl ? "⌘" : ""}${sym[key] ?? key}`;
  }
  const parts: string[] = [];
  if (a.cmdOrCtrl) parts.push("Ctrl");
  if (a.ctrl) parts.push("Win");
  if (a.alt) parts.push("Alt");
  if (a.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}
