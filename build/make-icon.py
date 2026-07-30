"""Draw the Firestarter mark and write the icon files.

    python build/make-icon.py

Kept as a script rather than a pair of binaries so the mark can be
adjusted and rebuilt rather than redrawn from memory. An icon has to
survive being sixteen pixels wide in a taskbar, so it is one shape with
one silhouette: no text, no thin lines, no detail that turns to mud.

Writes build/icon.png (512) and build/icon.ico (16 through 256), which
are the two electron-builder reads.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SIZE = 1024                      # drawn large, reduced with resampling

EMBER_DARK = (14, 9, 12)
EMBER_EDGE = (33, 16, 14)
FLAME_TOP = (255, 214, 122)
FLAME_MID = (255, 168, 58)
FLAME_LOW = (214, 58, 34)
CORE = (255, 251, 235)


def bezier(points, steps=140):
    """A cubic curve as a list of points, so the outline can be a polygon.

    Pillow draws polygons, not curves, and a flame made of straight lines
    looks like a shard. Computing the curve here keeps the silhouette
    smooth at any size.
    """
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ))
    return out


def scaled(pairs):
    return [(x * SIZE, y * SIZE) for x, y in pairs]


def flame_outline(scale=1.0, drop=0.0):
    """The silhouette, built from what makes fire read as fire.

    Three things do the work, and the first attempt at this had none of
    them, so it came out as a leaf:

      a hooked tip that leans, rather than a symmetrical point
      a wide, round base, rather than a second point at the bottom
      an S-curve down one flank, rather than two matching arcs

    scale shrinks the whole shape about its base so an inner flame can be
    the same silhouette rather than a different one, which is what keeps
    the mark coherent when the inner shape shows through.
    """
    def at(x, y):
        # measured from the base, so shrinking keeps the flame standing on
        # the same spot instead of floating up the plate
        return (0.5 + (x - 0.5) * scale, 0.88 + (y - 0.88) * scale + drop)

    tip = at(0.585, 0.045)
    # Right flank. The first control point sits close to the tip so the
    # curve leaves it steeply: placed far out, the tip rounds into a
    # shoulder and the whole mark goes blunt.
    right = bezier([tip, at(0.655, 0.16), at(0.80, 0.52), at(0.68, 0.79)])
    base_r = bezier([at(0.68, 0.79), at(0.63, 0.93), at(0.37, 0.93), at(0.32, 0.79)])
    # Left flank in two parts, so it can change direction. The inflection
    # is what separates a flame from a teardrop.
    left_low = bezier([at(0.32, 0.79), at(0.17, 0.60), at(0.235, 0.41), at(0.41, 0.335)])
    left_high = bezier([at(0.41, 0.335), at(0.505, 0.295), at(0.50, 0.13), tip])
    return scaled(right + base_r + left_low + left_high)


def vertical_gradient(size, top, bottom):
    band = Image.new("RGB", (1, size), top)
    pixels = band.load()
    for y in range(size):
        t = y / max(1, size - 1)
        pixels[0, y] = tuple(
            round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)
        )
    return band.resize((size, size))


def draw() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # The plate. Rounded because every platform rounds it anyway, and a
    # square drawn inside a rounded mask loses its corners twice.
    plate = vertical_gradient(SIZE, EMBER_EDGE, EMBER_DARK).convert("RGBA")
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)
    canvas.paste(plate, (0, 0), mask)

    # The flame, as a gradient clipped to the silhouette. Painting the
    # shape flat would read as a sticker; the gradient is what makes it
    # look lit from inside.
    body = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(body).polygon(flame_outline(), fill=255)

    glow = body.filter(ImageFilter.GaussianBlur(SIZE * 0.055))
    warm = Image.new("RGBA", (SIZE, SIZE), FLAME_LOW + (255,))
    canvas = Image.alpha_composite(canvas, Image.composite(
        warm, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)),
        glow.point(lambda v: int(v * 0.5))))

    fire = vertical_gradient(SIZE, FLAME_TOP, FLAME_LOW).convert("RGBA")
    canvas.paste(fire, (0, 0), body)

    # An inner flame, brighter and smaller, offset up. This is what stops
    # the mark reading as a plain drop at a glance.
    inner = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(inner).polygon(flame_outline(scale=0.40), fill=255)
    inner = inner.filter(ImageFilter.GaussianBlur(SIZE * 0.006))
    core = vertical_gradient(SIZE, CORE, FLAME_MID).convert("RGBA")
    canvas.paste(core, (0, 0), inner)

    return canvas


def main() -> None:
    art = draw()
    png = HERE / "icon.png"
    art.resize((512, 512), Image.LANCZOS).save(png)
    print(f"wrote {png.name}  512x512")

    # Every size Windows asks for. Letting the shell downscale one large
    # image instead gives a blurry sixteen pixel icon.
    sizes = [(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]
    ico = HERE / "icon.ico"
    art.save(ico, sizes=sizes)
    print(f"wrote {ico.name}   {', '.join(str(n) for n, _ in sizes)}")

    # A flat sheet to eyeball the small sizes without opening a build.
    sheet = Image.new("RGBA", (16 + 24 + 32 + 48 + 64 + 128 + 40, 140),
                      (24, 22, 28, 255))
    x = 8
    for n, _ in sizes[:-1]:
        sheet.paste(art.resize((n, n), Image.LANCZOS), (x, 8), art.resize((n, n), Image.LANCZOS))
        x += n + 6
    sheet.paste(art.resize((110, 110), Image.LANCZOS), (x, 14),
                art.resize((110, 110), Image.LANCZOS))
    preview = HERE / "icon-preview.png"
    sheet.save(preview)
    print(f"wrote {preview.name}  a sheet at every size")


if __name__ == "__main__":
    main()
