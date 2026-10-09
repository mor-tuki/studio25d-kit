# -*- coding: utf-8 -*-
"""pano_prep.py — 生成した 360° 正距円筒パノラマを検査して、スタジオ用に整える（Lanczos 拡大・追加モデル不要）。

  python tools/pano_prep.py <pano.png> <out_dir> [--width 4096] [--xfade 6] [--zenith-band 0] [--check-only]

検査（いつも出力・stats.json にも保存）:
  aspect      幅÷高さ。2.00 ±0.01 でなければ FAIL（正距円筒でない）
  seamRatio   左右端の列どうしの色差 ÷ 内部の隣り合う列の色差の平均。≤ 3.0 で合格（継ぎ目が見えない目安）
              ※ 整えた後の値（seamRatioAfter）も出す。拡大後の見た目検査はスタジオで tools/studio_check.py pano
  poleSpread  天頂/天底の最上・最下 1% の行の色のばらつき（標準偏差・0..255）。大きいと真上/真下に「くさび」や渦が出る
  floorRow    床と壁の境目らしき行（中央 ±10% の列で、下半分の明るさ変化が最大の行）→ pano.radius の目安を出す

整え（--check-only でなければ）:
  1. 継ぎ目の左右 --xfade px を互いへ寄せる（既定 6）
  2. 天頂・天底の 1.2% の行を行平均へ寄せる（極の渦を消す）
  3. --zenith-band > 0 のとき天頂側の帯を極ほど強く横ぼかし（天頂がくさびに割れる絵は 0.09）
  4. 左右を巻き込んで Lanczos 拡大 → 切り戻し（継ぎ目に拡大のにじみを作らない）

出力（<out_dir>/）: pano_4k.jpg（--width の幅・2:1）・thumb.jpg（640×360・正面）・light.json（照明色の目安）・stats.json
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


def seam_ratio(a):
    seam = np.abs(a[:, 0] - a[:, -1]).mean()
    inner = np.abs(a[:, 1:] - a[:, :-1]).mean()
    return float(seam / max(inner, 1e-6)), float(seam), float(inner)


def pole_spread(a):
    h = a.shape[0]
    n = max(2, h // 100)
    return float(a[:n].reshape(-1, 3).std(0).mean()), float(a[-n:].reshape(-1, 3).std(0).mean())


def floor_row(a):
    h, w = a.shape[:2]
    lum = a[:, int(w * 0.4):int(w * 0.6)] @ np.array([0.2126, 0.7152, 0.0722])
    prof = lum.mean(1)
    lo, hi = int(h * 0.52), int(h * 0.80)
    grad = np.abs(np.diff(prof[lo:hi]))
    return lo + int(np.argmax(grad))


def light_colors(a):
    h, w = a.shape[:2]
    lat = (0.5 - (np.arange(h) + 0.5) / h) * np.pi
    wt = np.cos(lat)[:, None]

    def mean(rows):
        ww = wt[rows]
        return (a[rows] * ww[..., None]).sum((0, 1)) / (ww.sum() * w)

    hx = lambda c: '#%02X%02X%02X' % tuple(int(min(1, x) * 255 + .5) for x in c)
    f = a / 255.0
    lum = f @ np.array([.2126, .7152, .0722])
    hot = f[lum >= np.quantile(lum, 0.985)].mean(0)
    return {'sky': hx(mean(slice(0, h // 2)) / 255.0), 'ground': hx(mean(slice(h // 2, h)) / 255.0), 'hot': hx(hot),
            'meanLum': float((lum * wt).sum() / (wt.sum() * w))}


def prep(img, xfade, zb):
    h, w = img.shape[:2]
    out = img.copy()
    for i in range(xfade):
        k = 0.5 * (1 - i / xfade)
        left, right = img[:, i].copy(), img[:, w - 1 - i].copy()
        out[:, i] = left * (1 - k) + right * k
        out[:, w - 1 - i] = right * (1 - k) + left * k
    p = max(4, int(h * 0.012))
    for i in range(p):
        k = (1 - i / p) ** 2
        for row in (i, h - 1 - i):
            out[row] = out[row] * (1 - k) + out[row].mean(0, keepdims=True) * k
    if zb > 0:
        z = int(h * zb)
        for row in range(z):
            r = int(w * 0.06 * (1 - row / z) ** 2)
            if r < 1:
                continue
            line = out[row]
            c = np.cumsum(np.concatenate([line[-r - 1:], line, line[:r]], 0), 0)
            out[row] = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
    return out


def upscale_wrapped(arr, width):
    h, w = arr.shape[:2]
    wrap = max(8, w // 32)
    pad = np.concatenate([arr[:, -wrap:], arr, arr[:, :wrap]], axis=1)
    s = width / w
    big = Image.fromarray(np.clip(pad + 0.5, 0, 255).astype(np.uint8)).resize(
        (round(pad.shape[1] * s), width // 2), Image.LANCZOS)
    x0 = round(wrap * s)
    return big.crop((x0, 0, x0 + width, width // 2))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--width", type=int, default=4096, help="出力の幅（2:1）。GPU の maxTextureSize 以下に。既定 4096")
    ap.add_argument("--xfade", type=int, default=6)
    ap.add_argument("--zenith-band", type=float, default=0.0)
    ap.add_argument("--eye-height", type=float, default=1.6, help="撮影点の高さ（m）の想定。radius の目安計算に使う")
    ap.add_argument("--check-only", action="store_true")
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    h, w = arr.shape[:2]
    aspect = w / h
    sr, seam, inner = seam_ratio(arr)
    top, bottom = pole_spread(arr)
    fr = floor_row(arr)
    depression = (fr / h - 0.5) * 180.0
    radius = a.eye_height / np.tan(np.radians(max(depression, 3.0)))
    stats = {"src": os.path.basename(a.src), "size": [w, h], "aspect": round(aspect, 4),
             "seamRatio": round(sr, 3), "seamDiff": round(seam, 2), "interiorDiff": round(inner, 2),
             "poleSpread": {"zenith": round(top, 2), "nadir": round(bottom, 2)},
             "floorRow": fr, "floorDepressionDeg": round(depression, 2),
             "suggest": {"pano.height": a.eye_height, "pano.radius": round(float(radius), 2),
                         "note": "radius ≈ height / tan(床と壁の境目の俯角)。部屋が狭く見えたら大きく、床が流れて見えたら小さく"}}
    ok_aspect = abs(aspect - 2.0) <= 0.01
    ok_seam = sr <= 3.0
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print("CHECK aspect 2:1 :", "PASS" if ok_aspect else "FAIL")
    print("CHECK seam ratio <= 3.0 :", "PASS" if ok_seam else "WARN (--xfade 20〜40 を試す / 作り直す)")
    if top > 40 or bottom > 40:
        print("WARN pole spread > 40: 天頂/天底に模様が残っている。--zenith-band 0.09 か作り直しを検討")
    if a.check_only:
        return 0 if ok_aspect else 1
    if not ok_aspect:
        print("aspect が 2:1 ではないので整えません（作り直すこと）")
        return 1
    out = prep(arr, a.xfade, a.zenith_band)
    stats["seamRatioAfter"] = round(seam_ratio(out)[0], 3)
    os.makedirs(a.out_dir, exist_ok=True)
    big = upscale_wrapped(out, a.width)
    big.save(os.path.join(a.out_dir, "pano_4k.jpg"), quality=88, optimize=True, progressive=True)
    fixed = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))
    t = fixed.crop((int(w * .32), int(h * .30), int(w * .68), int(h * .30) + int(w * .36 * 9 / 16))).resize((640, 360), Image.LANCZOS)
    t.save(os.path.join(a.out_dir, "thumb.jpg"), quality=85)
    light = light_colors(np.asarray(fixed).astype(np.float32))
    json.dump(light, open(os.path.join(a.out_dir, "light.json"), "w"), indent=1)
    stats["output"] = {"pano": list(big.size), "light": light}
    json.dump(stats, open(os.path.join(a.out_dir, "stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("seamRatioAfter:", stats["seamRatioAfter"], "->", a.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
