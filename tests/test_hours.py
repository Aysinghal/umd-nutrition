"""Opening hours: parsing the sheet, storing it, and exporting it.

The fixture is four real columns lifted out of the live sheet -- two weekdays and
a real weekend -- so the weekend cases below are UMD's actual published hours,
not invented ones.
"""

from __future__ import annotations

import json
from datetime import date as Date
from pathlib import Path

import pytest

from umd_nutrition import db
from umd_nutrition.export import export
from umd_nutrition.hours import HoursParseError, brunch_from, parse_hours
from umd_nutrition.scrape import scrape
from tests.test_scrape import StubClient

FIXTURES = Path(__file__).parent / "fixtures"

WEEKDAY = "2026-09-01"
SATURDAY = "2026-09-05"
ALL_DATES = ["2026-08-31", WEEKDAY, SATURDAY, "2026-09-06"]

SOUTH, YAHENTAMITSI, NORTH_251 = 16, 19, 51


@pytest.fixture
def sheet() -> str:
    return (FIXTURES / "hours_sheet.txt").read_text(encoding="utf-8")


@pytest.fixture
def parsed(sheet):
    return parse_hours(sheet, dates=ALL_DATES)


def day(found, date: str, hall: int) -> dict[str, str]:
    return {meal: value for (d, h, meal), value in found.items() if d == date and h == hall}


# --- parsing -----------------------------------------------------------------


def test_reads_every_hall_and_meal(parsed) -> None:
    # 3 halls x 3 meals x 4 dates
    assert len(parsed) == 36


def test_a_weekday(parsed) -> None:
    assert day(parsed, WEEKDAY, SOUTH) == {
        "Breakfast": "7am-10:30am",
        "Lunch": "10:30am-4pm",
        "Dinner": "4pm-9pm",
    }


def test_halls_genuinely_differ(parsed) -> None:
    """The whole reason for doing this rather than hardcoding one table."""
    assert day(parsed, WEEKDAY, SOUTH)["Dinner"] == "4pm-9pm"
    assert day(parsed, WEEKDAY, NORTH_251)["Dinner"] == "4pm-10pm"
    assert day(parsed, WEEKDAY, NORTH_251)["Breakfast"] == "8am-10:30am"


def test_weekends_genuinely_differ(parsed) -> None:
    assert day(parsed, WEEKDAY, SOUTH)["Breakfast"] == "7am-10:30am"
    assert day(parsed, SATURDAY, SOUTH)["Breakfast"] == "10am-10:30am"
    assert day(parsed, SATURDAY, NORTH_251)["Dinner"] == "4pm-7pm"


def test_the_sheet_name_maps_to_the_menu_site_id(parsed) -> None:
    """The sheet says 'Yahentamitsi'; locations.name is 'Yahentamitsi Dining Hall'."""
    assert day(parsed, WEEKDAY, YAHENTAMITSI)["Dinner"] == "4pm-9pm"


def test_dates_filter_keeps_the_window_small(sheet) -> None:
    one = parse_hours(sheet, dates=[WEEKDAY])
    assert len(one) == 9
    assert {d for d, _, _ in one} == {WEEKDAY}


def test_dates_not_in_the_sheet_are_simply_absent(sheet) -> None:
    found = parse_hours(sheet, dates=[WEEKDAY, "2027-01-01"])
    assert {d for d, _, _ in found} == {WEEKDAY}


def test_no_dates_filter_takes_everything(sheet) -> None:
    assert len(parse_hours(sheet)) == 36


# --- the parser refuses to fail quietly --------------------------------------


def test_not_a_gviz_response() -> None:
    with pytest.raises(HoursParseError):
        parse_hours("<html>Sign in to continue</html>")


def test_gviz_wrapper_with_bad_json() -> None:
    with pytest.raises(HoursParseError):
        parse_hours("google.visualization.Query.setResponse({not json});")


def test_no_date_columns() -> None:
    body = json.dumps({"table": {"cols": [], "rows": [{"c": [{"v": "venue"}]}]}})
    with pytest.raises(HoursParseError, match="no usable date columns"):
        parse_hours(f"/*O_o*/\ngoogle.visualization.Query.setResponse({body});")


def test_venues_renamed_out_from_under_us() -> None:
    body = json.dumps(
        {
            "table": {
                "cols": [{"label": "clos"}, {"label": "TUE"}],
                "rows": [
                    {"c": [{"v": "venue"}, {"v": "9/1/2026"}]},
                    {"c": [{"v": "Somewhere Else | Lunch"}, {"v": "10am-2pm"}]},
                ],
            }
        }
    )
    with pytest.raises(HoursParseError, match="none of"):
        parse_hours(f"/*O_o*/\ngoogle.visualization.Query.setResponse({body});")


# --- brunch, the one derived number ------------------------------------------


def test_brunch_spans_breakfast_start_to_lunch_end(parsed) -> None:
    assert brunch_from(day(parsed, SATURDAY, SOUTH)) == "10am-4pm"


def test_brunch_needs_both_halves() -> None:
    assert brunch_from({"Breakfast": "10am-10:30am"}) is None
    assert brunch_from({}) is None


def test_brunch_is_not_derived_from_a_closed_hall() -> None:
    assert brunch_from({"Breakfast": "Closed", "Lunch": "10:30am-4pm"}) is None
    assert brunch_from({"Breakfast": "10am-10:30am", "Lunch": "Closed"}) is None


def test_closed_is_kept_verbatim() -> None:
    body = json.dumps(
        {
            "table": {
                "cols": [{"label": "clos"}, {"label": "TUE"}],
                "rows": [
                    {"c": [{"v": "venue"}, {"v": "9/1/2026"}]},
                    {"c": [{"v": "251 North | Dinner"}, {"v": "Closed"}]},
                ],
            }
        }
    )
    found = parse_hours(f"/*O_o*/\ngoogle.visualization.Query.setResponse({body});")
    assert found[(WEEKDAY, NORTH_251, "Dinner")] == "Closed"


# --- storage -----------------------------------------------------------------


@pytest.fixture
def conn():
    connection = db.connect(":memory:")
    db.init_schema(connection)
    yield connection
    connection.close()


def test_round_trips_through_the_database(conn, parsed) -> None:
    assert db.replace_hall_hours(conn, parsed) == 36
    stored = db.hall_hours_map(conn)
    assert stored[(WEEKDAY, SOUTH)]["Dinner"] == "4pm-9pm"
    assert stored[(SATURDAY, NORTH_251)]["Dinner"] == "4pm-7pm"


def test_rerunning_overwrites_rather_than_duplicating(conn, parsed) -> None:
    db.replace_hall_hours(conn, parsed)
    db.replace_hall_hours(conn, {(WEEKDAY, SOUTH, "Dinner"): "4pm-11pm"})
    assert conn.execute("SELECT COUNT(*) FROM hall_hours").fetchone()[0] == 36
    assert db.hall_hours_map(conn)[(WEEKDAY, SOUTH)]["Dinner"] == "4pm-11pm"


def test_hours_are_pruned_with_menu_days(conn, parsed) -> None:
    db.replace_hall_hours(conn, parsed)
    db.prune_menu_entries(conn, keep_days=1, today=Date(2026, 9, 2))
    remaining = {d for d, _ in db.hall_hours_map(conn)}
    assert "2026-08-31" not in remaining
    assert WEEKDAY in remaining


# --- the scrape --------------------------------------------------------------


def run(conn, client, day=Date(2026, 9, 1)):
    return scrape(conn, client, dates=[day], halls=(16,), today=day)


def test_scrape_stores_the_hours(conn) -> None:
    summary = run(conn, StubClient())
    # Only the scraped date is stored, not the whole sheet.
    assert summary.hours_cells == 9
    assert db.hall_hours_map(conn)[(WEEKDAY, SOUTH)]["Dinner"] == "4pm-9pm"


def test_the_sheet_being_down_does_not_take_the_scrape_down(conn) -> None:
    summary = run(conn, StubClient(hours=None))

    assert summary.menu_pages == 1      # the menu still scraped fine
    assert summary.hours_cells == 0
    assert any(e.startswith("hours:") for e in summary.errors)


def test_an_unrecognisable_sheet_is_a_clean_error_not_a_crash(conn) -> None:
    """A Google error page must not reach the scrape as an AttributeError."""
    summary = run(conn, StubClient(hours="menu_tiny.html"))

    assert summary.menu_pages == 1
    assert any(e.startswith("hours:") for e in summary.errors)


def test_a_bad_morning_leaves_previously_stored_hours_alone(conn, parsed) -> None:
    """Google having a bad day must not blank out hours we already hold."""
    db.replace_hall_hours(conn, parsed)
    run(conn, StubClient(hours=None))
    assert db.hall_hours_map(conn)[(WEEKDAY, SOUTH)]["Dinner"] == "4pm-9pm"


# --- the export --------------------------------------------------------------


def index_of(tmp_path) -> dict:
    return json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))


def test_export_puts_hours_on_the_day(conn, tmp_path) -> None:
    run(conn, StubClient())
    export(conn, tmp_path)
    entry = index_of(tmp_path)["days"][0]
    # The tiny menu fixture serves Breakfast and Dinner only, and the export
    # publishes hours for the meals a day actually has -- so no Lunch here, even
    # though the sheet has Lunch hours for this date.
    assert entry["meals"] == ["Breakfast", "Dinner"]
    assert entry["hours"] == {"Breakfast": "7am-10:30am", "Dinner": "4pm-9pm"}


def test_export_only_publishes_meals_the_day_actually_serves(conn, tmp_path) -> None:
    """A Brunch hall serves no Breakfast and no Lunch; those hours must not ship."""
    run(conn, StubClient(), day=Date(2026, 9, 5))
    conn.execute("UPDATE menu_days SET meals_found = 'Brunch,Dinner'")
    conn.commit()
    export(conn, tmp_path)

    entry = index_of(tmp_path)["days"][0]
    assert entry["meals"] == ["Brunch", "Dinner"]
    assert entry["hours"] == {"Brunch": "10am-4pm", "Dinner": "4pm-9pm"}


def test_a_day_with_no_hours_gets_no_key_at_all(conn, tmp_path) -> None:
    """The app treats a missing key as 'we don't know', never as 'closed'."""
    run(conn, StubClient())
    conn.execute("DELETE FROM hall_hours")
    conn.commit()
    export(conn, tmp_path)
    assert "hours" not in index_of(tmp_path)["days"][0]
