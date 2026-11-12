import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ServerApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        data = Path(self.tempdir.name)
        self.paths = patch.multiple(
            server,
            DATA=data,
            SEEDS=data / "seeds.json",
            LOCAL_PHOTOS=data / "photos.json",
            SOURCE_CONFIG=data / "source.json",
            REMOTE_PHOTOS=data / "remote-photos.json",
            PROJECTS_DIR=data / "projects",
            WRITE_TOKEN="",
        )
        self.paths.start()
        (data / "photos.json").write_text(
            json.dumps({"photos": [{"id": "local-1", "thumb": "thumbs/1.jpg", "date": "2026-08-11"}], "dates": ["2026-08-11"]}),
            encoding="utf-8",
        )
        self.client = server.app.test_client()

    def tearDown(self):
        self.paths.stop()
        self.tempdir.cleanup()

    def test_health_and_local_photos(self):
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json()["backend"], "flask")

        photos = self.client.get("/api/photos")
        self.assertEqual(photos.status_code, 200)
        self.assertEqual(photos.headers["X-BPS-Photo-Source"], "local")
        self.assertEqual(photos.get_json()["photos"][0]["id"], "local-1")

    def test_only_public_static_files_are_served(self):
        response = self.client.get("/styles.css")
        self.assertEqual(response.status_code, 200)
        response.close()
        self.assertEqual(self.client.get("/server.py").status_code, 404)
        self.assertEqual(self.client.get("/data/source.json").status_code, 404)

    def test_seeds_round_trip(self):
        payload = {"byFloor": {"UG": [{"id": "photo-1", "x": 1, "y": 2}]}}
        saved = self.client.post("/api/seeds", json=payload)
        self.assertEqual(saved.status_code, 200)

        loaded = self.client.get("/api/seeds").get_json()
        self.assertEqual(loaded["byFloor"], payload["byFloor"])
        self.assertIsNotNone(loaded["updatedAt"])

    def test_invalid_seeds_are_rejected(self):
        response = self.client.post("/api/seeds", json={"byFloor": []})
        self.assertEqual(response.status_code, 400)

    def test_write_token_protects_changes(self):
        with patch.object(server, "WRITE_TOKEN", "secret"):
            denied = self.client.post("/api/seeds", json={"byFloor": {}})
            allowed = self.client.post(
                "/api/seeds",
                json={"byFloor": {}},
                headers={"X-BPS-Token": "secret"},
            )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(allowed.status_code, 200)

    def test_remote_source_is_cached_and_activated(self):
        manifest = {
            "photos": [{"id": "remote-1", "thumb": "https://cdn.example/photo.jpg", "date": "2026-08-12"}],
            "dates": ["2026-08-12"],
            "syncedAt": "2026-08-12T00:00:00+00:00",
        }
        with patch.object(server, "_download_manifest", return_value=manifest):
            response = self.client.post(
                "/api/source",
                json={"name": "Облако", "url": "https://example.com/photos.json"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["photoCount"], 1)

        photos = self.client.get("/api/photos")
        self.assertEqual(photos.headers["X-BPS-Photo-Source"], "remote")
        self.assertEqual(photos.get_json()["photos"][0]["id"], "remote-1")

    def test_failed_source_does_not_replace_local_source(self):
        with patch.object(server, "_download_manifest", side_effect=server.SourceError("bad source")):
            response = self.client.post("/api/source", json={"url": "https://bad.example/photos.json"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/photos").headers["X-BPS-Photo-Source"], "local")

    def test_local_addresses_are_blocked(self):
        with self.assertRaises(server.SourceError):
            server._validate_public_url("http://127.0.0.1/photos.json")

    def test_invalid_port_is_rejected(self):
        with self.assertRaises(server.SourceError):
            server._validate_public_url("https://example.com:invalid/photos.json")

    def test_manifest_relative_urls_become_absolute(self):
        manifest = server._normalise_manifest(
            {"photos": [{"id": "one", "thumb": "thumb/one.jpg", "originalUrl": "original/one.jpg"}]},
            "https://cdn.example/project/photos.json",
        )
        self.assertEqual(manifest["photos"][0]["thumb"], "https://cdn.example/project/thumb/one.jpg")
        self.assertEqual(manifest["photos"][0]["originalUrl"], "https://cdn.example/project/original/one.jpg")


if __name__ == "__main__":
    unittest.main()
