#!/usr/bin/env python3
"""Extract standalone vanilla block assets from a Minecraft Java client jar and build a texture atlas.

The renderer does not use the Minecraft client at runtime. This build step only
needs a local client jar so the shipped `assets/` directory is self contained.
"""
from __future__ import annotations
import argparse, io, json, math, os, sys, zipfile
from pathlib import Path
from PIL import Image

DEFAULT_JAR = Path(r"C:\Users\Administrator\Desktop\pcl\.minecraft\versions\Rapid Optimization\Rapid Optimization.jar")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
TILE = 16
PAD = 2
CELL = TILE + PAD * 2
ATLAS_DIM = 1024
GRID = ATLAS_DIM // CELL


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", type=Path, default=DEFAULT_JAR)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    jar_path = args.jar
    if not jar_path.exists():
        sys.exit(f"client jar not found: {jar_path}")
    out = args.out
    vanilla = out / "vanilla"
    (vanilla / "blockstates").mkdir(parents=True, exist_ok=True)
    (vanilla / "models" / "block").mkdir(parents=True, exist_ok=True)
    (out / "textures").mkdir(parents=True, exist_ok=True)

    textures: dict[str, Image.Image] = {}
    with zipfile.ZipFile(jar_path) as z:
        names = set(z.namelist())
        for n in sorted(names):
            if n.startswith("assets/minecraft/blockstates/") and n.endswith(".json"):
                (vanilla / "blockstates" / Path(n).name).write_bytes(z.read(n))
            elif n.startswith("assets/minecraft/models/block/") and n.endswith(".json"):
                (vanilla / "models" / "block" / Path(n).name).write_bytes(z.read(n))
            elif n.startswith("assets/minecraft/textures/block/") and n.endswith(".png"):
                key = n[len("assets/minecraft/textures/"):-4]  # block/stone
                try:
                    im = Image.open(io.BytesIO(z.read(n))).convert("RGBA")
                except Exception:
                    continue
                w, h = im.size
                if h > w and h % w == 0:  # animated strip: first frame
                    im = im.crop((0, 0, w, w))
                if im.size != (TILE, TILE):
                    im = im.resize((TILE, TILE), Image.Resampling.NEAREST)
                textures[key] = im

    keys = sorted(textures)
    if len(keys) > GRID * GRID:
        sys.exit(f"atlas too small: {len(keys)} textures > {GRID*GRID}")
    atlas = Image.new("RGBA", (ATLAS_DIM, ATLAS_DIM), (0, 0, 0, 0))
    manifest = {
        "version": 1,
        "atlas": "atlas.png",
        "atlasSize": ATLAS_DIM,
        "tile": TILE,
        "cell": CELL,
        "pad": PAD,
        "textures": {},
    }
    for i, key in enumerate(keys):
        col, row = i % GRID, i // GRID
        x0, y0 = col * CELL, row * CELL
        im = textures[key]
        atlas.paste(im, (x0 + PAD, y0 + PAD))
        # replicate edge pixels into the padding to stop mip bleeding
        left = im.crop((0, 0, 1, TILE)).resize((PAD, TILE), Image.Resampling.NEAREST)
        right = im.crop((TILE - 1, 0, TILE, TILE)).resize((PAD, TILE), Image.Resampling.NEAREST)
        top = im.crop((0, 0, TILE, 1)).resize((TILE, PAD), Image.Resampling.NEAREST)
        bottom = im.crop((0, TILE - 1, TILE, TILE)).resize((TILE, PAD), Image.Resampling.NEAREST)
        atlas.paste(left, (x0, y0 + PAD)); atlas.paste(right, (x0 + PAD + TILE, y0 + PAD))
        atlas.paste(top, (x0 + PAD, y0)); atlas.paste(bottom, (x0 + PAD, y0 + PAD + TILE))
        corners = [im.getpixel((0,0)), im.getpixel((TILE-1,0)), im.getpixel((0,TILE-1)), im.getpixel((TILE-1,TILE-1))]
        for (px, py), c in zip([(x0,y0),(x0+PAD+TILE,y0),(x0,y0+PAD+TILE),(x0+PAD+TILE,y0+PAD+TILE)], corners):
            atlas.paste(Image.new("RGBA",(PAD,PAD),c),(px,py))
        manifest["textures"][key] = [col, row]
    atlas.save(out / "atlas.png", optimize=True)
    (out / "atlas.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"textures={len(keys)} blockstates={len(list((vanilla/'blockstates').glob('*.json')))} models={len(list((vanilla/'models/block').glob('*.json')))}")
    print(f"atlas={out/'atlas.png'} size={ATLAS_DIM} bytes={(out/'atlas.png').stat().st_size}")


if __name__ == "__main__":
    main()
