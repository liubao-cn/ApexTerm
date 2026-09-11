/**
 * 输出显示过滤：把程序打印的 file:// 链接里的百分号编码（%E5%B7%A5 …）还原成可读文字。
 * Devin CLI 等工具按 URL 规范把中文路径编码后打印，人眼看是乱码；这里只改"显示"——
 * 只处理 file:// 开头的 URL（含被程序折行后的续行），逐段解码，遇到不完整 / 非法的 UTF-8 序列保留原样，
 * 不会把别的 % 文本改坏。
 */

const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;
/** URL 在一行内到此为止的字符 */
const TERMINATOR = /[\s()'"<>\x07\x1b]/;
/** 折行：换行 + 可选的 SGR 颜色序列 + 缩进 */
const LINE_BREAK_RE = /^(?:\r\n|\n|\r)(?:\x1b\[[0-9;]*m)*[ \t]*(?:\x1b\[[0-9;]*m)*/;
/** 续行开头必须像 URL 的一部分 */
const URL_CHAR = /[A-Za-z0-9%\/._~\-+@:,;=&#!*[\]]/;
/** 暂留的半截 URL 上限，超过就当它不是 URL */
const HOLD_LIMIT = 2048;

const strict = new TextDecoder("utf-8", { fatal: true });

/** 把一段连续的 %XX 序列拆成「能解码的前缀」和「剩下的编码」 */
export function splitPercentRun(run: string): { decoded: string; rest: string } {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  // 从整段往前退最多 3 字节，找到能严格解码的最长前缀
  for (let cut = bytes.length; cut > Math.max(0, bytes.length - 4); cut--) {
    try {
      const head = strict.decode(bytes.subarray(0, cut));
      // 控制字符解出来会破坏终端显示，整段保留编码
      if (/[\x00-\x1f\x7f]/.test(head)) return { decoded: "", rest: run };
      return { decoded: head, rest: run.slice(cut * 3) };
    } catch {
      /* 试更短的前缀 */
    }
  }
  return { decoded: "", rest: run };
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

/** 从 text[start] 处的 "file://" 开始，量出这个 URL 的范围，跨过程序折行 */
function scanUrl(text: string, start: number): UrlSpan {
  const segments: { from: number; to: number }[] = [];
  const breaks: string[] = [];
  let i = start + "file://".length;
  let from = start;
  for (;;) {
    while (i < text.length && !TERMINATOR.test(text[i])) i++;
    segments.push({ from, to: i });
    if (i >= text.length) return { start, end: i, segments, breaks, open: true };
    const ch = text[i];
    if (ch !== "\r" && ch !== "\n") break;
    const m = LINE_BREAK_RE.exec(text.slice(i, i + 64));
    if (!m) break;
    const j = i + m[0].length;
    // 换行 + 缩进之后文本就没了：还不知道下一行是不是续行，交给流式层暂留
    if (j >= text.length) return { start, end: i, segments, breaks, open: true };
    // 只有换行后紧跟 URL 字符、且前一段确实有内容时才算续行
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
  /** 把暂留的部分吐出来（定时器到期 / 会话结束时调用） */
  flush(): string;
  readonly pending: boolean;
}

/** 数据流末尾若停在一个还没结束的 file:// URL 里（含续行），先暂留，等下一段到了再一起处理 */
export function createFileUrlDecoder(): StreamDecoder {
  let held = "";
  return {
    push(chunk) {
      const text = held + chunk;
      held = "";
      if (!text.includes("file://")) return text;
      const spans = findSpans(text);
      const lastSpan = spans[spans.length - 1];
      if (lastSpan?.open && text.length - lastSpan.start < HOLD_LIMIT) {
        held = text.slice(lastSpan.start);
        return decodeFileUrls(text.slice(0, lastSpan.start));
      }
      return decodeFileUrls(text);
    },
    flush() {
      const out = decodeFileUrls(held);
      held = "";
      return out;
    },
    get pending() {
      return held.length > 0;
    },
  };
}
