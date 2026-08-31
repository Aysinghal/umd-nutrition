"""Database and orchestration tests. A stub client serves fixtures — no network."""

from __future__ import annotations

from datetime import date as Date
from pathlib import Path

import pytest

from umd_nutrition import db
from umd_nutrition.client import FetchError, FetchResult
from umd_nutrition.scrape import label_url, menu_url, scrape

FIXTURES = Path(__file__).parent / "fixtures"

LABELS = {
    "119370*1": "label_119370_1_french_toast.html",
    "102009*1": "label_102009_1_caramel_sauce.html",
    "050148*4": "label_050148_4_hunan_beef.html",
    "126719*1": "label_126719_1_chicken_thigh.html",
}


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8", errors="replace")


class StubClient:
    """Stands in for Client: same surface, fixtures instead of sockets."""

    def __init__(self, *, menu: str = "menu_tiny.html", broken: set[str] | None = None):
        self.menu_fixture = menu
        self.broken = broken or set()
        self.pages_fetched = 0
        self.cache_hits = 0
        self.requested: list[str] = []
        self.missing: set[str] = set()

    def get(self, url: str, *, cache_ok: bool = True) -> FetchResult:
        self.requested.append(url)
        if url in self.missing:
            raise FetchError(f"{url}: HTTP 404")
        self.pages_fetched += 1

        if "label.aspx" in url:
            rec_id = url.split("RecNumAndPort=")[1].replace("%2A", "*")
            html = load(LABELS[rec_id])
            if rec_id in self.broken:
                # Break one field so the label parser raises for this item only.
                html = html.replace("Protein", "Protien")
            return FetchResult(url=url, html=html, from_cache=False)

        return FetchResult(url=url, html=load(self.menu_fixture), from_cache=False)

    @property
    def label_requests(self) -> list[str]:
        return [u for u in self.requested if "label.aspx" in u]


@pytest.fixture
def conn():
    connection = db.connect(":memory:")
    db.init_schema(connection)
    yield connection
    connection.close()


def run(conn, client, day=Date(2026, 8, 31), halls=(16,), **kwargs):
    return scrape(conn, client, dates=[day], halls=halls, today=day, **kwargs)


def test_url_shapes() -> None:
    """dtdate is not zero padded; the portion separator must be encoded."""
    assert menu_url(16, Date(2026, 8, 31)) == (
        "https://nutrition.umd.edu/?locationNum=16&dtdate=8/31/2026"
    )
    assert menu_url(51, Date(2026, 9, 5)).endswith("dtdate=9/5/2026")
    assert label_url("119370*1") == (
        "https://nutrition.umd.edu/label.aspx?RecNumAndPort=119370%2A1"
    )


def test_scrape_populates_everything(conn) -> None:
    client = StubClient()
    summary = run(conn, client)

    assert summary.ok, summary.errors
    assert summary.new_items == 4
    assert summary.menu_pages == 1

    items = {r["rec_num_and_port"]: r for r in conn.execute("SELECT * FROM items")}
    assert set(items) == set(LABELS)
    assert items["119370*1"]["name"] == "French Toast"
    assert items["119370*1"]["calories"] == 251
    assert items["119370*1"]["allergens_text"] == "Dairy, Eggs, Gluten, Soybeans, Alcohol"
    assert items["126719*1"]["allergens_text"] == ""
    assert items["050148*4"]["ingredients"].upper().startswith("SLICED BEEF")
    assert items["119370*1"]["label_sha256"]

    # Chicken sits at two stations in one meal: five rows from four items.
    rows = list(conn.execute("SELECT * FROM menu_entries ORDER BY meal, station"))
    assert len(rows) == 5
    assert {r["meal"] for r in rows} == {"Breakfast", "Dinner"}
    assert {r["station"] for r in rows} == {
        "Broiler Works", "Treats", "Mongolian Grill", "Grill Works",
    }


def test_locations_come_from_the_dropdown(conn) -> None:
    run(conn, StubClient())
    halls = {r["location_num"]: r["name"] for r in conn.execute("SELECT * FROM locations")}
    assert halls == {16: "South Campus", 19: "Yahentamitsi Dining Hall", 51: "251 North"}


def test_tags_are_stored_with_their_kind(conn) -> None:
    run(conn, StubClient())
    tags = {
        (r["rec_num_and_port"], r["tag"]): r["kind"]
        for r in conn.execute("SELECT * FROM item_tags")
    }

    assert tags[("119370*1", "dairy")] == "allergen"
    assert tags[("119370*1", "vegetarian")] == "diet"
    assert tags[("126719*1", "halal")] == "diet"
    assert tags[("050148*4", "shellfish")] == "allergen"
    # The footer legend must not leak onto any item.
    assert not any(tag == "local" for _, tag in tags)


def test_labels_are_fetched_once_ever(conn) -> None:
    """The whole performance story: a second run fetches no labels at all."""
    first = StubClient()
    run(conn, first)
    assert len(first.label_requests) == 4

    second = StubClient()
    summary = run(conn, second)

    assert second.label_requests == []
    assert summary.new_items == 0
    assert summary.ok
    # The menu page is still re-fetched, because menus change.
    assert len(second.requested) == 1


def test_menu_rows_are_not_duplicated_on_rerun(conn) -> None:
    run(conn, StubClient())
    run(conn, StubClient())
    (count,) = conn.execute("SELECT COUNT(*) FROM menu_entries").fetchone()
    assert count == 5


def test_bad_label_is_recorded_but_run_continues(conn) -> None:
    """One unparseable label must not cost the other three."""
    client = StubClient(broken={"050148*4"})
    summary = run(conn, client)

    assert summary.new_items == 3
    assert len(summary.errors) == 1
    assert "050148*4" in summary.errors[0]
    assert "protein" in summary.errors[0].lower()
    assert not summary.ok

    stored = db.known_item_ids(conn)
    assert "050148*4" not in stored
    assert "119370*1" in stored
    # Its menu row and tags survive even though the label did not.
    (rows,) = conn.execute(
        "SELECT COUNT(*) FROM menu_entries WHERE rec_num_and_port = '050148*4'"
    ).fetchone()
    assert rows == 1


def test_failed_label_is_retried_on_the_next_run(conn) -> None:
    run(conn, StubClient(broken={"050148*4"}))
    healthy = StubClient()
    summary = run(conn, healthy)

    assert label_url("050148*4") in healthy.label_requests
    assert summary.new_items == 1
    assert summary.ok


def test_menu_fetch_failure_is_recorded_as_error(conn) -> None:
    client = StubClient()
    client.missing = {menu_url(16, Date(2026, 8, 31))}
    summary = run(conn, client)

    assert not summary.ok
    day = conn.execute("SELECT * FROM menu_days").fetchone()
    assert day["status"] == "error"
    assert day["item_count"] == 0


def test_empty_day_recorded_as_empty_not_error(conn) -> None:
    summary = run(conn, StubClient(menu="menu_16_empty.html"))

    assert summary.ok
    assert summary.empty_days == 1
    day = conn.execute("SELECT * FROM menu_days").fetchone()
    assert day["status"] == "empty"
    assert day["item_count"] == 0


def test_menu_day_records_meals_and_count(conn) -> None:
    run(conn, StubClient())
    day = conn.execute("SELECT * FROM menu_days").fetchone()

    assert day["status"] == "ok"
    assert day["meals_found"] == "Breakfast,Dinner"
    assert day["item_count"] == 5
    assert day["fetched_at"]


def test_scrape_run_is_logged(conn) -> None:
    summary = run(conn, StubClient())
    row = conn.execute("SELECT * FROM scrape_runs").fetchone()

    assert row["ok"] == 1
    assert row["new_items"] == 4
    assert row["errors"] == 0
    assert row["finished_at"]
    assert summary.report().startswith("menu pages:")


def test_real_menu_page_drives_the_right_number_of_label_fetches(conn) -> None:
    """348 unique ids on the real page, so 348 label fetches — not 720."""
    class MenuOnlyClient(StubClient):
        def get(self, url, *, cache_ok=True):
            if "label.aspx" in url:
                self.requested.append(url)
                raise FetchError("not fetching 348 labels in a test")
            return super().get(url, cache_ok=cache_ok)

    client = MenuOnlyClient(menu="menu_16_2026-08-31.html")
    summary = run(conn, client)

    assert len(client.label_requests) == 348
    (rows,) = conn.execute("SELECT COUNT(*) FROM menu_entries").fetchone()
    assert rows == 720
    assert len(summary.errors) == 348


def test_prune_drops_old_menu_rows_but_keeps_items(conn) -> None:
    run(conn, StubClient(), day=Date(2026, 1, 1), prune_keep_days=None)
    run(conn, StubClient(), day=Date(2026, 8, 31), prune_keep_days=31)

    dates = {r["date"] for r in conn.execute("SELECT DISTINCT date FROM menu_entries")}
    assert dates == {"2026-08-31"}
    assert len(db.known_item_ids(conn)) == 4
    days = {r["date"] for r in conn.execute("SELECT date FROM menu_days")}
    assert days == {"2026-08-31"}


def test_search_finds_items_by_partial_name(conn) -> None:
    run(conn, StubClient())

    names = [r["name"] for r in db.search_items(conn, "chick")]
    assert "Grilled Blackened Chicken Thigh" in names

    assert [r["name"] for r in db.search_items(conn, "french toast")] == ["French Toast"]
    assert db.search_items(conn, "") == []
    assert db.search_items(conn, "zzzznope") == []


def test_search_index_tracks_renames(conn) -> None:
    run(conn, StubClient())
    (before,) = conn.execute("SELECT COUNT(*) FROM items_fts").fetchone()
    run(conn, StubClient())
    (after,) = conn.execute("SELECT COUNT(*) FROM items_fts").fetchone()
    assert before == after == 4


def test_items_without_nutrition_data_are_stored_and_counted(conn) -> None:
    """They are real menu items, so they belong in the DB — flagged, not dropped."""
    class NoDataClient(StubClient):
        def get(self, url, *, cache_ok=True):
            if "label.aspx" in url:
                self.requested.append(url)
                self.pages_fetched += 1
                return FetchResult(
                    url=url, html=load("label_096369_2_no_data.html"), from_cache=False
                )
            return super().get(url, cache_ok=cache_ok)

    summary = run(conn, NoDataClient())

    assert summary.ok, summary.errors
    assert summary.items_without_data == 4
    rows = list(conn.execute("SELECT * FROM items"))
    assert len(rows) == 4
    assert all(r["nutrition_available"] == 0 for r in rows)
    assert all(r["calories"] is None for r in rows)
    # They are still searchable and still on the menu.
    (menu_rows,) = conn.execute("SELECT COUNT(*) FROM menu_entries").fetchone()
    assert menu_rows == 5


def test_normal_items_are_marked_available(conn) -> None:
    run(conn, StubClient())
    rows = list(conn.execute("SELECT * FROM items"))
    assert all(r["nutrition_available"] == 1 for r in rows)


def test_diet_classification_is_stored(conn) -> None:
    run(conn, StubClient())
    diets = {
        r["rec_num_and_port"]: r for r in conn.execute("SELECT * FROM item_diet")
    }

    assert len(diets) == 4
    assert diets["050148*4"]["diet_level"] == 4          # Hunan Beef
    assert diets["050148*4"]["has_beef"] == 1
    assert diets["126719*1"]["diet_level"] == 2          # chicken thigh
    assert diets["119370*1"]["diet_level"] == 1          # French Toast
    assert all(r["source"] == "classifier" for r in diets.values())


def test_manual_override_beats_the_classifier(conn) -> None:
    from umd_nutrition.scrape import reclassify_all

    run(conn, StubClient())
    conn.execute(
        "INSERT INTO item_overrides(rec_num_and_port, diet_level, note, set_at) "
        "VALUES ('050148*4', 1, 'actually the vegan version', '2026-09-01')"
    )
    conn.commit()
    reclassify_all(conn)

    row = conn.execute(
        "SELECT * FROM item_diet WHERE rec_num_and_port = '050148*4'"
    ).fetchone()
    assert row["diet_level"] == 1
    assert row["source"] == "override"


def test_reclassify_all_rewrites_every_item(conn) -> None:
    from umd_nutrition.diet import CLASSIFIER_VERSION
    from umd_nutrition.scrape import reclassify_all

    run(conn, StubClient())
    assert reclassify_all(conn, version=CLASSIFIER_VERSION + 1) == 4
    versions = {r[0] for r in conn.execute("SELECT classifier_version FROM item_diet")}
    assert versions == {CLASSIFIER_VERSION + 1}


def test_plausibility_is_stored(conn) -> None:
    run(conn, StubClient())
    rows = list(conn.execute("SELECT * FROM items"))
    assert all(r["plausible"] == 1 for r in rows)
    assert all(r["implausible_reason"] is None for r in rows)
