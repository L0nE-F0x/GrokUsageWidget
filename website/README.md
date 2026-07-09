# Grok Usage — download site

Static landing page for the **Grok Usage** Windows widget.

## Netlify

1. New site from Git → this repo
2. **Base directory:** `website` (if the repo also contains the app source)
3. **Publish directory:** `.` (relative to base) or `website` if base is empty
4. Deploy

Put the installer at:

```text
website/downloads/Grok-Usage-Setup.exe
```

## Local preview

Open `index.html` in a browser, or:

```bash
npx serve website
```
