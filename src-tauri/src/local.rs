//! 本机控制台：在本地 shell 里执行命令、读最近命令历史、系统概况。

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Disks, Networks, System};

use crate::error::{AppError, Result};
use crate::remote::{read_capped, RunResult};
use crate::tools;

/// 本地登录 shell 及其"执行一条命令"的参数
fn shell_command(command: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        let mut c = tools::command("powershell.exe");
        c.args(["-NoLogo", "-NoProfile", "-Command", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let mut c = tools::command(shell);
        // -l 让 PATH 等按登录 shell 初始化（Homebrew、nvm 之类才找得到）
        c.args(["-lc", command]);
        c
    }
}

/// 在本机执行一条命令（带超时、输出截断），行为与远端 run 对齐
pub fn run(command: &str, cwd: Option<&str>, timeout: Duration) -> Result<RunResult> {
    if command.trim().is_empty() {
        return Err(AppError::msg("命令不能为空"));
    }
    let started = Instant::now();
    let mut cmd = shell_command(command);
    let dir = cwd
        .map(crate::ssh_config::expand_tilde)
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("无法启动本地 shell: {e}")))?;
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
    Ok(RunResult {
        ok: !timed_out && status.map(|s| s.success()).unwrap_or(false),
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
        truncated: t1 || t2,
    })
}

/// 最近用过的命令：读 zsh / bash / PowerShell 历史，去重、去掉太短的，最新在前
pub fn recent_commands(limit: usize) -> Vec<String> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let mut files: Vec<PathBuf> = vec![home.join(".zsh_history"), home.join(".bash_history")];
    if let Ok(appdata) = std::env::var("APPDATA") {
        files.push(PathBuf::from(appdata).join(r"Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"));
    }
    let mut lines: Vec<String> = Vec::new();
    for f in files {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            // zsh 扩展格式：": 1700000000:0;cmd"
            let cmd = match line.strip_prefix(": ") {
                Some(rest) => rest.split_once(';').map(|(_, c)| c).unwrap_or(rest),
                None => line,
            };
            let cmd = cmd.trim();
            if cmd.len() < 3 || cmd.starts_with('#') {
                continue;
            }
            lines.push(cmd.to_string());
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for cmd in lines.into_iter().rev() {
        if seen.insert(cmd.clone()) {
            out.push(cmd);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub total: u64,
    pub free: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub hostname: String,
    pub user: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub shell: String,
    pub uptime_secs: u64,
    pub cpu_count: usize,
    pub cpu_brand: String,
    pub mem_total: u64,
    pub mem_used: u64,
    pub disks: Vec<DiskInfo>,
    pub ips: Vec<String>,
    pub home: String,
}

pub fn summary() -> Summary {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let disks = Disks::new_with_refreshed_list();
    let networks = Networks::new_with_refreshed_list();

    let mut ips: Vec<String> = Vec::new();
    for (name, data) in networks.iter() {
        if name.starts_with("lo") || name.starts_with("utun") || name.starts_with("awdl") || name.starts_with("llw") {
            continue;
        }
        for ip in data.ip_networks() {
            if ip.addr.is_ipv4() && !ip.addr.is_loopback() {
                ips.push(format!("{} {}", name, ip.addr));
            }
        }
    }
    ips.sort();

    let mut seen_mounts = HashSet::new();
    let disk_list: Vec<DiskInfo> = disks
        .iter()
        .filter(|d| {
            let m = d.mount_point().to_string_lossy().to_string();
            // 只保留真正的用户卷，去掉系统只读快照、恢复分区等
            let keep = m == "/" || m.starts_with("/System/Volumes/Data") || m.starts_with("/Volumes/") || m.len() <= 3;
            keep && !m.contains("/Volumes/Recovery") && seen_mounts.insert(m)
        })
        .map(|d| DiskInfo {
            mount: d.mount_point().to_string_lossy().to_string(),
            total: d.total_space(),
            free: d.available_space(),
        })
        .collect();

    Summary {
        hostname: System::host_name().unwrap_or_default(),
        user: std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default(),
        os: format!(
            "{} {}",
            System::name().unwrap_or_default(),
            System::os_version().unwrap_or_default()
        )
        .trim()
        .to_string(),
        kernel: System::kernel_version().unwrap_or_default(),
        arch: System::cpu_arch(),
        shell: std::env::var("SHELL").unwrap_or_else(|_| if cfg!(windows) { "powershell".into() } else { "sh".into() }),
        uptime_secs: System::uptime(),
        cpu_count: sys.cpus().len(),
        cpu_brand: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        mem_total: sys.total_memory(),
        mem_used: sys.used_memory(),
        disks: disk_list,
        ips,
        home: dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_local_echo() {
        let r = run("echo hello", None, Duration::from_secs(10)).unwrap();
        assert!(r.ok);
        assert!(r.stdout.contains("hello"));
        assert!(run("   ", None, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn summary_has_basics() {
        let s = summary();
        assert!(s.cpu_count >= 1);
        assert!(s.mem_total > 0);
        assert!(!s.home.is_empty());
    }

    #[test]
    fn recent_commands_dedupes() {
        let list = recent_commands(20);
        let set: HashSet<_> = list.iter().collect();
        assert_eq!(set.len(), list.len());
        assert!(list.len() <= 20);
    }
}
