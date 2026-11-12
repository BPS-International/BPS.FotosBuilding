"""Build Render-ready snapshots of OneDrive projects into projects/<id>/."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from photos_index import rebuild_photos_index

ROOT = Path(__file__).resolve().parent
PROJECTS = ROOT / "projects"
ONEDRIVE = Path(r"C:\BPS\OneDrive - BPS International GmbH")

JOBS = [
    {
        "id": "100_BPS.OSZ",
        "photos": ONEDRIVE / r"100_BPS.OSZ\04_DOC\00_KOR\Fotos building",
        "floors": {
            "activeFloorId": "UG",
            "floors": [
                {
                    "id": "UG",
                    "label": "UG",
                    "planFile": "2026-10-21_100_Freiflaechenplan.pdf",
                    "planRotation": 90,
                },
                {"id": "EG", "label": "EG", "planFile": None, "planRotation": 0},
                {"id": "1.OG", "label": "1.OG", "planFile": None, "planRotation": 0},
                {"id": "DG", "label": "DG", "planFile": None, "planRotation": 0},
            ],
        },
        "seeds": ROOT / "data" / "seeds-osz.json",
        "extraPlan": {
            "src": ONEDRIVE
            / r"100_BPS.OSZ\01_ARC\00_PUBLISH\2026-10-21_новые границы и парковка\2026-10-21_100_Freiflächenplan.pdf",
            "floor": "UG",
            "name": "2026-10-21_100_Freiflaechenplan.pdf",
        },
    },
    {
        "id": "101_UH9.UH9",
        "photos": ONEDRIVE / r"101_UH9.UH9\04_DOC\00_KOR\Fotos building",
        "floors": json.loads((ROOT / "data" / "floors.json").read_text(encoding="utf-8-sig")),
        "seeds": ROOT / "data" / "seeds.json",
    },
]


def _copy_images(src: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for item in src.iterdir():
        if item.is_file() and item.suffix.lower() in {".jpg", ".jpeg", ".png", ".heic", ".heif"}:
            shutil.copy2(item, dest / item.name)
            n += 1
    return n


def _copy_plans(src: Path, dest: Path, include: str | None = None, exclude: str | None = None) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    if not src.is_dir():
        return n
    for item in src.iterdir():
        if not item.is_file() or item.suffix.lower() != ".pdf":
            continue
        if include and include not in item.name:
            continue
        if exclude and exclude in item.name:
            continue
        shutil.copy2(item, dest / item.name)
        n += 1
    return n


def pack_job(job: dict) -> None:
    photos_root: Path = job["photos"]
    if not photos_root.is_dir():
        raise FileNotFoundError(photos_root)
    dest = PROJECTS / job["id"]
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    (dest / "data").mkdir()
    (dest / "plan" / "UG").mkdir(parents=True)
    originals = dest / "originals"
    n_orig = _copy_images(photos_root, originals)
    marker = "OSZ" if "OSZ" in job["id"] else "UH9"
    n_plan = _copy_plans(photos_root / "Level", dest / "plan" / "UG", include=marker)
    if n_plan == 0:
        n_plan = _copy_plans(
            photos_root / "Level",
            dest / "plan" / "UG",
            exclude="OSZ" if marker == "UH9" else None,
        )
    extra_plan = job.get("extraPlan")
    if extra_plan:
        src = Path(extra_plan["src"])
        if src.is_file():
            target = dest / "plan" / extra_plan.get("floor", "UG") / extra_plan["name"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            n_plan += 1
    index = rebuild_photos_index(photos_root, dest)
    (dest / "data" / "floors.json").write_text(
        json.dumps(job["floors"], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    seeds_src: Path = job["seeds"]
    if seeds_src.is_file():
        shutil.copy2(seeds_src, dest / "data" / "seeds.json")
    else:
        (dest / "data" / "seeds.json").write_text(
            json.dumps({"updatedAt": None, "byFloor": {}, "gpsCalib": {}}, indent=2) + "\n",
            encoding="utf-8",
        )
    print(
        f"{job['id']}: originals={n_orig} plans={n_plan} "
        f"indexed={index.get('count')} dates={index.get('dates')} stamp={index.get('buildStamp')}"
    )


def main() -> None:
    PROJECTS.mkdir(parents=True, exist_ok=True)
    for job in JOBS:
        pack_job(job)
    print("done", PROJECTS)


if __name__ == "__main__":
    main()
