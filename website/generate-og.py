"""Generate 1200x630 Open Graph / X card image for Grok Usage."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "og.png"
ICON = ROOT / "icon.png"

W, H = 1200, 630
BG = (7, 7, 9, 255)
ACCENT = (212, 160, 23, 255)
TEXT = (244, 244, 246, 255)
MUTED = (154, 154, 166, 255)
CARD = (17, 17, 22, 255)
BORDER = (42, 42, 50, 255)
GREEN = (62, 207, 142, 255)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\calibrib.ttf" if bold else r"C:\Windows\Fonts\calibri.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main() -> None:
    img = Image.new("RGBA", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Soft gold glow top-center
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W // 2 - 380, -220, W // 2 + 380, 340], fill=(212, 160, 23, 55))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # Subtle grid
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        gdraw.line([(x, 0), (x, H)], fill=(255, 255, 255, 8))
    for y in range(0, H, 48):
        gdraw.line([(0, y), (W, y)], fill=(255, 255, 255, 8))
    # fade grid toward bottom
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    for y in range(H):
        a = int(180 * max(0, 1 - y / (H * 0.75)))
        md.line([(0, y), (W, y)], fill=a)
    grid.putalpha(mask)
    img = Image.alpha_composite(img, grid)
    draw = ImageDraw.Draw(img)

    # Left copy
    title_f = font(64, bold=True)
    sub_f = font(28, bold=False)
    tag_f = font(20, bold=True)
    small_f = font(22, bold=False)

    # Tag pill
    tag = "WINDOWS DESKTOP WIDGET"
    tag_bbox = draw.textbbox((0, 0), tag, font=tag_f)
    tw, th = tag_bbox[2] - tag_bbox[0], tag_bbox[3] - tag_bbox[1]
    pill = [72, 120, 72 + tw + 36, 120 + th + 20]
    rounded_rect(draw, pill, 999, (212, 160, 23, 28), outline=(212, 160, 23, 70), width=2)
    draw.text((90, 128), tag, font=tag_f, fill=ACCENT)

    draw.text((72, 190), "Grok Usage", font=title_f, fill=TEXT)
    draw.text(
        (72, 275),
        "Your Weekly SuperGrok limit,\nalways in sight.",
        font=sub_f,
        fill=MUTED,
        spacing=8,
    )
    draw.text(
        (72, 380),
        "Live % · Sleek pill mode · Tray tooltip\nFree for Windows 10/11",
        font=small_f,
        fill=(120, 120, 132, 255),
        spacing=6,
    )

    # Right: mini widget card
    card = [680, 95, 1130, 520]
    rounded_rect(draw, card, 22, CARD, outline=BORDER, width=2)

    # titlebar
    draw.rectangle([680, 95, 1130, 145], fill=(20, 20, 26, 255))
    # clip top corners by redrawing - simple line under titlebar
    draw.line([(680, 145), (1130, 145)], fill=BORDER, width=1)
    draw.text((708, 110), "✦  Weekly SuperGrok Limit", font=font(20, bold=True), fill=TEXT)

    # overall
    draw.text((708, 175), "49% USED", font=font(16, bold=True), fill=MUTED)
    draw.text((1000, 165), "49%", font=font(36, bold=True), fill=TEXT)

    # progress track
    bar = [708, 220, 1102, 234]
    rounded_rect(draw, bar, 999, (20, 20, 26, 255), outline=BORDER, width=1)
    # fill ~49%
    fill_w = int((1102 - 708) * 0.49)
    rounded_rect(draw, [708, 220, 708 + fill_w, 234], 999, GREEN)

    # categories
    cats = [("Grok Build", 0.32), ("Chat", 0.12), ("API", 0.05)]
    y = 270
    for name, p in cats:
        draw.text((708, y), name, font=font(18, bold=False), fill=TEXT)
        draw.text((1055, y), f"{int(p*100)}%", font=font(18, bold=True), fill=MUTED)
        y += 28
        rounded_rect(draw, [708, y, 1102, y + 8], 999, (20, 20, 26, 255), outline=BORDER, width=1)
        fw = int((1102 - 708) * p)
        rounded_rect(draw, [708, y, 708 + fw, y + 8], 999, ACCENT if p > 0.2 else GREEN)
        y += 28

    # reset box
    rounded_rect(draw, [708, 430, 1102, 490], 12, (20, 20, 26, 255), outline=BORDER, width=1)
    draw.text((724, 442), "Resets July 12, 2026", font=font(18, bold=True), fill=TEXT)
    draw.text((724, 466), "at 10:50 AM", font=font(15), fill=MUTED)

    # Floating pill badge
    pill_box = [820, 545, 1110, 600]
    rounded_rect(draw, pill_box, 999, (14, 14, 18, 255), outline=BORDER, width=2)
    draw.text((848, 560), "✦  49%", font=font(22, bold=True), fill=TEXT)
    rounded_rect(draw, [940, 568, 1010, 578], 999, (20, 20, 26, 255))
    rounded_rect(draw, [940, 568, 974, 578], 999, GREEN)
    draw.text((1020, 562), "used", font=font(16), fill=MUTED)

    # App icon badge bottom-left of card
    if ICON.exists():
        icon = Image.open(ICON).convert("RGBA").resize((72, 72), Image.Resampling.LANCZOS)
        # rounded mask
        mask = Image.new("L", (72, 72), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, 71, 71], radius=16, fill=255)
        img.paste(icon, (72, 470), mask)

    # URL footer
    draw.text((160, 495), "grok-usage.netlify.app", font=font(20, bold=True), fill=ACCENT)

    # Ensure RGB PNG (some crawlers prefer no alpha)
    final = Image.new("RGB", (W, H), (7, 7, 9))
    final.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
    final.save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes) {final.size}")


if __name__ == "__main__":
    main()
