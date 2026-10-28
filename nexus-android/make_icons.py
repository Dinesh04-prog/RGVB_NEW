"""Draws the Kirana POS app icon (white shopping cart on the app's dark blue) in every Android launcher size,
plus the 512 px icon for the Play Store listing and the web app. Run from this folder:  python make_icons.py
Needs Pillow (pip install Pillow)."""
import os
from PIL import Image, ImageDraw

BLUE = (10, 61, 98, 255)      # #0a3d62, the app's colour
GREEN = (22, 163, 74, 255)    # #16A34A
WHITE = (255, 255, 255, 255)
HERE = os.path.dirname(os.path.abspath(__file__))


def draw_icon(size: int, round_shape: bool) -> Image.Image:
    s = size * 4  # draw large, then shrink for smooth edges
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_shape:
        d.ellipse((0, 0, s - 1, s - 1), fill=BLUE)
    else:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BLUE)

    u = s / 100.0  # 1 unit = 1 % of the icon
    w = max(2, int(5.5 * u))
    # handle and basket outline
    d.line([(20 * u, 30 * u), (30 * u, 30 * u), (38 * u, 62 * u), (72 * u, 62 * u), (79 * u, 39 * u), (33 * u, 39 * u)],
           fill=WHITE, width=w, joint='curve')
    # basket fill stripes
    for x in (46, 55, 64):
        d.line([(x * u, 41 * u), ((x - 1) * u, 60 * u)], fill=WHITE, width=max(1, int(3 * u)))
    # wheels
    for cx in (43, 67):
        r = 6 * u
        d.ellipse((cx * u - r, 72 * u - r, cx * u + r, 72 * u + r), fill=WHITE)
    # green tick badge: "billed"
    r = 13 * u
    cx, cy = 74 * u, 24 * u
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GREEN)
    d.line([(cx - 6 * u, cy), (cx - 1.5 * u, cy + 5 * u), (cx + 7 * u, cy - 5 * u)], fill=WHITE, width=max(2, int(3.5 * u)), joint='curve')
    return img.resize((size, size), Image.LANCZOS)


SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for dpi, px in SIZES.items():
    out = os.path.join(HERE, 'app', 'src', 'main', 'res', f'mipmap-{dpi}')
    os.makedirs(out, exist_ok=True)
    draw_icon(px, False).save(os.path.join(out, 'ic_launcher.png'))
    draw_icon(px, True).save(os.path.join(out, 'ic_launcher_round.png'))

# Play Store listing icon (512×512, full square: Play adds its own rounding) and the web app icon
play = Image.new('RGBA', (512, 512), BLUE)
play.alpha_composite(draw_icon(512, False))
play.convert('RGB').save(os.path.join(HERE, 'play-store-icon-512.png'))
web_public = os.path.join(HERE, '..', 'nexus-react-pos', 'public')
draw_icon(512, False).save(os.path.join(web_public, 'app-icon-512.png'))
draw_icon(192, False).save(os.path.join(web_public, 'app-icon-192.png'))
print('icons written')
