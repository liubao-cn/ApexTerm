//! 外部命令定位与启动（跨平台差异集中在这里）。
//!
//! - macOS / Linux：系统 OpenSSH 在 /usr/bin
//! - Windows 10 1809+：自带 OpenSSH 在 System32\OpenSSH，配置同样在 %USERPROFILE%\.ssh
//! - Windows 上从 GUI 进程启动控制台程序必须加 CREATE_NO_WINDOW，否则会闪出黑窗口

use std::path::PathBuf;
use std::process::Command;

fn locate(name: &str) -> PathBuf {
    #[cfg(windows)]
    let candidates: Vec<PathBuf> = {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        vec![
            PathBuf::from(format!(r"{sys}\System32\OpenSSH\{name}.exe")),
            PathBuf::from(format!(r"C:\Program Files\Git\usr\bin\{name}.exe")),
        ]
    };
    #[cfg(not(windows))]
    let candidates: Vec<PathBuf> = vec![
        PathBuf::from(format!("/usr/bin/{name}")),
        PathBuf::from(format!("/usr/local/bin/{name}")),
        PathBuf::from(format!("/opt/homebrew/bin/{name}")),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn ssh() -> PathBuf {
    locate("ssh")
}

pub fn ssh_keygen() -> PathBuf {
    locate("ssh-keygen")
}

/// 构造子进程命令；Windows 上隐藏控制台窗口
pub fn command(program: impl Into<PathBuf>) -> Command {
    let cmd = Command::new(program.into());
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = cmd;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_is_found_or_falls_back_to_path() {
        let p = ssh();
        assert!(p.is_file() || p == PathBuf::from("ssh"));
        let k = ssh_keygen();
        assert!(k.is_file() || k == PathBuf::from("ssh-keygen"));
    }
}
