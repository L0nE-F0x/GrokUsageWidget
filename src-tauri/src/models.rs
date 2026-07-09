//! Shared data models for SuperGrok usage and app settings.

use serde::{Deserialize, Serialize};

/// A single usage category (Grok Build, Chat, API, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryUsage {
    pub id: String,
    pub name: String,
    /// Used amount when known; otherwise 0.
    #[serde(default)]
    pub used: f64,
    /// Quota limit when known; otherwise 0.
    #[serde(default)]
    pub limit: f64,
    /// 0.0 – 100.0 percentage of quota consumed.
    pub percent: f64,
    #[serde(default)]
    pub unit: Option<String>,
}

/// Snapshot of Weekly SuperGrok usage returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// Overall weekly SuperGrok usage percentage (0–100).
    pub overall_percent: f64,
    pub categories: Vec<CategoryUsage>,
    /// Human-readable reset date, e.g. "July 12, 2026".
    #[serde(default)]
    pub resets_date: String,
    /// Human-readable reset time, e.g. "10:50 AM".
    #[serde(default)]
    pub resets_time: String,
    /// Combined display string when date/time split is unavailable.
    #[serde(default)]
    pub resets_display: String,
    /// Extra Usage Credits balance when available.
    #[serde(default)]
    pub extra_credits: Option<f64>,
    /// Free-text credits label as scraped (fallback).
    #[serde(default)]
    pub extra_credits_label: Option<String>,
    /// ISO 8601 timestamp when this snapshot was fetched.
    pub fetched_at: String,
    /// Reserved for scrape JSON compatibility (always false for live data).
    #[serde(default)]
    pub is_mock: bool,
    /// Source of the data: "playwright" | "cache".
    #[serde(default)]
    pub source: Option<String>,
    /// Optional free-form note (login hints, scrape warnings).
    #[serde(default)]
    pub note: Option<String>,
}

/// User-configurable app settings (persisted as JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Auto-refresh interval in minutes. 0 = disabled.
    pub refresh_interval_minutes: u32,
    /// Whether the window should stay always on top.
    pub always_on_top: bool,
    /// Directory for Playwright persistent browser context.
    /// Empty = default under app data (`playwright-profile`).
    #[serde(default)]
    pub browser_user_data_dir: Option<String>,
    /// Optional path to a Chromium/Chrome channel binary.
    #[serde(default)]
    pub browser_channel: Option<String>,
    /// Launch browser headed (visible) — useful for first-time login.
    #[serde(default = "default_true")]
    pub headed_for_login: bool,
    /// Force headed mode on every refresh (debugging).
    #[serde(default)]
    pub always_headed: bool,
    /// True after a successful live SuperGrok fetch (hides welcome setup).
    #[serde(default)]
    pub setup_complete: bool,
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            refresh_interval_minutes: 5,
            always_on_top: true,
            browser_user_data_dir: None,
            browser_channel: None,
            headed_for_login: true,
            always_headed: false,
            setup_complete: false,
            window_x: None,
            window_y: None,
        }
    }
}

/// Result wrapper so the frontend can distinguish success vs recoverable errors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<UsageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
