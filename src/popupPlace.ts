/**
 * 把在鼠标位置弹出的浮层摆进窗口：默认左上角对准鼠标，放不下就整体往回挪，四边留 margin；
 * 比窗口还高时贴顶并给出 maxHeight，由浮层自己滚动。Naive UI 的二级菜单只会翻转对齐、
 * 不会挪动也不会滚动，内容一长就被窗口边缘截掉，所以自绘浮层统一走这里。
 */
export function placePopup(o: { x: number; y: number; w: number; h: number; vw: number; vh: number; margin?: number }): {
  left: number;
  top: number;
  maxHeight: number;
} {
  const m = o.margin ?? 8;
  const maxHeight = Math.max(0, o.vh - m * 2);
  const h = Math.min(o.h, maxHeight);
  const clamp = (v: number, size: number, limit: number) => Math.round(Math.max(m, Math.min(v, limit - m - size)));
  return { left: clamp(o.x, o.w, o.vw), top: clamp(o.y, h, o.vh), maxHeight };
}
