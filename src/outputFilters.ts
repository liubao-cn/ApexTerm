/**
 * 输出显示过滤：把程序打印的 file:// 链接里的百分号编码（%E5%B7%A5 …）还原成可读文字。
 * Devin CLI 等工具按 URL 规范把中文路径编码后打印，人眼看是乱码；这里只改"显示"——
 * 只处理 file:// 开头的 token，逐段解码，遇到不完整 / 非法的 UTF-8 序列保留原样，不会把别的 % 文本改坏。
 */

const FILE_URL_RE = /file:\/\/[^\s()'"<>\x07\x1b]*%[0-9A-Fa-f]{2}[^\s()'"<>\x07\x1b]*/g;
const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;

const strict = new TextDecoder("utf-8", { fatal: true });

/** 把一段连续的 %XX 序列解码成文字；末尾不完整的多字节字符保留编码形式 */
export function decodePercentRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  // 从整段往前退最多 3 字节，找到能严格解码的最长前缀
  for (let cut = bytes.length; cut > Math.max(0, bytes.length - 4); cut--) {
    try {
      const head = strict.decode(bytes.subarray(0, cut));
      // 控制字符解出来会破坏终端显示，保留编码
      if (/[\x00-\x1f\x7f]/.test(head)) return run;
      return head + run.slice(cut * 3);
    } catch {
      /* 试更短的前缀 */
    }
  }
  return run;
}

/** 单次替换：文本里每个含编码的 file:// token 都还原 */
export function decodeFileUrls(text: string): string {
  if (!text.includes("file:") || !text.includes("%")) return text;
  return text.replace(FILE_URL_RE, (url) => url.replace(PERCENT_RUN_RE, decodePercentRun));
}

/** 数据流末尾若停在一个还没结束的 file:// token 里，先暂留，等下一段到了再一起处理 */
const TRAILING_URL_RE = /file:\/\/[^\s()'"<>\x07\x1b]*$/;

export interface StreamDecoder {
  /** 送入一段文本，返回可以立刻显示的部分 */
  push(chunk: string): string;
  /** 把暂留的部分吐出来（定时器到期 / 会话结束时调用） */
  flush(): string;
  readonly pending: boolean;
}

export function createFileUrlDecoder(): StreamDecoder {
  let held = "";
  return {
    push(chunk) {
      const text = held + chunk;
      held = "";
      const m = TRAILING_URL_RE.exec(text);
      // 结尾的半截 URL 最多暂留 512 字符，超过就当它不是 URL 直接放行
      if (m && m[0].length < 512) {
        held = m[0];
        return decodeFileUrls(text.slice(0, m.index));
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
