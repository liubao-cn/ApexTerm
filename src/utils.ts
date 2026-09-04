export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

export interface ParsedSsh {
  hostName: string;
  user: string | null;
  port: number | null;
  identityFiles: string[];
  proxyJump: string | null;
}

/** 解析形如 `ssh -p 2222 -i ~/.ssh/k -J bastion root@1.2.3.4` 的命令 */
export function parseSshCommand(cmd: string): ParsedSsh | null {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0] === "ssh") tokens.shift();
  const out: ParsedSsh = {
    hostName: "",
    user: null,
    port: null,
    identityFiles: [],
    proxyJump: null,
  };
  const withArg = new Set(["-p", "-i", "-J", "-l", "-o", "-F", "-L", "-R", "-D", "-W", "-b", "-c", "-e", "-m", "-I", "-w", "-E", "-B", "-Q", "-S"]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-") && t.length > 1) {
      const flag = t.slice(0, 2);
      const inline = t.length > 2 ? t.slice(2) : null;
      const value = withArg.has(flag) ? (inline ?? tokens[++i]) : null;
      if (value === undefined) break;
      if (flag === "-p" && value) out.port = Number(value) || null;
      if (flag === "-i" && value) out.identityFiles.push(value);
      if (flag === "-J" && value) out.proxyJump = value;
      if (flag === "-l" && value) out.user = value;
      continue;
    }
    if (!out.hostName) {
      const target = t.replace(/^ssh:\/\//, "");
      const at = target.lastIndexOf("@");
      if (at >= 0) {
        out.user = target.slice(0, at);
        out.hostName = target.slice(at + 1);
      } else {
        out.hostName = target;
      }
      const portMatch = out.hostName.match(/^(.+):(\d+)$/);
      if (portMatch && !out.hostName.includes("]")) {
        out.hostName = portMatch[1];
        out.port = Number(portMatch[2]);
      }
    }
  }
  return out.hostName ? out : null;
}

export function suggestAlias(hostName: string, user: string | null): string {
  const base = hostName.replace(/[^a-zA-Z0-9.-]/g, "-").replace(/^-+|-+$/g, "");
  if (/^\d+(\.\d+){3}$/.test(hostName)) {
    return `${user ?? "srv"}-${hostName.split(".").slice(-2).join("-")}`;
  }
  return base.split(".")[0] || "server";
}
