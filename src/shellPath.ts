import { isWindows } from "./platform";

/** 不需要引号就能安全出现在 shell 里的字符（Windows 允许反斜杠） */
const SAFE = isWindows ? /^[A-Za-z0-9_\-./\\:+@%]+$/ : /^[A-Za-z0-9_\-./:+@%]+$/;

/** 本地终端用：mac / Linux 按 POSIX 单引号，Windows（PowerShell）单引号内 ' 写成 '' */
export function quotePath(p: string): string {
  if (SAFE.test(p)) return p;
  return isWindows ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function pathsForShell(paths: string[]): string {
  return paths.map(quotePath).join(" ");
}
