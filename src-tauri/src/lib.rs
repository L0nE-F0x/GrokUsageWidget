//! Grok Usage Widget — Tauri application entry and commands.

mod fetch;
mod models;
mod scrape_runtime;
mod settings;
mod win_process;

use models::{AppSettings, UsageResponse};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, State,
    WebviewWindow, WindowEvent,
};

/// Tracks compact mode for Resized handlers (disk settings can lag a set_size).
static COMPACT_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Shared handles for tray updates from commands / frontend.
pub struct AppState {
    pub tray: Mutex<Option<TrayIcon>>,
}

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
        apply_window_mode(&window, new_settings.compact_mode)?;
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

/// Update the system tray hover tooltip (e.g. "42% SuperGrok used").
#[tauri::command]
fn set_tray_tooltip(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let guard = state.tray.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_ref() {
        tray.set_tooltip(Some(&text))
            .map_err(|e| format!("Failed to set tray tooltip: {e}"))?;
    }
    Ok(())
}

/// Toggle sleek/compact pill mode and resize the window.
#[tauri::command]
fn set_compact_mode(app: AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let mut s = settings::load_settings(&app);
    s.compact_mode = enabled;
    if let Some(window) = app.get_webview_window("main") {
        apply_window_mode(&window, enabled)?;
        let _ = window.set_always_on_top(s.always_on_top);
        if enabled {
            // Keep sleek mode visible while coding.
            let _ = window.set_always_on_top(true);
            s.always_on_top = true;
        }
    }
    settings::save_settings(&app, &s)?;
    Ok(s)
}

// -- Helpers ----------------------------------------------------------------

fn apply_window_mode(window: &WebviewWindow, compact: bool) -> Result<(), String> {
    COMPACT_MODE_ACTIVE.store(compact, Ordering::Relaxed);
    if compact {
        window
            .set_min_size(Some(Size::Logical(LogicalSize {
                width: 220.0,
                height: 40.0,
            })))
            .map_err(|e| e.to_string())?;
        window
            .set_size(Size::Logical(LogicalSize {
                width: 300.0,
                height: 48.0,
            }))
            .map_err(|e| e.to_string())?;
        window.set_resizable(false).map_err(|e| e.to_string())?;
    } else {
        window
            .set_min_size(Some(Size::Logical(LogicalSize {
                width: 280.0,
                height: 360.0,
            })))
            .map_err(|e| e.to_string())?;
        window
            .set_size(Size::Logical(LogicalSize {
                width: 320.0,
                height: 500.0,
            }))
            .map_err(|e| e.to_string())?;
        window.set_resizable(true).map_err(|e| e.to_string())?;
    }
    // Clip native window shape so square host corners never stick past the pill/card.
    apply_rounded_region(window, compact);
    // Expanding from a bottom-edge pill (or restoring full size at a pill position)
    // can push most of the window off-screen while Win32 still reports it "visible".
    ensure_window_on_screen(window);
    Ok(())
}

/// Clip the HWND to a rounded rect (full mode) or full pill (compact).
/// CSS border-radius alone cannot cut opaque host pixels; Win32 region does.
#[cfg(windows)]
fn apply_rounded_region(window: &WebviewWindow, compact: bool) {
    // Direct FFI avoids flaky windows-rs feature gating for SetWindowRgn.
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(
            x1: i32,
            y1: i32,
            x2: i32,
            y2: i32,
            w: i32,
            h: i32,
        ) -> isize;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: isize, hrgn: isize, b_redraw: i32) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let w = size.width as i32;
    let h = size.height as i32;
    if w <= 1 || h <= 1 {
        return;
    }

    // CreateRoundRectRgn ellipse width/height = corner diameter.
    // Clamp so extreme ellipses never collapse the region to empty.
    let (ellipse_w, ellipse_h) = if compact {
        // True pill: radius = half the bar height.
        let d = h.min(w).max(2);
        (d, d)
    } else {
        let scale = window.scale_factor().unwrap_or(1.0);
        // Match CSS --radius: 12px (logical → physical).
        let diameter = ((12.0 * scale).round() as i32 * 2)
            .max(2)
            .min(w)
            .min(h);
        (diameter, diameter)
    };

    unsafe {
        let hrgn = CreateRoundRectRgn(0, 0, w, h, ellipse_w, ellipse_h);
        if hrgn != 0 {
            // b_redraw = TRUE → system owns the region handle.
            let _ = SetWindowRgn(hwnd.0 as isize, hrgn, 1);
        }
    }
}

#[cfg(not(windows))]
fn apply_rounded_region(_window: &WebviewWindow, _compact: bool) {}

/// True when a usable chunk of the window intersects some monitor.
fn is_window_on_screen(window: &WebviewWindow) -> bool {
    let Ok(pos) = window.outer_position() else {
        return true;
    };
    let Ok(size) = window.outer_size() else {
        return true;
    };
    let w = size.width as i32;
    let h = size.height as i32;
    if w <= 0 || h <= 0 {
        return false;
    }

    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    // Require enough intersection to interact with (title bar / pill).
    let min_w = 80.min(w);
    let min_h = 40.min(h);

    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let mx1 = mp.x;
        let my1 = mp.y;
        let mx2 = mp.x + ms.width as i32;
        let my2 = mp.y + ms.height as i32;

        let ix1 = pos.x.max(mx1);
        let iy1 = pos.y.max(my1);
        let ix2 = (pos.x + w).min(mx2);
        let iy2 = (pos.y + h).min(my2);
        (ix2 - ix1) >= min_w && (iy2 - iy1) >= min_h
    })
}

/// If the window is mostly off-screen, clamp it into the nearest/primary work area.
fn ensure_window_on_screen(window: &WebviewWindow) {
    if is_window_on_screen(window) {
        return;
    }

    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let w = size.width as i32;
    let h = size.height as i32;
    if w <= 0 || h <= 0 {
        return;
    }

    let monitors = match window.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return,
    };

    // Prefer the monitor whose center is closest to the window's center.
    let cx = pos.x + w / 2;
    let cy = pos.y + h / 2;
    let mut best = 0usize;
    let mut best_dist = i64::MAX;
    for (i, m) in monitors.iter().enumerate() {
        let mp = m.position();
        let ms = m.size();
        let mcx = mp.x as i64 + ms.width as i64 / 2;
        let mcy = mp.y as i64 + ms.height as i64 / 2;
        let dist = (mcx - cx as i64).pow(2) + (mcy - cy as i64).pow(2);
        if dist < best_dist {
            best_dist = dist;
            best = i;
        }
    }

    let m = &monitors[best];
    let mp = m.position();
    let ms = m.size();
    let margin = 16;
    let max_x = mp.x + (ms.width as i32 - w).max(0);
    let max_y = mp.y + (ms.height as i32 - h).max(0);
    let x = pos.x.clamp(mp.x + margin, max_x.saturating_sub(margin).max(mp.x));
    let y = pos.y.clamp(mp.y + margin, max_y.saturating_sub(margin).max(mp.y));

    // If the window is taller/wider than the monitor, pin to top-left with margin.
    let x = if w + margin * 2 >= ms.width as i32 {
        mp.x + margin
    } else {
        x
    };
    let y = if h + margin * 2 >= ms.height as i32 {
        mp.y + margin
    } else {
        y
    };

    let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        ensure_window_on_screen(&window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        // Off-screen-but-"visible" windows must show+clamp, not hide.
        if visible && is_window_on_screen(&window) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn restore_window_state(window: &WebviewWindow, s: &AppSettings) {
    let _ = window.set_always_on_top(s.always_on_top);
    if let (Some(x), Some(y)) = (s.window_x, s.window_y) {
        let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
    }
    // Compact mode is applied by the frontend after live data loads
    // so we don't open a tiny empty pill on cold start.
    // apply_window_mode also clamps onto a visible monitor.
    let _ = apply_window_mode(window, false);
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
        .manage(AppState {
            tray: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_usage,
            get_settings,
            save_settings,
            set_always_on_top,
            save_window_position,
            hide_window,
            get_default_profile_dir,
            set_tray_tooltip,
            set_compact_mode,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load_settings(&handle);

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                // Opaque dark host (not transparent — WebView2 transparent windows
                // turn the whole panel glass-like on Windows). Matching #0c0c0e hides
                // the old white corner squares outside CSS border-radius.
                let _ = window.set_background_color(Some(tauri::window::Color(12, 12, 14, 255)));
                restore_window_state(&window, &s);
            }

            let show_i = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let refresh_i = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &refresh_i, &quit_i])?;

            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Grok Usage")
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

            if let Ok(mut guard) = app.state::<AppState>().tray.lock() {
                *guard = Some(tray);
            }

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
                WindowEvent::Resized(_) => {
                    // Keep the clip region in sync when the user resizes full mode.
                    // Use in-memory flag — disk settings can still hold the old mode
                    // while set_size is in flight during compact toggles.
                    let compact = COMPACT_MODE_ACTIVE.load(Ordering::Relaxed);
                    if let Some(w) = window.app_handle().get_webview_window("main") {
                        apply_rounded_region(&w, compact);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
