"""SQLite schema and access. No ORM: the queries are short and the shapes are fixed."""

from __future__ import annotations

import sqlite3
from datetime import date as Date
from datetime import timedelta
from pathlib import Path

from .diet import DietFacts
from .menu import tag_kind
from .models import Item, MenuEntry
from .quality import implausible_reason

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  rec_num_and_port       TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  serving_size           TEXT,
  serving_qty            REAL,
  serving_unit           TEXT,
  servings_per_container REAL,
  calories               REAL,
  protein_g              REAL,
  total_fat_g            REAL,
  saturated_fat_g        REAL,
  trans_fat_g            REAL,
  cholesterol_mg         REAL,
  sodium_mg              REAL,
  carbs_g                REAL,
  fiber_g                REAL,
  sugars_g               REAL,
  added_sugars_g         REAL,
  ingredients            TEXT,
  allergens_text         TEXT,
  label_fetched_at       TEXT,
  label_sha256           TEXT,
  -- 0 when the label page says no nutrition information exists for the recipe.
  -- Such an item has no ingredients, so it cannot be diet-classified either.
  nutrition_available    INTEGER NOT NULL DEFAULT 1,
  -- 0 when the numbers cannot be true (see quality.py). Roughly 1% of items
  -- hold whole-batch totals. Kept, not deleted, but hidden from rankings.
  plausible              INTEGER NOT NULL DEFAULT 1,
  implausible_reason     TEXT
);

-- No foreign key to items: tags come off the menu page, so they are known before
-- the label is fetched and survive a label that fails to parse.
CREATE TABLE IF NOT EXISTS item_tags (
  rec_num_and_port TEXT NOT NULL,
  tag              TEXT NOT NULL,
  kind             TEXT NOT NULL,
  PRIMARY KEY (rec_num_and_port, tag)
);

CREATE TABLE IF NOT EXISTS item_diet (
  rec_num_and_port   TEXT PRIMARY KEY REFERENCES items,
  has_beef           INTEGER NOT NULL DEFAULT 0,
  has_pork           INTEGER NOT NULL DEFAULT 0,
  has_poultry        INTEGER NOT NULL DEFAULT 0,
  has_fish           INTEGER NOT NULL DEFAULT 0,
  has_shellfish      INTEGER NOT NULL DEFAULT 0,
  diet_level         INTEGER,  -- NULL when unclassifiable; never assume level 1
  source             TEXT NOT NULL,
  classifier_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_overrides (
  rec_num_and_port TEXT PRIMARY KEY REFERENCES items,
  diet_level       INTEGER NOT NULL,
  note             TEXT,
  set_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  location_num INTEGER PRIMARY KEY,
  name         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_entries (
  id               INTEGER PRIMARY KEY,
  date             TEXT NOT NULL,
  location_num     INTEGER NOT NULL,
  meal             TEXT NOT NULL,
  station          TEXT NOT NULL,
  rec_num_and_port TEXT NOT NULL,
  UNIQUE (date, location_num, meal, station, rec_num_and_port)
);

CREATE TABLE IF NOT EXISTS menu_days (
  date         TEXT NOT NULL,
  location_num INTEGER NOT NULL,
  status       TEXT NOT NULL,
  meals_found  TEXT,
  item_count   INTEGER,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (date, location_num)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT,
  finished_at   TEXT,
  pages_fetched INTEGER,
  cache_hits    INTEGER,
  new_items     INTEGER,
  errors        INTEGER,
  ok            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_menu_lookup
  ON menu_entries(date, location_num, meal);
CREATE INDEX IF NOT EXISTS idx_menu_item
  ON menu_entries(rec_num_and_port);

-- Standalone rather than an external-content table: keeping FTS in sync with
-- `items` would need triggers, and at a few thousand rows the copied name is
-- cheaper than the machinery.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts
  USING fts5(rec_num_and_port UNINDEXED, name);
"""

ITEM_COLUMNS = (
    "rec_num_and_port", "name", "serving_size", "serving_qty", "serving_unit",
    "servings_per_container", "calories", "protein_g", "total_fat_g",
    "saturated_fat_g", "trans_fat_g", "cholesterol_mg", "sodium_mg", "carbs_g",
    "fiber_g", "sugars_g", "added_sugars_g", "ingredients", "allergens_text",
    "label_fetched_at", "label_sha256", "nutrition_available", "plausible",
    "implausible_reason",
)


def connect(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def upsert_location(conn: sqlite3.Connection, location_num: int, name: str) -> None:
    conn.execute(
        "INSERT INTO locations(location_num, name) VALUES (?, ?) "
        "ON CONFLICT(location_num) DO UPDATE SET name = excluded.name",
        (location_num, name),
    )


def upsert_item(
    conn: sqlite3.Connection, item: Item, *, fetched_at: str, sha256: str | None = None
) -> None:
    reason = implausible_reason(item)
    values = (
        item.rec_num_and_port, item.name, item.serving_size, item.serving_qty,
        item.serving_unit, item.servings_per_container, item.calories, item.protein_g,
        item.total_fat_g, item.saturated_fat_g, item.trans_fat_g, item.cholesterol_mg,
        item.sodium_mg, item.carbs_g, item.fiber_g, item.sugars_g, item.added_sugars_g,
        item.ingredients, ", ".join(item.allergens), fetched_at, sha256,
        int(item.nutrition_available), int(reason is None), reason,
    )
    placeholders = ", ".join("?" * len(ITEM_COLUMNS))
    updates = ", ".join(
        f"{col} = excluded.{col}" for col in ITEM_COLUMNS if col != "rec_num_and_port"
    )
    conn.execute(
        f"INSERT INTO items({', '.join(ITEM_COLUMNS)}) VALUES ({placeholders}) "
        f"ON CONFLICT(rec_num_and_port) DO UPDATE SET {updates}",
        values,
    )
    conn.execute("DELETE FROM items_fts WHERE rec_num_and_port = ?", (item.rec_num_and_port,))
    conn.execute(
        "INSERT INTO items_fts(rec_num_and_port, name) VALUES (?, ?)",
        (item.rec_num_and_port, item.name),
    )


def replace_item_tags(conn: sqlite3.Connection, rec_id: str, tags: list[str]) -> None:
    conn.execute("DELETE FROM item_tags WHERE rec_num_and_port = ?", (rec_id,))
    conn.executemany(
        "INSERT OR IGNORE INTO item_tags(rec_num_and_port, tag, kind) VALUES (?, ?, ?)",
        [(rec_id, tag, tag_kind(tag)) for tag in tags],
    )


def insert_menu_entries(conn: sqlite3.Connection, entries: list[MenuEntry]) -> int:
    """Insert menu rows, ignoring ones already recorded. Returns rows added."""
    before = conn.total_changes
    conn.executemany(
        "INSERT OR IGNORE INTO menu_entries"
        "(date, location_num, meal, station, rec_num_and_port) VALUES (?, ?, ?, ?, ?)",
        [
            (e.date, e.location_num, e.meal, e.station, e.rec_num_and_port)
            for e in entries
        ],
    )
    return conn.total_changes - before


def record_menu_day(
    conn: sqlite3.Connection,
    date: str,
    location_num: int,
    status: str,
    meals: list[str],
    item_count: int,
    fetched_at: str,
) -> None:
    conn.execute(
        "INSERT INTO menu_days(date, location_num, status, meals_found, item_count, "
        "fetched_at) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(date, location_num) DO UPDATE SET status = excluded.status, "
        "meals_found = excluded.meals_found, item_count = excluded.item_count, "
        "fetched_at = excluded.fetched_at",
        (date, location_num, status, ",".join(meals), item_count, fetched_at),
    )


def upsert_item_diet(
    conn: sqlite3.Connection, rec_id: str, facts: DietFacts, version: int
) -> None:
    """Store a classification. A manual override, if one exists, wins."""
    override = conn.execute(
        "SELECT diet_level FROM item_overrides WHERE rec_num_and_port = ?", (rec_id,)
    ).fetchone()
    level = override[0] if override else facts.diet_level
    source = "override" if override else "classifier"

    conn.execute(
        "INSERT INTO item_diet(rec_num_and_port, has_beef, has_pork, has_poultry, "
        "has_fish, has_shellfish, diet_level, source, classifier_version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(rec_num_and_port) DO UPDATE SET has_beef=excluded.has_beef, "
        "has_pork=excluded.has_pork, has_poultry=excluded.has_poultry, "
        "has_fish=excluded.has_fish, has_shellfish=excluded.has_shellfish, "
        "diet_level=excluded.diet_level, source=excluded.source, "
        "classifier_version=excluded.classifier_version",
        (
            rec_id, int(facts.has_beef), int(facts.has_pork), int(facts.has_poultry),
            int(facts.has_fish), int(facts.has_shellfish), level, source, version,
        ),
    )


def item_tags_for(conn: sqlite3.Connection, rec_id: str) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "SELECT tag FROM item_tags WHERE rec_num_and_port = ?", (rec_id,)
        )
    ]


def known_item_ids(conn: sqlite3.Connection) -> set[str]:
    """Ids whose label we already hold. These are never fetched again."""
    return {row[0] for row in conn.execute("SELECT rec_num_and_port FROM items")}


def start_scrape_run(conn: sqlite3.Connection, started_at: str) -> int:
    cursor = conn.execute(
        "INSERT INTO scrape_runs(started_at, pages_fetched, cache_hits, new_items, "
        "errors, ok) VALUES (?, 0, 0, 0, 0, 0)",
        (started_at,),
    )
    conn.commit()
    return int(cursor.lastrowid or 0)


def finish_scrape_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    finished_at: str,
    pages_fetched: int,
    cache_hits: int,
    new_items: int,
    errors: int,
    ok: bool,
) -> None:
    conn.execute(
        "UPDATE scrape_runs SET finished_at = ?, pages_fetched = ?, cache_hits = ?, "
        "new_items = ?, errors = ?, ok = ? WHERE id = ?",
        (finished_at, pages_fetched, cache_hits, new_items, errors, int(ok), run_id),
    )
    conn.commit()


def prune_menu_entries(conn: sqlite3.Connection, keep_days: int, today: Date) -> int:
    """Drop menu history older than `keep_days`. Items are never pruned."""
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    before = conn.total_changes
    conn.execute("DELETE FROM menu_entries WHERE date < ?", (cutoff,))
    conn.execute("DELETE FROM menu_days WHERE date < ?", (cutoff,))
    conn.commit()
    return conn.total_changes - before


def search_items(conn: sqlite3.Connection, query: str, limit: int = 25) -> list[sqlite3.Row]:
    """Fuzzy-ish name search. Prefix matching covers most half-remembered names."""
    terms = [t for t in query.replace('"', " ").split() if t]
    if not terms:
        return []
    match = " ".join(f'"{term}"*' for term in terms)
    return list(
        conn.execute(
            "SELECT i.* FROM items_fts f JOIN items i "
            "ON i.rec_num_and_port = f.rec_num_and_port "
            "WHERE items_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        )
    )
