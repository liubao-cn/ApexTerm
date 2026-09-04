import { DEFAULT_THEME_ID, LIGHT_THEME_ID, THEME_PRESETS } from "./themes";

/**
 * 精选主题目录：按"家族"组织，只收现代、在 CLI / TUI（Claude Code、Devin CLI、Codex 等）里
 * 看得清的配色；每个家族一句风格说明。完整的 600+ 套库仍可在设置里「全部」页签搜索。
 * 变体 id 必须存在于 THEME_PRESETS，不存在的会被过滤掉（构建目录时校验）。
 */
export interface ThemeFamilyDef {
  name: string;
  desc: string;
  variants: { id: string; label: string }[];
}

const FAMILIES: ThemeFamilyDef[] = [
  {
    name: "ApexTerm",
    desc: "默认配色：中性深底，所有 ANSI 色 ≥ 5:1、注释灰 ≥ 4:1，专为 CLI / TUI 调校",
    variants: [
      { id: DEFAULT_THEME_ID, label: "Dark" },
      { id: LIGHT_THEME_ID, label: "Light" },
    ],
  },
  {
    name: "Catppuccin",
    desc: "柔和低饱和的粉彩色，当下 TUI 社区最流行的一套",
    variants: [
      { id: "catppuccin-mocha", label: "Mocha" },
      { id: "catppuccin-macchiato", label: "Macchiato" },
      { id: "catppuccin-frappe", label: "Frappé" },
      { id: "catppuccin-latte", label: "Latte" },
    ],
  },
  {
    name: "Tokyo Night",
    desc: "靛蓝夜色，VS Code 同名主题移植，蓝紫点缀",
    variants: [
      { id: "tokyonight-night", label: "Night" },
      { id: "tokyonight-storm", label: "Storm" },
      { id: "tokyonight-moon", label: "Moon" },
      { id: "tokyonight-day", label: "Day" },
    ],
  },
  {
    name: "Rosé Pine",
    desc: "低调的玫瑰灰调，安静不刺眼",
    variants: [
      { id: "rose-pine", label: "Main" },
      { id: "rose-pine-moon", label: "Moon" },
      { id: "rose-pine-dawn", label: "Dawn" },
    ],
  },
  {
    name: "Kanagawa",
    desc: "取自浮世绘《神奈川冲浪里》的暖灰配色",
    variants: [
      { id: "kanagawa-wave", label: "Wave" },
      { id: "kanagawa-dragon", label: "Dragon" },
      { id: "kanagawa-lotus", label: "Lotus" },
    ],
  },
  {
    name: "Gruvbox",
    desc: "复古暖棕底，色彩辨识度高",
    variants: [
      { id: "gruvbox-dark", label: "Dark" },
      { id: "gruvbox-dark-hard", label: "Dark Hard" },
      { id: "gruvbox-material", label: "Material" },
      { id: "gruvbox-light", label: "Light" },
    ],
  },
  {
    name: "Everforest",
    desc: "森林绿灰，长时间盯屏很舒服",
    variants: [
      { id: "everforest-dark-med", label: "Dark" },
      { id: "everforest-dark-hard", label: "Dark Hard" },
    ],
  },
  {
    name: "Nord",
    desc: "北极蓝灰，克制冷静",
    variants: [{ id: "nord", label: "Nord" }],
  },
  {
    name: "GitHub",
    desc: "GitHub 官方配色，对比清晰、有高对比版",
    variants: [
      { id: "github-dark-default", label: "Dark" },
      { id: "github-dark-dimmed", label: "Dark Dimmed" },
      { id: "github-dark-high-contrast", label: "Dark High Contrast" },
      { id: "github-light-default", label: "Light" },
    ],
  },
  {
    name: "Nightfox",
    desc: "现代蓝灰系列，几个变体色温不同",
    variants: [
      { id: "nightfox", label: "Nightfox" },
      { id: "carbonfox", label: "Carbonfox" },
      { id: "duskfox", label: "Duskfox" },
      { id: "terafox", label: "Terafox" },
    ],
  },
  {
    name: "Dracula",
    desc: "经典紫底高饱和，辨识度极高",
    variants: [{ id: "dracula", label: "Dracula" }],
  },
  {
    name: "One Half",
    desc: "Atom One 系，均衡耐看",
    variants: [{ id: "one-half-dark", label: "Dark" }],
  },
  {
    name: "Monokai Pro",
    desc: "经典 Monokai 的现代版",
    variants: [
      { id: "monokai-pro", label: "Pro" },
      { id: "monokai-pro-spectrum", label: "Spectrum" },
    ],
  },
  {
    name: "Modus",
    desc: "Emacs Modus，为无障碍设计的高对比配色",
    variants: [
      { id: "modus-vivendi", label: "Vivendi" },
      { id: "modus-operandi", label: "Operandi" },
    ],
  },
  {
    name: "Flexoki",
    desc: "纸感墨色，像在纸上打印",
    variants: [
      { id: "flexoki-dark", label: "Dark" },
      { id: "flexoki-light", label: "Light" },
    ],
  },
  {
    name: "Ayu",
    desc: "简洁现代，橙色点缀",
    variants: [
      { id: "ayu", label: "Dark" },
      { id: "ayu-mirage", label: "Mirage" },
    ],
  },
  {
    name: "Material",
    desc: "Material Design 配色",
    variants: [
      { id: "material-darker", label: "Darker" },
      { id: "material-ocean", label: "Ocean" },
    ],
  },
  {
    name: "Poimandres",
    desc: "极简冷调，颜色很少但层次清楚",
    variants: [
      { id: "poimandres", label: "Poimandres" },
      { id: "poimandres-storm", label: "Storm" },
    ],
  },
  {
    name: "Solarized",
    desc: "经典科学配色（高对比版）",
    variants: [{ id: "solarized-dark-higher-contrast", label: "Dark HC" }],
  },
  {
    name: "Iceberg",
    desc: "冷蓝极简",
    variants: [
      { id: "iceberg-dark", label: "Dark" },
      { id: "iceberg-light", label: "Light" },
    ],
  },
  {
    name: "Xcode",
    desc: "Apple Xcode 配色",
    variants: [
      { id: "xcode-dark", label: "Dark" },
      { id: "xcode-light", label: "Light" },
    ],
  },
  {
    name: "Melange",
    desc: "暖色低饱和",
    variants: [{ id: "melange-dark", label: "Dark" }],
  },
  {
    name: "Vesper",
    desc: "极简深灰，暖橙点缀，对比很高",
    variants: [{ id: "vesper", label: "Vesper" }],
  },
  {
    name: "Oxocarbon",
    desc: "IBM Carbon 设计语言",
    variants: [{ id: "oxocarbon", label: "Oxocarbon" }],
  },
  {
    name: "Night Owl",
    desc: "夜猫子蓝，为低光环境设计",
    variants: [{ id: "night-owl", label: "Night Owl" }],
  },
  {
    name: "Horizon",
    desc: "暖粉紫，温和",
    variants: [{ id: "horizon", label: "Horizon" }],
  },
  {
    name: "Moonfly",
    desc: "高对比深灰",
    variants: [{ id: "moonfly", label: "Moonfly" }],
  },
  {
    name: "Sonokai",
    desc: "Monokai 变体，更柔和",
    variants: [{ id: "sonokai", label: "Sonokai" }],
  },
  {
    name: "Snazzy",
    desc: "鲜亮高饱和",
    variants: [{ id: "snazzy", label: "Snazzy" }],
  },
];

const KNOWN = new Set(THEME_PRESETS.map((p) => p.id));

/** 过滤掉库里不存在的变体（防止改库后精选出现空卡） */
export const THEME_FAMILIES: ThemeFamilyDef[] = FAMILIES.map((f) => ({
  ...f,
  variants: f.variants.filter((v) => KNOWN.has(v.id)),
})).filter((f) => f.variants.length);

export const CURATED_IDS = new Set(THEME_FAMILIES.flatMap((f) => f.variants.map((v) => v.id)));
