# -*- coding: utf-8 -*-
"""studio_check.py — スタジオの検査ドライバ（Playwright・ヘッドレス Chrome 1 つだけ・終わったら必ず閉じる）。

  python tools/studio_check.py smoke      起動確認：全部屋を描き、スクリーンショットを output/shots/ へ（--docs で docs/images/）。
                                          動画スライドがスクリーン上で再生されている（currentTime が進む）ことも確かめる。
                                          ブラウザが H.264 を再生できない（Playwright 同梱の Chromium など）ときは
                                          動画検査を "skipped: no H.264 decoder" として飛ばす（失敗にはしない）
  python tools/studio_check.py coverage   絵の外（マゼンタ）検査：全部屋 × プリセット3 × カメラ6軸の上下限 64 通り＋中央、
                                          隣の部屋への移動の全フレーム、moves.json の全ムーブ、待機ゆらぎ。合格＝max 0px
  python tools/studio_check.py shots      各部屋 × 全景/話し手/資料 の静止画 → output/shots/
  python tools/studio_check.py pano       360 部屋：継ぎ目（真後ろを床/壁/天井で 3 枚・色差比 ≤ 1.5）と天頂/天底の画像

共通オプション: --port N（既定 8811。配信中は 8812 など別のポートで）  --serve（このスクリプトがサーバーを起動し、最後に止める。smoke は常に --serve）
合格しなければ exit 1。サーバーは 127.0.0.1 のみ。空きメモリが --min-free-gb（既定 3）未満なら Chrome を起動しない。
"""
import argparse
import contextlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
STUDIO = os.path.join(KIT, "studio")
SHOTS = os.path.join(KIT, "output", "shots")
IMAGES = os.path.join(KIT, "docs", "images")


def free_gb():
    try:
        import psutil  # optional
        return psutil.virtual_memory().available / 1024 ** 3
    except ImportError:
        pass
    if sys.platform == "win32":
        import ctypes

        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS(); m.dwLength = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullAvailPhys / 1024 ** 3
    try:
        with open("/proc/meminfo") as f:
            info = dict(line.split(":", 1) for line in f)
        return int(info["MemAvailable"].split()[0]) / 1024 ** 2
    except (OSError, KeyError, ValueError):
        return 99.0


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def server_up(base):
    try:
        with urllib.request.urlopen(base + "/api/state", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


@contextlib.contextmanager
def studio_server(port, serve):
    base = f"http://127.0.0.1:{port}"
    proc = None
    if serve:
        os.makedirs(os.path.join(KIT, "output"), exist_ok=True)
        log = open(os.path.join(KIT, "output", "server.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, "-B", os.path.join(STUDIO, "server.py"), "--port", str(port)],
                                stdout=log, stderr=subprocess.STDOUT, cwd=KIT)
        for _ in range(100):
            if server_up(base):
                break
            if proc.poll() is not None:
                raise SystemExit("server exited early; see output/server.log")
            time.sleep(0.1)
    if not server_up(base):
        raise SystemExit(f"server not running on {base}: python studio/server.py --port {port}  (or add --serve)")
    try:
        yield base
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
            print("server stopped")


@contextlib.contextmanager
def studio_page(base, query="", width=1920, height=1080):
    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as pw:
        args = ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-gpu"]
        if sys.platform == "win32":
            args.append("--use-angle=d3d11")
        try:   # installed Google Chrome (has H.264). Playwright's bundled Chromium may lack the H.264 decoder.
            browser = pw.chromium.launch(channel="chrome", headless=True, args=args)
        except Exception:
            browser = pw.chromium.launch(headless=True, args=args)
        try:
            page = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1).new_page()
            page.on("pageerror", lambda e: errors.append({"type": "pageerror", "message": str(e)}))
            page.on("console", lambda m: m.type == "error" and errors.append({"type": "console", "message": m.text}))
            page.goto(f"{base}/?output=1" + (f"&{query}" if query else ""), wait_until="domcontentloaded")
            page.wait_for_function("window.__studio && window.__studio.ready && window.__studio.engine.ready", timeout=120000)
            yield page, errors
        finally:
            browser.close()
            print("browser closed")


def cmd(page, body):
    return page.evaluate("b => window.__studio.command(b)", body)


def wait_idle(page):
    page.wait_for_function("() => { const s = window.__studio.getState(); const e = window.__studio.engine;"
                           " return s && !s.transitionActive && !e.transition; }", timeout=30000)


def run_smoke(page, errors, base, out_dir=SHOTS):
    rooms = json.loads(urllib.request.urlopen(base + "/rooms.json").read())
    state = page.evaluate("() => window.__studio.getState()")
    os.makedirs(out_dir, exist_ok=True)
    rel_out = os.path.relpath(out_dir, KIT).replace(os.sep, "/")
    results, made = [], []
    has_char = page.evaluate("() => !!window.__studio.engine.vrm")
    for r in rooms:
        if state["room"] != r["id"]:
            cmd(page, {"type": "room", "value": r["id"]})
            page.wait_for_timeout(300)
            wait_idle(page)
            state = page.evaluate("() => window.__studio.getState()")
        cmd(page, {"type": "preset", "value": "wide"})
        page.wait_for_timeout(900)
        magenta = page.evaluate("() => window.__studio.engine.countMagenta(1920, 1080).magentaPixels")
        name = f"smoke_{r['id']}.jpg"
        page.screenshot(path=os.path.join(out_dir, name), type="jpeg", quality=85)
        made.append(name)
        results.append({"room": r["id"], "type": r.get("type", "2.5d"), "magentaWide": magenta})
        print(f"room {r['id']:20s} type={r.get('type', '2.5d'):8s} magenta(wide)={magenta}px -> {rel_out}/{name}")
    # video slide: find the first .mp4/.webm in the current deck, show it on the screen of the first room
    slides = page.evaluate("() => window.__studio.getState().slides")
    video_ok = None
    vid = next((i for i, s in enumerate(slides) if s.lower().endswith((".mp4", ".webm"))), None)
    h264 = page.evaluate("() => document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.42E01E\"')")
    if vid is not None and slides[vid].lower().endswith(".mp4") and not h264:
        # Playwright's bundled Chromium has no H.264 decoder (Google Chrome / Edge / OBS do). Not a studio failure.
        print(f"video slide #{vid + 1} {slides[vid]}: skipped: no H.264 decoder in this browser"
              " (install Google Chrome, or check in Chrome / OBS)")
        vid = None
    if vid is not None:
        cmd(page, {"type": "room", "value": rooms[0]["id"]})
        page.wait_for_timeout(300)
        wait_idle(page)
        cmd(page, {"type": "preset", "value": "screen"})
        cmd(page, {"type": "page", "value": vid})
        page.wait_for_function("() => { const t = window.__studio.engine.currentSlide; return t && t.userData.video && t.userData.video.currentTime > 0.3; }", timeout=20000)
        t1 = page.evaluate("() => window.__studio.engine.currentSlide.userData.video.currentTime")
        page.wait_for_timeout(1200)
        t2 = page.evaluate("() => window.__studio.engine.currentSlide.userData.video.currentTime")
        page.screenshot(path=os.path.join(out_dir, "smoke_video_slide.jpg"), type="jpeg", quality=85)
        made.append("smoke_video_slide.jpg")
        video_ok = t2 > t1
        print(f"video slide #{vid + 1} {slides[vid]}: currentTime {t1:.2f}s -> {t2:.2f}s  playing={video_ok}")
        cmd(page, {"type": "video", "value": "pause"})
        page.wait_for_timeout(400)
        p1 = page.evaluate("() => window.__studio.engine.currentSlide.userData.video.paused")
        print("pause command -> video.paused =", p1)
        video_ok = video_ok and p1
        cmd(page, {"type": "video", "value": "play"})
        cmd(page, {"type": "page", "value": 0})
        cmd(page, {"type": "preset", "value": "wide"})
    # control panel loads, lists the rooms and shows the video buttons
    panel = page.context.new_page()
    panel.on("pageerror", lambda e: errors.append({"type": "pageerror", "message": "control: " + str(e)}))
    panel.goto(f"{base}/control.html", wait_until="domcontentloaded")
    panel.wait_for_function("document.querySelectorAll('[data-room]').length > 0 && document.querySelectorAll('[data-move]').length > 0", timeout=20000)
    print("control panel: rooms", panel.evaluate("document.querySelectorAll('[data-room]').length"),
          "moves", panel.evaluate("document.querySelectorAll('[data-move]').length"),
          "video buttons", panel.evaluate("['video-toggle','video-restart','mute-toggle'].every(id => document.getElementById(id))"))
    panel.close()
    page_errors = [e for e in errors if e["type"] == "pageerror"]
    print("character (VRM):", "loaded" if has_char else "none (background + slides only)")
    print("pageerror:", len(page_errors), "console.error:", len([e for e in errors if e["type"] == "console"]))
    for e in errors[:10]:
        print("  ", e)
    ok = not page_errors and all(r["magentaWide"] == 0 for r in results) and video_ok is not False
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


def run_coverage(page, errors):
    res = page.evaluate("() => window.__studio.auditAll()")
    print(f"{'room / kind':44s} {'count':>6s} {'maxPx':>7s} {'failed':>7s} {'minSafe':>8s}")
    for k, v in res["table"].items():
        print(f"{k:44s} {v['count']:6d} {v['maxPx']:7d} {v['failed']:7d} {v['minSafeFactor']:8.3f}")
    s = res["summary"]
    print(f"expected={res['expected']['total']} count={s['count']} max={s['max']}px failed={s['failed']} exhaustive={s['exhaustive']}")
    print("negative control (yaw +12deg, no clamp):", res["negativeControl"])
    print("report:", res.get("path"))
    page_errors = [e for e in errors if e["type"] == "pageerror"]
    ok = s["max"] == 0 and s["exhaustive"] and res["negativeControl"]["alive"] and not page_errors
    if res.get("firstFailures"):
        print("first failures:", json.dumps(res["firstFailures"][:5], ensure_ascii=False))
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


def run_shots(page, base):
    rooms = json.loads(urllib.request.urlopen(base + "/rooms.json").read())
    page.wait_for_function("() => { const e = window.__studio.engine; const s = window.__studio.getState();"
                           " return !s.slides.length || e.slideTextures.length === s.slides.length; }", timeout=30000)
    n = 0
    for r in rooms:
        for preset in ("wide", "presenter", "screen"):
            page.evaluate("o => window.__studio.takeShot(o)", {"name": f"{r['id']}_{preset}.png", "room": r["id"], "preset": preset})
            n += 1
    print(f"shots: {n} -> {SHOTS}")
    return True


def seam_metric(path, x0=960, k=4):
    import numpy as np
    from PIL import Image
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    span = lambda x: np.abs(a[:, x - k] - a[:, x + k]).mean()
    ref = [x for x in range(40, a.shape[1] - 40, 8) if abs(x - x0) > 60]
    seam, inner = float(span(x0)), float(np.mean([span(x) for x in ref]))
    return {"seam4": round(seam, 3), "interior4": round(inner, 3), "ratio4": round(seam / inner, 3)}


def run_pano(page, base):
    rooms = [r for r in json.loads(urllib.request.urlopen(base + "/rooms.json").read()) if r.get("type") == "pano360"]
    ok = True
    for r in rooms:
        for tag, pitch in (("floor", -35), ("wall", 0), ("ceiling", 30)):
            name = f"pano_seam_{r['id']}_{tag}.png"
            page.evaluate("o => window.__studio.panoView(o)", {"room": r["id"], "yaw": 180, "pitch": pitch, "fov": 60, "name": name})
            m = seam_metric(os.path.join(SHOTS, name))
            ok = ok and m["ratio4"] <= 1.5
            print(f"{r['id']:20s} seam {tag:8s} ratio={m['ratio4']:.2f} (<=1.5)  {name}")
        for tag, pitch in (("zenith", 89.5), ("nadir", -89.5)):
            name = f"pano_pole_{r['id']}_{tag}.png"
            page.evaluate("o => window.__studio.panoView(o)", {"room": r["id"], "yaw": 0, "pitch": pitch, "fov": 75, "name": name})
            print(f"{r['id']:20s} pole {tag:8s} -> output/shots/{name}（目視：渦・くさび・つなぎ目が無いこと）")
    print("RESULT(seam):", "PASS" if ok else "FAIL")
    return ok


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["smoke", "coverage", "shots", "pano"])
    ap.add_argument("--port", type=int, default=8811)
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--min-free-gb", type=float, default=3.0)
    ap.add_argument("--docs", action="store_true", help="smoke: write screenshots to docs/images/ (README images) instead of output/shots/")
    a = ap.parse_args()
    serve = a.serve or a.what == "smoke"
    port = free_port() if a.what == "smoke" else a.port
    fg = free_gb()
    print(f"free memory: {fg:.1f} GB")
    if fg < a.min_free_gb:
        print(f"free memory < {a.min_free_gb} GB; not starting Chrome")
        return 3
    t0 = time.time()
    with studio_server(port, serve) as base:
        print("studio:", base)
        with studio_page(base) as (page, errors):
            page.set_default_timeout(a.timeout * 1000)
            ok = {"smoke": lambda: run_smoke(page, errors, base, IMAGES if a.docs else SHOTS), "coverage": lambda: run_coverage(page, errors),
                  "shots": lambda: run_shots(page, base), "pano": lambda: run_pano(page, base)}[a.what]()
    print(f"elapsed {time.time() - t0:.1f}s")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
