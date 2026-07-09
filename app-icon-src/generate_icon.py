"""Generate Grok Usage app icon (dark + gold sparkle + usage arc)."""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = Path(__file__).resolve().parent
SIZE = 1024

BG = (12, 12, 14, 255)  # #0c0c0e
BG_GRAD_TOP = (22, 22, 28, 255)
ACCENT = (212, 160, 23, 255)  # #d4a017
ACCENT_GLOW = (212, 160, 23, 55)
WHITE_GOLD = (255, 220, 120, 255)
TRACK = (42, 42, 50, 255)
BORDER = (42, 42, 50, 220)


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    radius = int(SIZE * 0.22)

    # Rounded gradient background
    grad = Image.new("RGBA", (SIZE, SIZE), BG)
    gdraw = ImageDraw.Draw(grad)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = int(BG_GRAD_TOP[0] * (1 - t) + BG[0] * t)
        g = int(BG_GRAD_TOP[1] * (1 - t) + BG[1] * t)
        b = int(BG_GRAD_TOP[2] * (1 - t) + BG[2] * t)
        gdraw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255
    )
    bg = Image.composite(grad, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask)
    img = Image.alpha_composite(img, bg)

    cx = cy = SIZE // 2

    # Soft gold glow
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_r = int(SIZE * 0.28)
    ImageDraw.Draw(glow).ellipse(
        [cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r], fill=ACCENT_GLOW
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(SIZE * 0.08)))
    img = Image.alpha_composite(img, glow)

    # Usage ring track + progress arc (~72%)
    ring_outer = int(SIZE * 0.38)
    ring_inner = int(SIZE * 0.30)
    bbox = [cx - ring_outer, cy - ring_outer, cx + ring_outer, cy + ring_outer]
    width = max(8, int(SIZE * 0.05))
    r_mid = (ring_outer + ring_inner) / 2.0

    track_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(track_layer).arc(bbox, start=0, end=360, fill=TRACK, width=width)
    img = Image.alpha_composite(img, track_layer)

    # Pillow angles: 0 at 3 o'clock, increasing counter-clockwise. Top = 90°.
    pct = 0.72
    end = 90
    start = 90 - int(360 * pct)

    arc_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_layer)
    ad.arc(bbox, start=start, end=end, fill=ACCENT, width=width)
    for ang_deg in (start, end):
        a = math.radians(ang_deg)
        x = cx + r_mid * math.cos(a)
        y = cy - r_mid * math.sin(a)
        cr = width / 2.0
        ad.ellipse([x - cr, y - cr, x + cr, y + cr], fill=ACCENT)
    img = Image.alpha_composite(img, arc_layer)

    # Four-pointed sparkle (matches widget logo mark ✦)
    sparkle = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sparkle)

    def star_points(outer: float, inner: float, ox: float = 0.0, oy: float = 0.0):
        pts = []
        for i in range(8):
            ang = math.radians(-90 + i * 45)
            r = outer if i % 2 == 0 else inner
            pts.append((cx + ox + r * math.cos(ang), cy + oy + r * math.sin(ang)))
        return pts

    sd.polygon(star_points(SIZE * 0.22, SIZE * 0.07), fill=ACCENT)
    sd.polygon(
        star_points(SIZE * 0.11, SIZE * 0.032, -SIZE * 0.018, -SIZE * 0.018),
        fill=WHITE_GOLD,
    )
    img = Image.alpha_composite(img, sparkle)

    # Subtle border
    border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [3, 3, SIZE - 4, SIZE - 4],
        radius=radius,
        outline=BORDER,
        width=max(2, SIZE // 256),
    )
    img = Image.alpha_composite(img, border)

    master = OUT_DIR / "app-icon.png"
    img.save(master, "PNG")
    print(f"Saved {master} {img.size} {img.mode}")
    print("center", img.getpixel((SIZE // 2, SIZE // 2)))
    print("corner", img.getpixel((0, 0)))


if __name__ == "__main__":
    main()
