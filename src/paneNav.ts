export type NavDir = "left" | "right" | "up" | "down";

/**
 * 按几何方向找相邻面板（键盘切换焦点用）：在当前可见的终端面板里，
 * 取位于指定方向一侧、主方向距离最近（横向偏移作次要权重）的那个。
 */
export function neighborPane(fromId: string, dir: NavDir): string | null {
  const els = [...document.querySelectorAll<HTMLElement>(".tab-body .term-wrap[data-session-id]")].filter(
    (el) => el.offsetParent !== null,
  );
  const from = els.find((el) => el.dataset.sessionId === fromId);
  if (!from) return null;
  const fr = from.getBoundingClientRect();
  const fx = (fr.left + fr.right) / 2;
  const fy = (fr.top + fr.bottom) / 2;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; score: number } | null = null;
  for (const el of els) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    const onSide =
      dir === "left" ? r.right <= fr.left + 1
      : dir === "right" ? r.left >= fr.right - 1
      : dir === "up" ? r.bottom <= fr.top + 1
      : r.top >= fr.bottom - 1;
    if (!onSide) continue;
    const dx = Math.abs((r.left + r.right) / 2 - fx);
    const dy = Math.abs((r.top + r.bottom) / 2 - fy);
    const score = horizontal ? dx + dy * 0.5 : dy + dx * 0.5;
    if (!best || score < best.score) best = { id: el.dataset.sessionId!, score };
  }
  return best?.id ?? null;
}
