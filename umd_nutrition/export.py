"""Export the database to static JSON for the phone app.

The app is a static page with no server, so the scrape writes files it can fetch.
Three shapes:

  index.json          halls, dates, and what was found on each day
  items.json          every item in the retained window, with its numbers
  menu/<hall>-<date>  that day's menu, referring to items by id

Ingredient text is deliberately left out. It is the largest field by far, it is
only ever classifier input, and dropping it keeps the download small enough to
open over cellular in a dining hall.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .diet import CLASSIFIER_VERSION

log = logging.getLogger(__name__)

# Numbers come out of the label with one decimal at most; keep that and no more.
_PLACES = 1


def _round(value: float | None) -> float | None:
    if value is None:
        return None
    rounded = round(value, _PLACES)
    return int(rounded) if rounded == int(rounded) else rounded


@dataclass
class ExportSummary:
    items: int = 0
    days: int = 0
    entries: int = 0
    bytes_written: int = 0
    stale_removed: int = 0

    def report(self) -> str:
        stale = f", removed {self.stale_removed} stale" if self.stale_removed else ""
        return (
            f"exported {self.items} items, {self.days} days, {self.entries} entries"
            f"{stale} ({self.bytes_written / 1024:.0f} KB)"
        )


def _write(path: Path, payload: object) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    # separators drop the spaces json.dumps would otherwise put after : and ,
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _items_payload(conn: sqlite3.Connection) -> dict[str, dict]:
    """Every item referenced by a retained menu entry."""
    rows = conn.execute(
        """
        SELECT i.*, d.diet_level, d.has_beef, d.has_pork, d.has_poultry,
               d.has_fish, d.has_shellfish
        FROM items i
        LEFT JOIN item_diet d USING (rec_num_and_port)
        WHERE i.rec_num_and_port IN (SELECT DISTINCT rec_num_and_port FROM menu_entries)
        """
    )

    tags_by_item: dict[str, dict[str, list[str]]] = {}
    for rec_id, tag, kind in conn.execute(
        "SELECT rec_num_and_port, tag, kind FROM item_tags ORDER BY tag"
    ):
        tags_by_item.setdefault(rec_id, {}).setdefault(kind, []).append(tag)

    payload: dict[str, dict] = {}
    for row in rows:
        rec_id = row["rec_num_and_port"]
        entry: dict[str, object] = {
            "name": row["name"],
            "serving": row["serving_size"],
            "cal": _round(row["calories"]),
            "protein": _round(row["protein_g"]),
            "fat": _round(row["total_fat_g"]),
            "sat_fat": _round(row["saturated_fat_g"]),
            "trans_fat": _round(row["trans_fat_g"]),
            "carbs": _round(row["carbs_g"]),
            "fiber": _round(row["fiber_g"]),
            "sugar": _round(row["sugars_g"]),
            "added_sugar": _round(row["added_sugars_g"]),
            "sodium": _round(row["sodium_mg"]),
            "chol": _round(row["cholesterol_mg"]),
            "diet_level": row["diet_level"],
            "tags": tags_by_item.get(rec_id, {}),
        }
        if row["allergens_text"]:
            entry["allergens"] = [
                part.strip() for part in row["allergens_text"].split(",") if part.strip()
            ]
        # Both flags are omitted when normal, which is the overwhelming majority.
        # The app treats a missing key as "fine".
        if not row["nutrition_available"]:
            entry["no_data"] = True
        if not row["plausible"]:
            entry["suspect"] = row["implausible_reason"]
        payload[rec_id] = entry
    return payload


def _menu_payload(conn: sqlite3.Connection, date: str, hall: int, hall_name: str) -> dict:
    meals: dict[str, dict[str, list[str]]] = {}
    for row in conn.execute(
        "SELECT meal, station, rec_num_and_port FROM menu_entries "
        "WHERE date = ? AND location_num = ? ORDER BY meal, station",
        (date, hall),
    ):
        meals.setdefault(row["meal"], {}).setdefault(row["station"], []).append(
            row["rec_num_and_port"]
        )

    return {
        "date": date,
        "hall": hall,
        "hall_name": hall_name,
        # A list, not a dict, because meal order matters and JSON objects have
        # no guaranteed order. Breakfast/Lunch/Dinner, or Brunch/Dinner.
        "meals": [
            {
                "meal": meal,
                "stations": [
                    {"station": station, "items": items}
                    for station, items in stations.items()
                ],
            }
            for meal, stations in meals.items()
        ],
    }


def export(conn: sqlite3.Connection, out_dir: Path | str) -> ExportSummary:
    """Write the whole static payload. Overwrites whatever was there."""
    out = Path(out_dir)
    summary = ExportSummary()

    halls = {
        row["location_num"]: row["name"]
        for row in conn.execute("SELECT * FROM locations ORDER BY location_num")
    }

    items = _items_payload(conn)
    summary.items = len(items)
    summary.bytes_written += _write(out / "items.json", items)

    days = list(
        conn.execute(
            "SELECT date, location_num, status, meals_found, item_count "
            "FROM menu_days ORDER BY date, location_num"
        )
    )
    written: set[str] = set()
    for day in days:
        if day["status"] != "ok":
            continue
        date, hall = day["date"], day["location_num"]
        payload = _menu_payload(conn, date, hall, halls.get(hall, str(hall)))
        summary.entries += sum(
            len(s["items"]) for m in payload["meals"] for s in m["stations"]
        )
        name = f"{hall}-{date}.json"
        summary.bytes_written += _write(out / "menu" / name, payload)
        written.add(name)
        summary.days += 1

    # items.json is one file and gets overwritten, but menu days are written one per
    # file. Without this, every day pruned from the database leaves its file behind
    # forever — about a thousand dead files a year, all committed to the repo.
    menu_dir = out / "menu"
    if menu_dir.is_dir():
        for path in menu_dir.glob("*.json"):
            if path.name not in written:
                path.unlink()
                summary.stale_removed += 1

    index = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "classifier_version": CLASSIFIER_VERSION,
        "halls": [{"id": num, "name": name} for num, name in halls.items()],
        "dates": sorted({day["date"] for day in days}),
        "days": [
            {
                "date": day["date"],
                "hall": day["location_num"],
                "status": day["status"],
                "meals": day["meals_found"].split(",") if day["meals_found"] else [],
                "items": day["item_count"],
            }
            for day in days
        ],
        "counts": {"items": summary.items, "entries": summary.entries},
    }
    summary.bytes_written += _write(out / "index.json", index)

    log.info("%s", summary.report())
    return summary
