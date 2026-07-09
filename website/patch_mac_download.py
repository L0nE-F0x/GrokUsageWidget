"""Add macOS download button (coming soon) alongside Windows."""
from __future__ import annotations

import re
from pathlib import Path

p = Path(__file__).with_name("index.html")
t = p.read_text(encoding="utf-8")

t = t.replace(
    '<a class="nav-cta" href="/downloads/Grok-Usage-Setup.exe" download>Download</a>',
    '<a class="nav-cta" href="#install">Download</a>',
)

t = re.sub(
    r"Windows 10 / 11 .{1,3} Free .{1,3} Personal use",
    "Windows now · macOS soon · Free · Personal use",
    t,
)

old_cta = """          <div class=\"cta-row\">
            <a class=\"btn primary\" href=\"/downloads/Grok-Usage-Setup.exe\" download>
              <svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\">
                <path d=\"M12 3v12M7 10l5 5 5-5M5 21h14\"/>
              </svg>
              Download for Windows
            </a>
            <a class=\"btn ghost\" href=\"#install\">Installation steps</a>
          </div>"""

new_cta = """          <div class=\"cta-row platform-ctas\">
            <a class=\"btn primary\" href=\"/downloads/Grok-Usage-Setup.exe\" download>
              <svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\">
                <path d=\"M12 3v12M7 10l5 5 5-5M5 21h14\"/>
              </svg>
              Windows
            </a>
            <a class=\"btn ghost platform-soon\" href=\"#macos\" aria-disabled=\"true\" title=\"macOS build coming soon\">
              <svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">
                <path d=\"M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z\"/>
              </svg>
              macOS
              <span class=\"soon-badge\">Soon</span>
            </a>
            <a class=\"btn ghost\" href=\"#install\">How to install</a>
          </div>"""

if old_cta not in t:
    raise SystemExit("CTA block not found")
t = t.replace(old_cta, new_cta)

m = re.search(r'<aside class="download-card">[\s\S]*?</aside>', t)
if not m:
    raise SystemExit("download card not found")

new_card = """          <aside class="download-card" id="download">
            <img src="/icon.png" alt="" width="56" height="56" class="download-icon" />
            <h3>Grok Usage</h3>
            <p class="download-meta">Free · unofficial personal tool</p>
            <div class="platform-stack">
              <a class="btn primary block" href="/downloads/Grok-Usage-Setup.exe" download>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>
                </svg>
                Download for Windows
              </a>
              <a class="btn ghost block platform-soon" href="#macos" id="macos" aria-disabled="true" title="macOS build coming soon — needs a signed .dmg built on a Mac">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
                macOS
                <span class="soon-badge">Coming soon</span>
              </a>
            </div>
            <p class="download-note">
              Windows x64 installer ready now. macOS (.dmg) needs a Mac build —
              not available yet. Unofficial · not affiliated with xAI or Grok.
            </p>
          </aside>"""
t = t[: m.start()] + new_card + t[m.end() :]

t = t.replace(
    "One small installer. First live refresh may take longer while helpers download.",
    "Windows installer is ready. First live refresh may take longer while helpers download.",
)

t = t.replace(
    """                <h3>Download the installer</h3>
                <p>
                  Get
                  <a href="/downloads/Grok-Usage-Setup.exe" download>Grok-Usage-Setup.exe</a>
                  (~2&nbsp;MB).
                </p>""",
    """                <h3>Download the installer</h3>
                <p>
                  <strong>Windows:</strong>
                  <a href="/downloads/Grok-Usage-Setup.exe" download>Grok-Usage-Setup.exe</a>
                  (~2&nbsp;MB).
                  <strong>macOS:</strong> coming soon.
                </p>""",
)

t = t.replace(
    "A sleek Windows desktop widget for your Weekly SuperGrok limit.",
    "A sleek desktop widget for your Weekly SuperGrok limit (Windows now, macOS soon).",
)
t = t.replace(
    "Free personal Windows app.",
    "Free personal app for Windows (macOS coming soon).",
)

p.write_text(t, encoding="utf-8")
print("index.html patched")
