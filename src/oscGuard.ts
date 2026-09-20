/**
 * OSC 8 超链接护栏。
 *
 * 程序输出里一个残缺的超链接序列（`\e]8;;URL` 后面没有结束符、也没有关闭序列）会让终端把之后的
 * 所有文字都算进这个链接：xterm 会一直把字节收进 URL 直到下一个 ESC / BEL，随后再没有人关闭它，
 * 整屏带下划线、点哪里都打开那个 URL，直到下一个链接出现为止。
 * 真实来源：Devin CLI 按字符数截断工具输出，把 Next.js 日志里的 `\e]8;;https://…\e\\标签\e]8;;\e\\`
 * 从中间切断，只剩 `\e]8;;https://…` + 换行。
 *
 * 这里只做两件事，其它输出一个字节不改：
 *  1. OSC 8 序列在收到结束符之前碰到换行 / 别的转义序列 → 视为残缺，URL 当普通文字显示，不开链接；
 *  2. 链接打开后到了换行仍没关闭 → 在换行前补一个关闭序列。
 * 其它 OSC（标题、剪贴板、shell 集成、内嵌图片…）只找结束符、不解析内容、原样放行。
 */

export interface StreamFilter {
  /** 送入一段文本，返回可以立刻显示的部分 */
  push(chunk: string): string;
  /**
   * 把暂留的部分吐出来。默认只放已经确定的部分（还没收全的转义序列继续留着等下一块）；
   * force 时全部吐出，之后靠"透传直到结束符"的状态继续跟踪。
   */
  flush(force?: boolean): string;
  readonly pending: boolean;
}

const CLOSE = "\x1b]8;;\x1b\\";
/** OSC 8 序列暂留上限：URL 不会这么长（浏览器上限约 2K），超过就当普通 OSC 透传 */
const OSC8_MAX = 8192;

const isDigit = (c: string) => c >= "0" && c <= "9";

/** [from, to) 里第一个 \r 或 \n 的位置，没有返回 -1 */
function indexOfNewline(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "\r" || c === "\n") return i;
  }
  return -1;
}

type Osc8Scan =
  | { kind: "st" | "bel"; payloadEnd: number; end: number }
  | { kind: "broken"; payloadEnd: number }
  | { kind: "incomplete" }
  | { kind: "long" };

/** 从 OSC 8 载荷起点扫到结束符 / 断裂点 */
function scanOsc8(text: string, from: number): Osc8Scan {
  for (let q = from; q < text.length; q++) {
    if (q - from > OSC8_MAX) return { kind: "long" };
    const c = text[q];
    if (c === "\x07") return { kind: "bel", payloadEnd: q, end: q + 1 };
    if (c === "\r" || c === "\n") return { kind: "broken", payloadEnd: q };
    if (c === "\x1b") {
      if (q + 1 >= text.length) return { kind: "incomplete" };
      return text[q + 1] === "\\" ? { kind: "st", payloadEnd: q, end: q + 2 } : { kind: "broken", payloadEnd: q };
    }
  }
  return { kind: "incomplete" };
}

/** OSC 8 载荷 "params;uri" 里的 uri；没有第二个分号视为空 */
function uriOf(payload: string): string {
  const semi = payload.indexOf(";");
  return semi === -1 ? "" : payload.slice(semi + 1);
}

export function createOscGuard(): StreamFilter {
  let linkOpen = false;
  /** 块尾还没收全的转义序列（"\x1b"、"\x1b]8"、"\x1b]8;;https://…" 等） */
  let held = "";
  /** 正在透传一个不解析内容的 OSC（非 8 号，或超长 / 被强制放行的 8 号）：只找结束符 */
  let passthrough = false;
  /** 上一块末尾孤零零的 ESC 已被强制放出：下一块的第一个字符决定它是什么序列 */
  let afterEsc = false;

  /** 透传模式：从 i 起放行到 OSC 结束符为止，返回新的扫描位置 */
  function passOsc(text: string, i: number, out: string[]): number {
    for (let j = i; ; ) {
      const esc = text.indexOf("\x1b", j);
      const bel = text.indexOf("\x07", j);
      const e = esc === -1 ? bel : bel === -1 ? esc : Math.min(esc, bel);
      if (e === -1) {
        out.push(text.slice(i));
        return text.length;
      }
      if (text[e] === "\x07") {
        out.push(text.slice(i, e + 1));
        passthrough = false;
        return e + 1;
      }
      if (e + 1 >= text.length) {
        // 不知道这个 ESC 是不是 ST 的开头
        out.push(text.slice(i, e));
        held = "\x1b";
        return text.length;
      }
      if (text[e + 1] === "\\") {
        out.push(text.slice(i, e + 2));
        passthrough = false;
        return e + 2;
      }
      // ESC 后面不是 '\'：按 VT 语义这个 OSC 到此结束，ESC 交回正常处理
      out.push(text.slice(i, e));
      passthrough = false;
      return e;
    }
  }

  return {
    push(chunk) {
      const text = held + chunk;
      held = "";
      const out: string[] = [];
      let i = 0;
      if (afterEsc && text.length > 0) {
        // 那个 ESC 已经在屏幕流里了，这里只能补上状态跟踪，不能再改写它
        afterEsc = false;
        if (passthrough && text[0] === "\\") {
          // 正好是 ST 的后半：这个 OSC 到此结束
          passthrough = false;
          out.push("\\");
          i = 1;
        } else {
          passthrough = false;
          if (text[0] === "]") {
            // 一个 OSC 开始了：只能透传到结束符；编号是 8（或还没收全）就按"链接可能已打开"处理
            let p = 1;
            while (p < text.length && isDigit(text[p])) p++;
            const num = text.slice(1, p);
            passthrough = true;
            if (num === "8" || p >= text.length) linkOpen = true;
            out.push(text.slice(0, p));
            i = p;
          } else {
            // CSI 等别的转义序列：这个字符原样放，其余按普通文字扫
            out.push(text[0]);
            i = 1;
          }
        }
      }
      while (i < text.length) {
        if (passthrough) {
          i = passOsc(text, i, out);
          continue;
        }
        const esc = text.indexOf("\x1b", i);
        const limit = esc === -1 ? text.length : esc;
        if (linkOpen) {
          const nl = indexOfNewline(text, i, limit);
          if (nl !== -1) {
            // 链接跨到了下一行还没关：在换行前替它关掉
            out.push(text.slice(i, nl), CLOSE);
            linkOpen = false;
            i = nl;
            continue;
          }
        }
        if (esc === -1) {
          out.push(text.slice(i));
          break;
        }
        out.push(text.slice(i, esc));
        if (esc + 1 >= text.length) {
          held = "\x1b";
          break;
        }
        if (text[esc + 1] !== "]") {
          // CSI / DCS / 单字符 ESC 序列：不解析，放过 ESC 和它的下一个字符，其余按普通文字继续扫
          out.push(text.slice(esc, esc + 2));
          i = esc + 2;
          continue;
        }
        // OSC：先看编号
        let p = esc + 2;
        while (p < text.length && isDigit(text[p])) p++;
        if (p >= text.length) {
          held = text.slice(esc);
          break;
        }
        if (text.slice(esc + 2, p) !== "8" || text[p] !== ";") {
          out.push(text.slice(esc, p));
          passthrough = true;
          i = p;
          continue;
        }
        const scan = scanOsc8(text, p + 1);
        if (scan.kind === "incomplete") {
          if (text.length - esc > OSC8_MAX) {
            out.push(text.slice(esc));
            passthrough = true;
            linkOpen = true;
            break;
          }
          held = text.slice(esc);
          break;
        }
        if (scan.kind === "long") {
          out.push(text.slice(esc));
          passthrough = true;
          linkOpen = true;
          break;
        }
        const uri = uriOf(text.slice(p + 1, scan.payloadEnd));
        if (scan.kind === "broken") {
          // 残缺的序列：有链接开着就先关掉，URL 当文字显示；断裂处的换行 / ESC 交回正常处理
          if (linkOpen) out.push(CLOSE);
          linkOpen = false;
          out.push(uri);
          i = scan.payloadEnd;
          continue;
        }
        out.push(text.slice(esc, scan.end));
        linkOpen = uri.length > 0;
        i = scan.end;
      }
      return out.join("");
    },
    flush(force = false) {
      if (!held) return "";
      // 半截序列非 force 不放：后续字节一定还在路上（程序不会只写半个转义序列就停）
      if (!force) return "";
      const text = held;
      held = "";
      if (text === "\x1b") {
        afterEsc = true;
      } else if (text.startsWith("\x1b]")) {
        // 强制放出一个没收全的 OSC：之后只能透传到结束符。编号是 8（或还没收全）就按"链接可能已打开"处理，
        // 多补一个关闭无害
        passthrough = true;
        const num = /^\x1b\](\d*)/.exec(text)![1];
        if (num === "8" || num === "") linkOpen = true;
      }
      return text;
    },
    get pending() {
      return held.length > 0;
    },
  };
}
