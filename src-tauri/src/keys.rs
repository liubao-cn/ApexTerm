//! 扫描 ~/.ssh 下的密钥。只读 .pub 文件（通过 ssh-keygen -lf 取指纹），绝不读取私钥内容。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ssh_config::{display_path, expand_tilde, HostEntry};
use crate::tools;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// 私钥路径（~ 形式）
    pub path: String,
    pub public_path: Option<String>,
    pub has_private: bool,
    pub algorithm: String,
    pub bits: u32,
    pub fingerprint: String,
    pub comment: String,
    /// 使用该密钥的主机 id
    pub used_by: Vec<String>,
}

/// 解析 `ssh-keygen -lf` 输出：`256 SHA256:xxxx comment (ED25519)`
fn fingerprint(pub_path: &Path) -> Option<(u32, String, String, String)> {
    let out = tools::command(tools::ssh_keygen())
        .arg("-lf")
        .arg(pub_path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut parts = text.splitn(3, ' ');
    let bits = parts.next()?.parse().ok()?;
    let fp = parts.next()?.to_string();
    let rest = parts.next().unwrap_or("").trim();
    let (comment, algo) = match rest.rfind(" (") {
        Some(i) if rest.ends_with(')') => (rest[..i].trim(), rest[i + 2..rest.len() - 1].to_string()),
        _ => (rest, String::new()),
    };
    let comment = if comment == "no comment" { "" } else { comment };
    Some((bits, fp, comment.to_string(), algo))
}

pub fn list_keys(ssh_dir: &Path, hosts: &[HostEntry]) -> Vec<KeyInfo> {
    let mut keys: BTreeMap<PathBuf, KeyInfo> = BTreeMap::new();

    if let Ok(rd) = std::fs::read_dir(ssh_dir) {
        let mut pubs: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "pub").unwrap_or(false) && p.is_file())
            .collect();
        pubs.sort();
        for pub_path in pubs {
            let private = pub_path.with_extension("");
            let (bits, fp, comment, algo) = fingerprint(&pub_path).unwrap_or_default();
            keys.insert(
                private.clone(),
                KeyInfo {
                    path: display_path(&private),
                    public_path: Some(display_path(&pub_path)),
                    has_private: private.is_file(),
                    algorithm: algo,
                    bits,
                    fingerprint: fp,
                    comment,
                    used_by: Vec::new(),
                },
            );
        }
    }

    for h in hosts {
        for f in &h.identity_files {
            let p = expand_tilde(f);
            let p = if p.is_absolute() { p } else { ssh_dir.join(p) };
            let entry = keys.entry(p.clone()).or_insert_with(|| KeyInfo {
                path: display_path(&p),
                public_path: None,
                has_private: p.is_file(),
                algorithm: String::new(),
                bits: 0,
                fingerprint: String::new(),
                comment: String::new(),
                used_by: Vec::new(),
            });
            if !entry.used_by.contains(&h.id) {
                entry.used_by.push(h.id.clone());
            }
        }
    }

    keys.into_values().collect()
}
