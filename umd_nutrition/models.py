"""Dataclasses mirroring the tables in SCHEMA.md."""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import unquote


def normalize_rec_id(raw: str) -> str:
    """Return a RecNumAndPort in its canonical `119370*1` form.

    The site writes the separator as a literal `*` in menu page hrefs but it has
    to be sent as `%2A` in a query string, so the same id reaches us both ways.
    """
    return unquote(raw.strip()).replace("%2A", "*").replace("%2a", "*")


@dataclass
class Item:
    """One nutrition label. Keyed by the full RecNumAndPort including portion."""

    rec_num_and_port: str
    name: str
    serving_size: str | None
    serving_qty: float | None
    serving_unit: str | None
    servings_per_container: float | None
    # None means the site printed "- - -" for that nutrient: it has no figure.
    # Distinct from 0.0, and callers must not treat the two as the same.
    calories: float | None
    protein_g: float | None
    total_fat_g: float | None
    saturated_fat_g: float | None
    trans_fat_g: float | None
    cholesterol_mg: float | None
    sodium_mg: float | None
    carbs_g: float | None
    fiber_g: float | None
    sugars_g: float | None
    added_sugars_g: float | None
    ingredients: str
    allergens: list[str] = field(default_factory=list)
    # False when the label says "Nutritional Information is not available for this
    # recipe": the item is real and on the menu, but carries no data at all. Kept
    # explicit so nothing has to infer "no data" from a row of NULLs.
    nutrition_available: bool = True

    @property
    def rec_num(self) -> str:
        """The recipe number without the portion suffix."""
        return self.rec_num_and_port.split("*", 1)[0]


@dataclass
class MenuEntry:
    """One item appearing at one station, in one meal, on one day, at one hall."""

    date: str  # ISO yyyy-mm-dd
    location_num: int
    meal: str  # tab text: Breakfast / Lunch / Dinner / Brunch
    station: str
    rec_num_and_port: str
    name: str
    tags: list[str] = field(default_factory=list)  # legend icon slugs
