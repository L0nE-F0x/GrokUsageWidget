# Grok Usage — download site

Static landing page + Windows installer. **No Node build.**

## Netlify (important)

This monorepo also contains the Tauri app source. Netlify must **not** use the root `package.json` (it would install Playwright and hang).

### Recommended settings

| Setting | Value |
|--------|--------|
| Base directory | `website` |
| Build command | *(empty)* or leave as in `netlify.toml` |
| Publish directory | `.` (relative to base) |

The **root** `netlify.toml` sets `base = "website"` so deploys stay static even if UI settings are wrong.

### After changing Netlify config

Trigger a clear cache and redeploy once.

## Installer

```text
website/downloads/Grok-Usage-Setup.exe
```

Replace this file when you ship a new app build, then commit + push.
