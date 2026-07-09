//! Self-contained scrape runtime for installed / shared builds.
//!
//! Goal: recipients should NOT need the git project folder.
//!
//! Layout (under app data):
//!   scrape-runtime/
//!     package.json
//!     fetch-usage.mjs
//!     node_modules/          (after first bootstrap)
//!     .bootstrap-ok          (marker file)
//!   node-runtime/            (optional portable Node if system Node missing)
//!     node.exe, npm.cmd, ...
//!
//! Bootstrap (first live refresh, needs network once):
//!   1. Copy bundled script + package.json into scrape-runtime
//!   2. Resolve Node (PATH, then portable Node in app data, then download portable Node)
//!   3. npm install playwright
//!   4. npx playwright install chromium
//!
//! After that, offline refreshes work (except grok.com itself).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

const BUNDLED_SCRIPT: &str = "fetch-usage.mjs";
const BUNDLED_PKG: &str = "package.json";
const MARKER: &str = ".bootstrap-ok";

/// Portable Node version for Windows x64 (LTS line). Bump when needed.
const PORTABLE_NODE_VERSION: &str = "v22.17.0";

pub struct ScrapeRuntime {
    pub runtime_dir: PathBuf,
    pub script_path: PathBuf,
    pub node_path: PathBuf,
}

/// Ensure runtime files + deps exist; return paths to run the scraper.
pub async fn ensure_runtime(app: &AppHandle) -> Result<ScrapeRuntime, String> {
    let runtime_dir = app_data_subdir(app, "scrape-runtime")?;
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Cannot create scrape-runtime dir: {e}"))?;

    sync_bundled_files(app, &runtime_dir)?;

    let node_path = resolve_or_install_node(app).await?;
    ensure_npm_deps(app, &runtime_dir, &node_path).await?;

    let script_path = runtime_dir.join(BUNDLED_SCRIPT);
    if !script_path.exists() {
        return Err(format!(
            "Scrape script missing at {}. Reinstall the app.",
            script_path.display()
        ));
    }

    Ok(ScrapeRuntime {
        runtime_dir,
        script_path,
        node_path,
    })
}

fn app_data_subdir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join(name);
    Ok(dir)
}

/// Copy fetch script + package.json from Tauri resources (install) or dev paths.
fn sync_bundled_files(app: &AppHandle, runtime_dir: &Path) -> Result<(), String> {
    let script_src = find_bundled_file(app, BUNDLED_SCRIPT)?;
    let pkg_src = find_bundled_file(app, BUNDLED_PKG)?;

    let script_dst = runtime_dir.join(BUNDLED_SCRIPT);
    let pkg_dst = runtime_dir.join(BUNDLED_PKG);

    // Always refresh script (selectors may improve between versions)
    fs::copy(&script_src, &script_dst)
        .map_err(|e| format!("Failed to copy scrape script: {e}"))?;

    // Refresh package.json if missing or different
    let should_copy_pkg = !pkg_dst.exists()
        || fs::read_to_string(&pkg_src).ok() != fs::read_to_string(&pkg_dst).ok();
    if should_copy_pkg {
        fs::copy(&pkg_src, &pkg_dst)
            .map_err(|e| format!("Failed to copy scrape package.json: {e}"))?;
        // Force re-bootstrap if package changed
        let _ = fs::remove_file(runtime_dir.join(MARKER));
    }

    Ok(())
}

fn find_bundled_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("resources").join("scrape").join(name));
        candidates.push(resource.join("scrape").join(name));
        candidates.push(resource.join(name));
    }

    // Dev: project scripts/ and src-tauri/resources/scrape/
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join(name));
        candidates.push(cwd.join("src-tauri").join("resources").join("scrape").join(name));
        candidates.push(cwd.join("resources").join("scrape").join(name));
        candidates.push(cwd.join("..").join("scripts").join(name));
        candidates.push(
            cwd.join("..")
                .join("src-tauri")
                .join("resources")
                .join("scrape")
                .join(name),
        );
    }

    // Next to the executable (portable layout)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("scrape").join(name));
            candidates.push(dir.join("scrape").join(name));
            candidates.push(dir.join("scripts").join(name));
        }
    }

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }

    Err(format!(
        "Could not find bundled scrape file '{name}'. Tried: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    ))
}

async fn resolve_or_install_node(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = find_node_on_path().await {
        return Ok(p);
    }

    let portable_root = app_data_subdir(app, "node-runtime")?;
    let portable_node = find_portable_node(&portable_root);
    if let Some(p) = portable_node {
        return Ok(p);
    }

    // Download portable Node (one-time) so shared installs work without system Node.
    download_portable_node(&portable_root).await?;
    find_portable_node(&portable_root).ok_or_else(|| {
        "Portable Node installed but node.exe not found. Check app data node-runtime folder."
            .into()
    })
}

async fn find_node_on_path() -> Option<PathBuf> {
    let mut cmd = Command::new("where");
    cmd.arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::win_process::hide_tokio_console(&mut cmd);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    let p = PathBuf::from(first);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn find_portable_node(root: &Path) -> Option<PathBuf> {
    // node-v22.x.x-win-x64/node.exe or nested
    if let Ok(entries) = fs::read_dir(root) {
        for ent in entries.flatten() {
            let p = ent.path();
            let candidate = if p.is_dir() {
                p.join("node.exe")
            } else {
                continue;
            };
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let direct = root.join("node.exe");
    if direct.exists() {
        return Some(direct);
    }
    None
}

async fn download_portable_node(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("node-runtime dir: {e}"))?;

    let ver = PORTABLE_NODE_VERSION;
    let folder = format!("node-{ver}-win-x64");
    let zip_name = format!("{folder}.zip");
    let url = format!("https://nodejs.org/dist/{ver}/{zip_name}");
    let zip_path = root.join(&zip_name);

    // PowerShell download + expand (available on all modern Windows)
    let ps = format!(
        "$ProgressPreference='SilentlyContinue'; \
         Invoke-WebRequest -Uri '{url}' -OutFile '{zip}'; \
         Expand-Archive -Path '{zip}' -DestinationPath '{dest}' -Force",
        url = url,
        zip = zip_path.display(),
        dest = root.display()
    );

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::win_process::hide_tokio_console(&mut cmd);
    let output = cmd.output().await.map_err(|e| {
        format!(
            "Failed to download portable Node ({e}).              Install Node.js LTS from https://nodejs.org and retry."
        )
    })?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Could not download portable Node from nodejs.org.\n{err}\n\
             Workaround: install Node.js LTS from https://nodejs.org then retry."
        ));
    }

    let _ = fs::remove_file(&zip_path);
    Ok(())
}

async fn ensure_npm_deps(
    app: &AppHandle,
    runtime_dir: &Path,
    node_path: &Path,
) -> Result<(), String> {
    let marker = runtime_dir.join(MARKER);
    let modules = runtime_dir.join("node_modules").join("playwright");
    if marker.exists() && modules.exists() {
        return Ok(());
    }

    let npm = resolve_npm(node_path)?;

    // npm install
    let mut install_cmd = Command::new(&npm);
    install_cmd
        .arg("install")
        .arg("--omit=dev")
        .arg("--no-fund")
        .arg("--no-audit")
        .current_dir(runtime_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::win_process::hide_tokio_console(&mut install_cmd);
    let install = install_cmd.output().await.map_err(|e| {
        format!(
            "npm install failed to start ({e}). Is Node/npm working? Path: {}",
            npm.display()
        )
    })?;

    if !install.status.success() {
        let err = String::from_utf8_lossy(&install.stderr);
        let out = String::from_utf8_lossy(&install.stdout);
        return Err(format!(
            "First-time scrape setup failed (npm install).\n{err}\n{out}"
        ));
    }

    // playwright install chromium (browsers go to default Playwright cache, often under user home)
    let npx = resolve_npx(node_path)?;
    let mut browsers_cmd = Command::new(&npx);
    browsers_cmd
        .args(["playwright", "install", "chromium"])
        .current_dir(runtime_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::win_process::hide_tokio_console(&mut browsers_cmd);
    let browsers = browsers_cmd
        .output()
        .await
        .map_err(|e| format!("playwright install failed to start: {e}"))?;

    if !browsers.status.success() {
        let err = String::from_utf8_lossy(&browsers.stderr);
        let out = String::from_utf8_lossy(&browsers.stdout);
        return Err(format!(
            "First-time scrape setup failed (playwright install chromium).\n{err}\n{out}\n\
             Need network once. Retry when online."
        ));
    }

    // Touch marker — also record where we put things for debugging
    let note = format!(
        "bootstrap ok\nnode={}\nruntime={}\nappdata={:?}\n",
        node_path.display(),
        runtime_dir.display(),
        app.path().app_data_dir().ok()
    );
    fs::write(&marker, note).map_err(|e| format!("write marker: {e}"))?;
    Ok(())
}

fn resolve_npm(node_path: &Path) -> Result<PathBuf, String> {
    // System npm.cmd on PATH
    let mut where_npm = std::process::Command::new("where");
    where_npm.arg("npm.cmd");
    crate::win_process::hide_std_console(&mut where_npm);
    if let Ok(output) = where_npm.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    // Portable Node ships npm.cmd next to node.exe
    if let Some(dir) = node_path.parent() {
        let npm = dir.join("npm.cmd");
        if npm.exists() {
            return Ok(npm);
        }
    }

    Err(
        "npm not found. Install Node.js LTS (includes npm) from https://nodejs.org"
            .into(),
    )
}

fn resolve_npx(node_path: &Path) -> Result<PathBuf, String> {
    let mut where_npx = std::process::Command::new("where");
    where_npx.arg("npx.cmd");
    crate::win_process::hide_std_console(&mut where_npx);
    if let Ok(output) = where_npx.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }
    if let Some(dir) = node_path.parent() {
        let npx = dir.join("npx.cmd");
        if npx.exists() {
            return Ok(npx);
        }
    }
    Err("npx not found (comes with Node.js)".into())
}
