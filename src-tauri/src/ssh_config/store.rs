//! 读取 `~/.ssh/config`（含 Include）、生成前端用的 HostEntry、带备份的安全写回。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::document::{unquote, BlockKind, Document};
use crate::error::{AppError, Result};

const GIT_HOSTS: &[&str] = &[
    "github.com",
    "gitlab.com",
    "gitee.com",
    "bitbucket.org",
    "e.coding.net",
    "codeup.aliyun.com",
    "ssh.dev.azure.com",
    "vs-ssh.visualstudio.com",
    "git.code.tencent.com",
    "gitcode.com",
    "gitcode.net",
    "jihulab.com",
    "atomgit.com",
    "codeberg.org",
    "git.sr.ht",
    "huggingface.co",
    "source.developers.google.com",
];

const KNOWN_KEYS: &[&str] = &["hostname", "user", "port", "identityfile", "proxyjump"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKind {
    Server,
    GitPlatform,
    Pattern,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub id: String,
    pub alias: String,
    pub patterns: Vec<String>,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub identities_only: bool,
    pub proxy_jump: Option<String>,
    pub extra: Vec<KeyValue>,
    pub description: Option<String>,
    pub kind: HostKind,
    pub source_file: String,
    pub line: usize,
    pub raw: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    /// 编辑时传原 id；新增时为空
    pub original_id: Option<String>,
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_files: Vec<String>,
    #[serde(default)]
    pub identities_only: bool,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub description: String,
}

/// `~/x` 或 `~\x` 展开为家目录；Windows OpenSSH 同样接受 `~/.ssh/id_rsa` 写法
pub fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    let rest = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"));
    if let Some(rest) = rest {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// 家目录前缀缩写成 `~`，分隔符统一显示为 `/`
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    match dirs::home_dir() {
        Some(h) => {
            let home = h.to_string_lossy().replace('\\', "/");
            match s.strip_prefix(home.as_str()) {
                Some(rest) if rest.starts_with('/') => format!("~{rest}"),
                _ => s,
            }
        }
        None => s,
    }
}

fn is_pattern(patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|p| p.contains('*') || p.contains('?') || p.starts_with('!'))
}

fn is_git_platform(alias: &str, user: Option<&str>, host_name: Option<&str>) -> bool {
    if user == Some("git") {
        return true;
    }
    let candidates = [Some(alias), host_name];
    candidates.iter().flatten().any(|h| {
        let h = h.to_ascii_lowercase();
        GIT_HOSTS
            .iter()
            .any(|g| h == *g || h.ends_with(&format!(".{g}")))
    })
}

fn validate_alias(alias: &str) -> Result<()> {
    if alias.is_empty() {
        return Err(AppError::msg("别名不能为空"));
    }
    if alias.contains(char::is_whitespace) {
        return Err(AppError::msg("别名不能包含空格"));
    }
    if alias.contains(['*', '?', '!', '#', '"']) {
        return Err(AppError::msg("别名不能包含 * ? ! # \" 等字符"));
    }
    Ok(())
}

pub struct ConfigStore {
    pub docs: Vec<Document>,
}

impl ConfigStore {
    pub fn load(ssh_dir: PathBuf) -> Result<Self> {
        let main_path = ssh_dir.join("config");
        let mut docs = Vec::new();
        let mut visited = HashSet::new();
        Self::load_file(&ssh_dir, &main_path, &mut docs, &mut visited, 0)?;
        Ok(Self { docs })
    }

    fn load_file(
        ssh_dir: &Path,
        path: &Path,
        docs: &mut Vec<Document>,
        visited: &mut HashSet<PathBuf>,
        depth: usize,
    ) -> Result<()> {
        if depth > 8 || !visited.insert(path.to_path_buf()) {
            return Ok(());
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && depth == 0 => String::new(),
            Err(e) => return Err(e.into()),
        };
        let doc = Document::parse(path, &content);
        let includes: Vec<String> = doc
            .globals
            .iter()
            .filter(|d| d.key_is("Include"))
            .flat_map(|d| d.value.split_whitespace().map(unquote).collect::<Vec<_>>())
            .collect();
        docs.push(doc);
        for pat in includes {
            for p in expand_include(ssh_dir, &pat) {
                Self::load_file(ssh_dir, &p, docs, visited, depth + 1)?;
            }
        }
        Ok(())
    }

    pub fn main_doc(&self) -> &Document {
        &self.docs[0]
    }

    pub fn files(&self) -> Vec<String> {
        self.docs.iter().map(|d| display_path(&d.path)).collect()
    }

    /// (doc_idx, block_idx, id) 三元组，id 对重复别名做去重后缀
    fn locate_all(&self) -> Vec<(usize, usize, String)> {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut out = Vec::new();
        for (di, doc) in self.docs.iter().enumerate() {
            for (bi, b) in doc.blocks.iter().enumerate() {
                if b.kind != BlockKind::Host {
                    continue;
                }
                let alias = b.patterns.first().cloned().unwrap_or_default();
                let n = seen.entry(alias.clone()).or_insert(0);
                *n += 1;
                let id = if *n == 1 {
                    alias
                } else {
                    format!("{alias}#{n}")
                };
                out.push((di, bi, id));
            }
        }
        out
    }

    pub fn locate(&self, id: &str) -> Result<(usize, usize)> {
        self.locate_all()
            .into_iter()
            .find(|(_, _, x)| x == id)
            .map(|(d, b, _)| (d, b))
            .ok_or_else(|| AppError::msg(format!("找不到主机 {id}")))
    }

    pub fn hosts(&self) -> Vec<HostEntry> {
        self.locate_all()
            .into_iter()
            .map(|(di, bi, id)| self.entry(di, bi, id))
            .collect()
    }

    fn entry(&self, di: usize, bi: usize, id: String) -> HostEntry {
        let doc = &self.docs[di];
        let b = &doc.blocks[bi];
        let first = |key: &str| {
            b.directives
                .iter()
                .find(|d| d.key_is(key))
                .map(|d| d.unquoted())
        };
        let alias = b.patterns.first().cloned().unwrap_or_default();
        let host_name = first("HostName");
        let user = first("User");
        let port = first("Port").and_then(|p| p.parse().ok());
        let identity_files = b
            .directives
            .iter()
            .filter(|d| d.key_is("IdentityFile"))
            .map(|d| d.unquoted())
            .collect();
        let identities_only = first("IdentitiesOnly")
            .map(|v| v.eq_ignore_ascii_case("yes") || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let extra = b
            .directives
            .iter()
            .filter(|d| !KNOWN_KEYS.contains(&d.key.to_ascii_lowercase().as_str()))
            .filter(|d| !d.key_is("IdentitiesOnly"))
            .map(|d| KeyValue {
                key: d.key.clone(),
                value: d.unquoted(),
            })
            .collect();
        let kind = if is_pattern(&b.patterns) {
            HostKind::Pattern
        } else if is_git_platform(&alias, user.as_deref(), host_name.as_deref()) {
            HostKind::GitPlatform
        } else {
            HostKind::Server
        };
        HostEntry {
            id,
            alias,
            patterns: b.patterns.clone(),
            host_name,
            user,
            port,
            identity_files,
            identities_only,
            proxy_jump: first("ProxyJump"),
            extra,
            description: doc.block_description(bi),
            kind,
            source_file: display_path(&doc.path),
            line: b.header + 1,
            raw: doc.block_raw(bi),
        }
    }

    fn assert_alias_free(&self, alias: &str, except: Option<(usize, usize)>) -> Result<()> {
        for (di, bi, _) in self.locate_all() {
            if Some((di, bi)) == except {
                continue;
            }
            if self.docs[di].blocks[bi].patterns.first().map(String::as_str) == Some(alias) {
                return Err(AppError::msg(format!("别名 {alias} 已存在")));
            }
        }
        Ok(())
    }

    /// 新增或更新主机，返回新 id
    pub fn upsert_host(&mut self, input: &HostInput) -> Result<String> {
        let (di, alias) = self.apply_upsert(input)?;
        self.save_doc(di)?;
        Ok(alias)
    }

    /// 批量新增/更新：先全部校验并应用到内存，再对每个涉及的文件只备份、写回一次。
    /// 任何一条校验失败则整体不写盘。
    pub fn upsert_many(&mut self, inputs: &[HostInput]) -> Result<Vec<String>> {
        let mut touched: Vec<usize> = Vec::new();
        let mut ids = Vec::with_capacity(inputs.len());
        for input in inputs {
            let (di, alias) = self.apply_upsert(input)?;
            if !touched.contains(&di) {
                touched.push(di);
            }
            ids.push(alias);
        }
        for di in touched {
            self.save_doc(di)?;
        }
        Ok(ids)
    }

    /// 只改内存中的文档，不写盘。返回 (所在文件下标, 新 alias)
    fn apply_upsert(&mut self, input: &HostInput) -> Result<(usize, String)> {
        let alias = input.alias.trim().to_string();
        validate_alias(&alias)?;
        let host_name = input.host_name.trim().to_string();
        if host_name.is_empty() {
            return Err(AppError::msg("主机地址不能为空"));
        }
        if input.port == Some(0) {
            return Err(AppError::msg("端口无效"));
        }
        let opt = |v: &Option<String>| -> Vec<String> {
            v.as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .into_iter()
                .collect()
        };
        let identity_files: Vec<String> = input
            .identity_files
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let port: Vec<String> = input.port.map(|p| p.to_string()).into_iter().collect();
        let identities_only: Vec<String> = if input.identities_only {
            vec!["yes".into()]
        } else {
            vec![]
        };

        let di = match &input.original_id {
            Some(id) => {
                let (di, bi) = self.locate(id)?;
                self.assert_alias_free(&alias, Some((di, bi)))?;
                let doc = &mut self.docs[di];
                let mut patterns = doc.blocks[bi].patterns.clone();
                if patterns.first() != Some(&alias) {
                    if patterns.is_empty() {
                        patterns.push(alias.clone());
                    } else {
                        patterns[0] = alias.clone();
                    }
                    doc.set_patterns(bi, &patterns);
                }
                doc.set_directive(bi, "HostName", &[host_name]);
                doc.set_directive(bi, "User", &opt(&input.user));
                doc.set_directive(bi, "Port", &port);
                doc.set_directive(bi, "IdentityFile", &identity_files);
                doc.set_directive(bi, "IdentitiesOnly", &identities_only);
                doc.set_directive(bi, "ProxyJump", &opt(&input.proxy_jump));
                doc.set_description(bi, &input.description);
                di
            }
            None => {
                self.assert_alias_free(&alias, None)?;
                let mut directives: Vec<(String, String)> = vec![("HostName".into(), host_name)];
                let push_all = |directives: &mut Vec<(String, String)>, k: &str, vs: &[String]| {
                    for v in vs {
                        directives.push((k.to_string(), v.clone()));
                    }
                };
                push_all(&mut directives, "User", &opt(&input.user));
                push_all(&mut directives, "Port", &port);
                push_all(&mut directives, "IdentityFile", &identity_files);
                push_all(&mut directives, "IdentitiesOnly", &identities_only);
                push_all(&mut directives, "ProxyJump", &opt(&input.proxy_jump));
                let desc = input.description.trim();
                self.docs[0].append_block(
                    &[alias.clone()],
                    &directives,
                    (!desc.is_empty()).then_some(desc),
                );
                0
            }
        };
        Ok((di, alias))
    }

    pub fn delete_host(&mut self, id: &str) -> Result<()> {
        let (di, bi) = self.locate(id)?;
        self.docs[di].remove_block(bi);
        self.save_doc(di)
    }

    pub fn replace_host_raw(&mut self, id: &str, raw: &str) -> Result<String> {
        let (di, bi) = self.locate(id)?;
        let probe = Document::parse("", raw);
        if let Some(b) = probe.blocks.first() {
            if let Some(alias) = b.patterns.first() {
                validate_alias(alias)?;
                self.assert_alias_free(alias, Some((di, bi)))?;
            }
        }
        self.docs[di]
            .replace_block_raw(bi, raw)
            .map_err(AppError::msg)?;
        self.save_doc(di)?;
        Ok(self.docs[di].blocks[bi].patterns[0].clone())
    }

    /// 备份原文件（config.bak.YYYYMMDD-HHMMSS）后原子写回，权限 0600
    fn save_doc(&self, di: usize) -> Result<()> {
        let doc = &self.docs[di];
        let path = &doc.path;
        if path.exists() {
            fs::copy(path, backup_path(path))?;
        } else if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "config".into());
        let tmp = path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
        fs::write(&tmp, doc.render())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

fn expand_include(ssh_dir: &Path, pat: &str) -> Vec<PathBuf> {
    let p = expand_tilde(pat);
    let p = if p.is_absolute() { p } else { ssh_dir.join(p) };
    let mut v: Vec<PathBuf> = glob::glob(&p.to_string_lossy())
        .map(|it| it.filter_map(|r| r.ok()).filter(|p| p.is_file()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut candidate = path.with_file_name(format!("{name}.bak.{stamp}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{name}.bak.{stamp}-{n}"));
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ssh_dir(name: &str, config: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apexterm-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config"), config).unwrap();
        dir
    }

    #[test]
    fn hosts_and_kinds() {
        let dir = temp_ssh_dir(
            "kinds",
            "Host web\n    HostName 1.2.3.4\n    User root\n    IdentityFile ~/.ssh/k\n    IdentitiesOnly yes\n    ServerAliveInterval 60\n\nHost github\n    HostName github.com\n    User git\n\nHost coding\n    HostName e.coding.net\n\nHost *\n    ServerAliveCountMax 3\n\nHost web\n    HostName dup\n",
        );
        let store = ConfigStore::load(dir.clone()).unwrap();
        let hosts = store.hosts();
        assert_eq!(hosts.len(), 5);
        assert_eq!(hosts[0].kind, HostKind::Server);
        assert!(hosts[0].identities_only);
        assert_eq!(hosts[0].extra.len(), 1);
        assert_eq!(hosts[0].extra[0].key, "ServerAliveInterval");
        assert_eq!(hosts[1].kind, HostKind::GitPlatform);
        assert_eq!(hosts[2].kind, HostKind::GitPlatform);
        assert_eq!(hosts[3].kind, HostKind::Pattern);
        assert_eq!(hosts[4].id, "web#2");
        assert_eq!(store.locate("web#2").unwrap(), (0, 4));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn include_is_followed_and_edits_go_to_owning_file() {
        let dir = temp_ssh_dir("include", "Include config.d/*.conf\n\nHost main\n    HostName m\n");
        fs::create_dir_all(dir.join("config.d")).unwrap();
        fs::write(dir.join("config.d/work.conf"), "Host work\n    HostName w\n").unwrap();
        let mut store = ConfigStore::load(dir.clone()).unwrap();
        assert_eq!(store.files().len(), 2);
        let ids: Vec<String> = store.hosts().into_iter().map(|h| h.id).collect();
        assert_eq!(ids, vec!["main", "work"]);

        store
            .upsert_host(&HostInput {
                original_id: Some("work".into()),
                alias: "work2".into(),
                host_name: "w2".into(),
                user: Some("ubuntu".into()),
                port: Some(2200),
                identity_files: vec![],
                identities_only: false,
                proxy_jump: None,
                description: String::new(),
            })
            .unwrap();
        let work = fs::read_to_string(dir.join("config.d/work.conf")).unwrap();
        assert_eq!(work, "Host work2\n    HostName w2\n    User ubuntu\n    Port 2200\n");
        assert_eq!(fs::read_to_string(dir.join("config")).unwrap(), "Include config.d/*.conf\n\nHost main\n    HostName m\n");
        assert!(fs::read_dir(dir.join("config.d")).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("work.conf.bak.")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upsert_delete_and_backup_on_main() {
        let dir = temp_ssh_dir("crud", "Host a\n    HostName 1.1.1.1\n    User root\n");
        let mut store = ConfigStore::load(dir.clone()).unwrap();
        let id = store
            .upsert_host(&HostInput {
                original_id: None,
                alias: "b".into(),
                host_name: "2.2.2.2".into(),
                user: Some("root".into()),
                port: None,
                identity_files: vec!["~/.ssh/id_ed25519".into()],
                identities_only: true,
                proxy_jump: None,
                description: "测试机".into(),
            })
            .unwrap();
        assert_eq!(id, "b");
        let content = fs::read_to_string(dir.join("config")).unwrap();
        assert_eq!(content, "Host a\n    HostName 1.1.1.1\n    User root\n\n# 测试机\nHost b\n    HostName 2.2.2.2\n    User root\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n");
        assert!(store.upsert_host(&HostInput { original_id: None, alias: "a".into(), host_name: "x".into(), user: None, port: None, identity_files: vec![], identities_only: false, proxy_jump: None, description: String::new() }).is_err());
        assert!(store.upsert_host(&HostInput { original_id: None, alias: "bad name".into(), host_name: "x".into(), user: None, port: None, identity_files: vec![], identities_only: false, proxy_jump: None, description: String::new() }).is_err());

        store.delete_host("a").unwrap();
        assert_eq!(fs::read_to_string(dir.join("config")).unwrap(), "# 测试机\nHost b\n    HostName 2.2.2.2\n    User root\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n");
        let baks = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("config.bak.")).count();
        assert_eq!(baks, 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join("config")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let new_id = store.replace_host_raw("b", "Host c\n    HostName 3.3.3.3").unwrap();
        assert_eq!(new_id, "c");
        assert_eq!(fs::read_to_string(dir.join("config")).unwrap(), "Host c\n    HostName 3.3.3.3\n");
        fs::remove_dir_all(dir).unwrap();
    }

    fn input(alias: &str, host: &str) -> HostInput {
        HostInput {
            original_id: None,
            alias: alias.into(),
            host_name: host.into(),
            user: Some("root".into()),
            port: None,
            identity_files: vec!["~/.ssh/id_rsa".into()],
            identities_only: true,
            proxy_jump: None,
            description: String::new(),
        }
    }

    #[test]
    fn upsert_many_writes_once_and_is_all_or_nothing() {
        let dir = temp_ssh_dir("many", "Host a\n    HostName 1.1.1.1\n");
        let mut store = ConfigStore::load(dir.clone()).unwrap();
        let ids = store
            .upsert_many(&[input("b", "2.2.2.2"), input("c", "3.3.3.3")])
            .unwrap();
        assert_eq!(ids, vec!["b", "c"]);
        let content = fs::read_to_string(dir.join("config")).unwrap();
        assert_eq!(
            content,
            "Host a\n    HostName 1.1.1.1\n\nHost b\n    HostName 2.2.2.2\n    User root\n    IdentityFile ~/.ssh/id_rsa\n    IdentitiesOnly yes\n\nHost c\n    HostName 3.3.3.3\n    User root\n    IdentityFile ~/.ssh/id_rsa\n    IdentitiesOnly yes\n"
        );
        let baks = || {
            fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("config.bak."))
                .count()
        };
        assert_eq!(baks(), 1, "两条只应产生一次备份");

        // 第二条与已有别名冲突：整体失败，文件和备份数都不变
        let err = store
            .upsert_many(&[input("d", "4.4.4.4"), input("a", "5.5.5.5")])
            .unwrap_err();
        assert!(err.to_string().contains("已存在"));
        assert_eq!(fs::read_to_string(dir.join("config")).unwrap(), content);
        assert_eq!(baks(), 1);
        // 批次内部重复别名同样拒绝
        assert!(store
            .upsert_many(&[input("e", "6.6.6.6"), input("e", "7.7.7.7")])
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_config_is_empty_not_error() {
        let dir = std::env::temp_dir().join(format!("apexterm-test-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = ConfigStore::load(dir.clone()).unwrap();
        assert!(store.hosts().is_empty());
    }

    /// 用本机真实的 ~/.ssh/config 验证解析后再渲染与原文件逐字节一致（只读，不写）
    #[test]
    fn real_config_roundtrip_if_present() {
        let Some(home) = dirs::home_dir() else { return };
        let path = home.join(".ssh/config");
        let Ok(content) = fs::read_to_string(&path) else { return };
        let doc = Document::parse(&path, &content);
        assert_eq!(doc.render(), content, "真实 config 往返不一致");
        let store = ConfigStore::load(home.join(".ssh")).unwrap();
        assert!(!store.hosts().is_empty());
    }
}
