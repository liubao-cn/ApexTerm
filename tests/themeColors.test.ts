import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contrastRatio,
  isDark,
  minimumContrastFor,
  selectionColors,
  toXtermTheme,
  type TermTheme,
  type TermThemePreset,
} from "../src/themeColors.ts";
import { APEX_PRESETS } from "../src/apexThemes.ts";

const library = JSON.parse(
  readFileSync(new URL("../src/themes.generated.json", import.meta.url), "utf8"),
) as TermThemePreset[];
const byId = new Map([...APEX_PRESETS, ...library].map((p) => [p.id, p.theme]));
const theme = (id: string): TermTheme => {
  const t = byId.get(id);
  assert.ok(t, `库里没有 ${id}`);
  return t;
};

test("选区：主题自带的不透明选区色本身清楚可读时原样采用（Tokyo Night 不再被冲淡到看不见）", () => {
  const t = theme("tokyonight-night");
  const { active } = selectionColors(t);
  assert.equal(active, t.selectionBackground);
  assert.ok(contrastRatio(active, t.background) >= 1.25);
});

test("选区：反色式选区（Catppuccin Mocha 的浅粉）换成同色相的柔和底色，正文在选区上仍 ≥ 4.5:1", () => {
  const t = theme("catppuccin-mocha");
  const { active } = selectionColors(t);
  assert.notEqual(active, t.selectionBackground);
  assert.match(active, /^#[0-9a-f]{6}$/);
  const vsBg = contrastRatio(active, t.background);
  assert.ok(vsBg >= 1.3 && vsBg <= 1.9, `选区与底色对比 ${vsBg.toFixed(2)}`);
  assert.ok(contrastRatio(t.foreground, active) >= 4.5);
});

test("选区：带透明度的选区色先叠到底色上再判断，输出一律是不透明色", () => {
  const t: TermTheme = { ...theme("tokyonight-night"), selectionBackground: "rgba(91, 141, 239, 0.35)" };
  const { active, inactive } = selectionColors(t);
  assert.match(active, /^#[0-9a-f]{6}$/);
  assert.match(inactive, /^#[0-9a-f]{6}$/);
});

test("选区：失焦时的选区比聚焦时更淡，但仍看得出", () => {
  for (const id of ["apexterm", "apexterm-light", "catppuccin-mocha", "github-light-default"]) {
    const t = theme(id);
    const { active, inactive } = selectionColors(t);
    const a = contrastRatio(active, t.background);
    const i = contrastRatio(inactive, t.background);
    assert.ok(i < a, `${id} 失焦 ${i.toFixed(2)} 应低于聚焦 ${a.toFixed(2)}`);
    assert.ok(i >= 1.1, `${id} 失焦选区 ${i.toFixed(2)} 太淡`);
  }
});

test("选区：全库每一套的选区都看得见又不刺眼；正文对比足够的主题，选中后正文仍 ≥ 4.5:1", () => {
  const bad: string[] = [];
  for (const [id, t] of byId) {
    const { active } = selectionColors(t);
    const vsBg = contrastRatio(active, t.background);
    const fgOnSel = contrastRatio(t.foreground, active);
    if (vsBg < 1.2 || vsBg > 2.6) bad.push(`${id} 选区/底色 ${vsBg.toFixed(2)}`);
    if (contrastRatio(t.foreground, t.background) >= 7 && fgOnSel < 4.5) bad.push(`${id} 正文/选区 ${fgOnSel.toFixed(2)}`);
  }
  assert.deepEqual(bad, []);
});

test("交给 xterm 的配色：选区是归一化后的不透明色，深浅判断不受影响", () => {
  const t = theme("catppuccin-mocha");
  const x = toXtermTheme(t);
  const { active, inactive } = selectionColors(t);
  assert.equal(x.selectionBackground, active);
  assert.equal(x.selectionInactiveBackground, inactive);
  assert.equal(x.cursorAccent, t.background);
  assert.equal(isDark(t), true);
});

test("可读性增强打开时让 xterm 按 4.5:1 动态保底（真彩色文字、选中文字都算），关掉为 1 即不干预", () => {
  assert.equal(minimumContrastFor(true), 4.5);
  assert.equal(minimumContrastFor(false), 1);
});

test("选区：设置里微调选区时取色器给的是 8 位 hex（带透明度），同样先叠到底色上再用", () => {
  const base = theme("apexterm");
  const { active } = selectionColors({ ...base, selectionBackground: "#5b8def59" });
  assert.match(active, /^#[0-9a-f]{6}$/);
  const vsBg = contrastRatio(active, base.background);
  assert.ok(vsBg >= 1.25 && vsBg <= 2.6, `选区/底色 ${vsBg.toFixed(2)}`);
  // 用户挑的是蓝色：结果里蓝通道应明显高于红通道，而不是被当成无效值丢掉
  assert.ok(parseInt(active.slice(5, 7), 16) > parseInt(active.slice(1, 3), 16) + 20, active);
  assert.equal(selectionColors({ ...base, selectionBackground: "#2c3c59ff" }).active, "#2c3c59");
});
