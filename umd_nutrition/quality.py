"""Catch nutrition rows that cannot be true.

About 1% of UMD's labels hold whole-batch recipe totals against a single-serving
label. ROTI is published as 20,160 calories and 520 g protein for "1 ea", with
"1 servings per container". The page really does say that — it is their data
entry, not a parsing fault.

Left alone these sit permanently at the top of any protein ranking, so they are
flagged. Flagged, not deleted: the item is genuinely on the menu, and the stored
row is the evidence for what the site claimed.

Two of the three rules are physical limits rather than guesses:

  * Macronutrients cannot weigh more than the serving containing them.
  * Nothing exceeds 9 cal/g, the energy density of pure fat.

The third — a calorie ceiling for servings with no weight ("1 slice") — is a
judgement call, because there is nothing to measure against.
"""

from __future__ import annotations

import re

from .models import Item

OZ_TO_GRAMS = 28.3495
LB_TO_GRAMS = 453.592

# Pure fat is 9 cal/g. A little headroom for rounding on tiny servings.
MAX_CALORIES_PER_GRAM = 9.5

# Macros may exceed the serving weight slightly through rounding, not by 10%.
MASS_TOLERANCE = 1.1

# For "1 slice" / "1 ea" there is no weight to check against. No dining hall
# portion of anything is 1,500 calories; the flagged ones are 2,000-20,000.
MAX_CALORIES_UNWEIGHED = 1500

_SERVING_RE = re.compile(r"([\d.]+)\s*(oz|ounce|g|gram|lb|pound)s?\b", re.IGNORECASE)


def serving_grams(serving_size: str | None) -> float | None:
    """Serving weight in grams, or None if the serving is not given by weight."""
    if not serving_size:
        return None
    match = _SERVING_RE.match(serving_size.strip())
    if match is None:
        return None
    quantity, unit = float(match.group(1)), match.group(2).lower()
    if unit.startswith("o"):
        return quantity * OZ_TO_GRAMS
    if unit.startswith("l") or unit.startswith("p"):
        return quantity * LB_TO_GRAMS
    return quantity


def implausible_reason(item: Item) -> str | None:
    """Why this item's numbers cannot be true, or None if they are believable."""
    if not item.nutrition_available:
        return None

    grams = serving_grams(item.serving_size)
    macros = (item.protein_g, item.carbs_g, item.total_fat_g)

    if grams and grams > 0:
        if all(m is not None for m in macros):
            total = sum(m for m in macros if m is not None)
            if total > grams * MASS_TOLERANCE:
                return (
                    f"macros weigh {total:.0f}g in a {grams:.0f}g "
                    f"({item.serving_size}) serving"
                )
        if item.calories and item.calories / grams > MAX_CALORIES_PER_GRAM:
            return (
                f"{item.calories / grams:.0f} cal/g, above the {MAX_CALORIES_PER_GRAM} "
                f"cal/g of pure fat"
            )
    elif item.calories and item.calories > MAX_CALORIES_UNWEIGHED:
        return (
            f"{item.calories:.0f} calories for one {item.serving_size or 'serving'}"
        )

    return None
