//! 原生菜单。必须自带「编辑」菜单，WKWebView 里的 ⌘C/⌘V 才能工作；
//! 同时把 ⌘W 从"关闭窗口"改成"关闭标签"，交给前端处理。
//! 快捷键是数据驱动的：默认表 + 用户覆盖（存在 meta 里），改动后整个菜单重建。

use std::collections::HashMap;

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 应用级快捷键：macOS 用 ⌘，其它平台用 Ctrl+Shift（Ctrl+W/T/K 在终端里有自己的含义，不能占用）
fn accel(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("CmdOrCtrl+{key}")
    } else {
        format!("Ctrl+Shift+{key}")
    }
}

fn accel_shift(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("CmdOrCtrl+Shift+{key}")
    } else {
        format!("Ctrl+Shift+Alt+{key}")
    }
}

/// 带 Alt 的组合：macOS ⌘⌥（iTerm2 切面板同款），其它平台 Ctrl+Alt（避开 shell 里的 Ctrl+Shift+方向键选词）
fn accel_alt(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("CmdOrCtrl+Alt+{key}")
    } else {
        format!("Ctrl+Alt+{key}")
    }
}

fn accel_tab(next: bool) -> String {
    if cfg!(target_os = "macos") {
        format!("CmdOrCtrl+Shift+{}", if next { "]" } else { "[" })
    } else {
        format!("Ctrl+{}", if next { "PageDown" } else { "PageUp" })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDef {
    pub id: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub default: String,
}

/// 所有可自定义的动作及默认快捷键（顺序即设置页显示顺序）
pub fn defaults() -> Vec<ShortcutDef> {
    let d = |id, label, group, default: String| ShortcutDef { id, label, group, default };
    vec![
        d("new-local-terminal", "新建本地终端", "终端", accel("T")),
        d("close-tab", "关闭当前分屏 / 标签", "终端", accel("W")),
        d("split-right", "向右分屏", "终端", accel("D")),
        d("split-down", "向下分屏", "终端", accel_shift("D")),
        d("focus-pane-left", "聚焦左侧面板", "终端", accel_alt("Left")),
        d("focus-pane-right", "聚焦右侧面板", "终端", accel_alt("Right")),
        d("focus-pane-up", "聚焦上方面板", "终端", accel_alt("Up")),
        d("focus-pane-down", "聚焦下方面板", "终端", accel_alt("Down")),
        d("clear-terminal", "清屏", "终端", accel("K")),
        d("find", "在终端里查找", "终端", accel("F")),
        d("next-tab", "下一个标签", "终端", accel_tab(true)),
        d("prev-tab", "上一个标签", "终端", accel_tab(false)),
        d("zoom-in", "放大字体", "外观", accel("=")),
        d("zoom-out", "缩小字体", "外观", accel("-")),
        d("zoom-reset", "恢复默认字号", "外观", accel("0")),
        d("settings", "打开设置", "外观", accel(",")),
        d("toggle-sidebar", "显示 / 隐藏侧栏", "外观", accel("B")),
        d("palette", "命令面板（搜主机 / 命令 / 动作）", "主机", accel("P")),
        d("local-console", "打开本机控制台", "主机", accel_shift("L")),
        d("reload-config", "重新读取 SSH 配置", "主机", accel("R")),
        d("new-host", "添加服务器", "主机", accel("N")),
        d("probe-all", "探测全部服务器", "主机", accel_shift("P")),
        d("privacy", "切换隐私模式", "主机", accel_shift("H")),
    ]
}

/// 合成最终快捷键表：默认值被 overrides 覆盖；空字符串表示"不绑定"
pub fn resolve(overrides: &HashMap<String, String>) -> HashMap<&'static str, String> {
    defaults()
        .into_iter()
        .map(|d| {
            let v = overrides.get(d.id).cloned().unwrap_or(d.default);
            (d.id, v)
        })
        .collect()
}

pub fn build<R: Runtime, M: Manager<R>>(app: &M, keys: &HashMap<&'static str, String>) -> tauri::Result<Menu<R>> {
    let acc = |id: &str| -> Option<String> {
        keys.get(id).filter(|s| !s.trim().is_empty()).cloned()
    };
    let item = |id: &'static str, label: &str| MenuItem::with_id(app, id, label, true, acc(id));

    let about = AboutMetadata {
        name: Some("ApexTerm".into()),
        comments: Some("管理免密 SSH 服务器的桌面程序".into()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "ApexTerm",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 ApexTerm"), Some(about))?,
            &item("check-update", "检查更新…")?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "设置…")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏 ApexTerm"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("退出 ApexTerm"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("find", "查找")?,
        ],
    )?;

    let hosts_menu = Submenu::with_items(
        app,
        "主机",
        true,
        &[
            &item("palette", "命令面板…")?,
            &item("local-console", "本机控制台")?,
            &PredefinedMenuItem::separator(app)?,
            &item("new-host", "添加服务器…")?,
            &item("reload-config", "重新读取 SSH 配置")?,
            &PredefinedMenuItem::separator(app)?,
            &item("probe-all", "探测全部服务器")?,
            &item("privacy", "切换隐私模式")?,
        ],
    )?;

    let terminal_menu = Submenu::with_items(
        app,
        "终端",
        true,
        &[
            &item("new-local-terminal", "新建本地终端")?,
            &item("close-tab", "关闭当前分屏 / 标签")?,
            &PredefinedMenuItem::separator(app)?,
            &item("split-right", "向右分屏")?,
            &item("split-down", "向下分屏")?,
            &PredefinedMenuItem::separator(app)?,
            &item("focus-pane-left", "聚焦左侧面板")?,
            &item("focus-pane-right", "聚焦右侧面板")?,
            &item("focus-pane-up", "聚焦上方面板")?,
            &item("focus-pane-down", "聚焦下方面板")?,
            &PredefinedMenuItem::separator(app)?,
            &item("clear-terminal", "清屏")?,
            &PredefinedMenuItem::separator(app)?,
            &item("zoom-in", "放大字体")?,
            &item("zoom-out", "缩小字体")?,
            &item("zoom-reset", "恢复默认字号")?,
            &PredefinedMenuItem::separator(app)?,
            &item("next-tab", "下一个标签")?,
            &item("prev-tab", "上一个标签")?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &item("toggle-sidebar", "显示 / 隐藏侧栏")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        &[
            &item("open-homepage", "项目主页（GitHub）")?,
            &item("open-issues", "反馈问题")?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &hosts_menu, &terminal_menu, &window_menu, &help_menu])
}

/// 首次安装菜单，并注册事件转发
pub fn install<R: Runtime>(app: &tauri::App<R>, overrides: &HashMap<String, String>) -> tauri::Result<()> {
    let menu = build(app, &resolve(overrides))?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().0.clone());
    });
    Ok(())
}

/// 快捷键改动后重建菜单
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, overrides: &HashMap<String, String>) -> tauri::Result<()> {
    let menu = build(app, &resolve(overrides))?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_apply_and_allow_unbinding() {
        let mut o = HashMap::new();
        o.insert("find".to_string(), "CmdOrCtrl+G".to_string());
        o.insert("zoom-in".to_string(), String::new());
        let r = resolve(&o);
        assert_eq!(r["find"], "CmdOrCtrl+G");
        assert_eq!(r["zoom-in"], "");
        assert_eq!(r["close-tab"], accel("W"));
        assert_eq!(defaults().len(), r.len());
    }
}
