import { createApp } from "vue";
import { createPinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.vue";
import { isMac, isWindows } from "./platform";
import { vTip } from "./tooltip";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

document.documentElement.classList.toggle("mac", isMac);
document.documentElement.classList.toggle("windows", isWindows);

/** 未捕获的前端错误：控制台 + 转发到 Rust 日志（tauri dev 的终端输出里能直接看到） */
function report(err: unknown, info?: string) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(e, info ?? "");
  invoke("log_frontend_error", { message: e.message, stack: e.stack ?? null, info: info ?? null }).catch(() => {});
}

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => report(err, info);
window.addEventListener("error", (e) => report(e.error ?? e.message, "window.onerror"));
window.addEventListener("unhandledrejection", (e) => report(e.reason, "unhandledrejection"));

app.use(createPinia()).directive("tip", vTip).mount("#app");
