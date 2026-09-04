/**
 * 复制时把"被终端宽度截断的长行"接回一行。
 *
 * xterm 只会合并它自己软换行的行（buffer line 的 isWrapped）；Claude Code / Devin CLI 这类 TUI 是按终端宽度
 * 自己排好版、用真正的换行写进来的，终端无从知道那其实是一句话。这里用两条启发式判断一个换行是不是"排版换行"：
 *  1. 上一行已经写满（接近）行宽；
 *  2. 下一行的第一个词放不进上一行剩下的空间（词换行的必然结果）。
 * 命中即拼接：两侧都不是 CJK 时补一个空格，否则直接相连。列表项、提示符、表格 / 边框、空行等视为真换行。
 */

/** 太窄的选区不可能是被截断的段落，原样返回 */
const MIN_WIDTH = 20;

/** 下一行以这些开头 → 一定是真换行（列表、编号、提示符、引用、标题、表格 / 边框、代码围栏） */
const HARD_START = /^(?:[-*+•·◦▪‣—]\s|\d{1,3}[.)]\s|[a-zA-Z][.)]\s|[>$#%❯➜⏺│┃║╭╰├└┌┐┘┤┬┴┼─━╮╯╔╗╚╝]|\||```)/;
/** 上一行以边框字符结尾 → 真换行 */
const HARD_END = /[│┃║╮╯╭╰┐┘┌└]\s*$/;

const CJK =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]|[\u{20000}-\u{3fffd}]/u;

function isWide(ch: string): boolean {
  return CJK.test(ch);
}

/** 终端显示宽度：CJK / 全角 / emoji 算 2 格 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch) ? 2 : 1;
  return w;
}

function firstWordWidth(s: string): number {
  const m = /^\S+/.exec(s);
  return m ? displayWidth(m[0]) : 0;
}

/** 两个字符之间拼接时要不要补空格：都不是 CJK 才补 */
function joiner(prevLast: string, nextFirst: string): string {
  if (!prevLast || !nextFirst) return "";
  if (isWide(prevLast) || isWide(nextFirst)) return "";
  return prevLast === " " ? "" : " ";
}

/**
 * @param text  xterm getSelection() 的结果（已按 isWrapped 合并过软换行）
 * @param cols  终端列数（行宽上限）
 */
export function reflowSelection(text: string, cols: number): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return text;

  const trimmed = lines.map((l) => l.trimEnd());
  const widths = trimmed.map(displayWidth);
  const maxW = Math.max(...widths);
  if (maxW < MIN_WIDTH) return text;

  // 估算排版宽度：至少两行接近最宽行，才相信最宽行就是排版宽度（避免一行长代码把宽度带偏）；否则用终端列数
  const nearMax = widths.filter((w) => w >= maxW * 0.85).length;
  const wrapW = nearMax >= 2 ? maxW : cols > 0 ? cols : maxW;
  const termW = cols > 0 ? cols : wrapW;

  const out: string[] = [];
  let cur = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prev = cur.trimEnd();
    const nextRaw = lines[i];
    const next = nextRaw.trimStart();
    const prevW = displayWidth(prev);
    const joinable =
      prev.length > 0 &&
      next.length > 0 &&
      !HARD_START.test(next) &&
      !HARD_END.test(prev) &&
      (prevW >= termW - 2 || prevW >= wrapW - 2 || prevW + 1 + firstWordWidth(next) > wrapW);
    if (joinable) {
      cur = prev + joiner(prev[prev.length - 1], next[0]) + next;
    } else {
      out.push(cur);
      cur = nextRaw;
    }
  }
  out.push(cur);
  return out.join(nl);
}
