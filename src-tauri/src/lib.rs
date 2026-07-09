//! Grok Usage Widget — Tauri application entry and commands.

mod fetch;
mod models;
mod scrape_runtime;
mod settings;
mod win_process;

use models::{AppSettings, UsageResponse};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};

// -- Commands ---------------------------------------------------------------

#[tauri::command]
async fn get_usage(app: AppHandle) -> UsageResponse {
    let s = settings::load_settings(&app);
    fetch::fetch_usage(&app, &s).await
}

#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    settings::load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, new_settings: AppSettings) -> Result<AppSettings, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(new_settings.always_on_top);
    }
    settings::save_settings(&app, &new_settings)?;
    Ok(new_settings)
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(enabled)
            .map_err(|e| format!("Failed to set always on top: {e}"))?;
    }
    let mut s = settings::load_settings(&app);
    s.always_on_top = enabled;
    settings::save_settings(&app, &s)?;
    Ok(())
}

#[tauri::command]
fn save_window_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let mut s = settings::load_settings(&app);
    s.window_x = Some(x);
    s.window_y = Some(y);
    settings::save_settings(&app, &s)
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_default_profile_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("playwright-profile");
    Ok(dir.to_string_lossy().into_owned())
}

// -- Helpers ----------------------------------------------------------------

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn restore_window_state(window: &WebviewWindow, s: &AppSettings) {
    let _ = window.set_always_on_top(s.always_on_top);
    if let (Some(x), Some(y)) = (s.window_x, s.window_y) {
        let _ = window.set_position(tauri::Position::Physical(PhysicalPosition { x, y }));
    }
}

fn persist_position(app: &AppHandle, x: i32, y: i32) {
    let mut s = settings::load_settings(app);
    s.window_x = Some(x);
    s.window_y = Some(y);
    let _ = settings::save_settings(app, &s);
}

// -- App setup --------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_usage,
            get_settings,
            save_settings,
            set_always_on_top,
            save_window_position,
            hide_window,
            get_default_profile_dir,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load_settings(&handle);

            if let Some(window) = app.get_webview_window("main") {
                // Ensure taskbar uses the bundled app icon (avoids stale default).
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                restore_window_state(&window, &s);
            }

            let show_i = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let refresh_i = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &refresh_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Grok SuperGrok Usage")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_main_window(app),
                    "refresh" => {
                        let _ = app.emit("tray-refresh", ());
                        show_main_window(app);
                    }
                    "quit" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(pos) = window.outer_position() {
                                persist_position(app, pos.x, pos.y);
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Ok(pos) = window.outer_position() {
                        persist_position(window.app_handle(), pos.x, pos.y);
                    }
                    let _ = window.hide();
                }
                WindowEvent::Moved(pos) => {
                    persist_position(window.app_handle(), pos.x, pos.y);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
