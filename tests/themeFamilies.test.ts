import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDark, type TermThemePreset } from "../src/themeColors.ts";
import { APEX_PRESETS } from "../src/apexThemes.ts";
import { THEME_GROUPS, counterpartOf, themeAfterAppearanceChange } from "../src/themeFamilies.ts";

const library = JSON.parse(
  readFileSync(new URL("../src/themes.generated.json", import.meta.url), "utf8"),
) as TermThemePreset[];
const byId = new Map([...APEX_PRESETS, ...library].map((p) => [p.id, p.theme]));
const families = THEME_GROUPS.flatMap((g) => g.families);

test("推荐目录收敛到 12 套以内：Apex 护眼系列 4 套在前，社区经典 8 套在后", () => {
  assert.deepEqual(THEME_GROUPS.map((g) => g.key), ["apex", "classic"]);
  assert.equal(THEME_GROUPS[0].families.length, 4);
  assert.equal(THEME_GROUPS[1].families.length, 8);
  assert.equal(new Set(families.map((f) => f.name)).size, families.length);
});

test("每一套都是成对的：一个深色、一个浅色，且都在主题库里", () => {
  for (const f of families) {
    const dark = byId.get(f.dark);
    const light = byId.get(f.light);
    assert.ok(dark, `${f.name} 的深色 ${f.dark} 不在库里`);
    assert.ok(light, `${f.name} 的浅色 ${f.light} 不在库里`);
    assert.equal(isDark(dark), true, `${f.dark} 应是深色`);
    assert.equal(isDark(light), false, `${f.light} 应是浅色`);
  }
});

test("成对查找：给出同一套里另一种深浅；不在推荐目录里的主题没有对应项", () => {
  assert.equal(counterpartOf("apexterm", false), "apexterm-light");
  assert.equal(counterpartOf("apexterm-light", true), "apexterm");
  assert.equal(counterpartOf("apexterm", true), "apexterm");
  assert.equal(counterpartOf("catppuccin-latte", true), "catppuccin-mocha");
  assert.equal(counterpartOf("dracula", false), null);
  assert.equal(counterpartOf("custom", false), null);
});

test("界面深浅切换：开关打开且主题成对时换成同套的另一版，其余情况一律不动", () => {
  assert.equal(themeAfterAppearanceChange("apexterm", false, true), "apexterm-light");
  assert.equal(themeAfterAppearanceChange("apex-sepia-light", true, true), "apex-sepia");
  assert.equal(themeAfterAppearanceChange("apexterm", true, true), "apexterm");
  assert.equal(themeAfterAppearanceChange("apexterm", false, false), "apexterm");
  assert.equal(themeAfterAppearanceChange("dracula", false, true), "dracula");
  assert.equal(themeAfterAppearanceChange("custom", false, true), "custom");
});
