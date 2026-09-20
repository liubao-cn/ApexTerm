import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { hideTip, showTipAt } from "./tooltip";
import { xtermAlreadyHandled } from "./imeInsert";
import { createOscGuard, type StreamFilter } from "./oscGuard";
import { createFileUrlDecoder, type StreamDecoder } from "./outputFilters";

/**
 * 终端运行时：xterm 实例 + pty 连接状态。按会话 id 登记，独立于 Vue 组件的挂载/卸载，
 * 这样把面板移到别的标签（组件重建）时终端和 SSH 连接都能原样保留。
 */
export interface TermRuntime {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backendId: string | null;
  /** 当前连接的令牌，旧连接的回调用它判断是否已过期 */
  connectionToken: object | null;
  gotOutput: boolean;
  /** 自动重连计数（正常退出会清零） */
  reconnectAttempts: number;
  reconnectTimer: number | null;
  /** 组件层挂上来的 UI 回调（查找框、拖放路径、重命名等） */
  ui: { toggleSearch?: () => void; pastePaths?: (paths: string[]) => void; rename?: () => void };
  /** pty 字节流 → 文本（跨块的半个 UTF-8 字符由它接住） */
  textDecoder: TextDecoder;
  /** 显示过滤第一级：残缺的 OSC 8 超链接序列不让它把后面整屏都变成链接 */
  oscGuard: StreamFilter;
  /** 显示过滤第二级：file:// 链接的百分号编码还原；结尾半截 URL 暂留 */
  urlDecoder: StreamDecoder;
  /** 最近一次输出是否走了 URL 解码（设置开着且不在全屏程序里），定时放行时沿用 */
  urlFilterActive: boolean;
  urlFlushTimer: number | null;
}

/** 短促的提示音（BEL），用 WebAudio 合成，不依赖音频文件 */
let audioCtx: AudioContext | null = null;
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {
    /* 无音频设备时忽略 */
  }
}

const runtimes = new Map<string, TermRuntime>();

export interface CreateOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "bar" | "block" | "underline";
  scrollback: number;
  optionAsMeta: boolean;
  brightBold: boolean;
  theme: ITheme;
}

export function getRuntime(sessionId: string | null | undefined): TermRuntime | undefined {
  return sessionId ? runtimes.get(sessionId) : undefined;
}

/** OSC 8 链接里的 file:// → 本机路径（把 %E6%96%B9 这类转义还原成中文） */
function fileUrlToPath(uri: string): string | null {
  if (!/^file:/i.test(uri)) return null;
  try {
    const u = new URL(uri);
    if (u.hostname && u.hostname !== "localhost") return null;
    return decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
}

/** 链接悬停时的可读文本：file 链接显示还原后的路径，其它显示解码后的 URL */
function linkTipText(uri: string): string {
  const path = fileUrlToPath(uri);
  if (path) return `${path}\n点击在${fileManagerName()}中显示`;
  try {
    return `${decodeURI(uri)}\n点击打开`;
  } catch {
    return `${uri}\n点击打开`;
  }
}

function fileManagerName(): string {
  return navigator.platform.toLowerCase().includes("mac") ? " Finder " : "文件管理器";
}

/** 打开程序输出里的 OSC 8 链接：file:// 在文件管理器里定位，其它交给系统默认程序 */
function activateLink(uri: string) {
  const path = fileUrlToPath(uri);
  (path ? revealItemInDir(path) : openUrl(uri)).catch(() => {});
}

export function createRuntime(sessionId: string, opts: CreateOptions): TermRuntime {
  const term = new Terminal({
    allowProposedApi: true,
    linkHandler: {
      activate: (_e, uri) => activateLink(uri),
      hover: (e, uri) => showTipAt(linkTipText(uri), e.clientX, e.clientY),
      leave: () => hideTip(),
    },
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    lineHeight: opts.lineHeight,
    cursorBlink: opts.cursorBlink,
    cursorStyle: opts.cursorStyle,
    scrollback: opts.scrollback,
    macOptionIsMeta: opts.optionAsMeta,
    drawBoldTextInBrightColors: opts.brightBold,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: false,
    theme: opts.theme,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri).catch(() => {})));
  const rt: TermRuntime = {
    sessionId,
    term,
    fit,
    search,
    backendId: null,
    connectionToken: null,
    gotOutput: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    ui: {},
    textDecoder: new TextDecoder("utf-8"),
    oscGuard: createOscGuard(),
    urlDecoder: createFileUrlDecoder(),
    urlFilterActive: false,
    urlFlushTimer: null,
  };
  runtimes.set(sessionId, rt);
  return rt;
}

/** 暂留的半截 URL 多久没有后续数据就先放行（解不出的半个字符仍留着） */
const URL_HOLD_MS = 120;
/** 再过多久连半个字符也放行（真正悬空的输出，比如提示符里就有个半截 URL） */
const URL_FORCE_FLUSH_MS = 1000;

function clearFlushTimer(rt: TermRuntime) {
  if (rt.urlFlushTimer !== null) {
    window.clearTimeout(rt.urlFlushTimer);
    rt.urlFlushTimer = null;
  }
}

/** 两级过滤是否还有暂留 */
function filtersPending(rt: TermRuntime): boolean {
  return rt.oscGuard.pending || rt.urlDecoder.pending;
}

/** 把两级过滤暂留的部分按顺序放出来：护栏放出的文字仍要经过 URL 解码（若它在工作） */
function drainFilters(rt: TermRuntime, force: boolean): string {
  const fromGuard = rt.oscGuard.flush(force);
  if (!rt.urlFilterActive) return (rt.urlDecoder.pending ? rt.urlDecoder.flush(true) : "") + fromGuard;
  return (fromGuard ? rt.urlDecoder.push(fromGuard) : "") + rt.urlDecoder.flush(force);
}

/**
 * 两段式放行：先放能显示的部分（解不出的半个字符继续留着等续行），过 1 秒还没有续行再全部放出。
 * 解码器自己记着"停在 URL 里"的状态，所以即便这里放行早了（主线程忙着 resize 重排），续行到了照样能接上。
 */
function scheduleFlush(rt: TermRuntime) {
  clearFlushTimer(rt);
  rt.urlFlushTimer = window.setTimeout(() => {
    rt.urlFlushTimer = null;
    rt.term.write(drainFilters(rt, false));
    if (filtersPending(rt)) {
      rt.urlFlushTimer = window.setTimeout(() => {
        rt.urlFlushTimer = null;
        rt.term.write(drainFilters(rt, true));
      }, URL_FORCE_FLUSH_MS);
    }
  }, URL_HOLD_MS);
}

/**
 * 把 pty 送来的一段字节写进终端。
 * 一律先过 OSC 8 护栏；开了「还原 file:// 链接里的中文」且不在全屏程序（备用缓冲区）里时再走 URL 解码；
 * 结尾若停在半截转义序列 / 半截 URL 上先暂留，等后续数据或定时器放行。
 */
export function writeOutput(rt: TermRuntime, bytes: Uint8Array, decodeFileUrls: boolean) {
  const text = rt.oscGuard.push(rt.textDecoder.decode(bytes, { stream: true }));
  clearFlushTimer(rt);
  rt.urlFilterActive = decodeFileUrls && rt.term.buffer.active.type === "normal";
  if (!rt.urlFilterActive) {
    const held = rt.urlDecoder.pending ? rt.urlDecoder.flush(true) : "";
    rt.term.write(held + text);
  } else {
    rt.term.write(rt.urlDecoder.push(text));
  }
  if (filtersPending(rt)) scheduleFlush(rt);
}

/** 会话结束等时机：把暂留的全部立刻吐出来 */
export function flushOutput(rt: TermRuntime) {
  clearFlushTimer(rt);
  if (filtersPending(rt)) rt.term.write(drainFilters(rt, true));
}

/**
 * 兜住 WebKit 输入法直接插入的字符（中文冒号、问号、引号等按着 Shift 打出的全角标点）。
 * WebKit 的事件顺序是 input(insertText) → keydown(keyCode 229)，而 xterm 在 Shift 的 keydown 之后
 * 直到 keyup 之前都认为"正有按键在处理"，会把这条 input 丢掉，于是字符消失。
 * 这里在 xterm 自己的 input 监听之后再监听一次：xterm 没发出数据的 insertText 由我们补发。
 *
 * 判断"xterm 已经发过"不能靠 beforeinput 重置标志：空格这类键 xterm 在 keypress 阶段就发了数据，
 * 之后 WebKit 仍会派发 beforeinput/input，标志被重置就会补发第二个空格。改为按时间判断（见 imeInsert.ts）。
 */
function fixImeDirectInsert(term: Terminal) {
  const ta = term.textarea;
  if (!ta) return;
  let lastKeydownAt = 0;
  let lastSentAt = -Infinity;
  term.onData(() => (lastSentAt = performance.now()));
  ta.addEventListener("keydown", () => (lastKeydownAt = performance.now()));
  ta.addEventListener("input", (e) => {
    const ev = e as InputEvent;
    if (ev.inputType !== "insertText" || !ev.data || ev.isComposing) return;
    if (!xtermAlreadyHandled(lastSentAt, lastKeydownAt, performance.now())) term.input(ev.data, true);
  });
}

/** 把终端挂到容器里：首次 open，之后只是把已有 DOM 移过去 */
export function attach(rt: TermRuntime, container: HTMLElement) {
  if (!rt.term.element) {
    rt.term.open(container);
    fixImeDirectInsert(rt.term);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      rt.term.loadAddon(webgl);
    } catch {
      /* WebGL 不可用时回退到 DOM 渲染 */
    }
  } else if (rt.term.element.parentElement !== container) {
    container.appendChild(rt.term.element);
    rt.term.refresh(0, rt.term.rows - 1);
  }
}

/** 从 DOM 上摘下来但保留实例（面板移动时用） */
export function detach(rt: TermRuntime) {
  rt.term.element?.remove();
}

/** 彻底销毁：结束 pty、释放 xterm */
export function disposeRuntime(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) return;
  runtimes.delete(sessionId);
  rt.connectionToken = null;
  if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
  if (rt.backendId) api.closeTerminal(rt.backendId).catch(() => {});
  rt.backendId = null;
  rt.term.dispose();
}

/** 兼容旧调用名 */
export const getTerm = getRuntime;
