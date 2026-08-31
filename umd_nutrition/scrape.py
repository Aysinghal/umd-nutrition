"""Scrape orchestration: menus for a date range, then any labels we have not seen.

The whole performance story is here. Menu pages are re-fetched because they change;
label pages are fetched once ever, because RecNumAndPort is a stable recipe id.
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import date as Date
from datetime import datetime, timedelta

from . import db
from .client import Client, FetchError
from .diet import CLASSIFIER_VERSION, check_against_tags, classify
from .label import LabelParseError, parse_label
from .menu import MenuParseError, parse_location_options, parse_menu

log = logging.getLogger(__name__)

BASE = "https://nutrition.umd.edu"
COMMIT_EVERY = 50
DEFAULT_HALLS = (16, 19, 51)


def menu_url(location_num: int, day: Date) -> str:
    # dtdate wants M/D/YYYY with no zero padding. Padded works too, but this is
    # the form the site's own links use.
    return f"{BASE}/?locationNum={location_num}&dtdate={day.month}/{day.day}/{day.year}"


def label_url(rec_num_and_port: str) -> str:
    # The `*` has to be percent-encoded to survive a query string.
    return f"{BASE}/label.aspx?RecNumAndPort={rec_num_and_port.replace('*', '%2A')}"


def date_range(start: Date, days: int) -> list[Date]:
    return [start + timedelta(days=offset) for offset in range(days)]


@dataclass
class ScrapeSummary:
    menu_pages: int = 0
    empty_days: int = 0
    menu_rows_added: int = 0
    new_items: int = 0
    items_without_data: int = 0
    unclassified: int = 0
    pages_fetched: int = 0
    cache_hits: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def report(self) -> str:
        lines = [
            f"menu pages:   {self.menu_pages} ({self.empty_days} with no menu)",
            f"menu rows:    +{self.menu_rows_added}",
            f"new items:    +{self.new_items} ({self.items_without_data} with no nutrition data)",
            f"fetched:      {self.pages_fetched} pages, {self.cache_hits} from cache",
            f"unclassified: {self.unclassified} (no diet level)",
            f"errors:       {len(self.errors)}",
        ]
        lines.extend(f"  - {message}" for message in self.errors[:20])
        if len(self.errors) > 20:
            lines.append(f"  ... and {len(self.errors) - 20} more")
        return "\n".join(lines)


def reclassify_all(conn: sqlite3.Connection, *, version: int = CLASSIFIER_VERSION) -> int:
    """Re-run the diet classifier over every stored item.

    Labels are never re-fetched, so bumping CLASSIFIER_VERSION would otherwise
    change nothing. This rebuilds every classification from the stored ingredient
    text and tags, with no network at all.
    """
    rows = list(
        conn.execute("SELECT rec_num_and_port, name, ingredients FROM items")
    )
    for row in rows:
        tags = db.item_tags_for(conn, row["rec_num_and_port"])
        facts = classify(row["name"], row["ingredients"] or "", tags)
        db.upsert_item_diet(conn, row["rec_num_and_port"], facts, version)
    conn.commit()
    log.info("reclassified %d items at version %d", len(rows), version)
    return len(rows)


def scrape(
    conn: sqlite3.Connection,
    client: Client,
    *,
    dates: list[Date],
    halls: tuple[int, ...] | list[int] = DEFAULT_HALLS,
    use_cached_menus: bool = False,
    prune_keep_days: int | None = 31,
    today: Date | None = None,
) -> ScrapeSummary:
    """Scrape the given halls over the given dates and store everything."""
    db.init_schema(conn)
    summary = ScrapeSummary()
    started_at = datetime.now().isoformat(timespec="seconds")
    run_id = db.start_scrape_run(conn, started_at)

    pending_labels: dict[str, str] = {}  # rec id -> name, for logging
    known = db.known_item_ids(conn)
    halls_seen = False

    for day in dates:
        iso = day.isoformat()
        for hall in halls:
            url = menu_url(hall, day)
            fetched_at = datetime.now().isoformat(timespec="seconds")
            try:
                result = client.get(url, cache_ok=use_cached_menus)
            except FetchError as exc:
                summary.errors.append(f"menu {iso} hall {hall}: {exc}")
                db.record_menu_day(conn, iso, hall, "error", [], 0, fetched_at)
                continue

            # The hall dropdown is on every menu page, so names come for free.
            if not halls_seen:
                for num, name in parse_location_options(result.html).items():
                    db.upsert_location(conn, num, name)
                halls_seen = True

            try:
                page = parse_menu(result.html, iso, hall)
            except MenuParseError as exc:
                summary.errors.append(str(exc))
                db.record_menu_day(conn, iso, hall, "error", [], 0, fetched_at)
                continue

            summary.menu_pages += 1
            if page.is_empty:
                summary.empty_days += 1
                db.record_menu_day(conn, iso, hall, "empty", [], 0, fetched_at)
                log.info("%s hall %s: no menu", iso, hall)
                continue

            summary.menu_rows_added += db.insert_menu_entries(conn, page.entries)
            db.record_menu_day(
                conn, iso, hall, "ok", page.meals, len(page.entries), fetched_at
            )

            for entry in page.entries:
                # Tags are stable per item, so writing them repeatedly is a no-op.
                db.replace_item_tags(conn, entry.rec_num_and_port, entry.tags)
                if entry.rec_num_and_port not in known:
                    pending_labels.setdefault(entry.rec_num_and_port, entry.name)

            conn.commit()
            log.info(
                "%s hall %s: %d items across %s",
                iso, hall, len(page.entries), ", ".join(page.meals),
            )

    log.info("%d labels to fetch (%d already cached)", len(pending_labels), len(known))

    total = len(pending_labels)
    for number, (rec_id, name) in enumerate(pending_labels.items(), start=1):
        url = label_url(rec_id)
        try:
            result = client.get(url, cache_ok=True)
        except FetchError as exc:
            summary.errors.append(f"label {rec_id} ({name}): {exc}")
            continue

        try:
            item = parse_label(result.html, rec_id)
        except LabelParseError as exc:
            # One unparseable label must not cost us the rest of the run.
            summary.errors.append(str(exc))
            continue

        db.upsert_item(
            conn,
            item,
            fetched_at=datetime.now().isoformat(timespec="seconds"),
            sha256=hashlib.sha256(result.html.encode("utf-8")).hexdigest(),
        )
        summary.new_items += 1
        if not item.nutrition_available:
            summary.items_without_data += 1

        # Classify now, from the text we just parsed. Tags were written during
        # the menu phase, so they are already there to cross-check against.
        tags = db.item_tags_for(conn, rec_id)
        facts = classify(item.name, item.ingredients, tags)
        db.upsert_item_diet(conn, rec_id, facts, CLASSIFIER_VERSION)
        if facts.diet_level is None:
            summary.unclassified += 1
        disagreement = check_against_tags(facts, tags)
        if disagreement:
            log.warning("diet check %s (%s): %s", rec_id, item.name, disagreement)

        # Commit as we go. A cold run is thousands of pages; losing all of it to
        # an interruption at page 1500 would mean re-parsing everything.
        if number % COMMIT_EVERY == 0:
            conn.commit()
            log.info(
                "labels %d/%d (%d new, %d errors)",
                number, total, summary.new_items, len(summary.errors),
            )

    conn.commit()

    if prune_keep_days is not None:
        removed = db.prune_menu_entries(conn, prune_keep_days, today or Date.today())
        if removed:
            log.info("pruned %d menu rows older than %d days", removed, prune_keep_days)

    summary.pages_fetched = client.pages_fetched
    summary.cache_hits = client.cache_hits
    db.finish_scrape_run(
        conn,
        run_id,
        finished_at=datetime.now().isoformat(timespec="seconds"),
        pages_fetched=summary.pages_fetched,
        cache_hits=summary.cache_hits,
        new_items=summary.new_items,
        errors=len(summary.errors),
        ok=summary.ok,
    )
    return summary
