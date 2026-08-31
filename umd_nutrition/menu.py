"""Parse a menu page into MenuEntry rows.

A menu page holds every meal for one hall on one day, in tab panes. Meal names
come from the tab link text, never from pane order: weekends are Brunch + Dinner,
so on a Saturday `#pane-2` is Dinner where on a weekday it is Lunch.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

from .models import MenuEntry, normalize_rec_id

# Legend icon slug -> kind. The site mixes three different concepts in one strip
# of images, and only splitting them makes "no nuts" a meaningful query.
TAG_KINDS: dict[str, str] = {
    "dairy": "allergen",
    "egg": "allergen",
    "fish": "allergen",
    "shellfish": "allergen",
    "gluten": "allergen",
    "soy": "allergen",
    "sesame": "allergen",
    "nuts": "allergen",
    "coconut": "allergen",
    "alcohol": "allergen",
    "pea_protein": "allergen",
    "vegan": "diet",
    "vegetarian": "diet",
    "halal": "diet",
    "pork": "diet",
    "local": "sourcing",
}

# Icon filenames are `icons_<year>_<slug>.<ext>`. Case and extension both vary --
# shellfish ships as icons_2016_Shellfish.gif on one page and .png on another --
# so the slug is lowercased and the extension dropped.
_ICON_ALIASES = {"halalfriendly": "halal"}

_ICON_RE = re.compile(r"icons_\d{4}_(.+)$", re.IGNORECASE)


class MenuParseError(ValueError):
    """Raised when a menu page does not look like a menu page any more."""


@dataclass
class MenuPage:
    """One hall, one day. Mirrors what menu_days records."""

    date: str
    location_num: int
    entries: list[MenuEntry] = field(default_factory=list)
    meals: list[str] = field(default_factory=list)
    is_empty: bool = False


def tag_kind(tag: str) -> str:
    """Classify a legend tag. Unknown tags are surfaced, not silently dropped."""
    return TAG_KINDS.get(tag, "unknown")


def _icon_slug(src: str) -> str | None:
    """Turn `/LegendImages/icons_2022_HalalFriendly.gif` into `halal`."""
    stem = src.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    match = _ICON_RE.match(stem)
    if match is None:
        return None
    slug = match.group(1).lower()
    return _ICON_ALIASES.get(slug, slug)


def parse_location_options(html: str) -> dict[int, str]:
    """Read the hall dropdown: {16: 'South Campus', ...}."""
    soup = BeautifulSoup(html, "lxml")
    halls: dict[int, str] = {}
    for option in soup.find_all("option"):
        value = (option.get("value") or "").strip()
        name = option.get_text(" ", strip=True)
        if value.isdigit() and name:
            halls[int(value)] = name
    return halls


def _meal_names_by_pane(soup: BeautifulSoup) -> dict[str, str]:
    """Map pane id -> meal name using the tab links' own text."""
    meals: dict[str, str] = {}
    for anchor in soup.select('a[role="tab"]'):
        pane_id = anchor.get("aria-controls") or (anchor.get("href") or "").lstrip("#")
        name = anchor.get_text(" ", strip=True)
        if pane_id and name:
            meals[pane_id] = name
    return meals


def _tags_for_row(row: Tag) -> list[str]:
    """Legend icons inside this row only.

    Scoping to the row matters: the page footer carries a legend showing every
    icon, and anything that scans forward from an item link swallows it.
    """
    tags: list[str] = []
    for img in row.find_all("img"):
        slug = _icon_slug(img.get("src") or "")
        if slug and slug not in tags:
            tags.append(slug)
    return tags


def parse_menu(html: str, date: str, location_num: int) -> MenuPage:
    """Parse a menu page. Raises MenuParseError if the markup stopped making sense."""
    soup = BeautifulSoup(html, "lxml")
    meals_by_pane = _meal_names_by_pane(soup)
    page = MenuPage(date=date, location_num=location_num)

    item_links = soup.select("a.menu-item-name")

    # A day with no menu comes back as a short page with no meal tabs and no
    # item links at all. That is a real answer, not a parse failure.
    if not meals_by_pane and not item_links:
        page.is_empty = True
        return page

    if not meals_by_pane:
        raise MenuParseError(
            f"{date} hall {location_num}: found {len(item_links)} item links but no "
            f"meal tabs — the tab markup changed"
        )

    for pane_id, meal in meals_by_pane.items():
        pane = soup.find(id=pane_id)
        if pane is None:
            raise MenuParseError(
                f"{date} hall {location_num}: tab {meal!r} points at #{pane_id}, "
                f"which is not on the page"
            )
        page.meals.append(meal)

        station: str | None = None
        # Selecting both in one query keeps them in document order, which is the
        # only thing tying an item to the station header above it.
        for node in pane.select("h3.card-title, div.menu-item-row"):
            if node.name == "h3":
                station = node.get_text(" ", strip=True)
                continue

            link = node.select_one("a.menu-item-name")
            if link is None:
                continue
            href = link.get("href") or ""
            match = re.search(r"RecNumAndPort=([^&\"'\s]+)", href)
            if match is None:
                raise MenuParseError(
                    f"{date} hall {location_num}: item {link.get_text(strip=True)!r} "
                    f"has no RecNumAndPort in href {href!r}"
                )
            if station is None:
                raise MenuParseError(
                    f"{date} hall {location_num}: item "
                    f"{link.get_text(strip=True)!r} in {meal} appears before any "
                    f"station heading"
                )

            page.entries.append(
                MenuEntry(
                    date=date,
                    location_num=location_num,
                    meal=meal,
                    station=station,
                    rec_num_and_port=normalize_rec_id(match.group(1)),
                    name=link.get_text(" ", strip=True),
                    tags=_tags_for_row(node),
                )
            )

    # Tabs but nothing under them means the markup moved, not that the hall is shut.
    if not page.entries:
        raise MenuParseError(
            f"{date} hall {location_num}: page has meal tabs "
            f"({', '.join(page.meals)}) but parsed zero items"
        )

    return page
