import type { Directive } from "vue";

/**
 * v-tip：自绘的快速悬停提示，替代系统 title（macOS 原生 title 要等 1 秒多且不可调）。
 * 用法：<button v-tip="'快捷命令'"> 或 v-tip="`第一行\n第二行`"
 * 出现延迟可通过 setTooltipDelay 全局调整。
 */
let delay = 150;
let box: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

const TEXT = Symbol("tipText");
const LABELED = Symbol("tipLabeled");
type TipEl = HTMLElement & { [TEXT]?: string; [LABELED]?: boolean };

/** 没有可见文字的元素（图标按钮）用提示的第一行补 aria-label，读屏能念出来；写过显式 aria-label 的不动 */
function syncAriaLabel(el: TipEl) {
  if (el.hasAttribute("aria-label") && !el[LABELED]) return;
  if (el.textContent?.trim()) return;
  const first = (el[TEXT] ?? "").split("\n")[0].trim();
  if (first) {
    el.setAttribute("aria-label", first);
    el[LABELED] = true;
  } else if (el[LABELED]) {
    el.removeAttribute("aria-label");
    el[LABELED] = false;
  }
}

export function setTooltipDelay(ms: number) {
  delay = Math.max(0, ms);
}

function ensureBox(): HTMLDivElement {
  if (!box) {
    box = document.createElement("div");
    box.className = "v-tip";
    document.body.appendChild(box);
  }
  return box;
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  current = null;
  if (box) box.classList.remove("show");
}

function show(el: TipEl) {
  const text = el[TEXT];
  if (!text) return;
  const b = ensureBox();
  b.textContent = text;
  b.classList.add("show");
  // 先放到左上测量，再定位到元素下方居中；越界则翻转/夹紧
  b.style.left = "0px";
  b.style.top = "0px";
  const r = el.getBoundingClientRect();
  const w = b.offsetWidth;
  const h = b.offsetHeight;
  const margin = 6;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  let top = r.bottom + margin;
  if (top + h > window.innerHeight - margin) top = r.top - h - margin;
  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(top)}px`;
  current = el;
}

function onEnter(this: TipEl) {
  clearTimeout(timer);
  const el = this;
  timer = window.setTimeout(() => show(el), delay);
}

function onLeave() {
  hide();
}

export const vTip: Directive<TipEl, string | undefined | null> = {
  mounted(el, binding) {
    el[TEXT] = binding.value ?? "";
    syncAriaLabel(el);
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("pointerdown", onLeave);
  },
  updated(el, binding) {
    el[TEXT] = binding.value ?? "";
    syncAriaLabel(el);
    if (current === el && box?.classList.contains("show")) {
      if (el[TEXT]) box.textContent = el[TEXT];
      else hide();
    }
  },
  unmounted(el) {
    if (current === el) hide();
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("pointerdown", onLeave);
  },
};

// 窗口滚动/失焦时收起，避免悬空
window.addEventListener("scroll", hide, true);
window.addEventListener("blur", hide);
