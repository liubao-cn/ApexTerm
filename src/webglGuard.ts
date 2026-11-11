import type { WebglAddon } from "@xterm/addon-webgl";

/**
 * 修复 @xterm/addon-webgl@0.19.0 在字形纹理图集分页合并（_mergePages）时的连环乱码与崩溃问题
 * （对应上游尚未随正式版发布的 xterm.js#5883、#6014、#6033）：
 *
 * 1. 同槽位页替换 version 碰撞：原版每张 AtlasPage 各自从 0 计数，4 页合并成新页后 version 恒为 1，
 *    常与该纹理单元槽位上旧页的 version 撞号，GPU 跳过 texImage2D 上传，新 UV 采样到旧纹理页像素，
 *    表现为单个汉字格子出现上下拼贴的异色文字碎片且长期不恢复；
 * 2. 帧中途合并导致前半帧顶点失效：_updateModel 遍历中途填满图集触发合并时，同帧已写入顶点缓冲的
 *    字符仍拿着合并前的旧页号与旧 UV 直接上屏（拖选文字会产生大量新背景色字形，集中触发页合并，
 *    所以越选中乱码越多）；
 * 3. 多面板共享图集失步：同字体、同配色的多个终端共享同一个 TextureAtlas，原版单布尔标志无法通知
 *    其余面板重建顶点缓冲，且置 true 后永不归零导致后续每次光标闪烁都全屏重算；
 * 4. 页数溢出与超大纹理：Apple Silicon MAX_TEXTURE_SIZE=16384 使原版 `maxTextureSize || 4096` 4096
 *    上限失效，且同尺寸页不足 4 张时页数突破 maxAtlasPages 抛异常中断渲染。
 */

const FORCED_MAX_TEXTURE_SIZE = 4096;
const MERGE_RETRY_LIMIT = 32;

interface InternalAtlasPage {
  canvas: HTMLCanvasElement;
  version: number;
  percentageUsed: number;
  currentRow: { x: number; y: number; height: number };
  clear(): void;
}

type AtlasPageConstructor = new (doc: Document, size: number, sourcePages?: InternalAtlasPage[]) => InternalAtlasPage;

interface InternalTextureAtlas {
  _document: Document;
  _textureSize: number;
  _pages: InternalAtlasPage[];
  _activePages: InternalAtlasPage[];
  _overflowSizePage: InternalAtlasPage | undefined;
  _cacheMap: { clear(): void };
  _cacheMapCombined: { clear(): void };
  _didWarmUp: boolean;
  _structureVersion?: number;
  _onAddTextureAtlasCanvas: { fire(canvas: HTMLCanvasElement): void };
  _onRemoveTextureAtlasCanvas: { fire(canvas: HTMLCanvasElement): void };
  pages: InternalAtlasPage[];
  clearTexture(): void;
  _createNewPage(): InternalAtlasPage;
  _mergePages(pages: InternalAtlasPage[], index: number): InternalAtlasPage;
  _deletePage(index: number): void;
}

interface InternalGlyphRenderer {
  _atlas?: InternalTextureAtlas;
  _atlasTextures: { texture: WebGLTexture; version: number }[];
  _lastStructureVersion?: number;
  beginFrame(): boolean;
  setAtlas(atlas: InternalTextureAtlas): void;
  render(model: unknown): void;
}

interface InternalWebglRenderer {
  _terminal: { rows: number };
  _isAttached?: boolean;
  _charAtlas?: InternalTextureAtlas;
  _glyphRenderer?: { value?: InternalGlyphRenderer };
  _inMergeRetry?: boolean;
  _clearModel(clearGlyphRenderer: boolean): void;
  _updateModel(start: number, end: number): void;
}

let nextGlobalPageVersion = 1;
const patchedPageProtos = new WeakSet<object>();
const patchedAtlasProtos = new WeakSet<object>();
const patchedGlyphProtos = new WeakSet<object>();
const patchedRendererProtos = new WeakSet<object>();

function patchAtlasPage(page: InternalAtlasPage | undefined): AtlasPageConstructor | null {
  if (!page) return null;
  const proto = Object.getPrototypeOf(page);
  if (proto && !patchedPageProtos.has(proto)) {
    patchedPageProtos.add(proto);
    Object.defineProperty(proto, "version", {
      configurable: true,
      enumerable: true,
      get(this: { _globalVersion?: number }) {
        return this._globalVersion ?? 0;
      },
      set(this: { _globalVersion?: number }) {
        this._globalVersion = nextGlobalPageVersion++;
      },
    });
  }
  if (Object.prototype.hasOwnProperty.call(page, "version")) {
    delete (page as { version?: number }).version;
    page.version = 0;
  }
  return page.constructor as AtlasPageConstructor;
}

function patchTextureAtlas(atlas: InternalTextureAtlas | undefined): void {
  if (!atlas || !Array.isArray(atlas._pages)) return;
  // 若未来升级到已内置 pagesVersion 的新版本 @xterm/addon-webgl，自动跳过
  if ("pagesVersion" in atlas) return;

  let pageCtor: AtlasPageConstructor | null = null;
  for (const p of atlas._pages) {
    pageCtor = patchAtlasPage(p) ?? pageCtor;
  }
  atlas._structureVersion ??= 0;

  const proto = Object.getPrototypeOf(atlas) as InternalTextureAtlas | null;
  if (!proto || patchedAtlasProtos.has(proto) || !pageCtor) return;
  patchedAtlasProtos.add(proto);

  const PageCtor = pageCtor;
  const origClearTexture = proto.clearTexture;

  // 原版创建 _overflowSizePage 时会设 _requestClearModel = true，桥接到单调递增的结构版本号
  Object.defineProperty(proto, "_requestClearModel", {
    configurable: true,
    enumerable: true,
    get(this: InternalTextureAtlas) {
      return false;
    },
    set(this: InternalTextureAtlas, v: boolean) {
      if (v) this._structureVersion = (this._structureVersion ?? 0) + 1;
    },
  });

  proto.clearTexture = function (this: InternalTextureAtlas) {
    origClearTexture.call(this);
    this._structureVersion = (this._structureVersion ?? 0) + 1;
  };

  proto._createNewPage = function (this: InternalTextureAtlas): InternalAtlasPage {
    const AtlasCtor = this.constructor as { maxAtlasPages?: number; maxTextureSize?: number };
    const hardCap = AtlasCtor.maxAtlasPages ?? 0;
    // 在纹理单元充裕（>4）且尚未分配超宽页时预留 1 个槽位，防止突发超宽连字使页数突破上限
    const mergeThreshold =
      hardCap > 4 && !this._overflowSizePage ? hardCap - 1 : Math.max(4, hardCap);

    if (hardCap && this._pages.length >= mergeThreshold) {
      const maxTexSize = Math.min(
        AtlasCtor.maxTextureSize || FORCED_MAX_TEXTURE_SIZE,
        FORCED_MAX_TEXTURE_SIZE,
      );
      const pagesBySize = this._pages
        .filter((e) => e.canvas.width * 2 <= maxTexSize)
        .sort((a, b) =>
          b.canvas.width !== a.canvas.width
            ? b.canvas.width - a.canvas.width
            : b.percentageUsed - a.percentageUsed,
        );

      // 挑出同尺寸数量最多的一组（2~4 张均可合并，避免不足 4 张时跳过合并导致页数溢出）
      let bestGroupStart = -1;
      let bestGroupSize = 0;
      let groupStart = 0;
      for (let i = 1; i <= pagesBySize.length; i++) {
        if (i === pagesBySize.length || pagesBySize[i].canvas.width !== pagesBySize[groupStart].canvas.width) {
          const groupSize = Math.min(4, i - groupStart);
          if (groupSize > bestGroupSize) {
            bestGroupSize = groupSize;
            bestGroupStart = groupStart;
            if (groupSize === 4) break;
          }
          groupStart = i;
        }
      }

      if (bestGroupSize >= 2) {
        const mergingPages = pagesBySize.slice(bestGroupStart, bestGroupStart + bestGroupSize);
        const sortedIndexes = mergingPages
          .map((e) => this._pages.indexOf(e))
          .filter((idx) => idx >= 0)
          .sort((a, b) => a - b);
        const mergedPageIndex = this._pages.length - sortedIndexes.length;
        const mergedPage = this._mergePages(mergingPages, mergedPageIndex);
        mergedPage.version++;
        for (let i = sortedIndexes.length - 1; i >= 0; i--) {
          this._deletePage(sortedIndexes[i]);
        }
        this._pages.push(mergedPage);
        this._structureVersion = (this._structureVersion ?? 0) + 1;
        this._onAddTextureAtlasCanvas.fire(mergedPage.canvas);
      } else {
        // 所有槽位均已是 4096 巨页且无法再合并：清空旧页回收显存，当帧重试会自动重绘当前视口字形
        for (const page of this._pages) {
          this._onRemoveTextureAtlasCanvas.fire(page.canvas);
          page.canvas.remove();
        }
        this._pages.length = 0;
        this._activePages.length = 0;
        this._overflowSizePage = undefined;
        this._cacheMap.clear();
        this._cacheMapCombined.clear();
        this._didWarmUp = false;
        this._structureVersion = (this._structureVersion ?? 0) + 1;
      }
    }

    const newPage = new PageCtor(this._document, this._textureSize);
    this._pages.push(newPage);
    this._activePages.push(newPage);
    this._onAddTextureAtlasCanvas.fire(newPage.canvas);
    return newPage;
  };
}

function patchGlyphRenderer(glyphRenderer: InternalGlyphRenderer | undefined): void {
  if (!glyphRenderer) return;
  if (glyphRenderer._atlas && "pagesVersion" in glyphRenderer._atlas) return;

  patchTextureAtlas(glyphRenderer._atlas);
  glyphRenderer._lastStructureVersion ??= glyphRenderer._atlas?._structureVersion ?? -1;

  const proto = Object.getPrototypeOf(glyphRenderer) as InternalGlyphRenderer | null;
  if (!proto || patchedGlyphProtos.has(proto)) return;
  patchedGlyphProtos.add(proto);

  const origSetAtlas = proto.setAtlas;
  const origRender = proto.render;

  proto.beginFrame = function (this: InternalGlyphRenderer): boolean {
    if (!this._atlas) return true;
    const ver = this._atlas._structureVersion ?? 0;
    if (ver !== this._lastStructureVersion) {
      this._lastStructureVersion = ver;
      for (const tex of this._atlasTextures) tex.version = -1;
      return true;
    }
    return false;
  };

  proto.setAtlas = function (this: InternalGlyphRenderer, atlas: InternalTextureAtlas) {
    patchTextureAtlas(atlas);
    this._lastStructureVersion = -1;
    origSetAtlas.call(this, atlas);
  };

  proto.render = function (this: InternalGlyphRenderer, model: unknown) {
    // 极端情况下（如硬件仅 4 个纹理单元又出现超宽连字）防止 pages 越界读取 _atlasTextures 崩溃
    const pages = this._atlas?._pages;
    const cap = this._atlasTextures?.length ?? 0;
    if (pages && cap > 0 && pages.length > cap) {
      const saved = pages.splice(cap);
      try {
        origRender.call(this, model);
      } finally {
        pages.push(...saved);
      }
      return;
    }
    origRender.call(this, model);
  };
}

export function patchWebglAddon(addon: WebglAddon): void {
  const renderer = (addon as unknown as { _renderer?: InternalWebglRenderer })._renderer;
  if (!renderer) return;

  // WebglRenderer 构造函数末尾用 screenElement.isConnected 覆盖了 _refreshCharAtlas 设下的 _isAttached=false，
  // 导致在 v-show 隐藏标签（isConnected=true 但字宽为 0）里挂载时，切到前台若行列数未变就不会创建图集
  if (!renderer._charAtlas) renderer._isAttached = false;

  patchTextureAtlas(renderer._charAtlas);
  patchGlyphRenderer(renderer._glyphRenderer?.value);
  if (renderer._charAtlas && "pagesVersion" in renderer._charAtlas) return;

  const proto = Object.getPrototypeOf(renderer) as InternalWebglRenderer | null;
  if (!proto || patchedRendererProtos.has(proto)) return;
  patchedRendererProtos.add(proto);

  const origUpdateModel = proto._updateModel;
  proto._updateModel = function (this: InternalWebglRenderer, start: number, end: number) {
    origUpdateModel.call(this, start, end);
    if (this._inMergeRetry) return;

    const glyph = this._glyphRenderer?.value;
    if (!glyph || !this._charAtlas) return;

    this._inMergeRetry = true;
    try {
      let retries = 0;
      while (glyph.beginFrame() && retries++ < MERGE_RETRY_LIMIT) {
        this._clearModel(true);
        origUpdateModel.call(this, 0, this._terminal.rows - 1);
      }
    } finally {
      this._inMergeRetry = false;
    }
  };
}
