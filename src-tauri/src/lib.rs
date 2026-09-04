mod clipboard;
mod cloud;
mod commands;
mod commands_files;
mod error;
mod keys;
mod known_hosts;
mod local;
mod menu;
mod meta;
mod remote;
mod sftp;
mod ssh_config;
mod terminal;
mod tools;
mod watcher;

use tauri::Manager;

use cloud::secrets::SecretStore;
use commands::AppState;
use meta::MetaStore;
use sftp::SftpState;
use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 更新器只在桌面端有意义；dev 构建里也注册，便于手动"检查更新"走一遍流程
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let ssh_dir = dirs::home_dir()
                .ok_or("无法定位用户主目录")?
                .join(".ssh");
            let data_dir = app.path().app_data_dir()?;
            let meta = MetaStore::new(data_dir.join("meta.json"));
            // 菜单快捷键可被用户覆盖，启动时从 meta 读出
            let shortcuts = meta.load().map(|m| m.shortcuts).unwrap_or_default();
            app.manage(AppState {
                ssh_dir,
                meta,
                secrets: SecretStore::new(data_dir.clone()),
                data_dir,
            });
            app.manage(TerminalState::default());
            app.manage(std::sync::Arc::new(SftpState::default()));
            app.manage(watcher::WatchState::default());
            menu::install(app, &shortcuts)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::save_shortcuts,
            commands::log_frontend_error,
            commands::clipboard_paste_payload,
            commands::run_local,
            commands::local_recent_commands,
            commands::local_summary,
            commands::save_local_snippets,
            commands::save_local_dirs,
            commands::load_hosts,
            commands::read_config_raw,
            commands::upsert_host,
            commands::upsert_hosts,
            commands::delete_host,
            commands::replace_host_raw,
            commands::load_meta,
            commands::save_host_meta,
            commands::save_groups,
            commands::touch_host_connected,
            commands::save_order,
            commands::probe_host,
            commands::save_snippets,
            commands::run_remote_command,
            commands::check_host_alive,
            commands::cloud_add_account,
            commands::cloud_remove_account,
            commands::cloud_scan,
            commands::cloud_bind,
            commands::cloud_state,
            commands::cloud_power,
            commands::cloud_vnc_url,
            commands::list_keys,
            commands::load_candidates,
            commands::set_candidates_ignored,
            commands::probe_candidate,
            commands::open_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::terminal_count,
            commands_files::local_home,
            commands_files::local_list,
            commands_files::local_mkdir,
            commands_files::local_remove,
            commands_files::local_rename,
            commands_files::sftp_home,
            commands_files::sftp_list,
            commands_files::sftp_mkdir,
            commands_files::sftp_remove,
            commands_files::sftp_rename,
            commands_files::sftp_disconnect,
            commands_files::sftp_set_compression,
            commands_files::sftp_upload,
            commands_files::sftp_download,
            commands_files::sftp_cancel,
            commands_files::sftp_sync_plan,
            commands_files::sftp_sync_apply,
            commands_files::save_folder_pairs,
            commands_files::watch_start,
            commands_files::watch_stop,
            commands_files::watch_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
