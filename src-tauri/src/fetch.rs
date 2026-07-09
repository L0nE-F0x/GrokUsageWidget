//! Fetch Weekly SuperGrok usage via Playwright.
//!
//! Installed / shared builds:
//! - Scrape script is bundled as a Tauri resource
//! - First live refresh bootstraps a per-user runtime under AppData
//!   (npm install playwright + chromium; portable Node if needed)
//! - Project folder is NOT required

use crate::models::{AppSettings, UsageResponse, UsageSnapshot};
use crate::scrape_runtime;
use chrono::Utc;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const USAGE_URL: &str = "https://grok.com/?_s=usage";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchConfig {
    user_data_dir: String,
    usage_url: String,
    headed: bool,
    channel: Option<String>,
    timeout_ms: u64,
    debug_dir: String,
}

/// Public entry: live Playwright fetch of Weekly SuperGrok usage.
pub async fn fetch_usage(app: &AppHandle, settings: &AppSettings) -> UsageResponse {
    match fetch_via_playwright(app, settings).await {
        Ok(snapshot) => UsageResponse {
            ok: true,
            data: Some(snapshot),
            error: None,
        },
        Err(err) => UsageResponse {
            ok: false,
            data: None,
            error: Some(err),
        },
    }
}

async fn fetch_via_playwright(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<UsageSnapshot, String> {
    // First-time (or after upgrade): ensure AppData scrape runtime exists.
    let runtime = scrape_runtime::ensure_runtime(app)
        .await
        .map_err(|e| {
            format!(
                "Scrape runtime setup failed (one-time).\n{e}\n\n\
                 Tips:\n\
                 • Need internet the first time\n\
                 • Or install Node.js LTS from https://nodejs.org and retry"
            )
        })?;

    let user_data_dir = resolve_user_data_dir(app, settings)?;
    let debug_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("debug");
    let _ = std::fs::create_dir_all(&debug_dir);

    let headed = settings.always_headed || settings.headed_for_login;

    let config = FetchConfig {
        user_data_dir: user_data_dir.to_string_lossy().into_owned(),
        usage_url: USAGE_URL.to_string(),
        headed,
        channel: settings.browser_channel.clone().filter(|s| !s.is_empty()),
        timeout_ms: 120_000,
        debug_dir: debug_dir.to_string_lossy().into_owned(),
    };

    let config_json = serde_json::to_string(&config)
        .map_err(|e| format!("Failed to serialize fetch config: {e}"))?;

    // Run with cwd = scrape-runtime so `import from "playwright"` resolves.
    let mut cmd = Command::new(&runtime.node_path);
    cmd.arg(&runtime.script_path)
        .current_dir(&runtime.runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::win_process::hide_tokio_console(&mut cmd);
    let mut child = cmd.spawn()
        .map_err(|e| {
            format!(
                "Failed to start scrape process ({e}).\nNode: {}\nScript: {}",
                runtime.node_path.display(),
                runtime.script_path.display()
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(config_json.as_bytes())
            .await
            .map_err(|e| format!("Failed writing config to scrape script: {e}"))?;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Scrape process error: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        if let Some(line) = stdout
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'))
        {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let mut msg = v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("Playwright fetch failed")
                    .to_string();
                if let Some(sample) = v.get("sample").and_then(|x| x.as_str()) {
                    if !sample.is_empty() {
                        msg.push_str("\n\nPage text sample:\n");
                        msg.push_str(sample);
                    }
                }
                if let Some(path) = v.get("debugPath").and_then(|x| x.as_str()) {
                    msg.push_str("\n\nDebug file: ");
                    msg.push_str(path);
                }
                return Err(msg);
            }
        }
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit code {:?}", output.status.code())
        };
        return Err(format!(
            "Could not read usage — are you logged in?\n{detail}"
        ));
    }

    let json_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| {
            format!("Scrape returned no JSON. stderr: {stderr} stdout: {stdout}")
        })?;

    let mut snapshot: UsageSnapshot = serde_json::from_str(json_line)
        .map_err(|e| format!("Failed to parse scrape JSON ({e}): {json_line}"))?;

    snapshot.is_mock = false;
    if snapshot.source.is_none() {
        snapshot.source = Some("playwright".into());
    }
    if snapshot.fetched_at.is_empty() {
        snapshot.fetched_at =
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    if snapshot.resets_display.is_empty() {
        let mut parts = Vec::new();
        if !snapshot.resets_date.is_empty() {
            parts.push(snapshot.resets_date.clone());
        }
        if !snapshot.resets_time.is_empty() {
            parts.push(format!("at {}", snapshot.resets_time));
        }
        snapshot.resets_display = parts.join(" ");
    }

    Ok(snapshot)
}

fn resolve_user_data_dir(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, String> {
    if let Some(custom) = settings
        .browser_user_data_dir
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(custom);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create browser profile parent: {e}"))?;
        }
        return Ok(p);
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("playwright-profile");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create playwright profile dir: {e}"))?;
    Ok(dir)
}

