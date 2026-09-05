"""Render the shared Legends release banner. Requires Pillow and a supplied font."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--font", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    for text in (args.name, args.description):
        if text != text.lower() or "\n" in text or "\r" in text:
            parser.error("banner copy must be lowercase and one line")

    # Fixed proportions from the hyperyap release face; never fit type to copy.
    scale = 1.6
    image = Image.new("RGB", (4096, 1024), "#000000")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 7, 1023), fill="#FF0000")
    for text, size, top, color in (
        (args.name, 36, 100, "#FF0000"),
        (args.description, 30, 182, "#FFFFFF"),
    ):
        font = ImageFont.truetype(str(args.font), round(size * scale))
        box = draw.textbbox((0, 0), text, font=font)
        if box[2] - box[0] > 960:
            parser.error("copy exceeds the fixed banner column; shorten the copy")
        draw.text((154 - box[0], round(top * scale) - box[1]), text, font=font, fill=color)
    draw.line((154, 244, 1114, 244), fill="#666666", width=2)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output.with_suffix(".png"), optimize=True)
    image.save(args.output.with_suffix(".webp"), lossless=True, method=6)
    print(f"{args.name}: 4096x1024 PNG + lossless WebP")


if __name__ == "__main__":
    main()
