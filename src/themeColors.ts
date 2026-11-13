import type { ITheme } from "@xterm/xterm";

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

// ---- 颜色分析：深/浅判断、对比度、可读性增强 ----

function parseColor(c: string): [number, number, number] | null {
  const hex = c.trim();
  // 8 位 hex 的后两位是透明度，这里只取颜色（透明度见 flatten）
  const m6 = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex);
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

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** a 向 b 混入 k（0–1），输出不透明 hex */
function mix(a: string, b: string, k: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * k) as [number, number, number]);
}

/** 把可能带 alpha 的颜色叠到底色上，得到实际看到的不透明色 */
function flatten(c: string, bg: string): string {
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(c.trim());
  const hex8 = /^#?[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c.trim());
  const alpha = rgba ? Number(rgba[1]) : hex8 ? parseInt(hex8[1], 16) / 255 : 1;
  return mix(bg, c, Math.min(1, Math.max(0, alpha)));
}

/** 选区底色与终端底色的对比度上下限：低于下限看不出选了什么，高于上限大片选中时晃眼 */
const SELECTION_MIN = 1.25;
const SELECTION_MAX = 2.6;

/**
 * 选区底色归一化（聚焦 / 失焦两档，均为不透明色）。
 * 主题自带的选区色叠到底色上后，若「看得出」又「不晃眼」且正文在其上 ≥ 4.5:1 就原样采用；
 * 否则（常见于反色式选区：直接拿前景色或很亮的浅色当选区）按主题色相重新调一个柔和的：
 * 深底目标对比 1.75、浅底 1.32，并保证不把正文在选区上的对比压得太低。
 */
export function selectionColors(t: TermTheme): { active: string; inactive: string } {
  const bg = t.background;
  const own = flatten(t.selectionBackground, bg);
  const vsBg = contrastRatio(own, bg);
  let active = own;
  if (vsBg < SELECTION_MIN || vsBg > SELECTION_MAX || contrastRatio(t.foreground, own) < 4.5) {
    const dark = isDark(t);
    const target = Math.min(dark ? 1.75 : 1.32, Math.max(dark ? 1.3 : 1.2, contrastRatio(t.foreground, bg) / 5.5));
    // 色相优先沿用主题自己的选区色（有彩度才算），其次蓝色；都调不到目标对比就退到前景色
    const tint = [(hsl(own)?.s ?? 0) > 0.2 ? own : null, t.blue, t.foreground].find(
      (c): c is string => !!c && contrastRatio(c, bg) >= target && luminance(c) > luminance(bg) === dark,
    );
    if (tint) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (contrastRatio(mix(bg, tint, mid), bg) < target) lo = mid;
        else hi = mid;
      }
      active = mix(bg, tint, hi);
    }
  }
  return { active, inactive: mix(bg, active, 0.6) };
}

/** 「可读性增强」对应的 xterm 动态最小对比度：按每个字实际所在的底色（含选区、TUI 色块）保底，真彩色文字也算 */
export function minimumContrastFor(boost: boolean): number {
  return boost ? 4.5 : 1;
}

/**
 * 生成交给 xterm 的最终配色：
 * - 选区底色归一化成不透明色（见 selectionColors）
 * - 可选让光标跟随文字颜色（不少主题自带很跳的光标色）
 * - 可选可读性增强（见 boostReadability）
 */
export function toXtermTheme(
  t: TermTheme,
  opts: { cursorFollowsForeground?: boolean; boostReadability?: boolean } = {},
): ITheme {
  const base = opts.boostReadability ? boostReadability(t) : t;
  const cursor = opts.cursorFollowsForeground ? base.foreground : base.cursor;
  const sel = selectionColors(base);
  return {
    ...base,
    cursor,
    cursorAccent: base.background,
    selectionBackground: sel.active,
    selectionInactiveBackground: sel.inactive,
  };
}
