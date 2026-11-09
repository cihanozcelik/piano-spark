"""Make every rach3 logo and icon file from the supplied images.

The app icons, favicons and the website's hero come from the artwork of the
pianist under the moon (brand/rach3-artwork.png, on its black stage). The
written name, rach3, is lifted off the paper of the first logo drawing. Run it
after changing either image and commit the files it writes.

    python3 brand/make.py        (needs numpy and Pillow)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
# The first logo drawing (brand/rach3-logo-source.png, 1420 px wide), enlarged three
# times in Photoshop with Preserve Details 2.0 so the wordmark stays sharp.
SOURCE = ROOT/'brand/rach3-logo-source-3x.png'
PAPER = np.array([248, 245, 247], float)   # the source image's background
S = 3                                       # SOURCE pixels per pixel of the original logo
H_ASCENDER = slice(855*S, 906*S)            # the h's ascender reaches into the mark's floor shadow
ARTWORK = ROOT/'brand/rach3-artwork.png'    # 1254 px square, black background
ART_CENTRE = (640, 600)                     # middle of the pianist and the moon in ARTWORK
HERO_CROP = (170, 220, 1130, 990)           # the website hero: the whole scene with room for its glow


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


def art_square(art, side):
    """A square of the artwork around the pianist and the moon, still on its black stage."""
    cx, cy = ART_CENTRE
    return art.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))


def tile(art, size, inset, radius, side, shadow):
    """The artwork inside a rounded black square. inset is the empty margin around the
    square on a 1024 canvas (the macOS icon grid uses 100); side is how much of the
    artwork (in its own pixels) the square shows."""
    scale = 4
    big = size * scale
    inset, radius = inset * big / 1024, radius * big / 1024
    shape = Image.new('L', (big, big), 0)
    ImageDraw.Draw(shape).rounded_rectangle([inset, inset, big-inset-1, big-inset-1], radius=radius, fill=255)
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    if shadow:
        drop = round(10 * big / 1024)
        blur = shape.filter(ImageFilter.GaussianBlur(drop)).point(lambda v: int(v * 0.35))
        canvas.paste((0, 0, 0, 255), (0, drop), blur)
    body = round(big - 2 * inset)
    square = art_square(art, side).convert('RGBA').resize((body, body), Image.LANCZOS)
    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    layer.paste(square, (round(inset), round(inset)))
    layer.putalpha(shape)
    canvas = Image.alpha_composite(canvas, layer)
    if shadow:
        # a hairline of light around the black square so it does not vanish on a dark Dock
        rim = Image.new('L', (big, big), 0)
        ImageDraw.Draw(rim).rounded_rectangle([inset, inset, big-inset-1, big-inset-1], radius=radius,
                                              outline=255, width=max(1, round(2 * big / 1024)))
        canvas.alpha_composite(Image.merge('RGBA', [Image.new('L', (big, big), 255)] * 3 + [rim.point(lambda v: v * 30 // 255)]))
    return canvas.resize((size, size), Image.LANCZOS)


def stage(art):
    """The artwork for the website's dark hero: the black stage becomes see-through, so the
    pianist sits on the page's own black without a visible box."""
    rgb = np.asarray(art.crop(HERO_CROP).convert('RGB')).astype(float) / 255
    alpha = np.clip((rgb.max(axis=2) - 0.02) / 0.98, 0, 1)
    color = np.clip(rgb / np.maximum(alpha, 1e-4)[..., None], 0, 1)
    return Image.fromarray(np.dstack([color * 255, alpha * 255]).astype(np.uint8), 'RGBA')


def save(image, path, limit=2400):
    if image.width > limit:
        image = width(image, limit)
    path = ROOT/path
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print(path.relative_to(ROOT), f'{image.width}x{image.height}')


def main():
    # The wordmark still comes from the first logo drawing.
    rgb = np.asarray(Image.open(SOURCE).convert('RGB')).astype(float)
    rgb[:, 1300*S:] = PAPER                       # a faint scan line along the source's right edge
    bottom = rgb[936*S:].copy()
    ascender = bottom[:12*S, H_ASCENDER].copy()
    bottom[:12*S] = PAPER
    bottom[:12*S, H_ASCENDER] = ascender
    wordmark = trim(to_alpha(bottom))
    save(wordmark, 'brand/rach3-wordmark.png')
    save(on_dark(wordmark), 'brand/rach3-wordmark-on-dark.png')

    # Everything else comes from the pianist under the moon.
    art = Image.open(ARTWORK).convert('RGB')
    mac = tile(art, 1024, 100, 185, 820, True)        # macOS icon grid: 824 square, soft shadow
    flat = tile(art, 1024, 40, 200, 820, False)       # Windows and web: little margin, no shadow
    save(mac, 'brand/rach3-app-icon-macos.png')
    save(flat, 'brand/rach3-app-icon.png')

    # Website (shown at about half these sizes, so they stay sharp on Retina screens)
    save(stage(art), 'site/assets/rach3-hero.png')
    save(height(on_dark(wordmark), 56), 'site/assets/rach3-wordmark-on-dark.png')
    save(width(mac, 256), 'site/assets/rach3-app-icon.png')
    save(tile(art, 64, 0, 200, 700, False), 'site/assets/favicon.png')
    save(tile(art, 180, 0, 0, 760, False), 'site/assets/apple-touch-icon.png')

    # The app's own header (dark)
    save(height(on_dark(wordmark), 40), 'assets/brand/rach3-wordmark-on-dark.png')

    # macOS: desktop/build.py turns this into Rach3.icns. Windows: the executable and installer icon.
    save(mac, 'desktop/AppIcon.png')
    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico = [tile(art, s, 0 if s <= 32 else 40, 200, 700 if s <= 32 else 820, False) for s in sizes]
    ico[-1].save(ROOT/'windows/Rach3/Rach3.ico', sizes=[(s, s) for s in sizes], append_images=ico[:-1])
    print('windows/Rach3/Rach3.ico', sizes)


if __name__ == '__main__':
    main()
