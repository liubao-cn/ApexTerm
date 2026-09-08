/**
 * WebKit 里一个 input(insertText) 事件到来时，判断 xterm 是否已经把这次输入发出去了。
 * 依据两个时间戳（performance.now()）：
 * - lastSentAt：xterm 最近一次 onData 的时刻
 * - lastKeydownAt：textarea 最近一次 keydown 的时刻
 *
 * 真实事件序列：
 * - 空格：keydown → keypress（xterm 在此发数据）→ beforeinput → input        → 已处理（发送在 keydown 之后）
 * - 输入法接受的标点（如 ，）：input（xterm 在自己的监听里发数据）→ keydown(229)  → 已处理（发送就在刚刚）
 * - 输入法被丢的标点（如 Shift 打出的 ：）：keydown(Shift) → input（xterm 不发）→ keydown(229) → 未处理，需补发
 */
export const SAME_KEYSTROKE_WINDOW_MS = 15;

export function xtermAlreadyHandled(lastSentAt: number, lastKeydownAt: number, now: number): boolean {
  return lastSentAt > lastKeydownAt || now - lastSentAt < SAME_KEYSTROKE_WINDOW_MS;
}
