"""Make every rach3 logo and icon file from the one supplied logo image.

The logo is used as drawn: this only lifts it off its paper background, splits
the mark from the wordmark and places the mark on app icon tiles. Run it after
changing the logo source and commit the files it writes.

    python3 brand/make.py        (needs numpy and Pillow)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
# The supplied logo (1420 px wide), enlarged three times in Photoshop with
# Preserve Details 2.0 so the logo stays sharp at large sizes.
ORIGINAL = ROOT/'brand/rach3-logo-source.png'
SOURCE = ROOT/'brand/rach3-logo-source-3x.png'
PAPER = np.array([248, 245, 247], float)   # the source image's background
S = 3                                       # SOURCE pixels per pixel of the original logo
H_ASCENDER = slice(855*S, 906*S)            # the h's ascender reaches into the mark's floor shadow


def to_alpha(rgb):
    """Colour-to-alpha against the paper: identical on that paper, clean on any light page."""
    alpha = np.clip(((PAPER - rgb) / PAPER).max(axis=2), 0, 1)
    alpha = np.where(alpha < 0.035, 0, alpha)
    safe = np.where(alpha > 0, alpha, 1)[..., None]
    color = np.clip((rgb - (1 - alpha[..., None]) * PAPER) / safe, 0, 255)
    return Image.fromarray(np.dstack([color, alpha * 255]).astype(np.uint8), 'RGBA')


def on_dark(image):
    """The same artwork for dark backgrounds: the black ink turns white, the slate blue lightens."""
    rgba = np.asarray(image).astype(float)
    color, alpha = rgba[..., :3] / 255, rgba[..., 3:]
    ink = np.clip((0.55 - color @ [0.299, 0.587, 0.114]) / 0.55, 0, 1)[..., None]
    mixed = (color + (1 - color) * 0.35) * (1 - ink) + np.array([0.97, 0.97, 0.98]) * ink
    return Image.fromarray(np.dstack([mixed * 255, alpha]).astype(np.uint8), 'RGBA')


def trim(image, pad=4):
    left, top, right, bottom = image.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    return image.crop((max(0, left-pad), max(0, top-pad), min(image.width, right+pad), min(image.height, bottom+pad)))


def width(image, pixels):
    return image.resize((pixels, round(image.height * pixels / image.width)), Image.LANCZOS)


def height(image, pixels):
    return image.resize((round(image.width * pixels / image.height), pixels), Image.LANCZOS)


def lockup(mark, wordmark, scale):
    """The mark above the wordmark, the mark drawn smaller than in the source so the
    name carries the lockup. The mark keeps its slight lean to the right of the text."""
    art = width(mark, round(mark.width * scale))
    centre = wordmark.width / 2 + 0.0375 * art.width
    left = min(0, round(centre - art.width / 2))
    right = max(wordmark.width, round(centre + art.width / 2))
    gap = round(0.10 * wordmark.height)
    canvas = Image.new('RGBA', (right - left, art.height + gap + wordmark.height), (0, 0, 0, 0))
    canvas.alpha_composite(art, (round(centre - art.width / 2) - left, 0))
    canvas.alpha_composite(wordmark, (-left, art.height + gap))
    return canvas


def tile(mark, size, inset, radius, mark_width, shadow):
    """The mark on the logo's paper inside a rounded square. inset is the empty margin
    around the square on a 1024 canvas (the macOS icon grid uses 100)."""
    scale = 4
    big = size * scale
    inset, radius = inset * big / 1024, radius * big / 1024
    shape = Image.new('L', (big, big), 0)
    ImageDraw.Draw(shape).rounded_rectangle([inset, inset, big-inset-1, big-inset-1], radius=radius, fill=255)
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    if shadow:
        drop = round(10 * big / 1024)
        blur = shape.filter(ImageFilter.GaussianBlur(drop)).point(lambda v: int(v * 0.28))
        canvas.paste((0, 0, 0, 255), (0, drop), blur)
    gradient = Image.linear_gradient('L').resize((big, big))
    paper = Image.composite(Image.new('RGBA', (big, big), (236, 236, 242, 255)),
                            Image.new('RGBA', (big, big), (252, 250, 251, 255)), gradient)
    canvas.paste(paper, (0, 0), shape)
    art = width(mark, round(mark_width * big / 1024))
    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    body = big - 2 * inset
    layer.alpha_composite(art, ((big - art.width) // 2 + round(0.01 * body), (big - art.height) // 2 - round(0.01 * body)))
    layer.putalpha(ImageChops.multiply(layer.getchannel('A'), shape))
    return Image.alpha_composite(canvas, layer).resize((size, size), Image.LANCZOS)


def save(image, path, limit=2400):
    if image.width > limit:
        image = width(image, limit)
    path = ROOT/path
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print(path.relative_to(ROOT), f'{image.width}x{image.height}')


def main():
    rgb = np.asarray(Image.open(SOURCE).convert('RGB')).astype(float)
    rgb[:, 1300*S:] = PAPER                       # a faint scan line along the source's right edge
    top = rgb[:948*S].copy()
    top[936*S:, H_ASCENDER] = PAPER
    bottom = rgb[936*S:].copy()
    ascender = bottom[:12*S, H_ASCENDER].copy()
    bottom[:12*S] = PAPER
    bottom[:12*S, H_ASCENDER] = ascender

    logo, mark, wordmark = trim(to_alpha(rgb)), trim(to_alpha(top)), trim(to_alpha(bottom))
    save(logo, 'brand/rach3-logo-original.png')
    combined = lockup(mark, wordmark, 0.62)
    save(combined, 'brand/rach3-logo.png')
    save(mark, 'brand/rach3-mark.png')
    save(wordmark, 'brand/rach3-wordmark.png')
    save(on_dark(wordmark), 'brand/rach3-wordmark-on-dark.png')

    mac = tile(mark, 1024, 100, 185, 700, True)       # macOS icon grid: 824 square, soft shadow
    flat = tile(mark, 1024, 40, 200, 820, False)      # Windows and web: little margin, no shadow
    save(mac, 'brand/rach3-app-icon-macos.png')
    save(flat, 'brand/rach3-app-icon.png')

    # Website (shown at about half these sizes, so they stay sharp on Retina screens)
    save(width(combined, 600), 'site/assets/rach3-logo.png')
    save(height(wordmark, 56), 'site/assets/rach3-wordmark.png')
    save(width(mac, 256), 'site/assets/rach3-app-icon.png')
    save(tile(mark, 64, 0, 200, 900, False), 'site/assets/favicon.png')
    save(tile(mark, 180, 0, 0, 860, False), 'site/assets/apple-touch-icon.png')

    # The app's own header (dark)
    save(height(on_dark(wordmark), 40), 'assets/brand/rach3-wordmark-on-dark.png')

    # macOS: desktop/build.py turns this into Rach3.icns. Windows: the executable and installer icon.
    save(mac, 'desktop/AppIcon.png')
    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico = [tile(mark, s, 0 if s <= 32 else 40, 200, 900 if s <= 32 else 820, False) for s in sizes]
    ico[-1].save(ROOT/'windows/Rach3/Rach3.ico', sizes=[(s, s) for s in sizes], append_images=ico[:-1])
    print('windows/Rach3/Rach3.ico', sizes)


if __name__ == '__main__':
    main()
