"""Cut the icon files from a chosen mark.

    python build/make-icon.py                        uses build/mark-source.png
    python build/make-icon.py candidates/other.png    or any other file

The mark itself is not drawn here. Three attempts at drawing irezumi from
primitives produced a leaf, a hurricane and a flower, in that order: the
style depends on deliberate asymmetry, which is the one thing a parametric
loop cannot supply. build/make-mark.py asks an image model instead, and
this cuts the sizes from whichever candidate was chosen.

The source is expected to be the mark on a plain light field. That field is
keyed out rather than trusted to be white, because a model returns
something near-white with compression noise in it, and pasting that over
the plate would leave a grey square where the artwork should be.

Writes build/icon.png (512), build/icon.ico (16-256), build/mark.png,
build/icon-preview.png.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SIZE = 1024
# Lifted off black on purpose. The mark's outer flames are a deep red, and
# against a near-black plate they disappeared: at sixteen pixels only the
# bright inner tongues survived and the ring lost its outline.
EMBER_DARK = (26, 14, 16)
EMBER_EDGE = (52, 24, 20)

# Anything brighter than this counts as the field rather than the drawing.
# Testing for pure white leaves a halo of off-white pixels around every
# stroke; too loose a test eats the lighter parts of the mark itself.
FIELD_THRESHOLD = 232


def vertical_gradient(size, top, bottom):
    band = Image.new("RGB", (1, size), top)
    pixels = band.load()
    for y in range(size):
        t = y / max(1, size - 1)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t)
                             for i in range(3))
    return band.resize((size, size))


def key_out_field(art: Image.Image) -> Image.Image:
    """The mark alone, with its light background removed.

    Keyed on brightness rather than an exact colour, so a near-white field
    with compression noise in it still goes.
    """
    art = art.convert("RGBA")
    grey = art.convert("L")
    alpha = grey.point(lambda v: 0 if v >= FIELD_THRESHOLD
                       else min(255, int((FIELD_THRESHOLD - v) * 6)))
    # a touch of blur, so strokes keep a soft edge rather than a jagged one
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    art.putalpha(ImageChops.darker(alpha, art.getchannel("A")))
    return art


def trim_and_centre(art: Image.Image, size: int, fill: float) -> Image.Image:
    """Crop to what was drawn, then place it centred at a chosen scale.

    A model leaves uneven margins, so scaling the whole frame would give a
    mark sitting off centre and smaller than intended. Cropping to the
    drawing first is what makes the icon fill its plate consistently.
    """
    box = art.getbbox()
    if box:
        art = art.crop(box)
    side = max(art.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(art, ((side - art.width) // 2, (side - art.height) // 2))

    inner = max(1, int(size * fill))
    square = square.resize((inner, inner), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(square, ((size - inner) // 2, (size - inner) // 2))
    return out


def on_plate(mark: Image.Image, size: int) -> Image.Image:
    plate = vertical_gradient(size, EMBER_EDGE, EMBER_DARK).convert("RGBA")
    rounded = Image.new("L", (size, size), 0)
    ImageDraw.Draw(rounded).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(plate, (0, 0), rounded)
    return Image.alpha_composite(canvas, mark)


def main(argv) -> int:
    given = argv[0] if argv else "mark-source.png"
    source = Path(given)
    if not source.exists():
        source = HERE / given
    if not source.exists():
        print(f"no such file: {given}\nrun build/make-mark.py first, "
              f"then pass one of build/candidates/.", file=sys.stderr)
        return 2

    art = key_out_field(Image.open(source))

    trim_and_centre(art, SIZE, fill=0.98).save(HERE / "mark.png")
    print("wrote mark.png          1024, transparent, for banners")

    # 0.80 rather than filling the square: every platform crops an icon a
    # little, and a mark drawn to the edge loses its outermost strokes.
    icon = on_plate(trim_and_centre(art, SIZE, fill=0.80), SIZE)
    icon.resize((512, 512), Image.LANCZOS).save(HERE / "icon.png")
    print("wrote icon.png          512, on the ember plate")

    sizes = [(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]
    icon.save(HERE / "icon.ico", sizes=sizes)
    print("wrote icon.ico          16 through 256")

    # A sheet at the sizes it will actually be seen at. This style looks
    # fine large and fails small, so the small end is the only useful test.
    sheet = Image.new("RGBA", (620, 260), (22, 20, 26, 255))
    x = 10
    for n, _ in sizes[:-1]:
        small = icon.resize((n, n), Image.LANCZOS)
        sheet.paste(small, (x, 12), small)
        x += n + 8
    big = icon.resize((180, 180), Image.LANCZOS)
    sheet.paste(big, (10, 66), big)
    plain = trim_and_centre(art, 180, fill=0.98)
    sheet.paste(plain, (210, 66), plain)
    sheet.save(HERE / "icon-preview.png")
    print("wrote icon-preview.png  every size, plus the plain mark")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
