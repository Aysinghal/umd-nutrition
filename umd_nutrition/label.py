"""Parse a label.aspx page into an Item.

The label markup splits every value across a pile of nested table cells, so this
works off the page's normalized visible text instead and anchors regexes on the
printed label words. That survives markup churn; table-walking would not.

The one thing to know: the site breaks phrases across tags, so the flattened text
contains "Trans\\nFat 0g" and "Nutrition\\nFacts". Every anchor phrase is therefore
built with `_phrase()`, which lets any whitespace sit between the words.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from .models import Item, normalize_rec_id

# Sentence appended to every label. Marks the end of the ALLERGENS value, which
# is otherwise unbounded — and is all that follows the colon when there are none.
_DISCLAIMER = r"The\s+nutrient\s+composition\s+of\s+food"

# Added above the disclaimer on any label that has a "- - -" value, so it can sit
# between the allergens and the disclaimer and must also terminate the allergens.
_DASH_NOTE = r"Note:\s+Nutritional\s+Values"

# A value is either a number or "- - -", which is how the site prints a nutrient
# it has no figure for. Those become None: not zero, which would be a lie.
_VALUE = r"(-(?:\s*-)*|[\d.,]+)"

# An allergen list longer than this is prose, not allergens: the disclaimer
# wording must have changed and we are swallowing the footer.
_MAX_ALLERGEN_CHARS = 300

# Some recipes have no label at all. The page renders the name and this sentence
# and nothing else -- a real state of the site, not a parse failure.
_NO_DATA = re.compile(
    r"Nutritional\s+Information\s+is\s+not\s+available\s+for\s+this\s+recipe",
    re.IGNORECASE,
)


class LabelParseError(ValueError):
    """Raised when a label page is missing something we require."""


def _phrase(words: str) -> str:
    """Regex fragment for a label phrase whose words may be split across tags."""
    return r"\s+".join(re.escape(word) for word in words.split())


def normalize_text(html: str) -> str:
    """Flatten the page to visible text, one text node per line."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style"]):
        tag.decompose()
    text = soup.get_text("\n")
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{2,}", "\n", text).strip()


def _number(pattern: str, text: str, field_name: str, rec_id: str) -> float | None:
    """The value for a label word. None when the site prints dashes for it."""
    match = re.search(pattern, text, re.IGNORECASE)
    if match is None:
        raise LabelParseError(
            f"{rec_id}: could not find {field_name!r} on the label "
            f"(pattern {pattern!r} matched nothing)"
        )
    raw = match.group(1).strip()
    if raw.startswith("-"):
        return None
    return float(raw.replace(",", ""))


def _split_serving_size(serving_size: str | None) -> tuple[float | None, str | None]:
    """Split "1 ea" into (1.0, "ea"). Returns (None, raw) if it isn't numeric."""
    if not serving_size:
        return None, None
    match = re.match(r"([\d.]+)(?:\s*/\s*([\d.]+))?\s*(.*)$", serving_size.strip())
    if match is None:
        return None, serving_size.strip() or None
    numerator, denominator, unit = match.groups()
    try:
        qty = float(numerator) / float(denominator) if denominator else float(numerator)
    except (ValueError, ZeroDivisionError):
        return None, serving_size.strip() or None
    return qty, (unit.strip() or None)


def parse_label(html: str, rec_num_and_port: str) -> Item:
    """Parse label HTML into an Item, raising LabelParseError if anything is missing."""
    rec_id = normalize_rec_id(rec_num_and_port)
    soup = BeautifulSoup(html, "lxml")
    text = normalize_text(html)

    heading = soup.find("h1")
    name = heading.get_text(" ", strip=True) if heading else ""
    if not name:
        raise LabelParseError(f"{rec_id}: no <h1> item name on the label page")

    if _NO_DATA.search(text):
        return Item(
            rec_num_and_port=rec_id,
            name=name,
            serving_size=None,
            serving_qty=None,
            serving_unit=None,
            servings_per_container=None,
            calories=None,
            protein_g=None,
            total_fat_g=None,
            saturated_fat_g=None,
            trans_fat_g=None,
            cholesterol_mg=None,
            sodium_mg=None,
            carbs_g=None,
            fiber_g=None,
            sugars_g=None,
            added_sugars_g=None,
            ingredients="",
            allergens=[],
            nutrition_available=False,
        )

    serving_match = re.search(
        rf"{_phrase('Serving size')}\s+(.+?)\s*{_phrase('Calories per serving')}",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    serving_size = serving_match.group(1).strip() if serving_match else None
    serving_qty, serving_unit = _split_serving_size(serving_size)

    servings_match = re.search(
        rf"([\d.,]+)\s+{_phrase('servings per container')}", text, re.IGNORECASE
    )
    servings_per_container = (
        float(servings_match.group(1).replace(",", "")) if servings_match else None
    )

    # Every pattern takes its FIRST match on purpose: the Nutrition Facts panel
    # comes before the micronutrient list, which repeats Protein, Sodium, Fat and
    # Calories with unrounded values (250.8kcal against the panel's 251).
    # "Trans Fat" requires whitespace after "Fat" so it cannot match the
    # micronutrient list's "Trans Fatty Acid". "Total Carbohydrate" is followed by
    # a stray period in the site's own markup, hence the optional \.
    values = {
        "calories": _number(
            rf"{_phrase('Calories per serving')}\s+{_VALUE}", text, "calories", rec_id
        ),
        "total_fat_g": _number(
            rf"{_phrase('Total Fat')}\s+{_VALUE}\s*g", text, "total fat", rec_id
        ),
        "saturated_fat_g": _number(
            rf"{_phrase('Saturated Fat')}\s+{_VALUE}\s*g", text, "saturated fat", rec_id
        ),
        "trans_fat_g": _number(
            rf"{_phrase('Trans Fat')}\s+{_VALUE}\s*g", text, "trans fat", rec_id
        ),
        "cholesterol_mg": _number(
            rf"{_phrase('Cholesterol')}\s+{_VALUE}\s*mg", text, "cholesterol", rec_id
        ),
        "sodium_mg": _number(
            rf"{_phrase('Sodium')}\s+{_VALUE}\s*mg", text, "sodium", rec_id
        ),
        "carbs_g": _number(
            rf"{_phrase('Total Carbohydrate')}\.?\s+{_VALUE}\s*g",
            text,
            "total carbohydrate",
            rec_id,
        ),
        "fiber_g": _number(
            rf"{_phrase('Dietary Fiber')}\s+{_VALUE}\s*g", text, "dietary fiber", rec_id
        ),
        "sugars_g": _number(
            rf"{_phrase('Total Sugars')}\s+{_VALUE}\s*g", text, "total sugars", rec_id
        ),
        "added_sugars_g": _number(
            rf"Includes\s+{_VALUE}\s*g\s+{_phrase('Added Sugars')}",
            text,
            "added sugars",
            rec_id,
        ),
        "protein_g": _number(
            rf"{_phrase('Protein')}\s+{_VALUE}\s*g", text, "protein", rec_id
        ),
    }

    ingredients_match = re.search(
        r"^INGREDIENTS:\s*(.*?)\s*(?:^ALLERGENS:|\Z)", text, re.DOTALL | re.MULTILINE
    )
    if ingredients_match is None:
        raise LabelParseError(f"{rec_id}: no INGREDIENTS: block on the label")
    ingredients = re.sub(r"\s+", " ", ingredients_match.group(1)).strip()
    if not ingredients:
        raise LabelParseError(f"{rec_id}: INGREDIENTS: block is empty")

    # The value runs to the disclaimer rather than to end-of-line: the site puts a
    # tag break after the colon, so the allergens land on the following line. When
    # an item has none, the disclaimer follows immediately and this is empty.
    allergens_match = re.search(
        rf"^ALLERGENS:\s*(.*?)\s*(?:{_DISCLAIMER}|{_DASH_NOTE}|\Z)",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if allergens_match is None:
        raise LabelParseError(f"{rec_id}: no ALLERGENS: line on the label")
    allergen_line = re.sub(r"\s+", " ", allergens_match.group(1)).strip()
    if len(allergen_line) > _MAX_ALLERGEN_CHARS:
        raise LabelParseError(
            f"{rec_id}: allergen list ran to {len(allergen_line)} characters, so the "
            f"end-of-allergens disclaimer was not found — the page wording changed"
        )
    allergens = [part.strip() for part in allergen_line.split(",") if part.strip()]

    return Item(
        rec_num_and_port=rec_id,
        name=name,
        serving_size=serving_size,
        serving_qty=serving_qty,
        serving_unit=serving_unit,
        servings_per_container=servings_per_container,
        ingredients=ingredients,
        allergens=allergens,
        **values,
    )
