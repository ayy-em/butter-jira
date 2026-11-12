# Stitches the README's three screenshots into assets/screenshots/carousel.webp:
# an animated WebP that holds each screen for four seconds, crossfades to the
# next, and marks the one on screen in a tab strip underneath. GitHub strips
# scripts from a README, so an animated image is the only carousel it renders.
#
# Documentation tooling, never packaged. Needs Pillow built with WebP:
#   python3 scripts/screenshot-carousel.py
# Run it after retaking the PNGs (see "Preview harnesses" in the README).
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "assets", "screenshots")
SHOTS = [
    ("dashboard-team-overview.png", "Sprint dashboard"),
    ("standup-speaker.png", "Standup"),
    ("kanban.png", "Kanban"),
]
W, H, BAR = 1512, 945, 72
HOLD_MS, FADE_STEPS, FADE_MS = 4000, 8, 55
# The app's dark tokens (css/app.css): --bg, --surface, --text, a muted grey, --accent-primary.
BG, SURF, TEXT, MUTED, ACC = (13, 15, 18), (22, 25, 32), (232, 234, 240), (120, 126, 140), (79, 142, 247)


def load_font(size):
    for path, index in (("/System/Library/Fonts/HelveticaNeue.ttc", 1), ("DejaVuSans-Bold.ttf", 0)):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default(size)


FONT = load_font(26)
IMGS = [Image.open(os.path.join(DIR, f)).convert("RGB").resize((W, H), Image.LANCZOS) for f, _ in SHOTS]


def frame(i, j=None, t=0.0):
    canvas = Image.new("RGB", (W, H + BAR), BG)
    canvas.paste(IMGS[i] if j is None else Image.blend(IMGS[i], IMGS[j], t), (0, 0))
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, H, W, H + BAR], fill=SURF)
    active = i if (j is None or t < 0.5) else j
    seg = W // len(SHOTS)
    for k, (_, label) in enumerate(SHOTS):
        x0 = k * seg
        text = f"{k + 1}  {label}"
        tw = d.textlength(text, font=FONT)
        d.text((x0 + (seg - tw) / 2, H + 20), text, font=FONT, fill=TEXT if k == active else MUTED)
        if k == active:
            d.rectangle([x0 + 24, H, x0 + seg - 24, H + 4], fill=ACC)
    return canvas


frames, durations = [], []
for i in range(len(SHOTS)):
    j = (i + 1) % len(SHOTS)
    frames.append(frame(i))
    durations.append(HOLD_MS)
    for s in range(1, FADE_STEPS):
        frames.append(frame(i, j, s / FADE_STEPS))
        durations.append(FADE_MS)

out = os.path.join(DIR, "carousel.webp")
frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=82, method=6)
print(f"wrote {os.path.relpath(out, ROOT)}: {len(frames)} frames, {os.path.getsize(out) // 1024} KB")
