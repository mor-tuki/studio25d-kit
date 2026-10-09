# -*- coding: utf-8 -*-
"""pdf_to_slides.py — PDF（PowerPoint / Keynote / Google スライドから書き出したもの）を 1 ページ 1 枚の PNG にして、
スタジオのデッキ（studio/assets/slides/<name>/）を作る。純 Python（PyMuPDF）。

  pip install pymupdf
  python tools/pdf_to_slides.py talk.pdf my_talk [--width 1920] [--video 3=demo.mp4] [--video 7=clip.webm]

  → studio/assets/slides/my_talk/01.png, 02.png, ...（幅 --width px・縦横比は PDF のまま。16:9 推奨）
  → --video N=FILE を付けると N ページ目の位置に動画を差し込み（N ページ目の画像の「次」に入る）、
    並び順を deck.json に書く。動画ファイルはデッキのフォルダへコピーされる（MP4/H.264 推奨・WebM 可）

デッキを切り替える：操作パネルの「デッキ」で選ぶ／python tools/studio_ctl.py deck my_talk
"""
import argparse
import json
import os
import re
import shutil
import sys

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SLIDES = os.path.join(KIT, "studio", "assets", "slides")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("name", help="デッキ名（英数字・_・- のみ）")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--video", action="append", default=[], metavar="N=FILE",
                    help="N ページ目の後ろに動画を入れる（複数可）")
    ap.add_argument("--force", action="store_true", help="同名のデッキを消して作り直す")
    a = ap.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", a.name):
        ap.error("name は英数字・_・- だけ")
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("PyMuPDF が必要です: pip install pymupdf")
        return 2
    out = os.path.join(SLIDES, a.name)
    if os.path.exists(out):
        if not a.force:
            print(f"{out} は既にあります（--force で作り直し）")
            return 1
        shutil.rmtree(out)
    os.makedirs(out)
    doc = fitz.open(a.pdf)
    names = []
    for i, page in enumerate(doc, 1):
        zoom = a.width / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        name = f"{i:02d}.png"
        pix.save(os.path.join(out, name))
        names.append(name)
        if i == 1:
            print(f"page size {pix.width}x{pix.height} (aspect {pix.width / pix.height:.3f}; 16:9 = 1.778)")
    print(f"{len(names)} pages -> {out}")
    videos = {}
    for spec in a.video:
        n, _, path = spec.partition("=")
        if not n.isdigit() or not os.path.isfile(path) or not path.lower().endswith((".mp4", ".webm")):
            ap.error(f"--video {spec}: N=動画ファイル(.mp4/.webm) の形で")
        videos.setdefault(int(n), []).append(path)
    if videos:
        items = []
        for i, name in enumerate(names, 1):
            items.append(name)
            for k, path in enumerate(videos.get(i, []), 1):
                vname = f"{i:02d}_video{k}{os.path.splitext(path)[1].lower()}"
                shutil.copyfile(path, os.path.join(out, vname))
                items.append(vname)
        with open(os.path.join(out, "deck.json"), "w", encoding="utf-8") as f:
            json.dump({"items": items}, f, ensure_ascii=False, indent=2)
        print("deck.json:", items)
    if len(names) + sum(len(v) for v in videos.values()) > 64:
        print("WARNING: 1 デッキは 64 枚まで（サーバーの上限）。分けてください")
    print(f"next: python tools/studio_ctl.py deck {a.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
