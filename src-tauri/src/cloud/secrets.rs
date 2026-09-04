//! 云账号 SecretKey 的保存。macOS 用系统钥匙串；其它平台暂用应用数据目录下的受限文件
//! （Windows 凭据管理器接入排在后面），任何情况下都不写进 meta.json。

use std::path::PathBuf;

use crate::error::{AppError, Result};

const SERVICE: &str = "ApexTerm 云账号";

pub struct SecretStore {
    #[allow(dead_code)]
    fallback_dir: PathBuf,
}

impl SecretStore {
    pub fn new(fallback_dir: PathBuf) -> Self {
        Self { fallback_dir }
    }

    #[cfg(target_os = "macos")]
    pub fn set(&self, account_id: &str, secret: &str) -> Result<()> {
        security_framework::passwords::set_generic_password(SERVICE, account_id, secret.as_bytes())
            .map_err(|e| AppError::msg(format!("写入钥匙串失败: {e}")))
    }

    #[cfg(target_os = "macos")]
    pub fn get(&self, account_id: &str) -> Result<String> {
        let bytes = security_framework::passwords::get_generic_password(SERVICE, account_id)
            .map_err(|e| AppError::msg(format!("读取钥匙串失败（账号 {account_id}）: {e}")))?;
        String::from_utf8(bytes).map_err(|_| AppError::msg("钥匙串内容损坏"))
    }

    #[cfg(target_os = "macos")]
    pub fn delete(&self, account_id: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(SERVICE, account_id) {
            Ok(()) => Ok(()),
            // 不存在也算删除成功
            Err(e) if e.code() == -25300 => Ok(()),
            Err(e) => Err(AppError::msg(format!("删除钥匙串条目失败: {e}"))),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn file(&self, account_id: &str) -> PathBuf {
        let safe: String = account_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        self.fallback_dir.join("secrets").join(format!("{safe}.key"))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn set(&self, account_id: &str, secret: &str) -> Result<()> {
        let path = self.file(account_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, secret)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn get(&self, account_id: &str) -> Result<String> {
        std::fs::read_to_string(self.file(account_id))
            .map_err(|e| AppError::msg(format!("读取密钥失败（账号 {account_id}）: {e}")))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn delete(&self, account_id: &str) -> Result<()> {
        match std::fs::remove_file(self.file(account_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
