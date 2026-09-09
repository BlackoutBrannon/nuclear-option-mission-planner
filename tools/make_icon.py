"""Draw the application icon.

Generated rather than hand-drawn so it can be changed by editing numbers here
instead of round-tripping an image editor, and so every size is rendered at its
own scale rather than downsampled from one bitmap - a 16 px icon made by
shrinking a 256 px one turns to mush.

The mark is what the planner is for: a surface-to-air launcher inside its own
engagement envelope, with the envelope bitten into by terrain. A plain circle
would say "range". The notches say the range is not the same on every bearing,
which is the thing this tool works out and the reason it exists.

The launcher is a hostile diamond because that is how the app itself draws one,
and the notched outline carries the meaning by shape, so nothing is lost when
the icon is 16 px, greyscale, or seen by someone who does not separate red from
green.

    python tools/make_icon.py     ->  shell/app.ico
"""

import math
import os

from PIL import Image, ImageDraw

# Windows picks the nearest size rather than scaling, so supply the ones it asks
# for: 16 and 32 in lists and the taskbar, 48 in Explorer, 256 for large tiles.
SIZES = [16, 24, 32, 48, 64, 128, 256]

BACKDROP = (14, 20, 26)        # near-black, matching the app's own ground
RING     = (122, 190, 224)     # the planner's blue
HOSTILE  = (240, 92, 82)       # the app's hostile red
GLYPH    = (255, 255, 255)

# Where terrain eats into the envelope, as (start degrees, end degrees, how far
# in). Clockwise from north, matching a compass rather than screen angles.
# Deliberately uneven: a regular pattern reads as decoration.
# Shallow on purpose. Deep bites stop reading as a ring at all, and the icon
# has to say "envelope" before it says "notched".
NOTCHES = [
    (38, 76, 0.80),
    (150, 174, 0.72),
    (255, 300, 0.78),
]

STEPS = 144                    # points around the ring


def reach(bearing):
    """Envelope radius at one bearing, as a fraction of the unmasked radius."""
    for start, end, depth in NOTCHES:
        if start <= bearing <= end:
            # Ease in and out so the notch has walls rather than a step, which
            # is how a real masked ring looks where terrain rises and falls.
            span = end - start
            t = (bearing - start) / span
            shoulder = math.sin(math.pi * t) ** 0.45
            return 1.0 - (1.0 - depth) * shoulder
    return 1.0


def draw(size):
    # Drawn at 8x and reduced: PIL has no anti-aliased primitives, so the
    # supersample is what keeps the curves from being staircases.
    s = size * 8
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = s * 0.02
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.18,
                        fill=BACKDROP)

    cx = cy = s / 2
    base = s * 0.355

    points = []
    for i in range(STEPS):
        bearing = 360.0 * i / STEPS
        r = base * reach(bearing)
        a = math.radians(bearing - 90.0)          # 0 deg = north = up
        points.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    # Stroked as a closed line rather than a polygon outline: PIL draws a
    # polygon's outline segment by segment, which combs into hatching wherever
    # the radius changes quickly - exactly at the notch walls.
    d.line(points + [points[0]], fill=RING,
           width=max(1, int(round(s * 0.05))), joint="curve")

    # The launcher, as the app draws a hostile ground unit: a diamond.
    h = s * 0.155
    d.polygon([(cx, cy - h), (cx + h, cy), (cx, cy + h), (cx - h, cy)],
              fill=HOSTILE)

    # A missile on the rail, pointing up. Drops out below about 32 px, where the
    # diamond alone has to carry it - which it does, being the app's own symbol.
    if size >= 32:
        w = s * 0.026
        top = cy - h * 0.62
        bot = cy + h * 0.42
        d.polygon([(cx - w, bot), (cx - w, top), (cx, top - w * 2.1),
                   (cx + w, top), (cx + w, bot)], fill=GLYPH)

    return img.resize((size, size), Image.LANCZOS)


HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "shell", "app.ico")


def main():
    frames = [draw(n) for n in SIZES]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames[-1].save(OUT, format="ICO",
                    sizes=[(n, n) for n in SIZES],
                    append_images=frames[:-1])
    print("wrote %s  (%d sizes, %.1f KB)"
          % (os.path.relpath(OUT, os.path.dirname(HERE)),
             len(SIZES), os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
