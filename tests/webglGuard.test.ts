import { test } from "node:test";
import assert from "node:assert/strict";
import { patchWebglAddon } from "../src/webglGuard.ts";

// ---- 最小浏览器 / WebGL2 桩，直接驱动 node_modules 里真实的 @xterm/addon-webgl@0.19.0 ----

interface FakeCanvas {
  id: number;
  width: number;
  height: number;
  style: Record<string, string>;
  classList: { add(): void; remove(): void };
  isConnected: boolean;
  parentElement: unknown;
  addEventListener(): void;
  removeEventListener(): void;
  remove(): void;
  append(): void;
  appendChild(el: { parentElement: unknown }): void;
  removeChild(): void;
  getContext(kind: string): unknown;
}

let nextCanvasId = 1;
let glyphPixelWidth = 180;
let glyphPixelHeight = 180;

function emitter<T = void>() {
  const listeners = new Set<(v: T) => void>();
  return {
    event: (fn: (v: T) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire: (v: T) => {
      for (const fn of listeners) fn(v);
    },
  };
}

function makeCanvas(w = 300, h = 150, maxUnits = 4, maxTexSize = 16384): FakeCanvas {
  const id = nextCanvasId++;
  const c: FakeCanvas & { _gl?: unknown } = {
    id,
    width: w,
    height: h,
    style: {},
    classList: { add() {}, remove() {} },
    isConnected: true,
    parentElement: null,
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    append() {},
    appendChild(el) {
      el.parentElement = c;
    },
    removeChild() {},
    getContext(kind: string) {
      if (kind === "2d") {
        return {
          save() {},
          restore() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          clip() {},
          setLineDash() {},
          fillRect() {},
          clearRect() {},
          drawImage() {},
          fillText() {},
          strokeText() {},
          measureText: () => ({ actualBoundingBoxDescent: 0 }),
          getImageData(_x: number, _y: number, gw: number, gh: number) {
            const data = new Uint8ClampedArray(gw * gh * 4);
            // 生成指定尺寸的不透明字形块，便于快速填满 512x512 纹理页触发合并
            const bw = Math.min(glyphPixelWidth, gw - 8);
            const bh = Math.min(glyphPixelHeight, gh - 8);
            for (let y = 4; y < 4 + bh; y++) {
              for (let x = 4; x < 4 + bw; x++) {
                const o = (y * gw + x) * 4;
                data[o] = 255;
                data[o + 1] = 255;
                data[o + 2] = 255;
                data[o + 3] = 255;
              }
            }
            return { data, width: gw, height: gh };
          },
          putImageData() {},
        };
      }
      if (kind === "webgl2") {
        let activeUnit = 0;
        const uploaded = new Map<number, FakeCanvas>();
        let lastStreamBuffer = new Float32Array(0);
        let streamUploadTarget = false;
        const attrBuf = { kind: "attr" };
        return {
          canvas: c,
          MAX_TEXTURE_SIZE: 0x0d33,
          MAX_TEXTURE_IMAGE_UNITS: 0x8872,
          VERTEX_SHADER: 1,
          FRAGMENT_SHADER: 2,
          COMPILE_STATUS: 3,
          LINK_STATUS: 4,
          ARRAY_BUFFER: 5,
          ELEMENT_ARRAY_BUFFER: 6,
          STATIC_DRAW: 7,
          STREAM_DRAW: 8,
          DYNAMIC_DRAW: 9,
          FLOAT: 10,
          UNSIGNED_BYTE: 11,
          RGBA: 12,
          TEXTURE_2D: 13,
          TEXTURE0: 100,
          TEXTURE_WRAP_S: 14,
          TEXTURE_WRAP_T: 15,
          CLAMP_TO_EDGE: 16,
          BLEND: 17,
          SRC_ALPHA: 18,
          ONE_MINUS_SRC_ALPHA: 19,
          TRIANGLE_STRIP: 20,
          _uploaded: uploaded,
          get _lastGlyphBuffer() {
            return lastStreamBuffer;
          },
          getParameter: (p: number) => (p === 0x8872 ? maxUnits : maxTexSize),
          createProgram: () => ({}),
          deleteProgram() {},
          createShader: () => ({}),
          shaderSource() {},
          compileShader() {},
          getShaderParameter: () => true,
          attachShader() {},
          linkProgram() {},
          getProgramParameter: () => true,
          useProgram() {},
          getUniformLocation: () => ({}),
          uniform1iv() {},
          uniform2f() {},
          uniformMatrix4fv() {},
          createVertexArray: () => ({}),
          bindVertexArray() {},
          createBuffer: () => ({ ...attrBuf }),
          deleteBuffer() {},
          bindBuffer(_t: number, buf: unknown) {
            streamUploadTarget = !!buf;
          },
          bufferData(_t: number, data: ArrayBufferView, usage: number) {
            if (usage === 8 && streamUploadTarget && data instanceof Float32Array) {
              lastStreamBuffer = new Float32Array(data);
            }
          },
          enableVertexAttribArray() {},
          vertexAttribPointer() {},
          vertexAttribDivisor() {},
          createTexture: () => ({ id: Math.random() }),
          deleteTexture() {},
          activeTexture(u: number) {
            activeUnit = u - 100;
          },
          bindTexture() {},
          texParameteri() {},
          texImage2D(...args: unknown[]) {
            if (args.length === 6) uploaded.set(activeUnit, args[5] as FakeCanvas);
          },
          generateMipmap() {},
          enable() {},
          blendFunc() {},
          viewport() {},
          drawElementsInstanced() {},
        };
      }
      return null;
    },
  };
  return c;
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel" },
  configurable: true,
});
(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
(globalThis as Record<string, unknown>).requestIdleCallback = () => 1;
(globalThis as Record<string, unknown>).cancelIdleCallback = () => {};
(globalThis as Record<string, unknown>).document = { createElement: () => makeCanvas() };
(globalThis as Record<string, unknown>).window = {
  devicePixelRatio: 2,
  ResizeObserver: FakeResizeObserver,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
};

const { WebglAddon } = await import("@xterm/addon-webgl");

interface CellSpec {
  code: number;
  ch: string;
  fg: number;
  bg: number;
}

let themeSeed = 1;

function createHarness(opts: { sharedThemeId?: number; rows?: number; cols?: number; initiallyHidden?: boolean } = {}) {
  const rows = opts.rows ?? 4;
  const cols = opts.cols ?? 8;
  const seed = opts.sharedThemeId ?? ++themeSeed;
  const rgbaObj = (rgba: number) => ({ css: "#000000", rgba });
  const colors = {
    foreground: rgbaObj(0xffffff00 | (seed & 0xff)),
    background: rgbaObj(0x141416ff),
    cursor: rgbaObj(0xffffffff),
    cursorAccent: rgbaObj(0x000000ff),
    selectionForeground: undefined,
    selectionBackgroundTransparent: rgbaObj(0x33557780),
    selectionBackgroundOpaque: rgbaObj(0x335577ff),
    selectionInactiveBackgroundTransparent: rgbaObj(0x22334480),
    selectionInactiveBackgroundOpaque: rgbaObj(0x223344ff),
    ansi: Array.from({ length: 256 }, (_, i) => rgbaObj(((i * 997) << 8) | 0xff)),
    contrastCache: { getColor: () => undefined, setColor() {} },
    halfContrastCache: { getColor: () => undefined, setColor() {} },
  };
  const rawOptions = {
    customGlyphs: false,
    letterSpacing: 0,
    lineHeight: 1.2,
    fontFamily: "monospace",
    fontSize: 13,
    fontWeight: "normal",
    fontWeightBold: "bold",
    allowTransparency: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    cursorBlink: false,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    cursorWidth: 1,
    rescaleOverlappingGlyphs: false,
  };
  const grid = new Map<string, CellSpec>();
  const screenElement = makeCanvas(800, 400);
  const core = {
    screenElement,
    options: rawOptions,
    rows,
    cols,
    buffer: {
      ydisp: 0,
      lines: {
        get: (r: number) => ({
          loadCell: (x: number, cell: { content: number; fg: number; bg: number; combinedData: string }) => {
            const d = grid.get(`${r},${x}`);
            if (!d) {
              cell.content = 0;
              cell.fg = 0;
              cell.bg = 0;
              cell.combinedData = "";
              return;
            }
            cell.content = (1 << 22) | d.code;
            cell.fg = d.fg;
            cell.bg = d.bg;
            cell.combinedData = d.ch;
          },
          translateToString: () => "",
        }),
      },
    },
    coreService: { decPrivateModes: {}, isCursorInitialized: true, isCursorHidden: true },
    optionsService: { rawOptions, options: rawOptions, onOptionChange: emitter().event },
    unicodeService: { wcwidth: () => 2, getStringCellWidth: () => 2 },
    linkifier: { onShowLinkUnderline: emitter().event, onHideLinkUnderline: emitter().event },
    _renderService: { setRenderer() {}, handleResize() {} },
    _characterJoinerService: { getJoinedCharacters: () => [] },
    // 使 deviceCellWidth = 100, deviceCellHeight = 200，每张 512x512 页放 4 个字形即触发新页与合并
    _charSizeService: opts.initiallyHidden ? { width: 0, height: 0 } : { width: 50, height: 84 },
    _coreBrowserService: {
      mainDocument: (globalThis as Record<string, unknown>).document,
      window: (globalThis as Record<string, unknown>).window,
      dpr: 2,
      isFocused: true,
      onWindowChange: emitter().event,
    },
    _decorationService: { forEachDecorationAtCell() {} },
    _logService: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    _themeService: { colors, onChangeColors: emitter().event },
    _store: { _isDisposed: false },
    _createRenderer: () => ({}),
  };
  const term = {
    rows,
    cols,
    element: screenElement,
    options: rawOptions,
    buffer: { active: { baseY: 0, cursorY: 0, cursorX: 0 } },
    _core: core,
  };
  const addon = new WebglAddon();
  addon.activate(term as never);
  patchWebglAddon(addon);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderer = (addon as any)._renderer;
  return {
    addon,
    term,
    renderer,
    grid,
    setCell(r: number, c: number, code: number, rgbBg = 0) {
      const bg = rgbBg ? (0x03000000 | (rgbBg & 0xffffff)) : 0;
      grid.set(`${r},${c}`, { code, ch: String.fromCodePoint(code), fg: 0, bg });
    },
  };
}

const INDICES_PER_CELL = 11;

test("单终端帧内触发纹理页合并：GPU 各槽位纹理必须同步重传，且前半帧单元格顶点指向合并后的新页与新 UV", () => {
  glyphPixelWidth = 180;
  glyphPixelHeight = 180;
  const h = createHarness({ rows: 4, cols: 8 });
  const atlas = h.renderer._charAtlas;
  // 先在第 0 行画一个汉字「证」(0x8bc1)，让它落在第 0 页并完成首次上传（此时部分槽位将拥有 version=1）
  h.setCell(0, 0, 0x8bc1, 0x222228);
  h.renderer.renderRows(0, 0);

  // 在同一帧内往第 1..3 行写入 20 个不同背景色的汉字（模拟灰底输入行 + 选中高亮），中途必触发 _mergePages
  let cp = 0x4e00;
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      cp++;
      h.setCell(r, c, cp, 0x102030 + cp);
    }
  }
  h.renderer.renderRows(1, 3);

  // 1. GPU 每个槽位实际上传的 canvas 必须与当前 atlas.pages[i].canvas 一致（不能因 version=1 碰撞跳过上传）
  const uploaded: Map<number, FakeCanvas> = h.renderer._gl._uploaded;
  for (let i = 0; i < atlas.pages.length; i++) {
    assert.equal(
      uploaded.get(i)?.id,
      atlas.pages[i].canvas.id,
      `纹理单元 ${i} 未重新上传合并后的新画布（同槽位 version 碰撞）`,
    );
  }

  // 2. 第 0 行第 0 格「证」在送往 GPU 的顶点缓冲里，texPage 与 texCoord 必须等于图集里最新坐标
  const glyph = atlas._cacheMap.get(0x8bc1, 0x03222228, 0, 0);
  assert.ok(glyph, "「证」应在图集缓存中");
  const buf: Float32Array = h.renderer._gl._lastGlyphBuffer;
  assert.equal(buf[4], glyph.texturePage, "前半帧/未改动行的顶点 texPage 仍是合并前的旧页号");
  assert.equal(
    Math.abs(buf[5] - glyph.texturePositionClipSpace.x) < 1e-6 &&
      Math.abs(buf[8] - glyph.sizeClipSpace.y) < 1e-6,
    true,
    "顶点 UV 尺寸/坐标仍是合并前的旧 512 页坐标",
  );
  h.addon.dispose();
});

test("分屏/多标签共享同一个 TextureAtlas：面板 A 触发页合并或清空图集后，面板 B 局部刷新也能重建全部顶点", () => {
  const sharedThemeId = 9001;
  const a = createHarness({ sharedThemeId, rows: 3, cols: 6 });
  const b = createHarness({ sharedThemeId, rows: 3, cols: 6 });
  assert.equal(a.renderer._charAtlas, b.renderer._charAtlas, "同配置终端应共享同一个 TextureAtlas");

  // 面板 B 第 0 行先画「验」(0x9a8c)
  b.setCell(0, 0, 0x9a8c, 0x25252b);
  b.renderer.renderRows(0, 2);

  // 面板 A 渲染大量彩色字形触发多次共享图集页合并，并已先一步消费完自己的帧渲染
  let cp = 0x5100;
  for (let round = 0; round < 2; round++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        cp++;
        a.setCell(r, c, cp, 0x300000 + cp);
      }
    }
    a.renderer.renderRows(0, 2);
  }

  // 面板 B 只更新第 2 行（如底部 Thinking 秒数跳动），第 0 行的「验」并未改动
  b.setCell(2, 0, 0x31, 0);
  b.renderer.renderRows(2, 2);

  const atlas = b.renderer._charAtlas;
  const glyph = atlas._cacheMap.get(0x9a8c, 0x0325252b, 0, 0);
  const bufB: Float32Array = b.renderer._gl._lastGlyphBuffer;
  assert.equal(bufB[4], glyph.texturePage, "共享图集合并后，兄弟面板 B 未重绘行的顶点 texPage 必须同步更新");
  for (let i = 0; i < atlas.pages.length; i++) {
    assert.equal(b.renderer._gl._uploaded.get(i)?.id, atlas.pages[i].canvas.id);
  }

  // 面板 A 调用 clearTextureAtlas() 后，面板 B 局部渲染也不能残留失效坐标（xtermjs#6014）
  a.addon.clearTextureAtlas();
  b.setCell(2, 1, 0x32, 0);
  b.renderer.renderRows(2, 2);
  const glyphAfterClear = atlas._cacheMap.get(0x9a8c, 0x0325252b, 0, 0);
  assert.ok(glyphAfterClear, "clearTextureAtlas 后兄弟面板 B 应重新光栅化第 0 行字符");
  assert.equal(b.renderer._gl._lastGlyphBuffer[4], glyphAfterClear.texturePage);

  a.addon.dispose();
  b.addon.dispose();
});

test("反复拖选高亮产生海量新背景色字形：单页尺寸不超过 4096，总页数永不突破 maxAtlasPages 崩溃", () => {
  const h = createHarness({ rows: 4, cols: 6 });
  const atlas = h.renderer._charAtlas;
  const maxPages: number = h.renderer._glyphRenderer.value._atlasTextures.length;

  let cp = 0x5400;
  // 连续 40 轮，每轮 24 个全新背景色汉字（960 个大字形，足以把 4 个 4096 槽位全部塞满并触发 2~3 页合并及满页驱逐）
  for (let round = 0; round < 40; round++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        cp++;
        h.setCell(r, c, cp, 0x400000 + round * 100 + r * 10 + c);
      }
    }
    assert.doesNotThrow(() => h.renderer.renderRows(0, 3));
    assert.equal(
      atlas.pages.length <= maxPages,
      true,
      `第 ${round} 轮页数 ${atlas.pages.length} 突破了纹理单元上限 ${maxPages}`,
    );
    for (const p of atlas.pages) {
      assert.equal(p.canvas.width <= 4096, true, `单页纹理尺寸 ${p.canvas.width} 超过了 4096 上限`);
    }
  }

  // 最后一屏上的所有 24 个字符都必须在图集缓存中且坐标有效
  const buf: Float32Array = h.renderer._gl._lastGlyphBuffer;
  assert.equal(buf.length, 24 * INDICES_PER_CELL);
  h.addon.dispose();
});

test("页合并完成重建后，后续普通局部刷新不再每帧全屏清空重算（修复 _requestClearModel 永不归零）", () => {
  const h = createHarness({ rows: 4, cols: 6 });
  let cp = 0x6200;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      cp++;
      h.setCell(r, c, cp, 0x500000 + cp);
    }
  }
  h.renderer.renderRows(0, 3);
  assert.equal(
    h.renderer._glyphRenderer.value.beginFrame(),
    false,
    "合并帧重绘完毕后，下一帧无结构变更时 beginFrame() 必须返回 false",
  );
  h.addon.dispose();
});

test("终端在隐藏标签中首次挂载（初始尺寸为 0 尚未创建图集），切到前台后延迟创建图集同样受护栏保护", () => {
  const h = createHarness({ initiallyHidden: true, rows: 4, cols: 6 });
  assert.equal(h.renderer._charAtlas, undefined, "隐藏挂载时暂未分配图集");

  // 切到前台，测量出字符尺寸并渲染触发合并
  h.term._core._charSizeService.width = 50;
  h.term._core._charSizeService.height = 84;
  let cp = 0x6800;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      cp++;
      h.setCell(r, c, cp, 0x600000 + cp);
    }
  }
  h.renderer.renderRows(0, 3);

  const atlas = h.renderer._charAtlas;
  assert.ok(atlas, "切到前台后已创建图集");
  for (let i = 0; i < atlas.pages.length; i++) {
    assert.equal(h.renderer._gl._uploaded.get(i)?.id, atlas.pages[i].canvas.id);
  }
  assert.equal(h.renderer._glyphRenderer.value.beginFrame(), false);
  h.addon.dispose();
});

