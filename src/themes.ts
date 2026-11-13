import generated from "./themes.generated.json";
import { APEX_PRESETS } from "./apexThemes";
import type { TermTheme, TermThemePreset } from "./themeColors";

export * from "./themeColors";
export { APEX_PRESETS, DEFAULT_THEME_ID, LIGHT_THEME_ID } from "./apexThemes";

/** 自家的 Apex 护眼系列 8 套 + iTerm2-Color-Schemes 全部 600+ 套（MIT，见 THIRD_PARTY_LICENSES.md） */
export const THEME_PRESETS: TermThemePreset[] = [...APEX_PRESETS, ...(generated as TermThemePreset[])];

const BY_ID = new Map(THEME_PRESETS.map((p) => [p.id, p]));

export function presetById(id: string): TermThemePreset {
  return BY_ID.get(id) ?? APEX_PRESETS[0];
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
