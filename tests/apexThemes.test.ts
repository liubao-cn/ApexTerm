import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastRatio, isDark, selectionColors, type TermTheme, type TermThemePreset } from "../src/themeColors.ts";
import { APEX_PRESETS, DEFAULT_THEME_ID, LIGHT_THEME_ID } from "../src/apexThemes.ts";

const library = JSON.parse(
  readFileSync(new URL("../src/themes.generated.json", import.meta.url), "utf8"),
) as TermThemePreset[];

const CHROMATIC: (keyof TermTheme)[] = [
  "red", "green", "yellow", "blue", "magenta", "cyan",
  "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan",
];

test("Apex 护眼系列：4 套、每套深浅各一，id 不与主题库撞车，默认 id 不变", () => {
  assert.equal(APEX_PRESETS.length, 8);
  const ids = APEX_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, 8);
  const lib = new Set(library.map((p) => p.id));
  assert.deepEqual(ids.filter((id) => lib.has(id)), []);
  assert.equal(DEFAULT_THEME_ID, "apexterm");
  assert.equal(LIGHT_THEME_ID, "apexterm-light");
  assert.equal(APEX_PRESETS.filter((p) => isDark(p.theme)).length, 4);
  for (const p of APEX_PRESETS) assert.equal(isDark(p.theme), !p.id.endsWith("-light"), p.id);
});

test("Apex 护眼系列：底色不用纯黑纯白，正文对比落在 10–13.5:1 的舒适区（不刺眼也不发灰）", () => {
  for (const { id, theme: t } of APEX_PRESETS) {
    assert.notEqual(t.background.toLowerCase(), "#000000", id);
    assert.notEqual(t.background.toLowerCase(), "#ffffff", id);
    const c = contrastRatio(t.foreground, t.background);
    assert.ok(c >= 10 && c <= 13.5, `${id} 正文对比 ${c.toFixed(1)}`);
  }
});

test("Apex 护眼系列：12 个彩色与注释灰全部 ≥ 4.5:1，AI CLI 的提示字、次要信息不用眯眼", () => {
  for (const { id, theme: t } of APEX_PRESETS) {
    for (const k of [...CHROMATIC, "brightBlack" as const]) {
      const c = contrastRatio(t[k], t.background);
      assert.ok(c >= 4.5, `${id}.${k} ${c.toFixed(2)}`);
    }
  }
});

test("Apex 护眼系列：同一套里各彩色明度接近，没有哪个颜色特别跳", () => {
  for (const { id, theme: t } of APEX_PRESETS) {
    const cs = ["red", "green", "yellow", "blue", "magenta", "cyan"].map((k) =>
      contrastRatio(t[k as keyof TermTheme], t.background),
    );
    const spread = Math.max(...cs) / Math.min(...cs);
    assert.ok(spread <= 1.25, `${id} 彩色对比度极差 ${spread.toFixed(2)}`);
  }
});

test("Apex 护眼系列：自带选区原样生效（不被归一化改写），选中后正文 ≥ 6:1、彩色 ≥ 3:1", () => {
  for (const { id, theme: t } of APEX_PRESETS) {
    const { active } = selectionColors(t);
    assert.equal(active, t.selectionBackground, id);
    assert.ok(contrastRatio(t.foreground, active) >= 6, `${id} 正文/选区`);
    for (const k of CHROMATIC) {
      const c = contrastRatio(t[k], active);
      assert.ok(c >= 3, `${id}.${k} 在选区上 ${c.toFixed(2)}`);
    }
  }
});
