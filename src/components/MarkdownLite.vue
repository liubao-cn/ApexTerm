<script lang="ts">
import { defineComponent, h, type VNodeChild } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseBlocks, type Inline } from "../markdownLite";

/** 渲染短 Markdown（更新说明等）。链接只放行 http(s)，用系统浏览器打开。 */
export default defineComponent({
  name: "MarkdownLite",
  props: { source: { type: String, required: true } },
  setup(props) {
    const inline = (parts: Inline[]): VNodeChild[] =>
      parts.map((p) => {
        switch (p.t) {
          case "code":
            return h("code", { class: "md-code" }, p.s);
          case "strong":
            return h("strong", p.s);
          case "em":
            return h("em", p.s);
          case "link":
            return /^https?:\/\//i.test(p.href)
              ? h(
                  "a",
                  { class: "md-link", href: p.href, onClick: (e: MouseEvent) => (e.preventDefault(), openUrl(p.href).catch(() => {})) },
                  p.s,
                )
              : p.s;
          default:
            return p.s;
        }
      });
    return () =>
      h(
        "div",
        { class: "md" },
        parseBlocks(props.source).map((b) => {
          if (b.t === "h") return h("div", { class: ["md-h", `md-h${Math.min(b.level, 4)}`] }, inline(b.inline));
          if (b.t === "p") return h("p", { class: "md-p" }, inline(b.inline));
          return h(
            b.t,
            { class: "md-list" },
            b.items.map((item) => h("li", inline(item))),
          );
        }),
      );
  },
});
</script>

<style scoped>
.md {
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
}

.md-h {
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 4px;
}

.md-h1 {
  font-size: 15px;
}

.md-h2 {
  font-size: 14px;
}

.md-h3,
.md-h4 {
  font-size: 12.5px;
  color: var(--text-2);
}

.md > * + .md-h {
  margin-top: 12px;
}

.md-p {
  margin: 0;
}

.md > * + .md-p {
  margin-top: 6px;
}

.md-list {
  margin: 0;
  padding-left: 18px;
}

.md-list li + li {
  margin-top: 3px;
}

.md-code {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover-3);
}

.md-link {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: default;
}
</style>
