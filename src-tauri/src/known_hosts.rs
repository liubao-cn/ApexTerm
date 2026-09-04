//! known_hosts 候选区：找出「连过（留有主机指纹）但没写进 config」的主机，
//! 并用 BatchMode 探测哪把本地密钥能免密登录。探测只执行 `exit`，不改动服务器。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::ssh_config::{display_path, HostEntry, HostKind};
use crate::tools;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// 唯一键 host:port
    pub key: String,
    pub host: String,
    pub port: u16,
    pub key_types: Vec<String>,
    pub lines: Vec<usize>,
    /// 从 shell 历史里 `user@host` 出现次数最多的用户名
    pub suggested_user: Option<String>,
    pub is_git: bool,
    pub is_private: bool,
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    /// 被服务器接受的私钥路径（~ 形式）
    pub key: Option<String>,
    pub key_type: Option<String>,
    pub message: String,
    pub duration_ms: u64,
}

struct KnownHostLine {
    host: String,
    port: u16,
    key_type: String,
    line: usize,
}

fn parse_known_hosts(path: &Path) -> Vec<KnownHostLine> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let mut hosts = parts.next().unwrap_or("");
        if hosts.starts_with('@') {
            // @cert-authority / @revoked 标记，跳过标记取下一个字段
            hosts = parts.next().unwrap_or("");
        }
        let key_type = parts.next().unwrap_or("").to_string();
        if hosts.starts_with("|1|") {
            continue; // HashKnownHosts 哈希行无法还原
        }
        for h in hosts.split(',') {
            let (host, port) = match h.strip_prefix('[') {
                Some(rest) => match rest.split_once("]:") {
                    Some((host, port)) => (host.to_string(), port.parse().unwrap_or(22)),
                    None => (rest.trim_end_matches(']').to_string(), 22),
                },
                None => (h.to_string(), 22),
            };
            if host.is_empty() {
                continue;
            }
            out.push(KnownHostLine {
                host,
                port,
                key_type: key_type.clone(),
                line: i + 1,
            });
        }
    }
    out
}

fn is_private_ip(host: &str) -> bool {
    let octets: Vec<u8> = host
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect();
    if octets.len() != 4 {
        return host == "localhost";
    }
    matches!(
        (octets[0], octets[1]),
        (10, _) | (127, _) | (192, 168) | (169, 254)
    ) || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn is_git_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    [
        "github.com",
        "gitlab.com",
        "gitee.com",
        "bitbucket.org",
        "e.coding.net",
        "codeup.aliyun.com",
        "ssh.dev.azure.com",
        "gitcode.com",
        "jihulab.com",
        "codeberg.org",
    ]
    .iter()
    .any(|g| h == *g || h.ends_with(&format!(".{g}")))
}

/// 各平台 shell 历史文件的位置（不存在的会被跳过）
fn history_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(home) = dirs::home_dir() {
        files.push(home.join(".zsh_history"));
        files.push(home.join(".bash_history"));
        files.push(home.join(".local/share/fish/fish_history"));
    }
    // Windows PowerShell（PSReadLine）历史：%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\
    if let Some(data) = dirs::data_dir() {
        files.push(data.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"));
    }
    files
}

/// 从 shell 历史里统计 `user@host` 出现次数，取最多的
fn suggested_users(hosts: &[String]) -> BTreeMap<String, String> {
    let mut counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for path in history_files() {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for host in hosts {
            let needle = format!("@{host}");
            for (idx, _) in text.match_indices(&needle) {
                let before = &text[..idx];
                let user: String = before
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                if user.is_empty() {
                    continue;
                }
                let after = &text[idx + needle.len()..];
                if after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '.') {
                    continue; // 只是更长地址的前缀
                }
                *counts
                    .entry(host.clone())
                    .or_default()
                    .entry(user)
                    .or_default() += 1;
            }
        }
    }
    counts
        .into_iter()
        .filter_map(|(host, users)| {
            users
                .into_iter()
                .max_by_key(|(_, n)| *n)
                .map(|(u, _)| (host, u))
        })
        .collect()
}

pub fn candidates(ssh_dir: &Path, hosts: &[HostEntry], ignored: &[String]) -> Vec<Candidate> {
    let mut covered: Vec<(String, Option<u16>)> = Vec::new();
    for h in hosts {
        if h.kind == HostKind::Pattern {
            continue;
        }
        covered.push((h.alias.to_ascii_lowercase(), h.port));
        if let Some(hn) = &h.host_name {
            covered.push((hn.to_ascii_lowercase(), h.port));
        }
    }
    let is_covered = |host: &str, port: u16| {
        let host = host.to_ascii_lowercase();
        covered
            .iter()
            .any(|(h, p)| *h == host && p.unwrap_or(22) == port)
    };

    let mut map: BTreeMap<(String, u16), Candidate> = BTreeMap::new();
    for l in parse_known_hosts(&ssh_dir.join("known_hosts")) {
        if is_covered(&l.host, l.port) {
            continue;
        }
        let key = format!("{}:{}", l.host, l.port);
        let c = map
            .entry((l.host.clone(), l.port))
            .or_insert_with(|| Candidate {
                key: key.clone(),
                host: l.host.clone(),
                port: l.port,
                key_types: Vec::new(),
                lines: Vec::new(),
                suggested_user: None,
                is_git: is_git_host(&l.host),
                is_private: is_private_ip(&l.host),
                ignored: ignored.contains(&key),
            });
        if !c.key_types.contains(&l.key_type) {
            c.key_types.push(l.key_type);
        }
        c.lines.push(l.line);
    }

    let host_names: Vec<String> = map.keys().map(|(h, _)| h.clone()).collect();
    let users = suggested_users(&host_names);
    let mut out: Vec<Candidate> = map.into_values().collect();
    for c in &mut out {
        c.suggested_user = users.get(&c.host).cloned();
    }
    // 公网服务器优先，Git 平台和内网地址靠后
    out.sort_by_key(|c| (c.ignored, c.is_git, c.is_private, c.host.clone()));
    out
}

/// 用 BatchMode 依次尝试给定私钥，返回被接受的那一把。只执行 `exit`。
pub fn probe(host: &str, port: u16, user: &str, keys: &[PathBuf]) -> ProbeResult {
    let started = Instant::now();
    let mut cmd = tools::command(tools::ssh());
    cmd.arg("-v")
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=8"])
        .args(["-o", "StrictHostKeyChecking=yes"])
        .args(["-o", "PreferredAuthentications=publickey"])
        .args(["-o", "NumberOfPasswordPrompts=0"])
        .args(["-o", "IdentitiesOnly=yes"])
        .args(["-o", "IdentityAgent=none"])
        .args(["-o", "ControlMaster=no"])
        .args(["-o", "LogLevel=DEBUG1"])
        .arg("-p")
        .arg(port.to_string());
    for k in keys.iter().take(6) {
        cmd.arg("-i").arg(k);
    }
    cmd.arg(format!("{user}@{host}")).arg("exit");
    cmd.stdin(std::process::Stdio::null());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return ProbeResult {
                ok: false,
                key: None,
                key_type: None,
                message: format!("无法启动 ssh: {e}"),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut accepted: Option<(String, String)> = None;
    for line in stderr.lines() {
        if let Some(rest) = line.split("Server accepts key: ").nth(1) {
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            if let Some(fp_idx) = tokens.iter().position(|t| t.starts_with("SHA256:")) {
                if fp_idx >= 2 {
                    let path = tokens[..fp_idx - 1].join(" ");
                    let ty = tokens[fp_idx - 1].to_string();
                    accepted = Some((path, ty));
                }
            }
        }
    }
    let authenticated = output.status.success() || stderr.contains("Authenticated to ");
    let duration_ms = started.elapsed().as_millis() as u64;

    if authenticated {
        let (key, key_type) = match accepted {
            Some((p, t)) => (Some(display_path(Path::new(&p))), Some(t)),
            None => (None, None),
        };
        let message = match &key {
            Some(k) => format!("免密可用，使用 {k}"),
            None => "免密可用".to_string(),
        };
        return ProbeResult {
            ok: true,
            key,
            key_type,
            message,
            duration_ms,
        };
    }

    let message = if stderr.to_ascii_lowercase().contains("permission denied") {
        format!(
            "服务器拒绝了全部 {} 把本地密钥（Permission denied）— 可能用户名不对，或该机器还没配免密",
            keys.len().min(6)
        )
    } else {
        crate::remote::classify_ssh_failure(&stderr)
    };
    ProbeResult {
        ok: false,
        key: None,
        key_type: None,
        message,
        duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_hosts_variants() {
        let dir = std::env::temp_dir().join(format!("apexterm-kh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("known_hosts"),
            "1.2.3.4 ssh-ed25519 AAAA\n1.2.3.4 ssh-rsa BBBB\n[5.6.7.8]:2222 ecdsa-sha2-nistp256 CCCC\ngithub.com,140.82.112.3 ssh-ed25519 DDDD\n|1|hash|hash ssh-rsa EEEE\n@revoked 9.9.9.9 ssh-rsa FFFF\n# comment\n\n192.168.1.10 ssh-ed25519 GGGG\n",
        )
        .unwrap();
        let lines = parse_known_hosts(&dir.join("known_hosts"));
        assert_eq!(lines.len(), 7);
        assert_eq!((lines[2].host.as_str(), lines[2].port), ("5.6.7.8", 2222));
        assert_eq!(lines[3].host, "github.com");
        assert_eq!(lines[4].host, "140.82.112.3");
        assert_eq!(lines[5].host, "9.9.9.9");

        let list = candidates(&dir, &[], &["5.6.7.8:2222".to_string()]);
        assert_eq!(list.len(), 6);
        assert_eq!(list[0].host, "1.2.3.4");
        assert_eq!(list[0].key_types, vec!["ssh-ed25519", "ssh-rsa"]);
        assert_eq!(list[0].lines, vec![1, 2]);
        assert!(list.iter().find(|c| c.host == "github.com").unwrap().is_git);
        assert!(list.iter().find(|c| c.host == "192.168.1.10").unwrap().is_private);
        let ignored = list.iter().find(|c| c.host == "5.6.7.8").unwrap();
        assert!(ignored.ignored && ignored.port == 2222);
        assert_eq!(list.last().unwrap().host, "5.6.7.8");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn private_ip_detection() {
        assert!(is_private_ip("192.168.0.1"));
        assert!(is_private_ip("10.1.2.3"));
        assert!(is_private_ip("172.16.0.1"));
        assert!(!is_private_ip("172.32.0.1"));
        assert!(!is_private_ip("43.153.107.95"));
        assert!(!is_private_ip("github.com"));
    }
}
