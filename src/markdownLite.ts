/**
 * 极简 Markdown 解析：给更新说明这类短文本用（标题、无序/有序列表、段落；行内 code / 粗体 / 斜体 / 链接）。
 * 只产出结构化数据，由组件用 Vue 节点渲染，不走 v-html，天然无注入风险。
 */
export type Inline =
  | { t: "text" | "code" | "strong" | "em"; s: string }
  | { t: "link"; s: string; href: string };

export type Block =
  | { t: "h"; level: number; inline: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "p"; inline: Inline[] };

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", s: s.slice(last, at) });
    if (m[1]) out.push({ t: "code", s: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: "strong", s: tok.slice(2, -2) });
    else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push({ t: "link", s: lm[1], href: lm[2] });
    } else out.push({ t: "em", s: tok.slice(1, -1) });
    last = at + tok.length;
  }
  if (last < s.length) out.push({ t: "text", s: s.slice(last) });
  return out;
}

export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inline: parseInline(para.join(" ")) });
    para = [];
  };
  const pushItem = (kind: "ul" | "ol", text: string) => {
    flush();
    const last = blocks[blocks.length - 1];
    if (last?.t === kind) last.items.push(parseInline(text));
    else blocks.push({ t: kind, items: [parseInline(text)] });
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line)) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1].length, inline: parseInline(h[2]) });
      continue;
    }
    const li = /^[-*+]\s+(.+)$/.exec(line);
    if (li) {
      pushItem("ul", li[1]);
      continue;
    }
    const oi = /^\d+[.)]\s+(.+)$/.exec(line);
    if (oi) {
      pushItem("ol", oi[1]);
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}
