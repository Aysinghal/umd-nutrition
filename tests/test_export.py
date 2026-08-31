"""JSON export tests. Builds a small database from fixtures, then exports it."""

from __future__ import annotations

import json
from datetime import date as Date
from pathlib import Path

import pytest

from umd_nutrition import db
from umd_nutrition.export import export
from umd_nutrition.scrape import scrape
from tests.test_scrape import StubClient


@pytest.fixture
def exported(tmp_path):
    conn = db.connect(":memory:")
    db.init_schema(conn)
    scrape(
        conn, StubClient(), dates=[Date(2026, 8, 31)], halls=(16,), today=Date(2026, 8, 31)
    )
    summary = export(conn, tmp_path)
    yield tmp_path, summary, conn
    conn.close()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_writes_the_three_shapes(exported) -> None:
    out, summary, _ = exported

    assert (out / "index.json").exists()
    assert (out / "items.json").exists()
    assert (out / "menu" / "16-2026-08-31.json").exists()
    assert summary.items == 4
    assert summary.days == 1
    assert summary.entries == 5


def test_items_carry_macros_and_diet_level(exported) -> None:
    out, _, _ = exported
    items = load(out / "items.json")

    toast = items["119370*1"]
    assert toast["name"] == "French Toast"
    assert toast["cal"] == 251
    assert toast["protein"] == 10.9
    assert toast["serving"] == "1 ea"
    assert toast["diet_level"] == 1
    assert toast["allergens"] == ["Dairy", "Eggs", "Gluten", "Soybeans", "Alcohol"]

    assert items["050148*4"]["diet_level"] == 4
    assert items["126719*1"]["diet_level"] == 2


def test_ingredients_are_not_exported(exported) -> None:
    """The biggest field, and only ever classifier input. It stays server side."""
    out, _, _ = exported
    items = load(out / "items.json")

    assert all("ingredients" not in item for item in items.values())
    raw = (out / "items.json").read_text(encoding="utf-8")
    assert "Liquid Eggs" not in raw
    assert "SLICED BEEF" not in raw


def test_tags_are_grouped_by_kind(exported) -> None:
    out, _, _ = exported
    items = load(out / "items.json")

    assert items["119370*1"]["tags"]["allergen"] == ["dairy", "egg"]
    assert items["119370*1"]["tags"]["diet"] == ["vegetarian"]
    assert items["126719*1"]["tags"]["diet"] == ["halal"]


def test_items_with_no_allergens_omit_the_key(exported) -> None:
    out, _, _ = exported
    items = load(out / "items.json")
    assert "allergens" not in items["126719*1"]


def test_normal_items_carry_no_warning_flags(exported) -> None:
    """`no_data` and `suspect` appear only when they apply."""
    out, _, _ = exported
    items = load(out / "items.json")

    assert all("no_data" not in item for item in items.values())
    assert all("suspect" not in item for item in items.values())


def test_suspect_items_export_their_reason(tmp_path) -> None:
    conn = db.connect(":memory:")
    db.init_schema(conn)
    scrape(conn, StubClient(), dates=[Date(2026, 8, 31)], halls=(16,), today=Date(2026, 8, 31))
    conn.execute(
        "UPDATE items SET plausible = 0, implausible_reason = 'macros weigh 889g' "
        "WHERE rec_num_and_port = '050148*4'"
    )
    conn.commit()
    export(conn, tmp_path)

    items = load(tmp_path / "items.json")
    assert items["050148*4"]["suspect"] == "macros weigh 889g"
    conn.close()


def test_menu_file_groups_by_meal_then_station(exported) -> None:
    out, _, _ = exported
    menu = load(out / "menu" / "16-2026-08-31.json")

    assert menu["date"] == "2026-08-31"
    assert menu["hall"] == 16
    assert menu["hall_name"] == "South Campus"

    meals = {m["meal"]: m for m in menu["meals"]}
    assert set(meals) == {"Breakfast", "Dinner"}

    breakfast = {s["station"]: s["items"] for s in meals["Breakfast"]["stations"]}
    assert breakfast["Broiler Works"] == ["119370*1"]
    assert breakfast["Treats"] == ["102009*1"]


def test_meals_are_a_list_so_order_survives(exported) -> None:
    """Brunch/Dinner and Breakfast/Lunch/Dinner both need their own order."""
    out, _, _ = exported
    menu = load(out / "menu" / "16-2026-08-31.json")

    assert isinstance(menu["meals"], list)
    assert [m["meal"] for m in menu["meals"]] == ["Breakfast", "Dinner"]


def test_menu_refers_to_items_that_exist(exported) -> None:
    out, _, _ = exported
    items = load(out / "items.json")
    menu = load(out / "menu" / "16-2026-08-31.json")

    referenced = {
        rec_id
        for meal in menu["meals"]
        for station in meal["stations"]
        for rec_id in station["items"]
    }
    assert referenced <= set(items), "menu points at an item not in items.json"


def test_index_lists_halls_dates_and_days(exported) -> None:
    out, _, _ = exported
    index = load(out / "index.json")

    assert index["dates"] == ["2026-08-31"]
    assert {h["id"] for h in index["halls"]} == {16, 19, 51}
    assert index["days"][0]["meals"] == ["Breakfast", "Dinner"]
    assert index["days"][0]["status"] == "ok"
    assert index["counts"]["items"] == 4
    assert index["generated_at"]
    assert index["classifier_version"] >= 1


def test_empty_days_are_in_the_index_but_have_no_menu_file(tmp_path) -> None:
    conn = db.connect(":memory:")
    db.init_schema(conn)
    scrape(
        conn, StubClient(menu="menu_16_empty.html"), dates=[Date(2026, 8, 31)],
        halls=(16,), today=Date(2026, 8, 31),
    )
    export(conn, tmp_path)

    index = load(tmp_path / "index.json")
    assert index["days"][0]["status"] == "empty"
    assert not (tmp_path / "menu" / "16-2026-08-31.json").exists()
    conn.close()


def test_export_overwrites_cleanly(exported) -> None:
    out, _, conn = exported
    first = (out / "items.json").read_text(encoding="utf-8")
    export(conn, out)
    assert (out / "items.json").read_text(encoding="utf-8") == first
