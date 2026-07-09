# Grok Usage Widget

Personal Windows desktop widget for **Weekly SuperGrok Limit** usage.

**Stack:** Tauri v2 + Vite/TypeScript + Playwright (persistent browser context)

## Repository layout

| Path | Purpose |
|------|---------|
| `src/`, `src-tauri/`, `index.html`, … | The desktop **app** source |
| `website/` | **Netlify** download landing page + installer |
| `netlify.toml` | Forces Netlify to deploy **only** `website/` (static, no npm) |

Netlify should never build the Tauri app from this repo.

## Download (end users)

Share your Netlify URL. The installer is served from:

```text
website/downloads/Grok-Usage-Setup.exe
```

## Develop the app

```bash
npm install
npm run tauri dev
```

## Build installer

```bash
npm install
npm run tauri build
```

Then copy the NSIS setup exe to `website/downloads/Grok-Usage-Setup.exe` and push if you want the site updated.

## Notes

- Close window = hide to tray; tray → Quit to exit
- Tray hover shows current SuperGrok % used
- Sleek mode = compact always-on-top pill while coding
- Personal-use tool; unofficial — not affiliated with xAI or Grok
