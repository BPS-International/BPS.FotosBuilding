"""Scan shared photo folder and rebuild photos.json + thumbs."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, ExifTags

PHOTO_NAME_RX = re.compile(
    r"^photo_(\d+)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.(jpe?g|png|heic|heif)$",
    re.IGNORECASE,
)
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif"}
HEIC_EXTS = {".heic", ".heif"}


def _is_heic(path: Path) -> bool:
    return Path(path).suffix.lower() in HEIC_EXTS


THUMB_MAX = 400
AI_MAX = 1024
VIEW_MAX = 8192
JPEG_QUALITY = 82
_HEIF_READY = False


def _ensure_heif_support(required: bool = False) -> bool:
    global _HEIF_READY
    if _HEIF_READY:
        return True
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _HEIF_READY = True
        return True
    except Exception:
        if required:
            raise RuntimeError(
                "Для просмотра HEIC/HEIF установите пакет pillow-heif "
                "(pip install pillow-heif)."
            )
        return False


_ensure_heif_support(required=False)

_GPS_IFD = 0x8825
_DATETIME_ORIGINAL = 36867
_DATETIME = 306
_MAKE = 271
_MODEL = 272
_FNUMBER = 33437
_EXPOSURE = 33434
_ISO = 34855
_ISO2 = 34864
_DIGITAL_ZOOM = 41988


def _stable_id(file_name: str) -> str:
    match = PHOTO_NAME_RX.match(file_name)
    if match:
        return f"photo_{int(match.group(1))}_{match.group(2)}"
    digest = hashlib.sha1(file_name.lower().encode("utf-8")).hexdigest()
    return f"f_{digest[:16]}"


def _ratio(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        pass
    if hasattr(value, "numerator") and hasattr(value, "denominator"):
        den = float(value.denominator or 0)
        if den == 0:
            return None
        return float(value.numerator) / den
    if isinstance(value, (tuple, list)) and len(value) == 2:
        den = float(value[1] or 0)
        if den == 0:
            return None
        return float(value[0]) / den
    return None


def _format_exposure(sec: float | None) -> str | None:
    if sec is None or sec <= 0:
        return None
    if sec >= 1:
        return f"{sec:0.###} s"
    den = max(1, round(1.0 / sec))
    return f"1/{den} s"


def _dms_to_decimal(dms: Any, ref: str) -> float | None:
    if not isinstance(dms, (tuple, list)) or len(dms) < 3:
        return None
    deg = _ratio(dms[0])
    minutes = _ratio(dms[1])
    sec = _ratio(dms[2])
    if deg is None or minutes is None or sec is None:
        return None
    dec = deg + minutes / 60.0 + sec / 3600.0
    if str(ref).upper() in {"S", "W"}:
        dec = -dec
    return dec


def _read_exif(path: Path) -> dict[str, Any]:
    empty = {
        "dateTaken": None,
        "dateTakenDisplay": None,
        "cameraMake": None,
        "cameraModel": None,
        "aperture": None,
        "shutter": None,
        "iso": None,
        "digitalZoom": None,
        "gpsLat": None,
        "gpsLon": None,
        "gpsAlt": None,
        "gpsLatDms": None,
        "gpsLonDms": None,
        "hasGps": False,
    }
    width = 0
    height = 0
    try:
        if _is_heic(path):
            _ensure_heif_support(required=True)
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            width, height = img.size
            raw = img.getexif()
            if not raw:
                return {"width": width, "height": height, "exif": empty}
            tags = {ExifTags.TAGS.get(k, k): v for k, v in raw.items()}
            dt = tags.get("DateTimeOriginal") or tags.get("DateTime")
            if not dt:
                dt = raw.get(_DATETIME_ORIGINAL) or raw.get(_DATETIME)
            if isinstance(dt, bytes):
                dt = dt.decode("utf-8", "ignore")
            dt = str(dt).strip() if dt else ""
            match = re.match(r"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})", dt)
            if match:
                empty["dateTaken"] = (
                    f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
                    f"T{match.group(4)}:{match.group(5)}:{match.group(6)}"
                )
                empty["dateTakenDisplay"] = (
                    f"{match.group(3)}.{match.group(2)}.{match.group(1)} "
                    f"{match.group(4)}:{match.group(5)}"
                )
            make = tags.get("Make") or raw.get(_MAKE)
            model = tags.get("Model") or raw.get(_MODEL)
            if make:
                empty["cameraMake"] = str(make).strip("\x00 ").strip()
            if model:
                empty["cameraModel"] = str(model).strip("\x00 ").strip()
            fnum = _ratio(raw.get(_FNUMBER) or tags.get("FNumber"))
            if fnum:
                empty["aperture"] = f"f/{fnum:.1f}"
            exp = _ratio(raw.get(_EXPOSURE) or tags.get("ExposureTime"))
            empty["shutter"] = _format_exposure(exp)
            iso = raw.get(_ISO) or raw.get(_ISO2) or tags.get("ISOSpeedRatings")
            if isinstance(iso, (tuple, list)) and iso:
                iso = iso[0]
            if iso is not None:
                try:
                    empty["iso"] = f"ISO-{int(iso)}"
                except (TypeError, ValueError):
                    pass
            zoom = _ratio(raw.get(_DIGITAL_ZOOM) or tags.get("DigitalZoomRatio"))
            if zoom is not None:
                empty["digitalZoom"] = round(zoom, 8)
            gps = {}
            try:
                gps = raw.get_ifd(_GPS_IFD) or {}
            except Exception:
                gps = {}
            lat = gps.get(2)
            lon = gps.get(4)
            lat_ref = gps.get(1) or "N"
            lon_ref = gps.get(3) or "E"
            if isinstance(lat_ref, bytes):
                lat_ref = lat_ref.decode("ascii", "ignore")
            if isinstance(lon_ref, bytes):
                lon_ref = lon_ref.decode("ascii", "ignore")
            lat_dec = _dms_to_decimal(lat, str(lat_ref)[:1])
            lon_dec = _dms_to_decimal(lon, str(lon_ref)[:1])
            if lat_dec is not None and lon_dec is not None:
                empty["gpsLat"] = round(lat_dec, 8)
                empty["gpsLon"] = round(lon_dec, 8)
                empty["hasGps"] = True
                if isinstance(lat, (tuple, list)) and len(lat) >= 3:
                    empty["gpsLatDms"] = (
                        f"{int(_ratio(lat[0]) or 0)}; {int(_ratio(lat[1]) or 0)}; "
                        f"{round(_ratio(lat[2]) or 0, 6)}"
                    )
                if isinstance(lon, (tuple, list)) and len(lon) >= 3:
                    empty["gpsLonDms"] = (
                        f"{int(_ratio(lon[0]) or 0)}; {int(_ratio(lon[1]) or 0)}; "
                        f"{round(_ratio(lon[2]) or 0, 6)}"
                    )
            alt = _ratio(gps.get(6))
            if alt is not None:
                if gps.get(5) == 1:
                    alt = -alt
                empty["gpsAlt"] = round(alt, 6)
    except Exception:
        pass
    return {"width": width, "height": height, "exif": empty}


def _save_resized(src: Path, dest: Path, max_side: int) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_mtime >= src.stat().st_mtime:
        return False
    if _is_heic(src):
        _ensure_heif_support(required=True)
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        w, h = img.size
        limit = max(1, int(max_side or VIEW_MAX))
        scale = min(1.0, limit / max(w, h))
        nw = max(1, round(w * scale))
        nh = max(1, round(h * scale))
        if (nw, nh) != (w, h):
            img = img.resize((nw, nh), Image.Resampling.LANCZOS)
        img.save(dest, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return True


def ensure_jpeg_preview(src: str | Path, dest: str | Path, max_side: int) -> Path:
    source = Path(src)
    target = Path(dest)
    _save_resized(source, target, max_side)
    return target


def heic_view_jpeg_path(src: Path, cache_dir: Path) -> Path:
    return Path(cache_dir) / f"{src.name}.jpg"


def ensure_heic_view_jpeg(src: str | Path, cache_dir: str | Path, max_side: int = VIEW_MAX) -> Path:
    source = Path(src)
    dest = heic_view_jpeg_path(source, Path(cache_dir))
    _save_resized(source, dest, max_side)
    return dest


def rebuild_photos_index(photos_root: Path, web_root: Path) -> dict[str, Any]:
    photos_root = Path(photos_root)
    web_root = Path(web_root)
    if not photos_root.is_dir():
        raise FileNotFoundError(f"Photos folder not found: {photos_root}")
    thumbs_dir = web_root / "thumbs"
    ai_dir = web_root / "ai"
    converted_dir = web_root / "converted"
    data_dir = web_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict[str, Any]] = []
    made_thumb = 0
    made_ai = 0
    made_view = 0
    with_gps = 0
    with_exif_date = 0
    files = [
        p
        for p in photos_root.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ]
    if any(_is_heic(p) for p in files):
        _ensure_heif_support(required=True)
    files.sort(key=lambda p: p.name.lower())
    for path in files:
        try:
            meta = _read_exif(path)
            exif = meta["exif"]
            modified = datetime.fromtimestamp(path.stat().st_mtime)
            if exif.get("dateTaken"):
                date = str(exif["dateTaken"])[:10]
                time_iso = str(exif["dateTaken"])[11:19]
                timestamp = exif["dateTaken"]
                with_exif_date += 1
            else:
                date = modified.strftime("%Y-%m-%d")
                time_iso = modified.strftime("%H:%M:%S")
                timestamp = modified.strftime("%Y-%m-%dT%H:%M:%S")
            thumb_name = path.with_suffix(".jpg").name
            if _save_resized(path, thumbs_dir / thumb_name, THUMB_MAX):
                made_thumb += 1
            if _save_resized(path, ai_dir / thumb_name, AI_MAX):
                made_ai += 1
            if _is_heic(path) and _save_resized(
                path, heic_view_jpeg_path(path, converted_dir), VIEW_MAX
            ):
                made_view += 1
            if exif.get("hasGps"):
                with_gps += 1
            items.append(
                {
                    "id": _stable_id(path.name),
                    "file": path.name,
                    "number": 0,
                    "date": date,
                    "time": time_iso,
                    "timestamp": timestamp,
                    "dateTaken": exif.get("dateTaken"),
                    "dateTakenDisplay": exif.get("dateTakenDisplay"),
                    "modifiedAt": modified.strftime("%Y-%m-%dT%H:%M:%S"),
                    "width": int(meta["width"] or 0),
                    "height": int(meta["height"] or 0),
                    "bytes": path.stat().st_size,
                    "sizeKb": int(round(path.stat().st_size / 1024.0)),
                    "thumb": f"thumbs/{thumb_name}",
                    "ai": f"ai/{thumb_name}",
                    "originalUrl": f"originals/{path.name}",
                    "exif": exif,
                }
            )
        except Exception:
            continue
    items.sort(key=lambda p: (p.get("timestamp") or "", p.get("file") or ""))
    for i, item in enumerate(items, start=1):
        item["number"] = i
    dates = sorted({p["date"] for p in items if p.get("date")})
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    index = {
        "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "buildStamp": stamp,
        "photosRoot": str(photos_root),
        "planPdfUrl": None,
        "count": len(items),
        "withGps": with_gps,
        "withExifDate": with_exif_date,
        "dates": dates,
        "photos": items,
        "thumbsMade": made_thumb,
        "aiMade": made_ai,
        "heicJpegMade": made_view,
    }
    (data_dir / "photos.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    source = {
        "photosRoot": str(photos_root),
        "updatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "Originals are served from photosRoot. Do not copy photos into the package.",
    }
    (data_dir / "photos-source.json").write_text(
        json.dumps(source, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return index


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="BPS.FotosBuilding photo helpers")
    parser.add_argument("--jpeg", nargs=3, metavar=("SRC", "DST", "MAX"))
    parser.add_argument("--meta", metavar="SRC")
    args = parser.parse_args()
    if args.jpeg:
        src, dst, mx = args.jpeg
        ensure_jpeg_preview(src, dst, int(mx))
        sys.exit(0)
    if args.meta:
        sys.stdout.write(json.dumps(_read_exif(Path(args.meta)), ensure_ascii=False))
        sys.exit(0)
    parser.print_help()
    sys.exit(2)
