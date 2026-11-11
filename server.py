#!/usr/bin/env python3
"""BPS.FotosBuilding Flask application."""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from flask import Flask, Response, jsonify, request, send_file, send_from_directory


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SEEDS = DATA / "seeds.json"
FLOORS = DATA / "floors.json"
META = DATA / "meta.json"
LOCAL_PHOTOS = DATA / "photos.json"
SOURCE_CONFIG = DATA / "source.json"
REMOTE_PHOTOS = DATA / "remote-photos.json"
PLAN_ROOT = ROOT / "plan"
PHOTOS_SOURCE = DATA / "photos-source.json"
PROJECTS = DATA / "projects.json"
THUMBS = ROOT / "thumbs"
AI_DIR = ROOT / "ai"
CONVERTED = ROOT / "converted"

def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on", "share"}


# Render sets PORT; bind all interfaces there. Local `python server.py` stays on 127.0.0.1.
HOST = os.environ.get("BPS_HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
PORT = int(os.environ.get("PORT") or os.environ.get("BPS_PORT", "8080"))
PUBLIC_VIEW = _env_flag("BPS_PUBLIC_VIEW")
WRITE_TOKEN = os.environ.get("BPS_WRITE_TOKEN", "")
SOURCE_HOSTS = {
    host.strip().lower()
    for host in os.environ.get("BPS_SOURCE_HOSTS", "").split(",")
    if host.strip()
}
SOURCE_TIMEOUT = float(os.environ.get("BPS_SOURCE_TIMEOUT", "12"))
MAX_MANIFEST_BYTES = 5 * 1024 * 1024
MAX_PLAN_BYTES = 40 * 1024 * 1024

app = Flask(__name__, static_folder=None)
_write_lock = threading.Lock()


class SourceError(ValueError):
    """A source URL or manifest cannot be used."""


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with _write_lock:
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)


def _is_plan_date(value: str) -> bool:
    import re

    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""))


def _photos_root() -> Path | None:
    env = os.environ.get("BPS_PHOTOS_ROOT", "").strip().strip('"')
    if env:
        path = Path(env)
        return path if path.is_dir() else None
    for candidate in (PHOTOS_SOURCE, LOCAL_PHOTOS, META):
        payload = _read_json(candidate, {})
        if isinstance(payload, dict) and payload.get("photosRoot"):
            path = Path(str(payload["photosRoot"]))
            if path.is_dir():
                return path
    return None


def _level_dir() -> Path | None:
    root = _photos_root()
    if root is None:
        return None
    level = root / "Level"
    return level if level.is_dir() else None


def _safe_pdf_name(name: str) -> str | None:
    safe = Path(str(name or "")).name
    if not safe or safe in {".", ".."} or not safe.lower().endswith(".pdf"):
        return None
    return safe


def _resolve_plan_file(floor_id: str, name: str) -> Path | None:
    """Find a PDF by the stored filename. Do not rename or rebind floors."""
    safe = _safe_pdf_name(name)
    if not safe:
        return None
    floor_safe = Path(str(floor_id or "")).name
    if floor_safe in {".", ".."}:
        floor_safe = ""
    candidates: list[Path] = []
    level = _level_dir()
    if level is not None:
        if floor_safe:
            candidates.append(level / floor_safe / safe)
        candidates.append(level / safe)
    if floor_safe:
        candidates.append(PLAN_ROOT / floor_safe / safe)
    candidates.append(PLAN_ROOT / safe)
    for path in candidates:
        if path.is_file():
            return path
    return None


def _iter_pdf_names(folder: Path | None) -> list[str]:
    names: list[str] = []
    if folder is None or not folder.is_dir():
        return names
    try:
        entries = list(folder.iterdir())
    except OSError:
        return names
    for item in entries:
        if item.is_file() and item.suffix.lower() == ".pdf":
            names.append(item.name)
    return names


def _list_plan_files(floor_id: str) -> list[str]:
    names: set[str] = set()
    floor_safe = Path(str(floor_id or "")).name
    if floor_safe in {".", ".."}:
        floor_safe = ""
    level = _level_dir()
    names.update(_iter_pdf_names(level))
    if level is not None and floor_safe:
        names.update(_iter_pdf_names(level / floor_safe))
    if floor_safe:
        names.update(_iter_pdf_names(PLAN_ROOT / floor_safe))
    names.update(_iter_pdf_names(PLAN_ROOT))
    return sorted(names, key=lambda item: item.lower())


def _project_label(photos_root: str) -> str:
    """Display chars 38–48 (1-based); prefer job folder like 100_BPS.OSZ."""
    import re

    text = str(photos_root or "").replace("/", "\\")
    sliced = text[37:48]
    match = re.search(r"\\(\d{2,4}_[^\\]+)\\", "\\" + text.strip("\\") + "\\")
    if match:
        return match.group(1)
    return sliced.strip() or Path(text).name


def _jobs_parent(photos_root: Path) -> Path | None:
    # ...\101_UH9.UH9\04_DOC\00_KOR\Fotos building → OneDrive company folder
    try:
        parent = photos_root.parent.parent.parent.parent
    except Exception:
        return None
    return parent if parent.is_dir() else None


def _resolve_photos_root(raw: str) -> Path | None:
    text = str(raw or "").strip().strip('"')
    if not text:
        return None
    path = Path(text)
    if path.is_file():
        path = path.parent
    if not path.exists():
        return None
    if path.is_dir() and path.name.lower() == "fotos building":
        return path
    for rel in (
        Path("04_DOC") / "00_KOR" / "Fotos building",
        Path("00_KOR") / "Fotos building",
        Path("Fotos building"),
    ):
        candidate = path / rel
        if candidate.is_dir():
            return candidate
    return path if path.is_dir() else None


def _registered_roots() -> list[Path]:
    payload = _read_json(PROJECTS, {})
    roots: list[Path] = []
    items = payload.get("projects") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return roots
    for item in items:
        raw = ""
        if isinstance(item, dict):
            raw = str(item.get("photosRoot") or "")
        elif isinstance(item, str):
            raw = item
        path = Path(raw.strip().strip('"')) if raw else None
        if path is not None and path.is_dir():
            roots.append(path)
    return roots


def _register_project(photos_root: Path) -> None:
    unique: list[Path] = []
    seen: set[str] = set()
    for path in [*_registered_roots(), photos_root]:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    _write_json(
        PROJECTS,
        {
            "updatedAt": _now(),
            "projects": [
                {"photosRoot": str(path), "label": _project_label(str(path))}
                for path in unique
            ],
        },
    )


def _project_entry(photos: Path) -> dict[str, str]:
    key = str(photos)
    try:
        ident = photos.parent.parent.parent.name
    except Exception:
        ident = photos.name
    return {
        "id": ident,
        "label": _project_label(key),
        "photosRoot": key,
    }


def _discover_projects(active_root: Path | None) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    seeds: list[Path] = []
    if active_root is not None:
        seeds.append(active_root)
    seeds.extend(_registered_roots())
    roots: list[Path] = []
    jobs_seen: set[str] = set()
    seen_seed: set[str] = set()
    for seed in seeds:
        key = str(seed)
        if key in seen_seed:
            continue
        seen_seed.add(key)
        roots.append(seed)
        jobs = _jobs_parent(seed)
        if jobs is None:
            continue
        jobs_key = str(jobs)
        if jobs_key in jobs_seen:
            continue
        jobs_seen.add(jobs_key)
        try:
            children = list(jobs.iterdir())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            photos = child / "04_DOC" / "00_KOR" / "Fotos building"
            if photos.is_dir():
                roots.append(photos)
    for photos in roots:
        key = str(photos)
        if key in found:
            continue
        found[key] = _project_entry(photos)
    return sorted(found.values(), key=lambda item: item["label"].lower())


def _activate_photos_root(photos_root: Path) -> dict[str, Any]:
    from photos_index import rebuild_photos_index

    _register_project(photos_root)
    _set_active_photos_root(photos_root)
    index = rebuild_photos_index(photos_root, ROOT)
    return {
        "ok": True,
        "photosRoot": str(photos_root),
        "label": _project_label(str(photos_root)),
        "count": index.get("count", 0),
        "dates": index.get("dates", []),
        "buildStamp": index.get("buildStamp"),
        "projects": _discover_projects(photos_root),
    }


def _set_active_photos_root(photos_root: Path) -> None:
    source = {
        "photosRoot": str(photos_root),
        "updatedAt": _now(),
        "note": "Originals are served from photosRoot. Do not copy photos into the package.",
    }
    _write_json(PHOTOS_SOURCE, source)
    meta = _read_json(META, {})
    if not isinstance(meta, dict):
        meta = {}
    meta["photosRoot"] = str(photos_root)
    meta["originalsFromSharedFolder"] = True
    _write_json(META, meta)


def _safe_file_in(root: Path, name: str) -> Path | None:
    safe = Path(name).name
    if not safe or safe in {".", ".."}:
        return None
    target = (root / safe).resolve()
    root_full = root.resolve()
    try:
        target.relative_to(root_full)
    except ValueError:
        return None
    return target if target.is_file() else None


def _ensure_plan_by_date(floor: dict[str, Any]) -> dict[str, Any]:
    by_date = floor.get("planByDate")
    if not isinstance(by_date, dict):
        by_date = {}
        floor["planByDate"] = by_date
    return by_date


def _source_config() -> dict[str, Any]:
    value = _read_json(SOURCE_CONFIG, {})
    if not isinstance(value, dict):
        value = {}
    mode = "remote" if value.get("mode") == "remote" and value.get("url") else "local"
    return {
        "mode": mode,
        "name": str(value.get("name") or ("Remote-Quelle" if mode == "remote" else "Lokale Fotos")),
        "url": str(value.get("url") or "") if mode == "remote" else "",
        "updatedAt": value.get("updatedAt"),
    }


def _write_authorized() -> bool:
    if not WRITE_TOKEN:
        return True
    token = request.headers.get("X-BPS-Token", "") or request.args.get("token", "")
    return bool(token) and token == WRITE_TOKEN


def _require_write_token() -> Response | None:
    if _write_authorized():
        return None
    return jsonify(ok=False, error="Forbidden"), 403


def _host_is_allowed(hostname: str) -> bool:
    hostname = hostname.rstrip(".").lower()
    if not SOURCE_HOSTS:
        return True
    return any(hostname == allowed or hostname.endswith("." + allowed) for allowed in SOURCE_HOSTS)


def _validate_public_url(raw_url: str) -> str:
    url = raw_url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SourceError("Vollständige http://- oder https://-URL zu photos.json erforderlich")
    if parsed.username or parsed.password:
        raise SourceError("Benutzername und Passwort dürfen nicht in der URL stehen")
    if not _host_is_allowed(parsed.hostname):
        raise SourceError("Die Domain der Quelle ist nicht erlaubt")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port)
    except ValueError as exc:
        raise SourceError("Ungültiger Port in der Quellen-URL") from exc
    except socket.gaierror as exc:
        raise SourceError("Server der Quelle nicht gefunden") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise SourceError("Interne und lokale Adressen sind nicht erlaubt")
    return url


class _SafeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        _validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _normalise_manifest(document: Any, manifest_url: str) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(document.get("photos"), list):
        raise SourceError("JSON muss ein Array photos enthalten")

    photos: list[dict[str, Any]] = []
    seen: set[str] = set()
    for position, raw_photo in enumerate(document["photos"], start=1):
        if not isinstance(raw_photo, dict):
            raise SourceError(f"Ungültiger Foto-Eintrag #{position}")
        photo = dict(raw_photo)
        photo_id = str(photo.get("id") or "").strip()
        if not photo_id or photo_id in seen:
            raise SourceError("Jedes Foto muss eine eindeutige id haben")
        seen.add(photo_id)
        photo["id"] = photo_id
        photo.setdefault("number", position)

        for field in ("thumb", "ai", "originalUrl"):
            value = photo.get(field)
            if isinstance(value, str) and value.strip():
                photo[field] = urljoin(manifest_url, value.strip())
        if not photo.get("originalUrl"):
            photo["originalUrl"] = photo.get("ai") or photo.get("thumb")
        if not photo.get("thumb"):
            photo["thumb"] = photo.get("ai") or photo.get("originalUrl")
        if not photo.get("thumb"):
            raise SourceError(f"Für Foto {photo_id} fehlt ein Bild-Link")
        photos.append(photo)

    dates = document.get("dates")
    if not isinstance(dates, list) or not dates:
        dates = sorted({str(photo.get("date")) for photo in photos if photo.get("date")})

    result = dict(document)
    result["photos"] = photos
    result["dates"] = dates
    result["count"] = len(photos)
    result["sourceUrl"] = manifest_url
    result["syncedAt"] = _now()
    return result


def _download_manifest(raw_url: str) -> dict[str, Any]:
    url = _validate_public_url(raw_url)
    opener = build_opener(_SafeRedirects())
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "BPS.FotosBuilding/1.0"})
    try:
        with opener.open(req, timeout=SOURCE_TIMEOUT) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_MANIFEST_BYTES:
                raise SourceError("Quelldatei ist zu groß")
            raw = response.read(MAX_MANIFEST_BYTES + 1)
            final_url = response.geturl()
    except SourceError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise SourceError(f"Quelle konnte nicht geladen werden: {exc}") from exc
    if len(raw) > MAX_MANIFEST_BYTES:
        raise SourceError("Quelldatei ist zu groß")
    try:
        document = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError("Unter der URL wurde ungültiges JSON empfangen") from exc
    return _normalise_manifest(document, final_url)


def _active_photos() -> tuple[dict[str, Any], str, bool]:
    config = _source_config()
    if config["mode"] == "remote":
        cached = _read_json(REMOTE_PHOTOS, None)
        if isinstance(cached, dict) and isinstance(cached.get("photos"), list):
            return cached, "remote", False
    local = _read_json(LOCAL_PHOTOS, {"photos": [], "dates": []})
    return local, "local", config["mode"] == "remote"


@app.after_request
def _response_headers(response: Response) -> Response:
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.get("/")
def index() -> Response:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    attrs = 'data-backend="web"'
    if PUBLIC_VIEW:
        attrs += ' data-mode="share"'
    html = html.replace("<body>", f"<body {attrs}>", 1)
    return Response(html, mimetype="text/html; charset=utf-8")


@app.get("/health")
@app.get("/api/health")
def health() -> Response:
    root = _photos_root()
    return jsonify(
        ok=True,
        app="BPS.FotosBuilding",
        backend="flask",
        time=_now(),
        photosRoot=str(root) if root else None,
        publicView=PUBLIC_VIEW,
    )


@app.get("/api/meta")
def get_meta() -> Response:
    payload = _read_json(
        META,
        {
            "mode": "edit",
            "backend": "web",
            "project": "BPS.FotosBuilding",
            "buildStamp": "00000000-000000",
        },
    )
    return jsonify(payload)


@app.get("/api/floors")
def get_floors() -> Response:
    payload = _read_json(FLOORS, {"activeFloorId": "UG", "floors": []})
    return jsonify(payload)


@app.get("/api/plans")
def list_plans() -> Response | tuple[Response, int]:
    floor_id = str(request.args.get("floorId") or "").strip()
    if not floor_id:
        return jsonify(ok=False, error="floorId required"), 400
    files = _list_plan_files(floor_id)
    return jsonify(ok=True, floorId=floor_id, files=files)


@app.post("/api/plan-select")
def select_plan() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    floor_id = str(document.get("floorId") or "").strip()
    plan_date = str(document.get("date") or "").strip()
    plan_file = Path(str(document.get("planFile") or "").strip()).name
    if not floor_id or not plan_file:
        return jsonify(ok=False, error="floorId, planFile required"), 400
    if not plan_file.lower().endswith(".pdf"):
        return jsonify(ok=False, error="only PDF allowed"), 400
    target = _resolve_plan_file(floor_id, plan_file)
    if target is None:
        return jsonify(ok=False, error="plan file not found"), 404
    floors_doc = _read_json(FLOORS, {"activeFloorId": "UG", "floors": []})
    floors = floors_doc.get("floors") if isinstance(floors_doc, dict) else []
    if not isinstance(floors, list):
        floors = []
        floors_doc = {"activeFloorId": floor_id, "floors": floors}
    found = False
    rotation = 0
    saved_date = None
    for floor in floors:
        if isinstance(floor, dict) and str(floor.get("id")) == floor_id:
            if _is_plan_date(plan_date):
                by_date = _ensure_plan_by_date(floor)
                entry = by_date.get(plan_date)
                if isinstance(entry, dict):
                    rotation = int(entry.get("planRotation") or 0)
                by_date[plan_date] = {"planFile": plan_file, "planRotation": rotation}
                saved_date = plan_date
            else:
                rotation = int(floor.get("planRotation") or 0)
                floor["planFile"] = plan_file
            found = True
            break
    if not found:
        floor: dict[str, Any] = {
            "id": floor_id,
            "label": floor_id,
            "planFile": None,
            "planRotation": 0,
            "planByDate": {},
        }
        if _is_plan_date(plan_date):
            floor["planByDate"][plan_date] = {"planFile": plan_file, "planRotation": 0}
            saved_date = plan_date
            rotation = 0
        else:
            floor["planFile"] = plan_file
        floors.append(floor)
    floors_doc["floors"] = floors
    floors_doc["activeFloorId"] = floor_id
    _write_json(FLOORS, floors_doc)
    return jsonify(
        ok=True,
        floorId=floor_id,
        planFile=plan_file,
        planRotation=rotation,
        date=saved_date,
    )


@app.post("/api/floor-rotation")
def save_floor_rotation() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    floor_id = str(document.get("floorId") or "").strip()
    plan_date = str(document.get("date") or "").strip()
    try:
        rotation = int(document.get("planRotation") or 0) % 360
    except (TypeError, ValueError):
        return jsonify(ok=False, error="planRotation must be int"), 400
    if not floor_id:
        return jsonify(ok=False, error="floorId required"), 400
    floors_doc = _read_json(FLOORS, {"activeFloorId": "UG", "floors": []})
    floors = floors_doc.get("floors") if isinstance(floors_doc, dict) else None
    if not isinstance(floors, list):
        return jsonify(ok=False, error="floors.json invalid"), 500
    found = False
    for floor in floors:
        if isinstance(floor, dict) and str(floor.get("id")) == floor_id:
            if _is_plan_date(plan_date):
                by_date = _ensure_plan_by_date(floor)
                entry = by_date.get(plan_date)
                if isinstance(entry, dict):
                    entry["planRotation"] = rotation
                elif floor.get("planFile"):
                    by_date[plan_date] = {
                        "planFile": str(floor.get("planFile")),
                        "planRotation": rotation,
                    }
                else:
                    floor["planRotation"] = rotation
            else:
                floor["planRotation"] = rotation
            found = True
            break
    if not found:
        return jsonify(ok=False, error="floor not found"), 404
    _write_json(FLOORS, floors_doc)
    return jsonify(ok=True, floorId=floor_id, planRotation=rotation)


@app.post("/api/plan")
def upload_plan() -> Response | tuple[Response, int]:
    import base64
    import re

    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    floor_id = str(document.get("floorId") or "").strip()
    plan_date = str(document.get("date") or "").strip()
    file_name = str(document.get("fileName") or "").strip()
    content_b64 = document.get("contentBase64")
    if not floor_id or not file_name or not isinstance(content_b64, str):
        return jsonify(ok=False, error="floorId, fileName, contentBase64 required"), 400
    if not re.fullmatch(r"[A-Za-z0-9._\-]+", floor_id):
        return jsonify(ok=False, error="invalid floorId"), 400
    safe_name = Path(file_name).name
    if not safe_name.lower().endswith(".pdf"):
        return jsonify(ok=False, error="only PDF allowed"), 400
    try:
        raw = base64.b64decode(content_b64, validate=False)
    except Exception as exc:  # noqa: BLE001
        return jsonify(ok=False, error=f"invalid base64: {exc}"), 400
    if len(raw) > MAX_PLAN_BYTES:
        return jsonify(ok=False, error="PDF too large"), 400
    floor_dir = PLAN_ROOT / floor_id
    floor_dir.mkdir(parents=True, exist_ok=True)
    target = floor_dir / safe_name
    level_root = _photos_root()
    level_dir = (level_root / "Level") if level_root is not None else None
    with _write_lock:
        target.write_bytes(raw)
        if level_dir is not None:
            level_dir.mkdir(parents=True, exist_ok=True)
            (level_dir / safe_name).write_bytes(raw)

    floors_doc = _read_json(FLOORS, {"activeFloorId": "UG", "floors": []})
    floors = floors_doc.get("floors") if isinstance(floors_doc, dict) else []
    if not isinstance(floors, list):
        floors = []
        floors_doc = {"activeFloorId": floor_id, "floors": floors}
    found = False
    saved_date = None
    for floor in floors:
        if isinstance(floor, dict) and str(floor.get("id")) == floor_id:
            if _is_plan_date(plan_date):
                by_date = _ensure_plan_by_date(floor)
                by_date[plan_date] = {"planFile": safe_name, "planRotation": 0}
                saved_date = plan_date
            else:
                floor["planFile"] = safe_name
                floor["planRotation"] = 0
            found = True
            break
    if not found:
        floor = {
            "id": floor_id,
            "label": floor_id,
            "planFile": None,
            "planRotation": 0,
            "planByDate": {},
        }
        if _is_plan_date(plan_date):
            floor["planByDate"][plan_date] = {"planFile": safe_name, "planRotation": 0}
            saved_date = plan_date
        else:
            floor["planFile"] = safe_name
        floors.append(floor)
    floors_doc["floors"] = floors
    _write_json(FLOORS, floors_doc)
    return jsonify(
        ok=True,
        floorId=floor_id,
        planFile=safe_name,
        planRotation=0,
        date=saved_date,
    )


@app.get("/api/seeds")
def get_seeds() -> Response:
    payload = _read_json(SEEDS, {"updatedAt": None, "byFloor": {}, "gpsCalib": {}})
    return jsonify(payload)


@app.post("/api/seeds")
def save_seeds() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict) or not isinstance(document.get("byFloor"), dict):
        return jsonify(ok=False, error="Expected JSON object with byFloor"), 400
    gps_calib = document.get("gpsCalib")
    if gps_calib is not None and not isinstance(gps_calib, dict):
        return jsonify(ok=False, error="gpsCalib must be object"), 400
    payload = {
        "updatedAt": _now(),
        "byFloor": document["byFloor"],
        "gpsCalib": gps_calib if isinstance(gps_calib, dict) else {},
    }
    _write_json(SEEDS, payload)
    return jsonify(ok=True)


@app.get("/api/photos")
def get_photos() -> Response:
    payload, source_mode, fallback = _active_photos()
    response = jsonify(payload)
    response.headers["X-BPS-Photo-Source"] = source_mode
    if fallback:
        response.headers["X-BPS-Source-Fallback"] = "local"
    return response


@app.get("/api/source")
def get_source() -> Response:
    config = _source_config()
    active, source_mode, fallback = _active_photos()
    return jsonify(
        ok=True,
        source=config,
        activeMode=source_mode,
        fallback=fallback,
        photoCount=len(active.get("photos", [])),
        syncedAt=active.get("syncedAt"),
    )


@app.post("/api/source/test")
def test_source() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    url = str(document.get("url") or "") if isinstance(document, dict) else ""
    try:
        manifest = _download_manifest(url)
    except SourceError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, photoCount=len(manifest["photos"]), dates=manifest.get("dates", []))


@app.post("/api/source")
def save_source() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    url = str(document.get("url") or "").strip()
    name = str(document.get("name") or "").strip()[:120]
    if not url:
        config = {"mode": "local", "name": name or "Lokale Fotos", "url": "", "updatedAt": _now()}
        _write_json(SOURCE_CONFIG, config)
        return jsonify(ok=True, source=config, photoCount=len(_read_json(LOCAL_PHOTOS, {}).get("photos", [])))
    try:
        manifest = _download_manifest(url)
    except SourceError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    config = {"mode": "remote", "name": name or "Remote-Quelle", "url": url, "updatedAt": _now()}
    _write_json(REMOTE_PHOTOS, manifest)
    _write_json(SOURCE_CONFIG, config)
    return jsonify(ok=True, source=config, photoCount=len(manifest["photos"]), syncedAt=manifest["syncedAt"])


@app.post("/api/source/refresh")
def refresh_source() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    config = _source_config()
    if config["mode"] != "remote":
        return jsonify(ok=False, error="Es wird gerade die lokale Quelle verwendet"), 400
    try:
        manifest = _download_manifest(config["url"])
    except SourceError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    _write_json(REMOTE_PHOTOS, manifest)
    config["updatedAt"] = _now()
    _write_json(SOURCE_CONFIG, config)
    return jsonify(ok=True, photoCount=len(manifest["photos"]), syncedAt=manifest["syncedAt"])


@app.get("/api/projects")
def list_projects() -> Response:
    active = _photos_root()
    projects = _discover_projects(active)
    return jsonify(
        ok=True,
        projects=projects,
        activePhotosRoot=str(active) if active else None,
        label=_project_label(str(active)) if active else None,
    )


@app.post("/api/project-select")
def select_project() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    raw = str(document.get("photosRoot") or "").strip().strip('"')
    if not raw:
        return jsonify(ok=False, error="photosRoot required"), 400
    photos_root = _resolve_photos_root(raw)
    if photos_root is None:
        return jsonify(ok=False, error=f"Photos folder not found: {raw}"), 404
    allowed = {item["photosRoot"] for item in _discover_projects(photos_root)}
    current = _photos_root()
    if current is not None:
        allowed.update(item["photosRoot"] for item in _discover_projects(current))
    if str(photos_root) not in allowed and photos_root.name.lower() != "fotos building":
        return jsonify(ok=False, error="Not a project photos folder"), 400
    try:
        payload = _activate_photos_root(photos_root)
    except Exception as exc:  # noqa: BLE001
        return jsonify(ok=False, error=str(exc)), 500
    return jsonify(payload)


@app.post("/api/project-add")
def add_project() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    document = request.get_json(silent=True)
    if not isinstance(document, dict):
        return jsonify(ok=False, error="Expected JSON object"), 400
    raw = str(document.get("photosRoot") or document.get("path") or "").strip().strip('"')
    if not raw:
        return jsonify(ok=False, error="photosRoot required"), 400
    photos_root = _resolve_photos_root(raw)
    if photos_root is None:
        return jsonify(ok=False, error=f"Photos folder not found: {raw}"), 404
    try:
        payload = _activate_photos_root(photos_root)
    except Exception as exc:  # noqa: BLE001
        return jsonify(ok=False, error=str(exc)), 500
    return jsonify(payload)


@app.post("/api/refresh-photos")
def refresh_photos() -> Response | tuple[Response, int]:
    denied = _require_write_token()
    if denied:
        return denied
    photos_root = _photos_root()
    if photos_root is None:
        index = _read_json(LOCAL_PHOTOS, {})
        photos = index.get("photos") if isinstance(index, dict) else None
        if not isinstance(photos, list):
            photos = []
        meta = _read_json(META, {})
        return jsonify(
            ok=True,
            count=len(photos),
            dates=index.get("dates", []) if isinstance(index, dict) else [],
            buildStamp=meta.get("buildStamp") if isinstance(meta, dict) else None,
            photosRoot=None,
            thumbsMade=0,
            withGps=0,
            bundled=True,
        )
    try:
        from photos_index import rebuild_photos_index

        index = rebuild_photos_index(photos_root, ROOT)
    except Exception as exc:  # noqa: BLE001
        return jsonify(ok=False, error=str(exc)), 500
    meta = _read_json(META, {})
    if not isinstance(meta, dict):
        meta = {}
    meta["buildStamp"] = index.get("buildStamp")
    meta["photosRoot"] = str(photos_root)
    meta["originalsFromSharedFolder"] = True
    _write_json(META, meta)
    return jsonify(
        ok=True,
        count=index.get("count", 0),
        dates=index.get("dates", []),
        buildStamp=index.get("buildStamp"),
        photosRoot=str(photos_root),
        thumbsMade=index.get("thumbsMade", 0),
        withGps=index.get("withGps", 0),
    )


@app.get("/plan/<floor_id>/<path:name>")
def serve_plan(floor_id: str, name: str) -> Response | tuple[Response, int]:
    found = _resolve_plan_file(floor_id, name)
    if found is None:
        return jsonify(ok=False, error="Not found"), 404
    return send_file(found, mimetype="application/pdf")


@app.get("/originals/<path:name>")
def serve_original(name: str) -> Response | tuple[Response, int]:
    photos_root = _photos_root()
    found = _safe_file_in(photos_root, name) if photos_root is not None else None
    if found is None:
        found = _safe_file_in(ROOT / "originals", name)
    if found is None:
        return jsonify(ok=False, error="Not found"), 404
    if found.suffix.lower() in {".heic", ".heif"}:
        from photos_index import ensure_heic_view_jpeg

        jpeg = ensure_heic_view_jpeg(found, CONVERTED)
        return send_file(jpeg, mimetype="image/jpeg", download_name=f"{found.stem}.jpg")
    return send_file(found)


@app.get("/<path:filename>")
def static_files(filename: str) -> Response:
    if filename == "index.html":
        return index()
    public_root_files = {"index.html", "app.js", "styles.css"}
    public_data_files = {"photos.json", "floors.json", "meta.json", "cameras.json"}
    parts = Path(filename).parts
    is_public_media = bool(parts) and parts[0] in {"ai", "thumbs", "originals", "converted", "plan"}
    is_public_data = len(parts) == 2 and parts[0] == "data" and parts[1] in public_data_files
    if filename not in public_root_files and not is_public_media and not is_public_data:
        return jsonify(ok=False, error="Not found"), 404
    return send_from_directory(ROOT, filename)


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    photos = _photos_root()
    print(f"BPS.FotosBuilding Flask  http://{HOST}:{PORT}/")
    print(f"Originals: {photos if photos else '(set BPS_PHOTOS_ROOT or data/photos-source.json)'}")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
