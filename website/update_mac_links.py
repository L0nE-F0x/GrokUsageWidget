"""Point macOS download buttons at GitHub Releases latest (placeholder until CI publishes)."""
from __future__ import annotations

from pathlib import Path

# Prefer latest release asset naming from tauri-action; users land on the releases page
# until we know the exact dmg filename from the first successful build.
RELEASES = "https://github.com/L0nE-F0x/GrokUsageWidget/releases/latest"
# Direct asset URLs work once CI has published; until then the releases page is safer.
MAC_SILICON = RELEASES
MAC_INTEL = RELEASES

p = Path(__file__).with_name("index.html")
t = p.read_text(encoding="utf-8")

# Replace disabled "coming soon" anchors with live release links
old_blocks = [
    (
        'class="btn ghost platform-soon" href="#macos" aria-disabled="true" title="macOS build coming soon"',
        f'class="btn ghost" href="{MAC_SILICON}" target="_blank" rel="noopener" title="Download macOS build from GitHub Releases"',
    ),
    (
        'class="btn ghost block platform-soon" href="#macos" id="macos" aria-disabled="true" title="macOS build coming soon — needs a signed .dmg built on a Mac"',
        f'class="btn ghost block" href="{MAC_SILICON}" id="macos" target="_blank" rel="noopener" title="Download macOS build from GitHub Releases"',
    ),
]

for a, b in old_blocks:
    if a in t:
        t = t.replace(a, b)
        print("replaced", a[:40])
    else:
        print("missing", a[:50])

# Badge text
t = t.replace(">Soon</span>", ">Releases</span>")
t = t.replace(">Coming soon</span>", ">GitHub Releases</span>")

# Notes
t = t.replace(
    "Windows x64 installer ready now. macOS (.dmg) needs a Mac build —\n              not available yet. Unofficial · not affiliated with xAI or Grok.",
    "Windows installer on this site. macOS builds ship via GitHub Actions Releases (Apple Silicon + Intel). Unsigned: right-click → Open the first time. Unofficial · not affiliated with xAI or Grok.",
)
t = t.replace(
    "<strong>macOS:</strong> coming soon.",
    f'<strong>macOS:</strong> <a href="{RELEASES}" target="_blank" rel="noopener">GitHub Releases</a>.',
)

# Soften "soon" pill tag
t = t.replace(
    "Windows now · macOS soon · Free · Personal use",
    "Windows · macOS (CI) · Free · Personal use",
)

# Remove the alert script for platform-soon (buttons are real links now)
import re

t = re.sub(
    r"\s*<script>\s*document\.querySelectorAll\('\.platform-soon'\)[\s\S]*?</script>\s*",
    "\n",
    t,
    count=1,
)

p.write_text(t, encoding="utf-8")
print("website mac links updated")
