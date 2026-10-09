# -*- coding: utf-8 -*-
"""studio_ctl.py — スタジオ（studio/server.py・既定 :8811）の CLI。

  python tools/studio_ctl.py state
  python tools/studio_ctl.py room <id> | next
  python tools/studio_ctl.py preset <wide|presenter|screen>
  python tools/studio_ctl.py slide next|prev|<page番号(1始まり)>
  python tools/studio_ctl.py deck <assets/slides/name | name>
  python tools/studio_ctl.py decks
  python tools/studio_ctl.py debug on|off
  python tools/studio_ctl.py avatar on|off / screen on|off / sway on|off（待機ゆらぎ）/ fade dark|light / reset
  python tools/studio_ctl.py head <path>      (HEAD の status / Content-Type を表示)
  python tools/studio_ctl.py moves                 (moves.json のムーブ・歩行とキーの一覧)
  python tools/studio_ctl.py move <name>|stop      (カメラムーブ。stop で preset/手動のカメラへ戻る)
  python tools/studio_ctl.py walk guide_slide|look_up|goto_a   (歩行。キャラがいるときだけ。歩行中・移動中は 409)
  python tools/studio_ctl.py video play|pause|toggle|restart   (動画スライド)
  python tools/studio_ctl.py muted on|off                      (動画スライドの消音)

全部 /api/command に POST（Origin ヘッダ無し＝サーバーは Origin が有る時だけ検証）。
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

ON = {"on": True, "off": False, "true": True, "false": False, "1": True, "0": False}


def request(base, method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            body = res.read()
            return res.status, dict(res.headers), body
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8811)
    ap.add_argument("cmd")
    ap.add_argument("args", nargs="*")
    a = ap.parse_args(argv)
    base = f"http://127.0.0.1:{a.port}"
    arg = a.args[0] if a.args else None

    if a.cmd == "state":
        status, _, body = request(base, "GET", "/api/state")
        print(status, body.decode("utf-8"))
        return 0 if status == 200 else 1
    if a.cmd == "decks":
        status, _, body = request(base, "GET", "/api/decks")
        print(status, body.decode("utf-8"))
        return 0 if status == 200 else 1
    if a.cmd == "moves":
        status, _, body = request(base, "GET", "/moves.json")
        if status != 200:
            print(status, body.decode("utf-8"))
            return 1
        for m in json.loads(body):
            print(f"{m.get('kind', 'move'):5s} {m['name']:20s} key={m.get('key', '-'):8s} {m.get('label', '')}")
        return 0
    if a.cmd == "head":
        status, headers, _ = request(base, "HEAD", "/" + (arg or "").lstrip("/"))
        print(status, headers.get("Content-Type"), headers.get("Content-Length"))
        return 0 if status == 200 else 1

    if a.cmd == "room" and arg == "next":
        _, _, body = request(base, "GET", "/api/state")
        state = json.loads(body)
        _, _, rbody = request(base, "GET", "/rooms.json")
        rooms = json.loads(rbody)
        ids = [r["id"] for r in rooms]
        cur = next((r for r in rooms if r["id"] == state["room"]), None)
        neigh = [n for n in (cur or {}).get("neighbours", []) if n in ids]
        neigh += [r["id"] for r in rooms if state["room"] in r.get("neighbours", []) and r["id"] not in neigh]
        target = neigh[0] if neigh else ids[(ids.index(state["room"]) + 1) % len(ids)]
        payload = {"type": "room", "value": target}
    elif a.cmd == "room":
        payload = {"type": "room", "value": arg}
    elif a.cmd == "preset":
        payload = {"type": "preset", "value": arg}
    elif a.cmd == "slide":
        if arg in ("next", "prev"):
            payload = {"type": "slide", "delta": 1 if arg == "next" else -1}
        else:
            payload = {"type": "page", "value": int(arg) - 1}
    elif a.cmd == "deck":
        payload = {"type": "deck", "value": arg if arg.startswith("assets/") else f"assets/slides/{arg}"}
    elif a.cmd == "video":
        payload = {"type": "video", "value": arg}
    elif a.cmd in ("debug", "avatar", "screen", "sway", "muted"):
        if arg not in ON:
            ap.error(f"{a.cmd} on|off")
        payload = {"type": a.cmd, "value": ON[arg]}
    elif a.cmd == "fade":
        payload = {"type": "fade", "value": arg}
    elif a.cmd == "reset":
        payload = {"type": "reset"}
    elif a.cmd in ("move", "walk"):
        payload = {"type": a.cmd, "value": arg}
    else:
        ap.error("unknown command")
        return 2
    status, _, body = request(base, "POST", "/api/command", payload)
    text = body.decode("utf-8")
    try:
        s = json.loads(text)
        if status == 200:
            text = json.dumps({k: s.get(k) for k in ("revision", "room", "preset", "page", "deck", "debug", "avatar", "screen", "fade", "transitionActive", "transitionId", "move", "moveId", "walk", "walkId", "walkFrom", "walkSpot", "walkActive", "sway", "videoPlaying", "videoMuted")}, ensure_ascii=False)
    except ValueError:
        pass
    print(status, text)
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
