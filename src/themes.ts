import type { ITheme } from "@xterm/xterm";
import generated from "./themes.generated.json";

export interface TermThemePreset {
  id: string;
  name: string;
  theme: Required<
    Pick<
      ITheme,
      | "background"
      | "foreground"
      | "cursor"
      | "selectionBackground"
      | "black"
      | "red"
      | "green"
      | "yellow"
      | "blue"
      | "magenta"
      | "cyan"
      | "white"
      | "brightBlack"
      | "brightRed"
      | "brightGreen"
      | "brightYellow"
      | "brightBlue"
      | "brightMagenta"
      | "brightCyan"
      | "brightWhite"
    >
  >;
}

export type TermTheme = TermThemePreset["theme"];

export const DEFAULT_THEME_ID = "apexterm";
export const LIGHT_THEME_ID = "apexterm-light";

/** 默认深色：中性深底，ANSI 全部 ≥ 5:1、注释灰 ≥ 4:1，给 Claude Code / Devin CLI 这类 TUI 用 */
const APEXTERM: TermThemePreset = {
  id: DEFAULT_THEME_ID,
  name: "ApexTerm Dark（默认）",
  theme: {
    background: "#141416",
    foreground: "#e6e6ea",
    cursor: "#e6e6ea",
    selectionBackground: "rgba(91, 141, 239, 0.35)",
    black: "#1c1c21",
    red: "#e5615b",
    green: "#3dbe7a",
    yellow: "#e3a23a",
    blue: "#5b8def",
    magenta: "#b884f0",
    cyan: "#4cc2d6",
    white: "#c8c8d0",
    brightBlack: "#7a7a86",
    brightRed: "#f07a74",
    brightGreen: "#5fd695",
    brightYellow: "#f2b95a",
    brightBlue: "#7ba3f3",
    brightMagenta: "#c99cf5",
    brightCyan: "#6fd5e6",
    brightWhite: "#f0f0f4",
  },
};

/** 默认浅色：亮色 ANSI 也压暗到 ≥ 4.5:1，避免浅底上黄/青看不见 */
const APEXTERM_LIGHT: TermThemePreset = {
  id: LIGHT_THEME_ID,
  name: "ApexTerm Light",
  theme: {
    background: "#f7f7f9",
    foreground: "#1f2024",
    cursor: "#1f2024",
    selectionBackground: "rgba(59, 111, 214, 0.25)",
    black: "#2a2b31",
    red: "#c9403b",
    green: "#1b7f4e",
    yellow: "#8f630f",
    blue: "#2f5cb8",
    magenta: "#7a3fbf",
    cyan: "#16788a",
    white: "#8e8e96",
    brightBlack: "#6b6b74",
    brightRed: "#b8322e",
    brightGreen: "#197a4a",
    brightYellow: "#8a5c08",
    brightBlue: "#274fa3",
    brightMagenta: "#6a34aa",
    brightCyan: "#12697a",
    brightWhite: "#5c5c66",
  },
};

/** 自带两套 + iTerm2-Color-Schemes 全部 600+ 套（MIT，见 THIRD_PARTY_LICENSES.md） */
export const THEME_PRESETS: TermThemePreset[] = [APEXTERM, APEXTERM_LIGHT, ...(generated as TermThemePreset[])];

const BY_ID = new Map(THEME_PRESETS.map((p) => [p.id, p]));

export function presetById(id: string): TermThemePreset {
  return BY_ID.get(id) ?? APEXTERM;
}

export const ANSI_KEYS: { key: keyof TermTheme; label: string }[] = [
  { key: "black", label: "黑" },
  { key: "red", label: "红" },
  { key: "green", label: "绿" },
  { key: "yellow", label: "黄" },
  { key: "blue", label: "蓝" },
  { key: "magenta", label: "紫" },
  { key: "cyan", label: "青" },
  { key: "white", label: "白" },
  { key: "brightBlack", label: "亮黑" },
  { key: "brightRed", label: "亮红" },
  { key: "brightGreen", label: "亮绿" },
  { key: "brightYellow", label: "亮黄" },
  { key: "brightBlue", label: "亮蓝" },
  { key: "brightMagenta", label: "亮紫" },
  { key: "brightCyan", label: "亮青" },
  { key: "brightWhite", label: "亮白" },
];

export const FONT_OPTIONS = [
  '"SF Mono", Menlo, Monaco, monospace',
  "Menlo, monospace",
  "Monaco, monospace",
  '"JetBrains Mono", monospace',
  '"Fira Code", monospace',
  '"Cascadia Mono", "Cascadia Code", monospace',
  '"Source Code Pro", monospace',
  "Hack, monospace",
  '"Ubuntu Mono", monospace',
  "Consolas, monospace",
  '"Courier New", monospace',
];

export const TERM_TYPES = ["xterm-256color", "xterm", "screen-256color", "tmux-256color", "vt100", "linux"];

// ---- 颜色分析：深/浅判断、对比度、可读性增强 ----

function parseColor(c: string): [number, number, number] | null {
  const hex = c.trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m3 = /^#?([0-9a-f]{3})$/i.exec(hex);
  if (m3) {
    const [r, g, b] = m3[1].split("").map((ch) => parseInt(ch + ch, 16));
    return [r, g, b];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  return null;
}

/** 简单亮度（只用来判断深浅底） */
function luminance(c: string): number {
  const rgb = parseColor(c);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 相对亮度 */
function relativeLuminance(c: string): number {
  const rgb = parseColor(c);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1–21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hsl(c: string): { h: number; s: number; l: number } | null {
  const rgb = parseColor(c);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

export function isDark(t: TermTheme): boolean {
  return luminance(t.background) < 0.45;
}

/** 对比度不够就沿亮度轴推（深底调亮、浅底调暗），直到达标；本来就达标则原样返回 */
export function ensureContrast(color: string, bg: string, min: number): string {
  if (contrastRatio(color, bg) >= min) return color;
  const c = hsl(color);
  if (!c) return color;
  const dark = luminance(bg) < 0.45;
  let l = c.l;
  let out = color;
  for (let i = 0; i < 50 && contrastRatio(out, bg) < min; i++) {
    l = Math.min(1, Math.max(0, l + (dark ? 0.02 : -0.02)));
    out = hslToHex(c.h, c.s, l);
  }
  return out;
}

const CHROMATIC: (keyof TermTheme)[] = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
];

/** 可读性增强：注释灰（brightBlack）≥ 4:1，其余彩色 ≥ 3:1；black / white 不动（TUI 常拿它们当底色） */
export function boostReadability(t: TermTheme): TermTheme {
  const out: TermTheme = { ...t, brightBlack: ensureContrast(t.brightBlack, t.background, 4) };
  for (const k of CHROMATIC) out[k] = ensureContrast(t[k], t.background, 3);
  return out;
}

/** 正文（前景）与六个基础彩色里最低的对比度，用来打「高对比」标签 */
export function minContrast(t: TermTheme): number {
  const keys: (keyof TermTheme)[] = ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan"];
  return Math.min(...keys.map((k) => contrastRatio(t[k], t.background)));
}

/** 把不透明颜色变成带 alpha 的 rgba；已经是 rgba 的原样返回 */
export function withAlpha(c: string, alpha: number): string {
  if (/^rgba\(/i.test(c)) return c;
  const rgb = parseColor(c);
  if (!rgb) return c;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * 生成交给 xterm 的最终配色：
 * - 选区底色统一加透明度（很多导入主题的选区色是不透明浅色，会把文字盖住）
 * - 可选让光标跟随文字颜色（不少主题自带很跳的光标色）
 * - 可选可读性增强（见 boostReadability）
 */
export function toXtermTheme(
  t: TermTheme,
  opts: { cursorFollowsForeground?: boolean; boostReadability?: boolean } = {},
): ITheme {
  const base = opts.boostReadability ? boostReadability(t) : t;
  const cursor = opts.cursorFollowsForeground ? base.foreground : base.cursor;
  return {
    ...base,
    cursor,
    cursorAccent: base.background,
    selectionBackground: withAlpha(base.selectionBackground, 0.4),
    selectionInactiveBackground: withAlpha(base.selectionBackground, 0.25),
  };
}
