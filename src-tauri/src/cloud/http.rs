//! HTTP 与签名用到的基础工具

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::error::{AppError, Result};

pub fn agent() -> Agent {
    Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(25)))
        // 火山引擎出错时返回 4xx，正文里才有错误码，不能让 ureq 直接当错误抛掉
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// RFC 3986 编码：仅 `A-Z a-z 0-9 - _ . ~` 不编码
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 读取响应正文并解析为 JSON
pub fn read_json(mut resp: ureq::http::Response<ureq::Body>) -> Result<serde_json::Value> {
    let status = resp.status();
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| AppError::msg(format!("读取响应失败: {e}")))?;
    serde_json::from_str(&text)
        .map_err(|_| AppError::msg(format!("接口返回了非 JSON 内容 (HTTP {status}): {}", text.chars().take(200).collect::<String>())))
}

pub fn net_err(e: ureq::Error) -> AppError {
    AppError::msg(format!("网络请求失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitives() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // RFC 4231 test case 2
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(percent_encode("a b/c~d"), "a%20b%2Fc~d");
        assert_eq!(percent_encode("i-abc_1.2"), "i-abc_1.2");
    }
}
