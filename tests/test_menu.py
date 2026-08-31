"""Menu parser tests. Fixtures only — these never touch the network."""

from __future__ import annotations

import collections
from pathlib import Path

import pytest

from umd_nutrition.menu import (
    TAG_KINDS,
    MenuParseError,
    parse_location_options,
    parse_menu,
    tag_kind,
)

FIXTURES = Path(__file__).parent / "fixtures"

WEEKDAY = "menu_16_2026-08-31.html"
SATURDAY = "menu_16_2026-09-05_brunch.html"
OTHER_HALL = "menu_51_2026-08-31.html"
EMPTY = "menu_16_empty.html"


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8", errors="replace")


def weekday_page():
    return parse_menu(load(WEEKDAY), "2026-08-31", 16)


def test_weekday_meals_and_counts() -> None:
    page = weekday_page()

    assert page.meals == ["Breakfast", "Lunch", "Dinner"]
    assert len(page.entries) == 720
    assert len({e.rec_num_and_port for e in page.entries}) == 348

    per_meal = collections.Counter(e.meal for e in page.entries)
    assert per_meal == {"Lunch": 332, "Dinner": 323, "Breakfast": 65}


def test_saturday_is_brunch_and_dinner() -> None:
    """Weekends have two meals, so pane order cannot be trusted for meal names."""
    page = parse_menu(load(SATURDAY), "2026-09-05", 16)

    assert page.meals == ["Brunch", "Dinner"]
    assert "Lunch" not in page.meals
    assert len(page.entries) > 0


def test_second_hall_parses() -> None:
    page = parse_menu(load(OTHER_HALL), "2026-08-31", 51)

    assert page.meals == ["Breakfast", "Lunch", "Dinner"]
    assert len(page.entries) == 426
    assert all(e.location_num == 51 for e in page.entries)


def test_known_item_lands_in_the_right_place() -> None:
    page = weekday_page()
    matches = [e for e in page.entries if e.rec_num_and_port == "119370*1"]

    assert len(matches) == 1
    entry = matches[0]
    assert entry.name == "French Toast"
    assert entry.meal == "Breakfast"
    assert entry.station == "Broiler Works"
    assert entry.date == "2026-08-31"
    assert entry.tags == ["dairy", "egg", "gluten", "soy", "vegetarian", "alcohol"]


def test_stations_are_read_and_varied() -> None:
    page = weekday_page()
    stations = {e.station for e in page.entries}

    assert len(stations) == 23
    assert "Broiler Works" in stations
    assert "Salad Bar" in stations
    assert "Mongolian Grill" in stations
    assert all(s and s.strip() for s in stations)


def test_same_item_appears_at_several_stations_in_one_meal() -> None:
    """Why station belongs in the unique key: 87 such cases in one day."""
    page = weekday_page()

    stations_per_item: dict[tuple[str, str], set[str]] = collections.defaultdict(set)
    for entry in page.entries:
        stations_per_item[(entry.meal, entry.rec_num_and_port)].add(entry.station)

    multi = {k: v for k, v in stations_per_item.items() if len(v) > 1}
    assert len(multi) == 87
    assert ("Breakfast", "060022*1") in multi


def test_no_duplicate_rows_under_the_unique_key() -> None:
    """(date, hall, meal, station, item) must not collide."""
    page = weekday_page()
    counts = collections.Counter(
        (e.date, e.location_num, e.meal, e.station, e.rec_num_and_port)
        for e in page.entries
    )
    assert [key for key, n in counts.items() if n > 1] == []


def test_item_names_are_stable_per_id() -> None:
    """One id never carries two different names, so name belongs on items."""
    page = weekday_page()
    names: dict[str, set[str]] = collections.defaultdict(set)
    for entry in page.entries:
        names[entry.rec_num_and_port].add(entry.name)

    assert [k for k, v in names.items() if len(v) > 1] == []


def test_tags_are_stable_per_id() -> None:
    """Icons never vary between occurrences, so tags hang off the item."""
    page = weekday_page()
    tags: dict[str, set[tuple[str, ...]]] = collections.defaultdict(set)
    for entry in page.entries:
        tags[entry.rec_num_and_port].add(tuple(sorted(entry.tags)))

    assert [k for k, v in tags.items() if len(v) > 1] == []


def test_footer_legend_is_not_scraped_as_tags() -> None:
    """The page footer shows every icon; no item may pick up the whole set."""
    page = weekday_page()
    assert max(len(e.tags) for e in page.entries) < len(TAG_KINDS)
    # `local` appears only in that footer legend on this page.
    assert not any("local" in e.tags for e in page.entries)


def test_every_tag_seen_is_classified() -> None:
    """An unmapped icon means a new allergen we would silently ignore."""
    page = weekday_page()
    seen = {t for e in page.entries for t in e.tags}

    unknown = sorted(t for t in seen if tag_kind(t) == "unknown")
    assert unknown == [], f"unmapped legend icons: {unknown}"


def test_shellfish_icon_normalizes_across_file_extensions() -> None:
    """It ships as icons_2016_Shellfish.gif on one page and .png on another."""
    weekday = {t for e in weekday_page().entries for t in e.tags}
    saturday = {
        t for e in parse_menu(load(SATURDAY), "2026-09-05", 16).entries for t in e.tags
    }

    assert "shellfish" in weekday | saturday
    assert not any(t.endswith((".gif", ".png")) for t in weekday | saturday)
    assert "halal" in weekday, "icons_2022_HalalFriendly.gif should alias to halal"


def test_tag_kinds_are_split_three_ways() -> None:
    assert tag_kind("nuts") == "allergen"
    assert tag_kind("vegan") == "diet"
    assert tag_kind("local") == "sourcing"
    assert tag_kind("something_new") == "unknown"


def test_empty_day_is_empty_not_an_error() -> None:
    """A day with no menu: short page, no tabs, no items. Not a failure."""
    page = parse_menu(load(EMPTY), "2027-12-25", 16)

    assert page.is_empty is True
    assert page.entries == []
    assert page.meals == []


def test_tabs_without_items_raises() -> None:
    """Markup change or partial page — the one case worth shouting about."""
    html = load(WEEKDAY).replace("menu-item-name", "menu-item-name-CHANGED")

    with pytest.raises(MenuParseError) as excinfo:
        parse_menu(html, "2026-08-31", 16)

    assert "zero items" in str(excinfo.value)
    assert "2026-08-31" in str(excinfo.value)


def test_ids_are_normalized() -> None:
    page = weekday_page()
    assert all("%2A" not in e.rec_num_and_port for e in page.entries)
    assert all("*" in e.rec_num_and_port for e in page.entries)


def test_location_dropdown_lists_all_three_halls() -> None:
    assert parse_location_options(load(WEEKDAY)) == {
        16: "South Campus",
        19: "Yahentamitsi Dining Hall",
        51: "251 North",
    }
