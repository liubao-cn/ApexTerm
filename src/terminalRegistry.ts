import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";

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

export function createRuntime(sessionId: string, opts: CreateOptions): TermRuntime {
  const term = new Terminal({
    allowProposedApi: true,
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
  };
  runtimes.set(sessionId, rt);
  return rt;
}

/** 把终端挂到容器里：首次 open，之后只是把已有 DOM 移过去 */
export function attach(rt: TermRuntime, container: HTMLElement) {
  if (!rt.term.element) {
    rt.term.open(container);
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
