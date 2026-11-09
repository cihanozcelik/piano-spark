"""Make the website's photos from their generated originals (see site/IMAGEGEN.md).

The laptops in some of them were generated with a flat green screen; the app's
real practice screenshot (English and Turkish) is put onto them here, so every
screen shows the actual app rather than an imagined one. Run it after
refreshing the screenshots:

    python3 site/compose.py        (needs numpy and Pillow)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent/'assets'


def screen_corners(photo):
    """The four corners of the green screen: top left, top right, bottom right, bottom left."""
    rgb = np.asarray(photo.convert('RGB')).astype(int)
    green = (rgb[..., 1] > 170) & (rgb[..., 0] < 120) & (rgb[..., 2] < 120)
    ys, xs = np.nonzero(green)
    s, d = xs + ys, xs - ys
    return green, [(xs[s.argmin()], ys[s.argmin()]), (xs[d.argmax()], ys[d.argmax()]),
                   (xs[s.argmax()], ys[s.argmax()]), (xs[d.argmin()], ys[d.argmin()])]


def perspective(source_size, corners):
    """Coefficients PIL needs to draw a rectangle of source_size onto the corners."""
    w, h = source_size
    rows, values = [], []
    for (x, y), (u, v) in zip(corners, [(0, 0), (w, 0), (w, h), (0, h)]):
        rows += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        values += [u, v]
    return np.linalg.solve(np.array(rows, float), np.array(values, float))


def put_on_screen(photo, screenshot):
    green, corners = screen_corners(photo)
    # grow the screen a little so no green fringe survives along its edges
    cx, cy = np.mean(corners, axis=0)
    corners = [(x + (x - cx) * 0.006, y + (y - cy) * 0.006) for x, y in corners]
    # shrink first to about the screen's size, so fine score lines stay smooth instead of jagged
    width = round(max(x for x, _ in corners) - min(x for x, _ in corners)) * 2
    screenshot = screenshot.convert('RGB').resize((width, round(width * screenshot.height / screenshot.width)), Image.LANCZOS)
    warped = screenshot.transform(photo.size, Image.PERSPECTIVE, perspective(screenshot.size, corners),
                                                 Image.BICUBIC)
    # a screen in a dim room: a touch darker, with a faint sheen from the lamp on the left
    warped = Image.blend(warped, Image.new('RGB', photo.size, (0, 0, 0)), 0.08)
    shape = Image.new('L', photo.size, 0)
    ImageDraw.Draw(shape).polygon(corners, fill=255)
    spill = Image.fromarray((green * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    shape = ImageChops.lighter(shape, spill).filter(ImageFilter.GaussianBlur(0.6))
    sheen = Image.linear_gradient('L').rotate(60, expand=False).resize(photo.size).point(lambda v: int(v * 0.10))
    lit = Image.composite(Image.new('RGB', photo.size, (255, 244, 230)), warped, sheen)
    result = Image.composite(lit, photo.convert('RGB'), shape)
    return without_green_glow(result, corners)


def without_green_glow(image, corners):
    """The green screen lit the laptop's keyboard below it; turn that glow into the app's
    soft neutral light instead."""
    rgb = np.asarray(image).astype(float)
    left = max(0, int(min(x for x, _ in corners)) - 200)
    right = int(max(x for x, _ in corners)) + 100   # not as far as the plants beside some laptops
    # from the screen's lower edge (it slopes, so start at its higher end) downwards
    top = int(min(corners[2][1], corners[3][1])) - 10
    area = rgb[top:top + 220, left:right]
    excess = np.clip(area[..., 1] - np.maximum(area[..., 0], area[..., 2]), 0, None)
    area[..., 1] -= excess
    area[..., :3] += (excess * 0.35)[..., None]
    rgb[top:top + 220, left:right] = area
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))


WITH_SCREEN = ('piano-at-home', 'learner-morning', 'learner-night', 'learner-family')   # one copy per language
PLAIN = ('youtube-cover',)


def main():
    for name in WITH_SCREEN:
        photo = Image.open(ASSETS/f'{name}-source.png')
        for folder in (ASSETS, ASSETS/'tr'):
            put_on_screen(photo, Image.open(folder/'practice.png')).save(
                folder/f'{name}.jpg', quality=84, optimize=True, progressive=True)
            print(folder/f'{name}.jpg')
    for name in PLAIN:
        Image.open(ASSETS/f'{name}-source.png').convert('RGB').save(
            ASSETS/f'{name}.jpg', quality=82, optimize=True, progressive=True)
        print(ASSETS/f'{name}.jpg')


if __name__ == '__main__':
    main()
