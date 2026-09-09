"""Draw the application icon.

Generated rather than hand-drawn so it can be changed by editing numbers here
instead of round-tripping an image editor, and so every size is rendered at its
own scale rather than downsampled from one bitmap - a 16 px icon made by
shrinking a 256 px one turns to mush.

The mark is a range ring with a waypoint diamond on it: the two things the
planner is actually for. Both are shapes, not colours, so it survives being
tiny, greyscale, or seen by someone who does not separate red from green.

    python tools/make_icon.py     ->  shell/app.ico
"""

import os

from PIL import Image, ImageDraw

# Windows picks the nearest size rather than scaling, so supply the ones it asks
# for: 16 and 32 in lists and the taskbar, 48 in Explorer, 256 for large tiles.
SIZES = [16, 24, 32, 48, 64, 128, 256]

BACKDROP = (14, 20, 26)        # near-black, matching the app's own ground
RING     = (122, 190, 224)     # the planner's blue
MARK     = (240, 245, 250)     # near-white, so it reads against the ring

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "shell", "app.ico")


def draw(size):
    # Drawn at 8x and reduced: PIL has no anti-aliased primitives, so the
    # supersample is what keeps the curves from being staircases.
    s = size * 8
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square backdrop, so the icon reads as an app rather than floating.
    pad = s * 0.02
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.18,
                        fill=BACKDROP)

    cx = cy = s / 2

    # Two rings. The outer one is the envelope, the inner is the reference
    # spacing - the same idea as the bullseye rose in the app.
    for radius, width in ((s * 0.32, s * 0.055), (s * 0.17, s * 0.035)):
        d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                  outline=RING, width=int(round(width)))

    # A tick at each cardinal, which is what makes it read as a range ring
    # rather than a target roundel.
    tick = s * 0.075
    r = s * 0.32
    w = int(round(s * 0.055))
    d.line([cx, cy - r - tick, cx, cy - r + tick], fill=RING, width=w)
    d.line([cx, cy + r - tick, cx, cy + r + tick], fill=RING, width=w)
    d.line([cx - r - tick, cy, cx - r + tick, cy], fill=RING, width=w)
    d.line([cx + r + tick, cy, cx + r - tick, cy], fill=RING, width=w)

    # The waypoint, sitting on the outer ring up and to the right. Filled, so it
    # stays solid at 16 px where an outline would close up.
    m = s * 0.105
    mx = cx + r * 0.707
    my = cy - r * 0.707
    d.polygon([(mx, my - m), (mx + m, my), (mx, my + m), (mx - m, my)],
              fill=MARK)

    return img.resize((size, size), Image.LANCZOS)


def main():
    frames = [draw(n) for n in SIZES]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # Pillow writes every supplied size into the .ico when given sizes=.
    frames[-1].save(OUT, format="ICO",
                    sizes=[(n, n) for n in SIZES],
                    append_images=frames[:-1])
    print("wrote %s  (%d sizes, %.1f KB)"
          % (os.path.relpath(OUT, os.path.dirname(HERE)),
             len(SIZES), os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
