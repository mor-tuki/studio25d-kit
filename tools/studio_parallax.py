# -*- coding: utf-8 -*-
"""studio_parallax.py — 2.5D 部屋の「立体感（視差）」を数で見る（サーバー・ブラウザ不要）。

  python tools/studio_parallax.py [--dx 0.16] [--room <id>] [--json out.json]

カメラを横に dx m 平行移動（向きは変えない＝待機ゆらぎ・truck_lr と同じ動き）したとき、出力 1920×1080 の画面上で
手前・スクリーン面・奥がそれぞれ何 px 動くか（Δpx = dx·f / z）と、その差＝視差を出す。
深度は rooms.json の depth（rg16）を engine.js と同じ双線形・同じ写像（depthRange があればそれ、無ければ depthAmplitude）で引く。
点は自動で選ぶ：near＝深度 d の 97 パーセンタイル（手前）、far＝3 パーセンタイル（奥）、screen＝スクリーン矩形の中央値。

目安（実測）：作者が実際の配信で使った 2 部屋が 53・55 px、見本部屋 sample_atelier が 60 px（dx=0.16・depthRange 4.0..10.8）。
  30〜70 px を「立体に見える・破綻しない」範囲として扱う。15 px 未満＝ほぼ平面（絵に手前の物を置く／depthRange を広げる）。
  80 px 超＝手前の物の縁が伸びて見えやすい（depthRange の zmax を下げる・手前の物を画面端から離す）。
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ROOT = os.path.join(KIT, "studio")


def load_depth(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    return (a[..., 0] * 256 + a[..., 1]) / 65535


def sampler(dep, W, H):
    h, w = dep.shape

    def s(px, py):
        x = min(max(px / W * (w - 1), 0), w - 1); y = min(max(py / H * (h - 1), 0), h - 1)
        x0, y0 = int(x), int(y); x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1); tx, ty = x - x0, y - y0
        return (dep[y0, x0] * (1 - tx) + dep[y0, x1] * tx) * (1 - ty) + (dep[y1, x0] * (1 - tx) + dep[y1, x1] * tx) * ty
    return s


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dx", type=float, default=0.16)
    ap.add_argument("--room")
    ap.add_argument("--json")
    a = ap.parse_args()
    rooms = json.load(open(os.path.join(ROOT, "rooms.json"), encoding="utf-8-sig"))
    out = {}
    for room in rooms:
        rid = room["id"]
        if room.get("type", "2.5d") != "2.5d" or not room.get("depth") or (a.room and rid != a.room):
            continue
        W, H = room["width"], room["height"]
        dep = load_depth(os.path.join(ROOT, room["depth"]))
        s = sampler(dep, W, H)
        focal = H / 2 / math.tan(math.radians(room["referenceFov"] / 2))
        tl, tr, br, bl = room["screen"]
        screenZ = room["screenWidth"] * focal / (tr[0] - tl[0])
        cx, cy = sum(p[0] for p in room["screen"]) / 4, sum(p[1] for p in room["screen"]) / 4
        dCenter = s(cx, cy)
        med = sorted(s(x, y) for y in range(tl[1], bl[1], 6) for x in range(tl[0], tr[0], 6))
        ds = med[len(med) // 2]
        R = room.get("depthRange")
        if R:
            zf = lambda d: screenZ * (R["zmin"] + (1 - d) * (R["zmax"] - R["zmin"])) / (R["zmin"] + (1 - ds) * (R["zmax"] - R["zmin"]))
            mapping = f"depthRange {R['zmin']}..{R['zmax']}"
        else:
            zf = lambda d: screenZ + (dCenter - d) * room.get("depthAmplitude", 0.5)
            mapping = f"depthAmplitude {room.get('depthAmplitude', 0.5)}"
        f = 540 / math.tan(math.radians(room["camera"]["fov"] / 2))
        pts = {"near(p97)": float(np.percentile(dep, 97)), "screen": ds, "far(p3)": float(np.percentile(dep, 3))}
        row = {k: {"d": round(d, 3), "z_m": round(zf(d), 3), "px": round(a.dx * f / zf(d), 2)} for k, d in pts.items()}
        row["parallax_near_far_px"] = round(row["near(p97)"]["px"] - row["far(p3)"]["px"], 2)
        row["parallax_near_screen_px"] = round(row["near(p97)"]["px"] - row["screen"]["px"], 2)
        out[rid] = row
        print(f"== {rid}  ({mapping}, dx=+{a.dx} m, fov {room['camera']['fov']}, screenZ={screenZ:.2f} m)")
        for k in pts:
            print(f"  {k:10s} d={row[k]['d']:.3f}  z={row[k]['z_m']:6.2f} m  moves {row[k]['px']:6.2f} px")
        v = row["parallax_near_far_px"]
        verdict = "flat (<15px)" if v < 15 else "very strong (>80px: check edge stretching)" if v > 80 else "ok (reference rooms: 53-60px)" if v >= 30 else "weak (15-30px)"
        print(f"  parallax near-far = {v:.2f} px   near-screen = {row['parallax_near_screen_px']:.2f} px   -> {verdict}")
    if a.json:
        json.dump(out, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
