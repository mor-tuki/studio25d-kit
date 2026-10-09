#!/usr/bin/env python3
"""studio25d-kit server (127.0.0.1 only, default port 8811): static assets + one shared state for
preview / control panel / OBS (Python stdlib only).

State lives here (/api/state); every page polls it, so a late-opened OBS source starts in the current
room and deck. Capture endpoints (/save /save_frame /log /api/audit) write into ../output/.
"""

import argparse
import base64
import binascii
import copy
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DEFAULT_PORT = 8811
CAPTURE_DIR = REPO / "output"
MAX_BODY_BYTES = 40 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
TRANSITION_SECONDS = 2.0
FALLBACK_ROOMS = ("room_a", "room_b")   # used only when rooms.json is missing (tests)
CAMERA_BOUNDS = {
    "yaw": (-4, 4), "pitch": (-2, 1), "x": (-0.3, 0.3),
    "y": (-0.3, 0.3), "dolly": (0, 3), "zoom": (0, 8),
}
DEFAULT_DECK = "assets/slides/sample"
SLIDE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".mp4", ".webm"}
DECK_NAME = re.compile(r"assets/slides/[A-Za-z0-9_-]+")
DECK_PATH = re.compile(r"assets/(uploads/[0-9a-f]{64}\.(png|jpg|webp)|slides/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp|svg|mp4|webm))")
VIDEO_ACTIONS = ("play", "pause", "toggle", "restart")


def natural_key(name):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


class APIError(Exception):
    def __init__(self, message, status=400, code="invalid_command"):
        super().__init__(message)
        self.status = status
        self.code = code


def zero_camera():
    return {key: 0 for key in CAMERA_BOUNDS}


class StudioState:
    """One authoritative, thread-safe state shared by independent browsers.

    View state lasts for this server process. The server restores a validated
    uploaded deck manifest on restart, while resetting the initial view.
    """

    def __init__(self, clock=None, monotonic=None, config_path=None, root=None):
        self.lock = threading.RLock()
        self.clock = clock or time.time
        self.monotonic = monotonic or time.monotonic
        self.config_path = Path(config_path) if config_path else None
        self.root = Path(root).resolve() if root else (self.config_path.resolve().parent if self.config_path else ROOT)
        self.busy_until = 0
        self.state = {
            "revision": 0, "room": FALLBACK_ROOMS[0], "page": 0, "preset": "wide",
            "mode": "A", "fade": "dark", "camera": zero_camera(),
            "debug": False, "transitionId": 0, "transitionStartedAt": 0,
            "transitionUntil": 0, "transitionSeconds": TRANSITION_SECONDS,
            "slides": [], "deck": None,
            # Video slides (.mp4/.webm): videoPlaying = should the current video run; videoMuted = sound off
            # (default, so browsers allow autoplay); videoRestartId bumps to rewind the current video.
            "videoPlaying": True, "videoMuted": True, "videoRestartId": 0,
            "avatar": True, "screen": True, "sway": True,
            # One-shot orders (same detection pattern as transitionId; design section 9).
            # move: the camera move being held/played (None = follow preset/camera). Cleared by
            #       preset/camera/reset/room/stop. walk: last walk order; walkFrom/walkSpot are the
            #       spot keys it starts from / ends at, so a late page can rebuild the same path.
            "move": None, "moveId": 0, "moveStartedAt": 0,
            "walk": None, "walkId": 0, "walkStartedAt": 0, "walkUntil": 0, "walkFrom": "a", "walkSpot": "a",
        }
        try:   # start in the first room of rooms.json
            self.state["room"] = next(iter(self.room_definitions()))
        except APIError:
            pass

    def move_defs(self, kind="move"):
        path = self.root / "moves.json"
        try:
            moves = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else []
        except (OSError, ValueError):
            raise APIError("The local moves.json is invalid.", 500, "invalid_moves") from None
        return {m["name"]: m for m in (moves if isinstance(moves, list) else [])
                if isinstance(m, dict) and isinstance(m.get("name"), str) and (m.get("kind") or "move") == kind}

    def room_type(self, room_id):
        room = self.room_definitions().get(room_id, {})
        kind = room.get("type") if isinstance(room, dict) else None
        return kind if isinstance(kind, str) and kind else "2.5d"

    def move_fits_room(self, definition, room_id):
        # moves.json "roomTypes": ["pano360"] limits a move to rooms of that rooms.json type ("2.5d" when unset);
        # "rooms": {"<id>": false} disables it in one room. Same rule as js/moves.js moveEnabled().
        types = definition.get("roomTypes")
        if isinstance(types, list) and self.room_type(room_id) not in types:
            return False
        rooms = definition.get("rooms")
        return not (isinstance(rooms, dict) and rooms.get(room_id) is False)

    def move_names(self):
        return set(self.move_defs("move"))

    def room_definitions(self):
        # The renderer, panel and server share this single room registry. Read
        # lazily so the asset-generation workflow can create it after import.
        if self.config_path is None or not self.config_path.exists():
            return {room: {"camera": CAMERA_BOUNDS} for room in FALLBACK_ROOMS}
        try:
            rooms = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
            if not isinstance(rooms, list) or not rooms:
                raise ValueError("Room registry must be a nonempty array")
            result = {}
            for room in rooms:
                if not isinstance(room, dict) or not isinstance(room.get("id"), str) or not room["id"] or room["id"] in result:
                    raise ValueError("Each room needs a unique string id")
                result[room["id"]] = room
            return result
        except (OSError, ValueError):
            raise APIError("The local rooms.json registry is invalid.", 500, "invalid_rooms") from None

    def camera_bounds(self):
        camera = self.room_definitions().get(self.state["room"], {}).get("camera", {})
        if not isinstance(camera, dict):
            raise APIError("Invalid camera limits in rooms.json.", 500, "invalid_rooms")
        bounds = {}
        for key, fallback in CAMERA_BOUNDS.items():
            bound = camera.get(key, fallback)
            if not isinstance(bound, (list, tuple)) or len(bound) != 2 or any(type(number) not in (int, float) for number in bound) or not -1e9 <= bound[0] <= bound[1] <= 1e9:
                raise APIError("Invalid camera limits in rooms.json.", 500, "invalid_rooms")
            bounds[key] = bound
        return bounds

    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.state)
            result["transitionActive"] = self.monotonic() < self.busy_until
            result["walkActive"] = round(self.clock() * 1000) < self.state["walkUntil"]
            result["serverTime"] = round(self.clock() * 1000)
            return result

    def command(self, command):
        if not isinstance(command, dict):
            raise APIError("Command must be a JSON object.")
        kind = command.get("type")
        value = command.get("value")
        with self.lock:
            next_state = copy.deepcopy(self.state)
            if kind == "room":
                if not isinstance(value, str) or value not in self.room_definitions():
                    raise APIError("Unknown room.")
                if value == self.state["room"]:
                    return self.snapshot()
                if self.monotonic() < self.busy_until:
                    raise APIError("Room transition is still running.", 409, "transition_busy")
                next_state["room"] = value
                next_state["camera"] = zero_camera()
                next_state["move"] = None
                next_state["walk"] = None
                next_state["walkFrom"] = next_state["walkSpot"] = "a"
                next_state["walkUntil"] = 0
                next_state["transitionId"] += 1
                next_state["transitionStartedAt"] = round(self.clock() * 1000)
                next_state["transitionUntil"] = next_state["transitionStartedAt"] + round(next_state["transitionSeconds"] * 1000)
            elif kind == "slide":
                delta = command.get("delta")
                if type(delta) is not int or delta not in (-1, 1):
                    raise APIError("Slide delta must be -1 or 1.")
                if not self.state["slides"]:
                    raise APIError("No deck is loaded.", 409, "no_deck")
                next_state["page"] = (self.state["page"] + delta) % len(self.state["slides"])
                next_state["videoPlaying"] = True        # a newly shown video starts from the top
                next_state["videoRestartId"] += 1
            elif kind == "page":
                if type(value) is not int or not 0 <= value < len(self.state["slides"]):
                    raise APIError("Page is outside the current deck.")
                next_state["page"] = value
                next_state["videoPlaying"] = True
                next_state["videoRestartId"] += 1
            elif kind == "video":
                if value not in VIDEO_ACTIONS:
                    raise APIError("Video action must be play, pause, toggle or restart.", 400, "invalid_video")
                if value == "toggle":
                    next_state["videoPlaying"] = not self.state["videoPlaying"]
                elif value == "restart":
                    next_state["videoPlaying"] = True
                    next_state["videoRestartId"] += 1
                else:
                    next_state["videoPlaying"] = value == "play"
            elif kind == "muted":
                if type(value) is not bool:
                    raise APIError("muted must be true or false.")
                next_state["videoMuted"] = value
            elif kind == "preset":
                if value not in ("wide", "presenter", "screen"):
                    raise APIError("Unknown camera preset.")
                next_state["preset"] = value
                next_state["camera"] = zero_camera()
                next_state["move"] = None
            elif kind == "camera":
                if not isinstance(value, dict) or not value or set(value) - set(CAMERA_BOUNDS):
                    raise APIError("Camera must contain known camera fields.")
                bounds = self.camera_bounds()
                for key, number in value.items():
                    low, high = bounds[key]
                    if type(number) not in (int, float) or not low <= number <= high:
                        raise APIError(f"Camera {key} must be between {low} and {high}.")
                next_state["camera"].update(value)
                next_state["move"] = None
            elif kind == "reset":
                next_state["camera"] = zero_camera()
                next_state["move"] = None
            elif kind == "debug":
                if type(value) is not bool:
                    raise APIError("Debug must be true or false.")
                next_state["debug"] = value
            elif kind == "mode":
                if value not in ("A", "B"):
                    raise APIError("Transition mode must be A or B.")
                next_state["mode"] = value
            elif kind == "fade":
                if value not in ("dark", "light"):
                    raise APIError("Fade must be dark or light.")
                next_state["fade"] = value
            elif kind in ("avatar", "screen", "sway"):
                if type(value) is not bool:
                    raise APIError(f"{kind} must be true or false.")
                next_state[kind] = value
            elif kind == "move":
                if value == "stop":
                    next_state["move"] = None
                elif not isinstance(value, str) or value not in self.move_names():
                    raise APIError("Unknown move (not in moves.json).", 400, "unknown_move")
                elif not self.move_fits_room(self.move_defs("move")[value], self.state["room"]):
                    raise APIError("This move is not available in the current room type.", 409, "move_not_in_room")
                else:
                    next_state["move"] = value
                    next_state["moveId"] += 1
                    next_state["moveStartedAt"] = round(self.clock() * 1000)
            elif kind == "walk":
                walks = self.move_defs("walk")
                if not isinstance(value, str) or value not in walks:
                    raise APIError("Unknown walk (not in moves.json).", 400, "unknown_walk")
                if self.monotonic() < self.busy_until:
                    raise APIError("Room transition is still running.", 409, "transition_busy")
                now = round(self.clock() * 1000)
                if now < self.state["walkUntil"]:
                    raise APIError("A walk is still running.", 409, "walk_busy")
                spot = walks[value].get("end")
                max_seconds = walks[value].get("maxSeconds", 20)
                if type(max_seconds) not in (int, float) or not 0 < max_seconds <= 120:
                    raise APIError("Invalid maxSeconds in moves.json.", 500, "invalid_moves")
                next_state["walk"] = value
                next_state["walkId"] += 1
                next_state["walkStartedAt"] = now
                next_state["walkUntil"] = now + round(max_seconds * 1000)
                next_state["walkFrom"] = self.state["walkSpot"]
                next_state["walkSpot"] = spot if isinstance(spot, str) and spot else self.state["walkSpot"]
            elif kind == "deck":
                next_state["slides"] = self.deck_paths(value)
                next_state["deck"] = value
                next_state["page"] = 0
            else:
                raise APIError("Unknown command type.")
            if next_state != self.state:
                next_state["revision"] += 1
                self.state = next_state
                if kind == "room":
                    self.busy_until = self.monotonic() + self.state["transitionSeconds"]
            return self.snapshot()

    def deck_paths(self, folder):
        """A deck = assets/slides/<name>/. If it has deck.json ({"items": ["01.png", "02.mp4", ...]})
        that order is used (images and videos can be mixed); otherwise every image/video file in
        natural filename order (01.png, 02.png, ..., 10.png)."""
        if not isinstance(folder, str) or not DECK_NAME.fullmatch(folder):
            raise APIError("Deck must be assets/slides/<name>.", 400, "invalid_deck")
        directory = (self.root / folder).resolve()
        if not directory.is_relative_to(self.root) or not directory.is_dir():
            raise APIError("Deck folder not found.", 404, "invalid_deck")
        listing = directory / "deck.json"
        if listing.is_file():
            try:
                items = json.loads(listing.read_text(encoding="utf-8-sig"))
                items = items.get("items") if isinstance(items, dict) else items
                names = [item if isinstance(item, str) else item.get("src") for item in items]
                if not all(isinstance(name, str) and (directory / name).is_file() for name in names):
                    raise ValueError
            except (OSError, ValueError, AttributeError, TypeError):
                raise APIError('deck.json must list existing files: {"items": ["01.png", "02.mp4"]}.', 400, "invalid_deck") from None
        else:
            names = sorted((p.name for p in directory.iterdir() if p.is_file() and p.suffix.lower() in SLIDE_SUFFIXES), key=natural_key)
        paths = [f"{folder}/{name}" for name in names if DECK_PATH.fullmatch(f"{folder}/{name}")]
        if not 1 <= len(paths) <= 64:
            raise APIError("Deck needs 1 to 64 images.", 400, "invalid_deck")
        return paths

    def deck_folders(self):
        base = self.root / "assets" / "slides"
        if not base.is_dir():
            return []
        return [f"assets/slides/{p.name}" for p in sorted(base.iterdir(), key=lambda p: natural_key(p.name))
                if p.is_dir() and DECK_NAME.fullmatch(f"assets/slides/{p.name}")]

    def set_slides(self, paths, deck=None):
        with self.lock:
            self.state["slides"] = list(paths)
            self.state["deck"] = deck
            self.state["page"] = 0
            self.state["revision"] += 1
            return self.snapshot()


def decode_slides(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("slides"), list):
        raise APIError("Expected {slides: [{name, data}]}.", code="invalid_slides")
    slides = payload["slides"]
    if not 1 <= len(slides) <= 32:
        raise APIError("Upload between 1 and 32 slides.", code="invalid_slides")
    result = []
    for slide in slides:
        if not isinstance(slide, dict) or not isinstance(slide.get("data"), str):
            raise APIError("Each slide needs base64 image data.", code="invalid_slides")
        data = slide["data"]
        if data.startswith("data:"):
            header, separator, data = data.partition(",")
            if not separator or header not in ("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"):
                raise APIError("Unsupported image data URL.", code="invalid_slides")
        try:
            binary = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error):
            raise APIError("Invalid base64 image data.", code="invalid_slides") from None
        if not 16 <= len(binary) <= MAX_IMAGE_BYTES:
            raise APIError("Each image must be at most 8 MB.", 413, "image_size")
        if binary.startswith(b"\x89PNG\r\n\x1a\n") and binary[12:16] == b"IHDR":
            extension = "png"
        elif binary.startswith(b"\xff\xd8\xff"):
            extension = "jpg"
        elif binary.startswith(b"RIFF") and binary[8:12] == b"WEBP":
            extension = "webp"
        else:
            raise APIError("Only PNG, JPEG and WebP image slides are accepted.", code="invalid_slides")
        result.append((hashlib.sha256(binary).hexdigest() + "." + extension, binary))
    return result


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address=("127.0.0.1", DEFAULT_PORT), root=ROOT, state=None, capture_dir=None):
        self.root = Path(root).resolve()
        self.capture_dir = Path(capture_dir) if capture_dir else (CAPTURE_DIR if self.root == ROOT else self.root / "_capture")
        self.studio = state or StudioState(config_path=self.root / "rooms.json", root=self.root)
        self.upload_lock = threading.Lock()
        if state is None:
            self.restore_deck()
            if not self.studio.state["slides"]:
                self.load_default_deck()
        super().__init__(address, StudioHandler)

    def restore_deck(self):
        manifest = self.root / "assets" / "uploads" / "deck.json"
        try:
            if not manifest.resolve().is_relative_to(self.root):
                return
            saved = json.loads(manifest.read_text(encoding="utf-8"))
            paths = saved["slides"]
            if not isinstance(paths, list) or not 1 <= len(paths) <= 64:
                return
            for path in paths:
                if not isinstance(path, str) or not DECK_PATH.fullmatch(path):
                    return
                asset = (self.root / path).resolve()
                if not asset.is_relative_to(self.root) or not asset.is_file():
                    return
            deck = saved.get("deck")
            self.studio.set_slides(paths, deck if isinstance(deck, str) and DECK_NAME.fullmatch(deck) else None)
        except (OSError, ValueError, KeyError, TypeError):
            # A missing or damaged manifest safely falls back to the built-in deck.
            pass

    def load_default_deck(self):
        # assets/slides/sample when present, else the first deck folder. No deck = a plain screen.
        decks = self.studio.deck_folders()
        for deck in ([DEFAULT_DECK] if DEFAULT_DECK in decks else []) + decks:
            try:
                self.studio.set_slides(self.studio.deck_paths(deck), deck)
                return
            except APIError:
                continue

    def write_manifest(self, paths, deck=None):
        with self.upload_lock:
            uploads = self.root / "assets" / "uploads"
            uploads.mkdir(parents=True, exist_ok=True)
            manifest, pending = uploads / "deck.json", uploads / "deck.pending"
            if not all(path.resolve().is_relative_to(uploads.resolve()) for path in (manifest, pending)):
                raise APIError("Invalid deck manifest destination.", 403, "invalid_path")
            pending.write_text(json.dumps({"slides": paths, "deck": deck}), encoding="utf-8")
            pending.replace(manifest)

    def save_deck(self, decoded):
        with self.upload_lock:
            uploads = self.root / "assets" / "uploads"
            if not uploads.resolve().is_relative_to(self.root):
                raise APIError("Upload folder is outside the studio.", 403, "invalid_path")
            uploads.mkdir(parents=True, exist_ok=True)
            paths = []
            for filename, binary in decoded:
                destination = uploads / filename
                if not destination.resolve().is_relative_to(uploads.resolve()):
                    raise APIError("Invalid upload destination.", 403, "invalid_path")
                try:
                    with destination.open("xb") as output:
                        output.write(binary)
                except FileExistsError:
                    pass
                paths.append("assets/uploads/" + filename)
            manifest = uploads / "deck.json"
            pending = uploads / "deck.pending"
            if not all(path.resolve().is_relative_to(uploads.resolve()) for path in (manifest, pending)):
                raise APIError("Invalid deck manifest destination.", 403, "invalid_path")
            pending.write_text(json.dumps({"slides": paths}), encoding="utf-8")
            pending.replace(manifest)
            return self.studio.set_slides(paths)


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "Studio25D/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        # Continuous state polling would otherwise fill the launcher's log.
        if not (self.path.startswith("/api/state") and len(args) > 1 and str(args[1]) == "200"):
            super().log_message(fmt, *args)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": message or HTTPStatus(code).phrase, "code": "http_error"})

    def validate_host(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            hosts.update(("127.0.0.1", "localhost"))
        host = self.headers.get("Host", "").lower()
        if host not in hosts:
            raise APIError("This server accepts local Host headers only.", 403, "invalid_host")
        return host

    def validate_origin(self):
        host = self.validate_host()
        # Origin is checked only when present (CLI / curl send none); browsers always send it on POST.
        origin = self.headers.get("Origin")
        if origin is not None and origin.lower() != f"http://{host}":
            raise APIError("Commands must come from this studio's local origin.", 403, "invalid_origin")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError("Cross-site commands are not allowed.", 403, "invalid_origin")

    def read_json(self):
        if self.headers.get("Transfer-Encoding"):
            raise APIError("Chunked requests are unsupported.", 400, "invalid_length")
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            raise APIError("Use application/json.", 415, "invalid_content_type")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise APIError("A valid Content-Length is required.", 411, "invalid_length")
        length = int(lengths[0])
        if not 0 < length <= MAX_BODY_BYTES:
            raise APIError("Request must be between 1 byte and 40 MB.", 413, "body_size")
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete body")
            return json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON number")))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise APIError("Invalid JSON request.", 400, "invalid_json") from None

    def do_POST(self):
        try:
            self.validate_origin()
            parts = urlsplit(self.path)
            path = parts.path
            if path in ("/save", "/save_frame", "/log"):
                self.send_json(200, self.capture(path, parse_qs(parts.query)))
                return
            if path not in ("/api/command", "/api/slides", "/api/audit"):
                raise APIError("Endpoint not found.", 404, "not_found")
            payload = self.read_json()
            if path == "/api/audit":
                self.send_json(200, self.save_audit(payload))
                return
            if path == "/api/command":
                state = self.server.studio.command(payload)
                if isinstance(payload, dict) and payload.get("type") == "deck":
                    self.server.write_manifest(state["slides"], state["deck"])
            else:
                decoded = decode_slides(payload)
                state = self.server.save_deck(decoded)
            self.send_json(200, state)
        except APIError as error:
            self.send_json(error.status, {"error": str(error), "code": error.code})
        except (OSError, TimeoutError):
            self.send_json(500, {"error": "Local file or connection operation failed.", "code": "io_error"})

    def read_raw(self):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise APIError("A valid Content-Length is required.", 411, "invalid_length")
        length = int(lengths[0])
        if length > MAX_BODY_BYTES:
            raise APIError("Body too large.", 413, "body_size")
        return self.rfile.read(length)

    def capture(self, path, query):
        """Capture sinks for shots / safety frames / page logs."""
        base = self.server.capture_dir / "shots"
        body = self.read_raw()
        base.mkdir(parents=True, exist_ok=True)
        if path == "/save":
            name = os.path.basename(query.get("name", ["shot.png"])[0]) or "shot.png"
            if not name.lower().endswith((".png", ".jpg", ".json")):
                name += ".png"
            (base / name).write_bytes(body)
            return {"ok": True, "name": name, "bytes": len(body)}
        if path == "/save_frame":
            folder = os.path.basename(query.get("dir", ["frames"])[0]) or "frames"
            seq = os.path.basename(query.get("seq", ["0000"])[0]) or "0000"
            ext = query.get("ext", ["png"])[0]
            ext = ext if ext in ("png", "jpg", "json") else "png"
            target = base / folder
            target.mkdir(parents=True, exist_ok=True)
            (target / f"{seq}.{ext}").write_bytes(body)
            return {"ok": True}
        with (base / "log.txt").open("ab") as stream:
            stream.write(time.strftime("%H:%M:%S ").encode() + body + b"\n")
        print("[log]", body.decode("utf-8", "replace"), flush=True)
        return {"ok": True}

    def save_audit(self, payload):
        reports = self.server.capture_dir / "reports"
        reports.mkdir(parents=True, exist_ok=True)
        kind = payload.get("kind") if isinstance(payload, dict) and payload.get("kind") in ("coverage", "safety", "motion", "slip") else "coverage"
        target = reports / f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}.json"
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        return {"ok": True, "path": str(target)}

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self.validate_host()
            path = unquote(urlsplit(self.path).path)
            if path == "/api/state":
                self.send_json(200, self.server.studio.snapshot())
                return
            if path == "/api/decks":
                self.send_json(200, {"decks": self.server.studio.deck_folders()})
                return
            if path.startswith("/api/"):
                raise APIError("Endpoint not found.", 404, "not_found")
            if "\\" in path or "\x00" in path or any(part.startswith(".") for part in path.split("/") if part):
                raise APIError("Invalid asset path.", 403, "invalid_path")
            relative = "index.html" if path == "/" else path.lstrip("/")
            asset = (self.server.root / relative).resolve()
            if not asset.is_relative_to(self.server.root):
                raise APIError("Asset is outside the studio.", 403, "invalid_path")
            if not asset.is_file():
                raise APIError("Asset not found.", 404, "not_found")
            # A static asset server has no reason to expose executable source/logs.
            if asset.suffix.lower() not in {".html", ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".vrm", ".glb", ".gltf", ".bin", ".woff", ".woff2", ".mp3", ".wav", ".ogg", ".mp4", ".webm"}:
                raise APIError("This file type is not a studio asset.", 403, "invalid_path")
            content_type = {".js": "text/javascript", ".mjs": "text/javascript", ".vrm": "model/gltf-binary",
                            ".mp4": "video/mp4", ".webm": "video/webm"}.get(asset.suffix.lower()) or mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
            size = asset.stat().st_size
            start, end = 0, size - 1
            # Byte ranges (single range only): browsers need them to seek / loop <video> reliably.
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
            partial = bool(match and (match.group(1) or match.group(2)) and size > 0)
            if partial:
                if match.group(1):
                    start = int(match.group(1))
                    end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
                else:
                    start = max(0, size - int(match.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            with asset.open("rb") as stream:
                self.send_response(206 if partial else 200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Accept-Ranges", "bytes")
                if partial:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if self.command != "HEAD":
                    stream.seek(start)
                    remaining = end - start + 1
                    while remaining > 0 and (chunk := stream.read(min(256 * 1024, remaining))):
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except APIError as error:
            self.send_json(error.status, {"error": str(error), "code": error.code})
        except (OSError, TimeoutError):
            self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    with StudioServer(("127.0.0.1", args.port)) as server:
        print(f"Studio: http://127.0.0.1:{args.port}/", flush=True)
        print(f"Control: http://127.0.0.1:{args.port}/control.html", flush=True)
        print(f"OBS: http://127.0.0.1:{args.port}/?output=1  (1920 x 1080)", flush=True)
        print("State is shared across all local browser / OBS processes. Ctrl+C stops the server.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
