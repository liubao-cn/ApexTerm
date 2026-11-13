/**
 * 推荐目录：只放「成套」的配色——每套一个深色、一个浅色，界面深浅切换时可以整套跟着换。
 * 先是自家调校的 Apex 护眼系列 4 套，再是 8 套口碑最好的社区经典；其余 600 多套仍在
 * 设置 →「全部」里可搜、可收藏，收藏的会出现在各处的快选里。
 * 这里刻意保持短：选项一多就没人选得出来。新增一套之前先想想能不能换掉一套。
 */
export interface ThemeFamily {
  name: string;
  desc: string;
  /** 深色版预设 id */
  dark: string;
  /** 浅色版预设 id */
  light: string;
}

export interface ThemeGroup {
  key: "apex" | "classic";
  name: string;
  desc: string;
  families: ThemeFamily[];
}

export const THEME_GROUPS: ThemeGroup[] = [
  {
    key: "apex",
    name: "Apex 护眼系列",
    desc: "为长时间看 AI CLI 调的：底色不用纯黑纯白，彩色等明度不抢眼，提示字和选中文字都看得清。四套只是色温不同",
    families: [
      { name: "石墨", desc: "中性冷灰，默认。什么环境都不出错", dark: "apexterm", light: "apexterm-light" },
      { name: "暖墨", desc: "暖炭底、米色字，蓝光最少，夜里久看最舒服", dark: "apex-sepia", light: "apex-sepia-light" },
      { name: "松雾", desc: "灰绿底，对比最柔和，像隔着一层雾", dark: "apex-moss", light: "apex-moss-light" },
      { name: "深湾", desc: "蓝灰底，冷静清爽，喜欢冷色调选它", dark: "apex-fjord", light: "apex-fjord-light" },
    ],
  },
  {
    key: "classic",
    name: "社区经典",
    desc: "口碑最好的几套，原味保留；对比不足的颜色由「可读性增强」兜底",
    families: [
      { name: "Catppuccin", desc: "柔和粉彩，TUI 社区最流行", dark: "catppuccin-mocha", light: "catppuccin-latte" },
      { name: "Rosé Pine", desc: "玫瑰灰调，安静不刺眼", dark: "rose-pine", light: "rose-pine-dawn" },
      { name: "Tokyo Night", desc: "靛蓝夜色，蓝紫点缀", dark: "tokyonight-night", light: "tokyonight-day" },
      { name: "Everforest", desc: "森林绿灰，低对比", dark: "everforest-dark-med", light: "everforest-light-med" },
      { name: "Gruvbox", desc: "复古暖棕（Material 柔和版）", dark: "gruvbox-material-dark", light: "gruvbox-material-light" },
      { name: "Kanagawa", desc: "浮世绘《神奈川冲浪里》的暖灰", dark: "kanagawa-wave", light: "kanagawa-lotus" },
      { name: "GitHub", desc: "GitHub 官方配色，中性清晰", dark: "github-dark-dimmed", light: "github-light-default" },
      { name: "Flexoki", desc: "纸感墨色，像印在纸上", dark: "flexoki-dark", light: "flexoki-light" },
    ],
  },
];

const FAMILY_OF = new Map<string, ThemeFamily>(
  THEME_GROUPS.flatMap((g) => g.families).flatMap((f) => [[f.dark, f], [f.light, f]] as [string, ThemeFamily][]),
);

/** 预设所属的那一套；不在推荐目录里返回 undefined */
export function familyOf(id: string): ThemeFamily | undefined {
  return FAMILY_OF.get(id);
}

/** 同一套里指定深浅的那一版；不在推荐目录里（含 custom）返回 null */
export function counterpartOf(id: string, dark: boolean): string | null {
  const f = FAMILY_OF.get(id);
  return f ? (dark ? f.dark : f.light) : null;
}

/** 界面深浅变了之后终端该用哪个预设：开关打开且当前主题成对才换，否则原样返回 */
export function themeAfterAppearanceChange(id: string, appDark: boolean, enabled: boolean): string {
  return (enabled && counterpartOf(id, appDark)) || id;
}
