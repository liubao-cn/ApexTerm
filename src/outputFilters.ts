/**
 * 输出显示过滤：把程序打印的 file:// 链接里的百分号编码（%E5%B7%A5 …）还原成可读文字。
 * Devin CLI 等工具按 URL 规范把中文路径编码后打印，人眼看是乱码；这里只改"显示"——
 * 只处理 file:// 开头的 URL（含被程序折行后的续行），逐段解码，遇到不完整 / 非法的 UTF-8 序列保留原样，
 * 不会把别的 % 文本改坏。
 */

const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;
/** URL 在一行内到此为止的字符 */
const TERMINATOR = /[\s()'"<>\x07\x1b]/;
/**
 * URL 中间可以"透明"跨过的东西：不移动光标的 CSI 序列（SGR 颜色 m、清行 K、清屏 J、模式开关 h/l）、
 * 换行 + 缩进，可连续多个。Devin 的实际排版是 `…%E5%B7-\e[0m\r\n   \e[38;2;124;124;124m%E4%BB…`，
 * 行尾有时还带 `\e[K`。光标移动类（A/B/C/D/G/H）不算，那意味着程序在别处画东西。
 */
const SEPARATOR_RE = /^(?:\x1b\[[0-9;?]*[mKJhl]|(?:\r\n|\n|\r)[ \t]*)+/;
/** 续行开头必须像 URL 的一部分 */
const URL_CHAR = /[A-Za-z0-9%\/._~\-+@:,;=&#!*[\]]/;
/** 文本末尾只剩一个没收全的 CSI 序列（如 "\x1b[38;2;12"） */
const INCOMPLETE_ESC_RE = /^\x1b(?:\[[0-9;?]*)?$/;
/** 文本末尾是 "file://" 的前几个字符（前面不是字母，避免把 "profile" 的尾巴当成它） */
const PARTIAL_SCHEME_RE = /(?:^|[^A-Za-z])(f|fi|fil|file|file:|file:\/)$/;
/** 暂留的半截 URL 上限，超过就当它不是 URL */
const HOLD_LIMIT = 2048;

const strict = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 首字节对应的序列长度；单字节 ASCII 与非法首字节返回 0（都保留 %XX 原样） */
function utf8Len(b: number): number {
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 0;
}

/**
 * 把一段连续的 %XX 序列拆成「已解码文本」和「末尾还没收全的多字节字符」。
 * 只还原多字节（非 ASCII）字符；单字节的 %20 / %2F / %1B 之类一律保留编码，既不会把 ( ) 空格解出来
 * 搅乱排版，也不会被人用 %1B 注入转义序列。中间夹着的非法字节保留 %XX，后面的字符继续解，
 * 不会因为一个坏字节把整段都放弃。
 */
export function splitPercentRun(run: string): { decoded: string; rest: string } {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  let out = "";
  let p = 0;
  while (p < bytes.length) {
    const len = utf8Len(bytes[p]);
    if (len === 0) {
      out += run.slice(p * 3, p * 3 + 3);
      p++;
      continue;
    }
    // 末尾不完整的多字节字符：留给下一段接着解
    if (p + len > bytes.length) return { decoded: out, rest: run.slice(p * 3) };
    try {
      out += strict.decode(bytes.subarray(p, p + len));
      p += len;
    } catch {
      out += run.slice(p * 3, p * 3 + 3);
      p++;
    }
  }
  return { decoded: out, rest: "" };
}

export function decodePercentRun(run: string): string {
  const { decoded, rest } = splitPercentRun(run);
  return decoded + rest;
}

interface UrlSpan {
  start: number;
  end: number;
  /** 每段在 text 里的范围（折行拆开的） */
  segments: { from: number; to: number }[];
  /** 段与段之间的换行 + 缩进原文 */
  breaks: string[];
  /** 到文本末尾还没结束（可能下一块数据还有续行） */
  open: boolean;
}

/**
 * 从 text[start] 处量出一个 URL 的范围，跨过程序折行。
 * 正常从 "file://" 开始（skip 跳过这 7 个字符）；上一块数据停在 URL 里、这一块从续行开始时 skip = 0。
 */
function scanUrl(text: string, start: number, skip = "file://".length): UrlSpan {
  const segments: { from: number; to: number }[] = [];
  const breaks: string[] = [];
  let i = start + skip;
  let from = start;
  for (;;) {
    while (i < text.length && !TERMINATOR.test(text[i])) i++;
    segments.push({ from, to: i });
    if (i >= text.length) return { start, end: i, segments, breaks, open: true };
    const ch = text[i];
    if (ch !== "\r" && ch !== "\n" && ch !== "\x1b") break;
    const m = SEPARATOR_RE.exec(text.slice(i, i + 256));
    if (!m) {
      // 停在一个还没收全的转义序列上（数据块恰好断在 ␛[38;2;… 中间）：结论未定，交给流式层暂留
      if (INCOMPLETE_ESC_RE.test(text.slice(i))) return { start, end: i, segments, breaks, open: true };
      break;
    }
    const j = i + m[0].length;
    // 分隔符之后文本就没了、或只剩半截转义序列：还不知道下一段是不是续行，交给流式层暂留
    if (j >= text.length || INCOMPLETE_ESC_RE.test(text.slice(j))) {
      return { start, end: i, segments, breaks, open: true };
    }
    // 只有分隔符后紧跟 URL 字符、且前一段确实有内容时才算续行
    if (!URL_CHAR.test(text[j]) || segments[segments.length - 1].to === from) break;
    breaks.push(m[0]);
    from = j;
    i = j;
  }
  return { start, end: i, segments, breaks, open: false };
}

/** 把一个 URL 范围内的编码还原；行尾被切断的半个字符搬到下一段开头再解 */
function decodeSpan(text: string, span: UrlSpan): string {
  let out = "";
  let carry = "";
  span.segments.forEach((seg, k) => {
    const hasNext = k < span.segments.length - 1;
    let s = carry + text.slice(seg.from, seg.to);
    carry = "";
    s = s.replace(PERCENT_RUN_RE, (run, offset: number, whole: string) => {
      const { decoded, rest } = splitPercentRun(run);
      if (hasNext && rest && offset + run.length === whole.length) {
        carry = rest;
        return decoded;
      }
      return decoded + rest;
    });
    // 行尾孤零零的 "%" 或 "%E"：也搬到下一段
    if (hasNext) {
      const tail = /%[0-9A-Fa-f]?$/.exec(s);
      if (tail) {
        carry = tail[0] + carry;
        s = s.slice(0, tail.index);
      }
    }
    out += s + (hasNext ? span.breaks[k] : "");
  });
  return out + carry;
}

/**
 * 一个还没结束的 URL：算出"从哪个位置起是解不出来的半个字符"（含它后面的折行分隔符、半截 %X），
 * 放行时这一截要继续留着等续行。没有这样的尾巴返回 null。
 */
function trailingHoldIndex(text: string, span: UrlSpan): number | null {
  let carry = "";
  let holdFrom: number | null = null;
  span.segments.forEach((seg) => {
    const carried = carry.length;
    const s = carry + text.slice(seg.from, seg.to);
    carry = "";
    // 段尾一段连续 %XX + 可能的半截 %X
    const m = /((?:%[0-9A-Fa-f]{2})*)(%[0-9A-Fa-f]?)?$/.exec(s)!;
    const run = m[1];
    const dangling = m[2] ?? "";
    const rest = (run ? splitPercentRun(run).rest : "") + dangling;
    if (!rest) {
      holdFrom = null;
      return;
    }
    carry = rest;
    const restStartInS = s.length - rest.length;
    // 尾巴从上一段带过来的部分开始 → 保留上一段算出的位置；否则定位到本段
    if (restStartInS >= carried || holdFrom === null) holdFrom = seg.from + Math.max(0, restStartInS - carried);
  });
  return holdFrom;
}

function findSpans(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  let i = text.indexOf("file://");
  while (i >= 0) {
    const span = scanUrl(text, i);
    spans.push(span);
    i = text.indexOf("file://", Math.max(span.end, i + 1));
  }
  return spans;
}

/** 单次替换：文本里每个含编码的 file:// URL 都还原（含折行续行） */
export function decodeFileUrls(text: string): string {
  if (!text.includes("file://") || !text.includes("%")) return text;
  let out = "";
  let last = 0;
  for (const span of findSpans(text)) {
    out += text.slice(last, span.start) + decodeSpan(text, span);
    last = span.end;
  }
  return out + text.slice(last);
}

export interface StreamDecoder {
  /** 送入一段文本，返回可以立刻显示的部分 */
  push(chunk: string): string;
  /**
   * 把暂留的部分吐出来（定时器到期 / 会话结束时调用）。
   * 默认会把末尾还没收全的半个字符（≤ 9 个字符的 %XX）继续留着等续行；force 时全部吐出。
   */
  flush(force?: boolean): string;
  readonly pending: boolean;
}

/**
 * 续行状态下一块数据的开头允许出现的东西：上一块可能刚好在换行后、缩进前被切开，
 * 所以这里比 SEPARATOR_RE 宽松——单独的缩进空格也算。
 */
const CONTINUATION_PREFIX_RE = /^(?:[ \t]+|\x1b\[[0-9;?]*[mKJhl]|\r\n|\n|\r)*/;
/**
 * 流式解码：数据流末尾若停在一个还没结束的 file:// URL 里（含续行），先暂留，等下一段到了再一起处理。
 * 若暂留被定时器提前放行（比如主线程正忙着 resize 重排），仍记住"停在 URL 里"这个状态：
 * 下一块开头若是续行，照样按 URL 解码，最多只剩被切断的那半个字符。
 */
export function createFileUrlDecoder(): StreamDecoder {
  let held = "";
  /** 暂留被放行时 URL 还没结束：下一块的开头可能是它的续行 */
  let continuing = false;

  /** 把 text 开头当作 URL 续行处理（可带分隔符），返回处理后的开头部分和剩余文本的起点 */
  function decodeContinuation(text: string): { out: string; rest: number; open: boolean } {
    const j = CONTINUATION_PREFIX_RE.exec(text)![0].length;
    if (j >= text.length || INCOMPLETE_ESC_RE.test(text.slice(j))) return { out: "", rest: 0, open: true };
    if (!URL_CHAR.test(text[j])) return { out: "", rest: 0, open: false };
    const span = scanUrl(text, j, 0);
    if (span.open && text.length - j < HOLD_LIMIT) return { out: "", rest: 0, open: true };
    return { out: text.slice(0, j) + decodeSpan(text, span), rest: span.end, open: false };
  }

  /** 放行一段"处在 URL 续行状态"的文本：开头按续行解码（哪怕还没结束），后面按普通文本处理 */
  function decodeAsContinuation(text: string): string {
    const j = CONTINUATION_PREFIX_RE.exec(text)![0].length;
    if (j >= text.length || !URL_CHAR.test(text[j])) return decodeFileUrls(text);
    const span = scanUrl(text, j, 0);
    return text.slice(0, j) + decodeSpan(text, span) + decodeFileUrls(text.slice(span.end));
  }

  /** 续行状态下，把 text 开头那段续行量成一个（可能未结束的）span；开头不像续行则返回 null */
  function openContinuationSpan(text: string): UrlSpan | null {
    const j = CONTINUATION_PREFIX_RE.exec(text)![0].length;
    // 只剩分隔符 / 半截转义序列：还没法判断，维持续行状态
    if (j >= text.length || INCOMPLETE_ESC_RE.test(text.slice(j))) {
      return { start: j, end: text.length, segments: [], breaks: [], open: true };
    }
    if (!URL_CHAR.test(text[j])) return null;
    const span = scanUrl(text, j, 0);
    return span.open ? span : null;
  }

  return {
    push(chunk) {
      let text = held + chunk;
      held = "";
      let prefix = "";
      if (continuing) {
        continuing = false;
        const c = decodeContinuation(text);
        if (c.open) {
          held = text;
          continuing = true;
          return "";
        }
        prefix = c.out;
        text = text.slice(c.rest);
      }
      if (!text.includes("file://")) {
        const partial = PARTIAL_SCHEME_RE.exec(text);
        if (!partial) return prefix + text;
        held = partial[1];
        return prefix + text.slice(0, text.length - partial[1].length);
      }
      const spans = findSpans(text);
      const lastSpan = spans[spans.length - 1];
      if (lastSpan?.open && text.length - lastSpan.start < HOLD_LIMIT) {
        held = text.slice(lastSpan.start);
        return prefix + decodeFileUrls(text.slice(0, lastSpan.start));
      }
      // 数据块恰好断在 "file://" 这几个字符中间：把这半截也留到下一块
      const partial = PARTIAL_SCHEME_RE.exec(text);
      if (partial) {
        held = partial[1];
        return prefix + decodeFileUrls(text.slice(0, text.length - partial[1].length));
      }
      return prefix + decodeFileUrls(text);
    },
    flush(force = false) {
      if (!held) return "";
      let text = held;
      held = "";
      if (!text.includes("file://") && !continuing) {
        // 只是 "file://" 的前几个字符：非 force 时继续留着（最多 6 个字符，随后的 force 会放行）
        if (!force && PARTIAL_SCHEME_RE.test(text) && text.length <= "file:/".length) {
          held = text;
          return "";
        }
        return text;
      }
      // 放行的是一个没结束的 URL：记住状态，下一块的续行仍要解码
      const wasContinuing = continuing;
      const spans = findSpans(text);
      const openSpan = spans.find((s) => s.open) ?? (continuing ? openContinuationSpan(text) : null);
      continuing = openSpan !== null;
      if (openSpan && !force) {
        // 末尾解不出来的半个字符（连同它后面的折行分隔符）先不放：接上续行才能解
        const holdFrom = trailingHoldIndex(text, openSpan);
        if (holdFrom !== null && holdFrom < text.length) {
          held = text.slice(holdFrom);
          text = text.slice(0, holdFrom);
        }
      }
      return wasContinuing ? decodeAsContinuation(text) : decodeFileUrls(text);
    },
    get pending() {
      return held.length > 0;
    },
  };
}
