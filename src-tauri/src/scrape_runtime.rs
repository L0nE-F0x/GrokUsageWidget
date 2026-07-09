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

/// Portable Node version (LTS). Bump when needed.
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
    if let Some(p) = find_portable_node(&portable_root) {
        return Ok(p);
    }

    download_portable_node(&portable_root).await?;
    find_portable_node(&portable_root).ok_or_else(|| {
        format!(
            "Portable Node installed but node binary not found under {}. Install Node.js LTS from https://nodejs.org and retry.",
            portable_root.display()
        )
    })
}

async fn find_node_on_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("where");
        c.arg("node");
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("which");
        c.arg("node");
        c
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
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

fn node_binary_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn find_portable_node(root: &Path) -> Option<PathBuf> {
    let bin = node_binary_name();
    if let Ok(entries) = fs::read_dir(root) {
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_dir() {
                continue;
            }
            // Windows: node-vX-win-x64/node.exe
            // macOS/Linux: node-vX-darwin-arm64/bin/node
            for c in [p.join(bin), p.join("bin").join(bin)] {
                if c.exists() {
                    return Some(c);
                }
            }
        }
    }
    let direct = root.join(bin);
    if direct.exists() {
        return Some(direct);
    }
    let nested = root.join("bin").join(bin);
    if nested.exists() {
        return Some(nested);
    }
    None
}

/// Returns (dist folder name, archive file name, is_zip).
fn portable_node_artifact() -> Option<(String, String, bool)> {
    let ver = PORTABLE_NODE_VERSION;
    if cfg!(all(windows, target_arch = "x86_64")) {
        let folder = format!("node-{ver}-win-x64");
        return Some((folder.clone(), format!("{folder}.zip"), true));
    }
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        let folder = format!("node-{ver}-darwin-arm64");
        return Some((folder.clone(), format!("{folder}.tar.gz"), false));
    }
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        let folder = format!("node-{ver}-darwin-x64");
        return Some((folder.clone(), format!("{folder}.tar.gz"), false));
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        let folder = format!("node-{ver}-linux-x64");
        return Some((folder.clone(), format!("{folder}.tar.gz"), false));
    }
    if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        let folder = format!("node-{ver}-linux-arm64");
        return Some((folder.clone(), format!("{folder}.tar.gz"), false));
    }
    None
}

async fn download_portable_node(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("node-runtime dir: {e}"))?;

    let ver = PORTABLE_NODE_VERSION;
    let (folder, archive_name, is_zip) = portable_node_artifact().ok_or_else(|| {
        "Automatic portable Node is not supported on this platform. Install Node.js LTS from https://nodejs.org".to_string()
    })?;
    let _ = folder;
    let url = format!("https://nodejs.org/dist/{ver}/{archive_name}");
    let archive_path = root.join(&archive_name);

    if cfg!(windows) {
        let ps = format!(
            "$ProgressPreference='SilentlyContinue'; \
             Invoke-WebRequest -Uri '{url}' -OutFile '{zip}'; \
             Expand-Archive -Path '{zip}' -DestinationPath '{dest}' -Force",
            url = url,
            zip = archive_path.display(),
            dest = root.display()
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::win_process::hide_tokio_console(&mut cmd);
        let output = cmd.output().await.map_err(|e| {
            format!(
                "Failed to download portable Node ({e}). Install Node.js LTS from https://nodejs.org and retry."
            )
        })?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Could not download portable Node from nodejs.org.\n{err}\n\
                 Workaround: install Node.js LTS from https://nodejs.org then retry."
            ));
        }
        let _ = fs::remove_file(&archive_path);
        let _ = is_zip;
        return Ok(());
    }

    // macOS / Linux: curl + tar
    let mut dl = Command::new("curl");
    dl.args(["-fsSL", &url, "-o"])
        .arg(&archive_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::win_process::hide_tokio_console(&mut dl);
    let output = dl.output().await.map_err(|e| {
        format!(
            "Failed to download portable Node with curl ({e}). Install Node.js LTS from https://nodejs.org and retry."
        )
    })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Could not download portable Node from nodejs.org.\n{err}\n\
             Workaround: install Node.js LTS from https://nodejs.org then retry."
        ));
    }

    let mut tar = Command::new("tar");
    tar.args(["-xzf"])
        .arg(&archive_path)
        .arg("-C")
        .arg(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::win_process::hide_tokio_console(&mut tar);
    let extract = tar
        .output()
        .await
        .map_err(|e| format!("Failed to extract portable Node archive: {e}"))?;
    if !extract.status.success() {
        let err = String::from_utf8_lossy(&extract.stderr);
        return Err(format!("Could not extract portable Node.\n{err}"));
    }
    let _ = fs::remove_file(&archive_path);
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

    let note = format!(
        "bootstrap ok\nnode={}\nruntime={}\nappdata={:?}\n",
        node_path.display(),
        runtime_dir.display(),
        app.path().app_data_dir().ok()
    );
    fs::write(&marker, note).map_err(|e| format!("write marker: {e}"))?;
    Ok(())
}

fn path_from_which_output(output: &std::process::Output) -> Option<PathBuf> {
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let p = PathBuf::from(line);
    p.exists().then_some(p)
}

fn resolve_npm(node_path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let mut where_npm = std::process::Command::new("where");
        where_npm.arg("npm.cmd");
        crate::win_process::hide_std_console(&mut where_npm);
        if let Ok(output) = where_npm.output() {
            if let Some(p) = path_from_which_output(&output) {
                return Ok(p);
            }
        }
        if let Some(dir) = node_path.parent() {
            let npm = dir.join("npm.cmd");
            if npm.exists() {
                return Ok(npm);
            }
        }
    }

    #[cfg(not(windows))]
    {
        let mut which_npm = std::process::Command::new("which");
        which_npm.arg("npm");
        crate::win_process::hide_std_console(&mut which_npm);
        if let Ok(output) = which_npm.output() {
            if let Some(p) = path_from_which_output(&output) {
                return Ok(p);
            }
        }
        if let Some(dir) = node_path.parent() {
            let npm = dir.join("npm");
            if npm.exists() {
                return Ok(npm);
            }
        }
    }

    Err(
        "npm not found. Install Node.js LTS (includes npm) from https://nodejs.org"
            .into(),
    )
}

fn resolve_npx(node_path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let mut where_npx = std::process::Command::new("where");
        where_npx.arg("npx.cmd");
        crate::win_process::hide_std_console(&mut where_npx);
        if let Ok(output) = where_npx.output() {
            if let Some(p) = path_from_which_output(&output) {
                return Ok(p);
            }
        }
        if let Some(dir) = node_path.parent() {
            let npx = dir.join("npx.cmd");
            if npx.exists() {
                return Ok(npx);
            }
        }
    }

    #[cfg(not(windows))]
    {
        let mut which_npx = std::process::Command::new("which");
        which_npx.arg("npx");
        crate::win_process::hide_std_console(&mut which_npx);
        if let Ok(output) = which_npx.output() {
            if let Some(p) = path_from_which_output(&output) {
                return Ok(p);
            }
        }
        if let Some(dir) = node_path.parent() {
            let npx = dir.join("npx");
            if npx.exists() {
                return Ok(npx);
            }
        }
    }

    Err("npx not found (comes with Node.js)".into())
}
