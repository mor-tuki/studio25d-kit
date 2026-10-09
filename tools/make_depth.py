# -*- coding: utf-8 -*-
"""make_depth.py — 1 枚の絵から rg16 深度（depth_rg.png）を作る。

  python tools/make_depth.py <bg.png> <out_dir> [--model small|base|large] [--max-side 1672] [--preview]

出力（<out_dir>/）:
  depth_rg.png       … スタジオが読む深度。16bit を R=上位 8bit / G=下位 8bit に詰めた RGB PNG（B=0）
                       値 d は 0..1（1 = いちばん手前 / 0 = いちばん奥）。engine.js が (R*256+G)/65535 で戻す
  depth16.png        … 同じ値の 16bit グレースケール（確認・再加工用。スタジオは読まない）
  depth_preview.png  … --preview 時のみ。8bit の見た目確認用

方法（Depth Anything V2・Hugging Face transformers・CPU で動く）:
  1. depth-anything/Depth-Anything-V2-{Small,Base,Large}-hf で相対深度（大きい＝手前）を推定
  2. predicted_depth（float）を元画像サイズへ双三次補間（pipeline の 'depth' 画像は 8bit に量子化されているので使わない）
  3. 1〜99 パーセンタイルで 0..1 に正規化（外れ値の点で全体のコントラストが潰れないように）
  4. 16bit に量子化して rg16 に詰める

モデルの初回ダウンロードはネット接続が必要（Small 約 100MB）。ライセンス: Depth-Anything-V2-Small は Apache-2.0、
Base / Large は CC-BY-NC-4.0（商用不可）なので、配信で収益化するなら Small を使う。
"""
import argparse
import os
import sys

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np
from PIL import Image

MODELS = {
    "small": "depth-anything/Depth-Anything-V2-Small-hf",
    "base": "depth-anything/Depth-Anything-V2-Base-hf",
    "large": "depth-anything/Depth-Anything-V2-Large-hf",
}


def estimate(img, model_key):
    import torch
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    name = MODELS[model_key]
    processor = AutoImageProcessor.from_pretrained(name)
    model = AutoModelForDepthEstimation.from_pretrained(name).eval()
    with torch.no_grad():
        inputs = processor(images=img, return_tensors="pt")
        pred = model(**inputs).predicted_depth            # (1, h, w) 相対深度（大きい＝手前）
        pred = torch.nn.functional.interpolate(pred.unsqueeze(1), size=(img.height, img.width),
                                               mode="bicubic", align_corners=False)[0, 0]
    return pred.cpu().numpy().astype(np.float32)


def pack_rg16(d01):
    q = np.clip(np.round(d01 * 65535), 0, 65535).astype(np.uint16)
    rgb = np.zeros((*q.shape, 3), dtype=np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    return q, rgb


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--model", choices=sorted(MODELS), default="small")
    ap.add_argument("--max-side", type=int, default=1672,
                    help="深度画像の長辺（px）。背景より小さくてよい（engine は双線形で引く）。既定 1672")
    ap.add_argument("--low", type=float, default=1.0, help="正規化の下側パーセンタイル（既定 1）")
    ap.add_argument("--high", type=float, default=99.0, help="正規化の上側パーセンタイル（既定 99）")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()

    img = Image.open(a.src).convert("RGB")
    scale = min(1.0, a.max_side / max(img.size))
    if scale < 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    raw = estimate(img, a.model)
    lo, hi = np.percentile(raw, [a.low, a.high])
    d = np.clip((raw - lo) / max(float(hi - lo), 1e-6), 0, 1)
    q, rgb = pack_rg16(d)
    os.makedirs(a.out_dir, exist_ok=True)
    Image.fromarray(rgb).save(os.path.join(a.out_dir, "depth_rg.png"), optimize=True)
    Image.fromarray(q).save(os.path.join(a.out_dir, "depth16.png"))
    if a.preview:
        Image.fromarray((d * 255).astype(np.uint8)).save(os.path.join(a.out_dir, "depth_preview.png"))
    h, w = d.shape
    print(f"depth {w}x{h} model={a.model} raw[min={raw.min():.3f} max={raw.max():.3f}] "
          f"normalized p{a.low:g}..p{a.high:g}; top-row mean={d[: h // 10].mean():.3f} (far is small) "
          f"bottom-row mean={d[-h // 10:].mean():.3f} (near is large)")
    if d[-h // 10:].mean() <= d[: h // 10].mean():
        print("WARNING: 画面下（床・手前）が画面上（奥・天井）より奥と推定された。絵の構図か推定を確認すること")


if __name__ == "__main__":
    main()
