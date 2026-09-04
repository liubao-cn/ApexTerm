//! 静默远程执行：`ssh -o BatchMode=yes <alias> '<command>'`，捕获输出、带超时。
//! 用于快捷命令的后台模式、批量执行和重启后的存活探测。

use std::io::Read;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::tools;

/// 单次输出最多保留 1 MiB，避免 `cat 大文件` 把前端拖死
const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub truncated: bool,
}

pub fn validate_alias(alias: &str) -> Result<()> {
    if alias.is_empty() || alias.starts_with('-') || alias.contains(char::is_whitespace) {
        return Err(AppError::msg("非法的主机别名"));
    }
    Ok(())
}

pub fn read_capped(mut r: impl Read) -> (String, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < MAX_OUTPUT {
                    let take = n.min(MAX_OUTPUT - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

/// 在远端执行一条命令。命令原样交给远端登录 shell 解释（和在终端里敲一样）。
pub fn run(alias: &str, command: &str, timeout: Duration) -> Result<RunResult> {
    validate_alias(alias)?;
    if command.trim().is_empty() {
        return Err(AppError::msg("命令不能为空"));
    }
    let started = Instant::now();
    let mut child = tools::command(tools::ssh())
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=10"])
        .args(["-o", "LogLevel=ERROR"])
        .arg("--")
        .arg(alias)
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("无法启动 ssh: {e}")))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let out_thread = thread::spawn(move || read_capped(stdout));
    let err_thread = thread::spawn(move || read_capped(stderr));

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok();
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    let (stdout, t1) = out_thread.join().unwrap_or_default();
    let (stderr, t2) = err_thread.join().unwrap_or_default();
    let code = status.and_then(|s| s.code());
    Ok(RunResult {
        ok: !timed_out && status.map(|s| s.success()).unwrap_or(false),
        code,
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
        truncated: t1 || t2,
    })
}

/// 把 ssh 的 stderr 归纳成一句人能看懂的失败原因
pub fn classify_ssh_failure(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("permission denied") {
        "服务器拒绝了密钥（Permission denied）— 免密可能已失效，或用户名不对".to_string()
    } else if lower.contains("timed out") {
        "连接超时（主机不在线或网络不通）".to_string()
    } else if lower.contains("connection refused") {
        "连接被拒绝（端口未开放 / sshd 未运行）".to_string()
    } else if lower.contains("host key verification failed") || lower.contains("host key has changed") {
        "主机指纹校验失败（known_hosts 里的指纹与服务器不一致）".to_string()
    } else if lower.contains("could not resolve") {
        "域名无法解析".to_string()
    } else if lower.contains("no route to host") || lower.contains("network is unreachable") {
        "网络不可达".to_string()
    } else if lower.contains("connection reset") || lower.contains("connection closed") {
        "连接被服务器直接断开（可能被 fail2ban / 防火墙拦截）".to_string()
    } else if lower.contains("incorrect passphrase") || lower.contains("passphrase") {
        "密钥带口令，BatchMode 下无法解锁（先 ssh-add）".to_string()
    } else if lower.contains("too many authentication failures") {
        "尝试次数超过服务器上限（MaxAuthTries）".to_string()
    } else if lower.contains("no such file or directory") && lower.contains("identity") {
        "config 里指定的密钥文件不存在".to_string()
    } else {
        stderr
            .lines()
            .filter(|l| !l.starts_with("debug") && !l.trim().is_empty())
            .last()
            .unwrap_or("未知错误")
            .to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliveResult {
    pub ok: bool,
    pub message: String,
    pub duration_ms: u64,
}

/// 按 config 别名探测：能免密登录并执行 `exit` 即在线；失败给出原因
pub fn probe_alias(alias: &str) -> Result<AliveResult> {
    validate_alias(alias)?;
    let started = Instant::now();
    let output = tools::command(tools::ssh())
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=8"])
        .args(["-o", "NumberOfPasswordPrompts=0"])
        .args(["-o", "LogLevel=ERROR"])
        .arg("--")
        .arg(alias)
        .arg("exit")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::msg(format!("无法启动 ssh: {e}")))?;
    let duration_ms = started.elapsed().as_millis() as u64;
    if output.status.success() {
        return Ok(AliveResult {
            ok: true,
            message: format!("在线，免密可用（{duration_ms} ms）"),
            duration_ms,
        });
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(AliveResult {
        ok: false,
        message: classify_ssh_failure(&stderr),
        duration_ms,
    })
}

/// 存活探测：能免密登录并执行 `true` 即视为在线
pub fn is_alive(alias: &str) -> Result<bool> {
    validate_alias(alias)?;
    let status = tools::command(tools::ssh())
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=5"])
        .args(["-o", "LogLevel=ERROR"])
        .arg("--")
        .arg(alias)
        .arg("true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| AppError::msg(format!("无法启动 ssh: {e}")))?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_validation() {
        assert!(validate_alias("prod").is_ok());
        assert!(validate_alias("-oProxyCommand=x").is_err());
        assert!(validate_alias("a b").is_err());
        assert!(validate_alias("").is_err());
        assert!(run("prod", "   ", Duration::from_secs(1)).is_err());
    }

    #[test]
    fn failure_classification() {
        assert!(classify_ssh_failure("root@1.2.3.4: Permission denied (publickey).").contains("Permission denied"));
        assert!(classify_ssh_failure("ssh: connect to host 1.2.3.4 port 22: Operation timed out").contains("超时"));
        assert!(classify_ssh_failure("ssh: connect to host x port 22: Connection refused").contains("拒绝"));
        assert!(classify_ssh_failure("Connection closed by 1.2.3.4 port 22").contains("断开"));
        assert!(classify_ssh_failure("ssh: Could not resolve hostname foo: nodename nor servname provided").contains("解析"));
        assert_eq!(classify_ssh_failure("debug1: x\nsomething odd\n"), "something odd");
        assert_eq!(classify_ssh_failure(""), "未知错误");
    }

    #[test]
    fn read_capped_truncates() {
        let big = vec![b'x'; MAX_OUTPUT + 10];
        let (s, truncated) = read_capped(&big[..]);
        assert_eq!(s.len(), MAX_OUTPUT);
        assert!(truncated);
        let (s, truncated) = read_capped(&b"hello"[..]);
        assert_eq!(s, "hello");
        assert!(!truncated);
    }
}
