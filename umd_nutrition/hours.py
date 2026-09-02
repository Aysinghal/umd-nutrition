"""Dining hall opening hours.

nutrition.umd.edu does not publish hours. Not a single time string appears on a
menu page -- it knows what is being served and nothing about when.

The hours dining.umd.edu shows are fetched by its own page, in the browser, from
a public Google Sheet. So that is where these come from: the same sheet, read
server-side during the scrape. It carries every hall, every meal, every calendar
date, roughly a year ahead.

The response is Google's "gviz" format, which is JSON wrapped in a JavaScript
call:

    /*O_o*/
    google.visualization.Query.setResponse({"version":"0.6", ... });

Row 0 is a header of M/D/YYYY dates. Every other row is one venue's one meal,
named "South Campus | Breakfast", with a cell per date holding either a range
("7am-10:30am") or "Closed".
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date as Date

log = logging.getLogger(__name__)

HOURS_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1vdWskGO2-aJfKLSW8-3zMaj_nx4SBJHF3OvMEy4-ZNo/gviz/tq?gid=479022338"
)

# The sheet names venues its own way, and not quite the way the menu site does:
# it says "Yahentamitsi" where locations.name is "Yahentamitsi Dining Hall".
# Three halls total, so an explicit map is clearer than fuzzy-matching names.
VENUES: dict[str, int] = {
    "South Campus": 16,
    "Yahentamitsi": 19,
    "251 North": 51,
}

MEALS = ("Breakfast", "Lunch", "Dinner")

CLOSED = "Closed"

_DATE_RE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$")


class HoursParseError(ValueError):
    """The sheet no longer looks like the sheet."""


def _iso(cell: object) -> str | None:
    """'9/1/2026' -> '2026-09-01'. None for anything that is not a date."""
    if not isinstance(cell, str):
        return None
    match = _DATE_RE.match(cell)
    if match is None:
        return None
    month, day, year = (int(part) for part in match.groups())
    try:
        return Date(year, month, day).isoformat()
    except ValueError:
        return None


def _unwrap(text: str) -> dict:
    """Pull the JSON payload out of the gviz JavaScript wrapper."""
    try:
        start = text.index("(")
        end = text.rindex(")")
    except ValueError as exc:
        raise HoursParseError("hours sheet: not a gviz response") from exc
    try:
        payload = json.loads(text[start + 1 : end])
    except json.JSONDecodeError as exc:
        raise HoursParseError(f"hours sheet: bad JSON ({exc})") from exc
    # An HTML error page can still get this far: any two parentheses in it slice
    # out something json.loads is happy to read as a number.
    if not isinstance(payload, dict):
        raise HoursParseError(
            f"hours sheet: expected an object, got {type(payload).__name__}"
        )
    return payload


def parse_hours(text: str, *, dates: list[str] | None = None) -> dict[tuple[str, int, str], str]:
    """Read the sheet into {(iso_date, location_num, meal): "7am-10:30am"}.

    `dates` limits the result to the days being scraped. The sheet holds a year;
    storing all of it would mean carrying 1,000 days of hours for a 31-day window.
    """
    payload = _unwrap(text)
    table = payload.get("table")
    if not isinstance(table, dict) or not table.get("rows"):
        raise HoursParseError("hours sheet: no table rows")

    rows = [[cell["v"] if cell else "" for cell in row.get("c", [])] for row in table["rows"]]
    header = rows[0] if rows else []

    # Column index -> ISO date. Column 0 is the venue label, not a date.
    columns: dict[int, str] = {}
    for index, cell in enumerate(header):
        iso = _iso(cell)
        if iso is not None and (dates is None or iso in dates):
            columns[index] = iso

    if not columns:
        raise HoursParseError(
            f"hours sheet: no usable date columns in {len(header)} header cells"
        )

    wanted = set(dates) if dates is not None else None
    found: dict[tuple[str, int, str], str] = {}
    venues_seen: set[str] = set()

    for row in rows[1:]:
        label = str(row[0] if row else "").strip()
        if "|" not in label:
            continue
        venue, _, meal = label.partition("|")
        venue, meal = venue.strip(), meal.strip()
        location = VENUES.get(venue)
        if location is None or meal not in MEALS:
            continue
        venues_seen.add(venue)

        for index, iso in columns.items():
            value = str(row[index]).strip() if index < len(row) else ""
            if value:
                found[(iso, location, meal)] = value

    if not venues_seen:
        raise HoursParseError(
            f"hours sheet: none of {sorted(VENUES)} found among {len(rows) - 1} rows"
        )
    missing = set(VENUES) - venues_seen
    if missing:
        # Worth saying out loud, but one hall dropping off the sheet is not a
        # reason to publish no hours at all.
        log.warning("hours sheet: no rows for %s", ", ".join(sorted(missing)))
    if wanted:
        absent = wanted - {iso for iso, _, _ in found}
        if absent:
            log.warning("hours sheet: no hours for %s", ", ".join(sorted(absent)))

    return found


def brunch_from(day_hours: dict[str, str]) -> str | None:
    """Weekend Brunch, built from Breakfast's start and Lunch's end.

    The sheet has no Brunch row, but South Campus and Yahentamitsi serve Brunch
    on weekends. On a Saturday their Breakfast reads 10am-10:30am and their Lunch
    10:30am-4pm, which is one 10am-4pm service split across two rows. This is a
    derivation, not published data -- it is the one number here that UMD does not
    actually state.
    """
    breakfast = day_hours.get("Breakfast", "")
    lunch = day_hours.get("Lunch", "")
    if not breakfast or not lunch:
        return None
    if breakfast == CLOSED or lunch == CLOSED:
        return None
    if "-" not in breakfast or "-" not in lunch:
        return None
    return f"{breakfast.split('-')[0].strip()}-{lunch.rsplit('-', 1)[1].strip()}"
