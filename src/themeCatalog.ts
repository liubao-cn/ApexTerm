import { THEME_PRESETS } from "./themes";
import { THEME_GROUPS, type ThemeFamily, type ThemeGroup } from "./themeFamilies";

export { counterpartOf, familyOf, themeAfterAppearanceChange } from "./themeFamilies";
export type { ThemeFamily, ThemeGroup };

const KNOWN = new Set(THEME_PRESETS.map((p) => p.id));

/** 推荐目录（定义见 themeFamilies.ts）；深浅任一版不在库里的整套不展示，防止改库后出现空卡 */
export const CURATED_GROUPS: ThemeGroup[] = THEME_GROUPS.map((g) => ({
  ...g,
  families: g.families.filter((f) => KNOWN.has(f.dark) && KNOWN.has(f.light)),
})).filter((g) => g.families.length);

export const CURATED_FAMILIES: ThemeFamily[] = CURATED_GROUPS.flatMap((g) => g.families);

export const CURATED_IDS = new Set(CURATED_FAMILIES.flatMap((f) => [f.dark, f.light]));

/** 不在推荐目录里、但用户收藏了或正在用的预设：各处快选都把它们单列出来，换目录不会让人找不到自己的主题 */
export function extraThemeIds(favorites: string[], inUse: (string | null | undefined)[]): string[] {
  const ids = [...favorites, ...inUse].filter((id): id is string => !!id && KNOWN.has(id) && !CURATED_IDS.has(id));
  return [...new Set(ids)];
}
