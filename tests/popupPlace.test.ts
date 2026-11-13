import { test } from "node:test";
import assert from "node:assert/strict";
import { placePopup } from "../src/popupPlace.ts";

const vp = { vw: 1240, vh: 800 };

test("空间够时弹层左上角就在鼠标位置", () => {
  assert.deepEqual(placePopup({ x: 300, y: 200, w: 320, h: 400, ...vp }), { left: 300, top: 200, maxHeight: 784 });
});

test("靠右、靠下时整体往回挪，四边都留 8px，不出窗口", () => {
  const p = placePopup({ x: 1200, y: 760, w: 320, h: 400, ...vp });
  assert.deepEqual(p, { left: 912, top: 392, maxHeight: 784 });
});

test("弹层比窗口还高：贴顶放，高度限制到窗口内（内容自己滚动）", () => {
  const p = placePopup({ x: 100, y: 500, w: 320, h: 1037, vw: 1240, vh: 620 });
  assert.deepEqual(p, { left: 100, top: 8, maxHeight: 604 });
});

test("任意位置右键：弹层始终完整落在窗口内", () => {
  for (const vh of [620, 800, 1200]) {
    for (let y = 0; y <= vh; y += 37) {
      for (const x of [0, 400, 1239]) {
        const h = 520;
        const p = placePopup({ x, y, w: 320, h, vw: 1240, vh });
        const shown = Math.min(h, p.maxHeight);
        assert.ok(p.top >= 8 && p.top + shown <= vh - 8, `vh=${vh} y=${y} top=${p.top}`);
        assert.ok(p.left >= 8 && p.left + 320 <= 1240 - 8, `x=${x} left=${p.left}`);
      }
    }
  }
});
