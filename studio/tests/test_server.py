"""Run: python -B -m unittest discover -s tests -p test_server.py -v"""

import base64
from concurrent.futures import ThreadPoolExecutor
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest


spec = importlib.util.spec_from_file_location("studio_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = server.StudioState(clock=lambda: self.now, monotonic=lambda: self.now)

    def test_room_transition_has_shared_deadline_and_rejects_overlap(self):
        result = self.state.command({"type": "room", "value": "room_b"})
        self.assertEqual((result["revision"], result["transitionId"], result["transitionUntil"]), (1, 1, 102000))
        self.assertTrue(result["transitionActive"])
        with self.assertRaises(server.APIError) as raised:
            self.state.command({"type": "room", "value": "room_a"})
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.state.snapshot()["room"], "room_b")
        self.now = 102.1
        self.assertFalse(self.state.snapshot()["transitionActive"])
        self.assertEqual(self.state.command({"type": "room", "value": "room_a"})["transitionId"], 2)

    def test_page_wrap_and_simultaneous_revisions(self):
        with self.assertRaises(server.APIError):            # no deck yet → 409 no_deck
            self.state.command({"type": "slide", "delta": 1})
        self.state.set_slides(["assets/slides/x/01.png", "assets/slides/x/02.png", "assets/slides/x/03.png"])
        self.assertEqual(self.state.command({"type": "slide", "delta": -1})["page"], 2)
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: self.state.command({"type": "slide", "delta": 1}), range(120)))
        self.assertEqual(self.state.snapshot()["revision"], 122)
        self.assertEqual(self.state.snapshot()["page"], 2)
        self.assertEqual(len({result["revision"] for result in results}), 120)

    def test_rejected_commands_do_not_mutate_state(self):
        invalid = [None, [], {}, {"type": "slide", "delta": True}, {"type": "page", "value": -1},
                   {"type": "page", "value": 3}, {"type": "camera", "value": {"yaw": 5}},
                   {"type": "camera", "value": {"pitch": float("nan")}},
                   {"type": "camera", "value": {"x": True}}, {"type": "camera", "value": {"foo": 0}},
                   {"type": "debug", "value": 1}, {"type": "room", "value": "attic"}]
        before = self.state.snapshot()
        for command in invalid:
            with self.subTest(command=command), self.assertRaises(server.APIError):
                self.state.command(command)
        self.assertEqual(self.state.snapshot(), before)

    def test_camera_atomic_patch_reset_and_snapshot_isolation(self):
        self.state.command({"type": "camera", "value": {"yaw": 4, "dolly": 3}})
        result = self.state.command({"type": "camera", "value": {"pitch": -2}})
        self.assertEqual(result["camera"]["yaw"], 4)
        result["camera"]["yaw"] = 99
        self.assertEqual(self.state.snapshot()["camera"]["yaw"], 4)
        self.assertEqual(self.state.command({"type": "reset"})["camera"], server.zero_camera())

    def test_registry_is_the_source_for_room_ids_and_camera_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory) / "rooms.json"
            state = server.StudioState(config_path=registry)
            registry.write_text(json.dumps([
                {"id": "room_a", "camera": {"yaw": [-2, 2]}},
                {"id": "terrace"},
            ]), encoding="utf-8")
            with self.assertRaises(server.APIError):
                state.command({"type": "camera", "value": {"yaw": 3}})
            with self.assertRaises(server.APIError):
                state.command({"type": "room", "value": "room_b"})
            self.assertEqual(state.command({"type": "room", "value": "terrace"})["room"], "terrace")


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        (cls.root / "index.html").write_text("<h1>Studio</h1>", encoding="utf-8")
        cls.httpd = server.StudioServer(("127.0.0.1", 0), root=cls.root)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        port = self.httpd.server_port
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        body = None if payload is None else json.dumps(payload)
        request_headers = {"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"}
        request_headers.update(headers or {})
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        connection.close()
        return status, data

    def test_controller_and_obs_read_same_authoritative_state(self):
        status, changed = self.request("POST", "/api/command", {"type": "preset", "value": "screen"})
        self.assertEqual(status, 200)
        status, polled = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(polled)["revision"], json.loads(changed)["revision"])
        self.assertEqual(json.loads(polled)["preset"], "screen")

    def test_traversal_and_nonlocal_host_are_rejected(self):
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/%5c..%5csecret.txt", "/.git/config"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/")[0], 200)

    def test_cross_origin_or_missing_origin_cannot_mutate(self):
        for origin in ("https://evil.example", "null", ""):
            with self.subTest(origin=origin):
                status, data = self.request("POST", "/api/command", {"type": "debug", "value": True}, {"Origin": origin})
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(data)["code"], "invalid_origin")

    def test_size_limit_is_checked_before_reading_body(self):
        self.assertEqual(self.request("POST", "/api/command", {}, {"Content-Length": str(server.MAX_BODY_BYTES + 1)})[0], 413)

    def test_slide_upload_validates_magic_and_uses_opaque_local_names(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
        payload = {"slides": [{"name": "../../escape.png", "data": base64.b64encode(png).decode()}]}
        status, data = self.request("POST", "/api/slides", payload)
        self.assertEqual(status, 200)
        slides = json.loads(data)["slides"]
        self.assertEqual(len(slides), 1)
        self.assertTrue(slides[0].startswith("assets/uploads/"))
        self.assertEqual(self.request("GET", "/" + slides[0])[1], png)
        payload["slides"][0]["data"] = base64.b64encode(b"<svg>not accepted</svg>").decode()
        self.assertEqual(self.request("POST", "/api/slides", payload)[0], 400)
        self.assertEqual(json.loads(self.request("GET", "/api/state")[1])["slides"], slides)
        with server.StudioServer(("127.0.0.1", 0), root=self.root) as restarted:
            self.assertEqual(restarted.studio.snapshot()["slides"], slides)
            self.assertEqual(restarted.studio.snapshot()["page"], 0)

    def test_restart_never_restores_paths_outside_uploaded_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            uploads = root / "assets" / "uploads"
            uploads.mkdir(parents=True)
            (uploads / "deck.json").write_text(json.dumps({"slides": ["../../private.png"]}), encoding="utf-8")
            with server.StudioServer(("127.0.0.1", 0), root=root) as restarted:
                self.assertEqual(restarted.studio.snapshot()["slides"], [])


class StudioAdditionTests(unittest.TestCase):
    """Deck / avatar / screen / move / walk commands."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "rooms.json").write_text(json.dumps([{"id": "room_a"}, {"id": "room_b"}]), encoding="utf-8")
        (self.root / "moves.json").write_text("[]", encoding="utf-8")
        deck = self.root / "assets" / "slides" / "lt_test"
        deck.mkdir(parents=True)
        for name in ("10.png", "2.png", "1.png", "notes.txt"):
            (deck / name).write_bytes(b"x")
        self.now = 50.0
        self.state = server.StudioState(clock=lambda: self.now, monotonic=lambda: self.now,
                                        config_path=self.root / "rooms.json", root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_state_exposes_transition_seconds_and_one_shot_slots(self):
        snap = self.state.snapshot()
        self.assertEqual(snap["transitionSeconds"], 2.0)
        self.assertEqual((snap["move"], snap["moveId"], snap["walk"], snap["walkId"]), (None, 0, None, 0))
        self.assertEqual(self.state.command({"type": "room", "value": "room_b"})["transitionUntil"], 52000)

    def test_move_and_walk_unknown_names_are_400_without_mutation(self):
        before = self.state.snapshot()
        for command in ({"type": "move", "value": "push_in"}, {"type": "move", "value": 3}, {"type": "walk", "value": "a"}):
            with self.subTest(command=command), self.assertRaises(server.APIError) as raised:
                self.state.command(command)
            self.assertEqual(raised.exception.status, 400)
        self.assertEqual(self.state.snapshot(), before)
        (self.root / "moves.json").write_text(json.dumps([{"name": "push_in"}]), encoding="utf-8")
        self.assertEqual(self.state.command({"type": "move", "value": "push_in"})["moveId"], 1)

    def test_move_stop_and_clearing_by_camera_commands(self):
        (self.root / "moves.json").write_text(json.dumps([{"name": "push_in"}, {"name": "guide_slide", "kind": "walk"}]), encoding="utf-8")
        with self.assertRaises(server.APIError):            # a walk name is not a move
            self.state.command({"type": "move", "value": "guide_slide"})
        snap = self.state.command({"type": "move", "value": "push_in"})
        self.assertEqual((snap["move"], snap["moveId"], snap["moveStartedAt"]), ("push_in", 1, 50000))
        self.assertIsNone(self.state.command({"type": "move", "value": "stop"})["move"])
        for clearing in ({"type": "preset", "value": "screen"}, {"type": "camera", "value": {"yaw": 1}}, {"type": "reset"}):
            with self.subTest(clearing=clearing):
                self.state.command({"type": "move", "value": "push_in"})
                self.assertIsNone(self.state.command(clearing)["move"])
        self.assertEqual(self.state.snapshot()["moveId"], 4)

    def test_walk_orders_chain_spots_and_reject_overlap(self):
        (self.root / "moves.json").write_text(json.dumps([
            {"name": "guide_slide", "kind": "walk", "end": "b", "maxSeconds": 12},
            {"name": "goto_a", "kind": "walk", "end": "a", "maxSeconds": 6}]), encoding="utf-8")
        snap = self.state.command({"type": "walk", "value": "guide_slide"})
        self.assertEqual((snap["walk"], snap["walkId"], snap["walkFrom"], snap["walkSpot"], snap["walkUntil"]), ("guide_slide", 1, "a", "b", 62000))
        self.assertTrue(snap["walkActive"])
        with self.assertRaises(server.APIError) as raised:
            self.state.command({"type": "walk", "value": "goto_a"})
        self.assertEqual((raised.exception.status, raised.exception.code), (409, "walk_busy"))
        self.now = 62.5
        snap = self.state.command({"type": "walk", "value": "goto_a"})
        self.assertEqual((snap["walkFrom"], snap["walkSpot"], snap["walkId"]), ("b", "a", 2))
        with self.assertRaises(server.APIError):            # a move name is not a walk
            self.state.command({"type": "walk", "value": "push_in"})
        self.now = 70.0
        self.state.command({"type": "walk", "value": "guide_slide"})
        self.now = 83.0
        snap = self.state.command({"type": "room", "value": "room_b"})   # a room change resets the spot
        self.assertEqual((snap["walk"], snap["walkSpot"], snap["walkFrom"]), (None, "a", "a"))
        with self.assertRaises(server.APIError) as raised:                  # no walking during the transition
            self.state.command({"type": "walk", "value": "guide_slide"})
        self.assertEqual(raised.exception.code, "transition_busy")

    def test_room_type_limited_moves_only_play_in_matching_rooms(self):
        (self.root / "rooms.json").write_text(json.dumps([{"id": "room_a"}, {"id": "pano", "type": "pano360"}]), encoding="utf-8")
        (self.root / "moves.json").write_text(json.dumps([
            {"name": "orbit360", "roomTypes": ["pano360"]}, {"name": "push_in"}, {"name": "flat_only", "roomTypes": ["2.5d"]},
            {"name": "not_here", "rooms": {"pano": False}}]), encoding="utf-8")
        before = self.state.snapshot()
        with self.assertRaises(server.APIError) as raised:                  # 2.5D room: the 360 move is refused
            self.state.command({"type": "move", "value": "orbit360"})
        self.assertEqual((raised.exception.status, raised.exception.code), (409, "move_not_in_room"))
        self.assertEqual(self.state.snapshot(), before)
        self.assertEqual(self.state.command({"type": "move", "value": "flat_only"})["move"], "flat_only")
        self.state.command({"type": "room", "value": "pano"})
        self.now += 3
        self.assertEqual(self.state.command({"type": "move", "value": "orbit360"})["move"], "orbit360")
        self.assertEqual(self.state.command({"type": "move", "value": "push_in"})["move"], "push_in")   # untyped = everywhere
        for name in ("flat_only", "not_here"):
            with self.subTest(name=name), self.assertRaises(server.APIError):
                self.state.command({"type": "move", "value": name})

    def test_idle_sway_defaults_on_and_toggles(self):
        self.assertTrue(self.state.snapshot()["sway"])
        self.assertFalse(self.state.command({"type": "sway", "value": False})["sway"])
        with self.assertRaises(server.APIError):
            self.state.command({"type": "sway", "value": "off"})

    def test_deck_lists_folder_in_natural_order_and_rejects_escape(self):
        result = self.state.command({"type": "deck", "value": "assets/slides/lt_test"})
        self.assertEqual(result["slides"], [f"assets/slides/lt_test/{n}.png" for n in (1, 2, 10)])
        self.assertEqual(result["page"], 0)
        for value in ("assets/slides/../..", "assets/uploads", "assets/slides/missing", 7):
            with self.subTest(value=value), self.assertRaises(server.APIError):
                self.state.command({"type": "deck", "value": value})
        self.assertEqual(self.state.deck_folders(), ["assets/slides/lt_test"])

    def test_avatar_and_screen_toggles(self):
        self.assertFalse(self.state.command({"type": "avatar", "value": False})["avatar"])
        self.assertFalse(self.state.command({"type": "screen", "value": False})["screen"])
        with self.assertRaises(server.APIError):
            self.state.command({"type": "screen", "value": "no"})


class VideoCommandTests(unittest.TestCase):
    def test_video_play_pause_restart_and_mute(self):
        state = server.StudioState(clock=lambda: 1.0, monotonic=lambda: 1.0)
        snap = state.snapshot()
        self.assertEqual((snap["videoPlaying"], snap["videoMuted"]), (True, True))
        self.assertFalse(state.command({"type": "video", "value": "pause"})["videoPlaying"])
        self.assertTrue(state.command({"type": "video", "value": "toggle"})["videoPlaying"])
        rid = state.snapshot()["videoRestartId"]
        self.assertEqual(state.command({"type": "video", "value": "restart"})["videoRestartId"], rid + 1)
        self.assertFalse(state.command({"type": "muted", "value": False})["videoMuted"])
        with self.assertRaises(server.APIError):
            state.command({"type": "video", "value": "rewind"})
        with self.assertRaises(server.APIError):
            state.command({"type": "muted", "value": "yes"})


class StudioHTTPAdditionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        (cls.root / "index.html").write_text("<h1>Studio</h1>", encoding="utf-8")
        deck = cls.root / "assets" / "slides" / "deck_a"
        deck.mkdir(parents=True)
        (deck / "01.png").write_bytes(b"\x89PNG")
        video = cls.root / "assets" / "slides" / "deck_v"
        video.mkdir(parents=True)
        (video / "01.png").write_bytes(b"\x89PNG")
        (video / "02.mp4").write_bytes(b"0123456789")
        (video / "deck.json").write_text(json.dumps({"items": ["02.mp4", "01.png"]}), encoding="utf-8")
        cls.httpd = server.StudioServer(("127.0.0.1", 0), root=cls.root)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = (response.status, response.getheader("Content-Type"), data)
        connection.close()
        return result

    def test_video_is_served_with_byte_ranges(self):
        status, content_type, data = self.request("GET", "/assets/slides/deck_v/02.mp4", headers={"Range": "bytes=2-5"})
        self.assertEqual((status, content_type, data), (206, "video/mp4", b"2345"))
        status, _, data = self.request("GET", "/assets/slides/deck_v/02.mp4", headers={"Range": "bytes=-3"})
        self.assertEqual((status, data), (206, b"789"))
        status, _, data = self.request("GET", "/assets/slides/deck_v/02.mp4")
        self.assertEqual((status, data), (200, b"0123456789"))
        self.assertEqual(self.request("GET", "/assets/slides/deck_v/02.mp4", headers={"Range": "bytes=50-60"})[0], 416)

    def test_deck_json_orders_mixed_images_and_videos(self):
        body = json.dumps({"type": "deck", "value": "assets/slides/deck_v"})
        status, _, data = self.request("POST", "/api/command", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["slides"], ["assets/slides/deck_v/02.mp4", "assets/slides/deck_v/01.png"])

    def test_cli_without_origin_may_command_but_foreign_origin_may_not(self):
        body = json.dumps({"type": "deck", "value": "assets/slides/deck_a"})
        status, _, data = self.request("POST", "/api/command", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["slides"], ["assets/slides/deck_a/01.png"])
        self.assertTrue((self.root / "assets" / "uploads" / "deck.json").is_file())
        with server.StudioServer(("127.0.0.1", 0), root=self.root) as restarted:
            self.assertEqual(restarted.studio.snapshot()["slides"], ["assets/slides/deck_a/01.png"])
        status, _, _ = self.request("POST", "/api/command", body, {"Content-Type": "application/json", "Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/command", body, {"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_capture_endpoints_flatten_paths(self):
        status, _, _ = self.request("POST", "/save_frame?dir=../../evil&seq=../0001", b"PNGDATA", {"Content-Length": "7"})
        self.assertEqual(status, 200)
        self.assertEqual((self.root / "_capture" / "shots" / "evil" / "0001.png").read_bytes(), b"PNGDATA")
        status, _, data = self.request("POST", "/api/audit", json.dumps({"kind": "coverage", "summary": {}}), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        report = json.loads(data)["path"]
        self.assertFalse(Path(report).is_absolute())
        self.assertTrue((self.root / report).is_file())
        for bad in ("..", ".", "a/.."):
            status, _, _ = self.request("POST", f"/save_frame?dir={bad}&seq={bad}", b"X", {"Content-Length": "1"})
            self.assertEqual(status, 200)
        self.assertEqual((self.root / "_capture" / "shots" / "frames" / "0000.png").read_bytes(), b"X")
        self.assertFalse((self.root / "_capture" / "...png").exists())
        status, _, data = self.request("GET", "/api/decks")
        self.assertEqual(json.loads(data)["decks"], ["assets/slides/deck_a", "assets/slides/deck_v"])


if __name__ == "__main__":
    unittest.main()
