//! 给终端粘贴用的剪贴板读取：文件列表 → 图片（存成 PNG）→ 文本。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{AppError, Result};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PastePayload {
    Files { paths: Vec<String> },
    Image { paths: Vec<String> },
    Text { text: String },
    Empty,
}

/// 粘贴出来的截图保留 7 天
const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

pub fn read(image_dir: &Path) -> Result<PastePayload> {
    let mut cb = arboard::Clipboard::new().map_err(|e| AppError::msg(format!("打开剪贴板失败: {e}")))?;
    // 微信截图 / Finder 复制文件都带 file-url，优先当文件处理
    if let Ok(files) = cb.get().file_list() {
        if !files.is_empty() {
            return Ok(PastePayload::Files {
                paths: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            });
        }
    }
    if let Ok(img) = cb.get_image() {
        let path = save_png(image_dir, img.width, img.height, &img.bytes)?;
        return Ok(PastePayload::Image {
            paths: vec![path.to_string_lossy().into_owned()],
        });
    }
    match cb.get_text() {
        Ok(t) if !t.is_empty() => Ok(PastePayload::Text { text: t }),
        _ => Ok(PastePayload::Empty),
    }
}

pub fn save_png(dir: &Path, width: usize, height: usize, rgba: &[u8]) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    cleanup(dir);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let path = dir.join(format!(
        "{}-{:04x}.png",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        nanos & 0xffff
    ));
    let file = std::fs::File::create(&path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc
        .write_header()
        .map_err(|e| AppError::msg(format!("写 PNG 失败: {e}")))?;
    w.write_image_data(rgba)
        .map_err(|e| AppError::msg(format!("写 PNG 失败: {e}")))?;
    w.finish().map_err(|e| AppError::msg(format!("写 PNG 失败: {e}")))?;
    Ok(path)
}

/// 删除超过保留期的旧截图；失败忽略
fn cleanup(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_png_and_cleans_old_files() {
        let dir = std::env::temp_dir().join(format!("apexterm-clip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("old.png");
        std::fs::write(&stale, b"x").unwrap();
        let eight_days_ago = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();

        let p = save_png(&dir, 2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert!(p.extension().is_some_and(|e| e == "png"));
        assert!(std::fs::read(&p).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        assert!(!stale.exists(), "过期文件应被清理");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
