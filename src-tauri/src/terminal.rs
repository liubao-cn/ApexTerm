//! 内嵌终端：在伪终端里驱动系统 `/usr/bin/ssh`（或本地 shell），
//! 输出以 base64 分片通过 Tauri Channel 推给前端 xterm.js，按键原样写回 pty。
//! 不自己实现 SSH 协议，所以 ~/.ssh/config 里的所有选项与终端里敲 `ssh 别名` 完全一致。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::tools;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalTarget {
    /// `ssh <alias>`，alias 必须是 config 里的 Host 别名。
    /// 带 command 时先执行该命令，结束后接着进入远端登录 shell，标签仍可继续使用。
    Ssh {
        alias: String,
        #[serde(default)]
        command: Option<String>,
    },
    /// 本地登录 shell，可指定起始目录
    Local {
        #[serde(default)]
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermMessage {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[derive(Default)]
pub struct TerminalState {
    sessions: Sessions,
    seq: AtomicU64,
}

/// GUI 进程通常没有 LANG，缺了会让远端 shell 的中文乱码。
/// 优先沿用环境里的；macOS 上按系统区域推一个 UTF-8 locale；其它平台回退 en_US.UTF-8。
#[cfg_attr(windows, allow(dead_code))]
fn preferred_lang() -> String {
    if let Ok(lang) = std::env::var("LANG") {
        if lang.to_ascii_lowercase().contains("utf") {
            return lang;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let locale = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLocale"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let base = locale.split('@').next().unwrap_or("").trim();
        if base.len() >= 5 && base.contains('_') {
            return format!("{base}.UTF-8");
        }
    }
    "en_US.UTF-8".to_string()
}

/// 从 Finder/launchd 启动时 SSH_AUTH_SOCK 可能不在环境里，带口令的密钥会用不了 agent
#[cfg_attr(windows, allow(dead_code))]
fn ssh_auth_sock() -> Option<String> {
    if let Ok(v) = std::env::var("SSH_AUTH_SOCK") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("/bin/launchctl")
            .args(["getenv", "SSH_AUTH_SOCK"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
    }
    #[allow(unreachable_code)]
    None
}

/// 本地终端用的 shell：类 Unix 取 $SHELL 登录 shell，Windows 用 PowerShell
fn local_shell() -> (String, Vec<&'static str>) {
    #[cfg(windows)]
    {
        let pwsh = std::env::var("ProgramFiles")
            .map(|p| format!(r"{p}\PowerShell\7\pwsh.exe"))
            .unwrap_or_default();
        if std::path::Path::new(&pwsh).is_file() {
            return (pwsh, vec!["-NoLogo"]);
        }
        return ("powershell.exe".to_string(), vec!["-NoLogo"]);
    }
    #[allow(unreachable_code)]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        (shell, vec!["-l"])
    }
}

fn build_command(target: &TerminalTarget, term_type: &str) -> Result<CommandBuilder> {
    let home = dirs::home_dir().ok_or_else(|| AppError::msg("无法定位用户主目录"))?;
    let mut cmd = match target {
        TerminalTarget::Ssh { alias, command } => {
            let alias = alias.trim();
            if alias.is_empty() || alias.starts_with('-') || alias.contains(char::is_whitespace) {
                return Err(AppError::msg("非法的主机别名"));
            }
            let mut c = CommandBuilder::new(tools::ssh());
            match command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(remote) => {
                    // -t 强制分配 tty，命令跑完 exec 进登录 shell；$SHELL 在远端展开
                    c.arg("-t");
                    c.arg("--");
                    c.arg(alias);
                    c.arg(format!("{remote}; exec \"${{SHELL:-/bin/sh}}\" -l"));
                }
                None => {
                    c.arg("--");
                    c.arg(alias);
                }
            }
            c
        }
        TerminalTarget::Local { .. } => {
            let (shell, args) = local_shell();
            let mut c = CommandBuilder::new(shell);
            for a in args {
                c.arg(a);
            }
            c
        }
    };
    // 本地终端可指定起始目录（不存在则回退到家目录）
    let start_dir = match target {
        TerminalTarget::Local { cwd: Some(d) } => {
            let p = crate::ssh_config::expand_tilde(d);
            if p.is_dir() { p } else { home.clone() }
        }
        _ => home.clone(),
    };
    cmd.cwd(&start_dir);
    // 只允许常见的 TERM 值，防止奇怪字符串进环境变量
    let term_type = if term_type.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && !term_type.is_empty() {
        term_type
    } else {
        "xterm-256color"
    };
    cmd.env("TERM", term_type);
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ApexTerm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // xterm.js 原生支持 OSC 8 超链接，但 CLI 工具只认名单里的终端；这个变量是 supports-hyperlinks
    // （Node / Rust 两个生态）约定的强制开关，让 Claude Code 之类的工具直接发可点击链接而不是把 URL 打印出来
    cmd.env("FORCE_HYPERLINK", "1");
    #[cfg(not(windows))]
    {
        cmd.env("LANG", preferred_lang());
        if let Some(sock) = ssh_auth_sock() {
            cmd.env("SSH_AUTH_SOCK", sock);
        }
        // 从 Finder 启动时 PATH 只有系统目录，补上 Homebrew / local
        if std::env::var("PATH").map(|p| !p.contains("/usr/local/bin")).unwrap_or(true) {
            cmd.env(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            );
        }
    }
    Ok(cmd)
}

impl TerminalState {
    pub fn open(
        &self,
        target: &TerminalTarget,
        cols: u16,
        rows: u16,
        term_type: &str,
        channel: Channel<TermMessage>,
    ) -> Result<String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::msg(format!("创建伪终端失败: {e}")))?;
        let cmd = build_command(target, term_type)?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::msg(format!("启动进程失败: {e}")))?;
        // 子进程已持有 slave，父进程这边必须放掉，否则子进程退出后读端拿不到 EOF
        drop(pair.slave);

        let id = format!("t{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::msg(format!("读取伪终端失败: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::msg(format!("写入伪终端失败: {e}")))?;
        let killer = child.clone_killer();

        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                writer,
                master: pair.master,
                killer,
            },
        );

        let ch = channel.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            if ch.send(TermMessage::Data { data }).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| AppError::msg(format!("创建读取线程失败: {e}")))?;

        let sessions = self.sessions.clone();
        let sid = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                sessions.lock().unwrap().remove(&sid);
                let _ = channel.send(TermMessage::Exit { code });
            })
            .map_err(|e| AppError::msg(format!("创建等待线程失败: {e}")))?;

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get_mut(id)
            .ok_or_else(|| AppError::msg("会话已结束"))?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(id)
            .ok_or_else(|| AppError::msg("会话已结束"))?;
        s.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::msg(format!("调整终端尺寸失败: {e}")))
    }

    /// 结束会话：先杀子进程，等待线程随后会清理并发出 Exit
    pub fn close(&self, id: &str) -> Result<()> {
        let killer = self
            .sessions
            .lock()
            .unwrap()
            .get_mut(id)
            .map(|s| s.killer.clone_killer());
        if let Some(mut k) = killer {
            let _ = k.kill();
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_lang_is_utf8() {
        assert!(preferred_lang().to_ascii_lowercase().contains("utf-8"));
        let _ = ssh_auth_sock();
        assert!(!local_shell().0.is_empty());
    }

    fn ssh(alias: &str, command: Option<&str>) -> TerminalTarget {
        TerminalTarget::Ssh {
            alias: alias.into(),
            command: command.map(String::from),
        }
    }

    #[test]
    fn rejects_bad_alias() {
        assert!(build_command(&ssh("-oProxyCommand=x", None), "xterm-256color").is_err());
        assert!(build_command(&ssh("a b", None), "xterm-256color").is_err());
        assert!(build_command(&ssh("", None), "xterm-256color").is_err());
        assert!(build_command(&ssh("prod-web", None), "xterm-256color").is_ok());
        assert!(build_command(&TerminalTarget::Local { cwd: None }, "xterm-256color").is_ok());
    }

    #[test]
    fn initial_command_is_wrapped_with_login_shell() {
        let cmd = build_command(&ssh("prod", Some("df -h")), "xterm-256color").unwrap();
        let args: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[1..], ["-t", "--", "prod", "df -h; exec \"${SHELL:-/bin/sh}\" -l"]);
        let plain = build_command(&ssh("prod", Some("  ")), "xterm-256color").unwrap();
        assert_eq!(plain.get_argv().len(), 3);
    }
}
