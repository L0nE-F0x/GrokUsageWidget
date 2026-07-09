# Grok Usage Widget

Personal Windows desktop widget for **Weekly SuperGrok Limit** usage.

**Stack:** Tauri v2 + Vite/TypeScript + Playwright (persistent browser context)

## Download (friends & family)

Use the landing site / installer:

- Landing page source: [`website/`](./website/)
- Installer path after build: `src-tauri/target/release/bundle/nsis/Grok Usage_*_x64-setup.exe`
- Site download file: `website/downloads/Grok-Usage-Setup.exe`

## Install (end users)

1. Download and run **Grok-Usage-Setup.exe**
2. Start **Grok Usage** from the Start Menu
3. Click **Connect my Grok account** and sign in when the browser opens
4. Wait for usage numbers (first run can take a few minutes while Chromium downloads)

### Data locations (per user)

| Data | Path |
|------|------|
| Settings | `%AppData%\com.personal.grok-usage-widget\settings.json` |
| Grok login (Playwright) | `%AppData%\com.personal.grok-usage-widget\playwright-profile\` |
| Scrape runtime | `%AppData%\com.personal.grok-usage-widget\scrape-runtime\` |

**Do not** share your `playwright-profile` folder — that is your session.

## Develop

```bash
npm install
npm run tauri dev
```

## Build installer

```bash
npm install
npm run tauri build
```

Copy the NSIS setup exe to `website/downloads/Grok-Usage-Setup.exe` for the Netlify site.

## Netlify

Connect this repo in Netlify:

- **Base directory:** `website`
- **Publish directory:** `.` (or leave default for that base)
- **Build command:** none (static files)

## Notes

- Close window = hide to tray; tray → Quit to exit
- Personal-use tool; not multi-account SaaS
- Unofficial — not affiliated with xAI or Grok
