"""Work out what meat an item contains, so the diet ladder can filter on it.

The site has no icon for beef or poultry, so the ladder cannot come from tags
alone. Ingredients usually name the animal outright ("SLICED BEEF (Beef)").

But ingredients alone are not enough either, because UMD sometimes omits the
headline protein entirely: "Escovitch Tilapia" lists oil, vinegar, onions and
peppers, and no fish at all. So three sources are combined — the item name, the
ingredient text, and the site's own pork/fish/shellfish icons — and any of them
finding a meat is enough.

Naive keyword matching gets this wrong in four ways, all of them real here:

  * "Vegan Beef Strip" and "Vegan Breaded Chicken Cutlet" are plant protein.
  * A supplier writes "Free from Crustaceans, Fish, Molluscs" — an allergen
    *absence* statement that reads as its own opposite.
  * "Oyster Crackers" contain no oysters.
  * "Turkey Bacon" is poultry, not pork.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Bump when the rules below change, so every stored classification can be
# rebuilt from the ingredient text without re-scraping anything.
CLASSIFIER_VERSION = 1

MEAT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "beef": (
        "beef", "steak", "veal", "brisket", "oxtail", "pastrami", "corned beef",
        "sirloin", "ribeye", "meatloaf",
    ),
    "pork": (
        "pork", "bacon", "ham", "prosciutto", "pancetta", "chorizo", "salami",
        "pepperoni", "lard", "andouille", "capicola", "guanciale",
    ),
    "poultry": ("chicken", "turkey", "duck", "poultry", "capon"),
    "fish": (
        "fish", "salmon", "tuna", "tilapia", "cod", "anchovy", "anchovies",
        "sardine", "halibut", "mahi", "trout", "pollock", "catfish", "swordfish",
        "haddock", "snapper", "barramundi", "swai", "sole",
    ),
    "shellfish": (
        "shrimp", "crab", "lobster", "clam", "oyster", "scallop", "mussel",
        "crawfish", "crayfish", "prawn", "shellfish", "squid", "calamari",
        "octopus", "crustacean",
    ),
}

# Words that, appearing just before a keyword, mean it is not really that meat.
_NEGATORS = re.compile(
    r"\b(?:vegan|vgn|veggie|vegetarian|plant[\s-]?based|meatless|meat[\s-]?free|"
    r"imitation|mock|substitute|alternative|analogue|free\s+from|free\s+of|"
    r"does\s+not\s+contain|without)\b",
    re.IGNORECASE,
)

# How far back to look for a negator. Long enough for "Vegan Breaded Chicken
# Cutlet" and "Free from Crustaceans, Fish", short enough not to reach back into
# the previous ingredient and negate something unrelated.
_NEGATION_WINDOW = 60

# Phrases that contain a keyword but are not the animal at all.
_NOT_THE_ANIMAL = (
    "oyster cracker",
    "beefsteak tomato",
    "crab apple",
    "crabapple",
    "hamburger bun",
    "chicken of the woods",
    "duck sauce",
    "fish pepper",
    "sole purpose",
)

# "Turkey Bacon" is poultry. Collapse the pair to the bird before the pork
# keywords get a look at it — but keep the bird, so poultry still registers.
_POULTRY_STYLED = re.compile(
    r"\b(turkey|chicken|duck)([\s-]+)(?:bacon|ham|sausage|pepperoni|salami|"
    r"prosciutto|chorizo)\b",
    re.IGNORECASE,
)

# The site's own icons for these three are authoritative: if UMD says an item
# contains fish, it contains fish, whatever its ingredient list leaves out.
_TAG_CATEGORY = {"pork": "pork", "fish": "fish", "shellfish": "shellfish"}

_LEVEL_BY_CATEGORY = {"beef": 4, "pork": 3, "fish": 3, "shellfish": 3, "poultry": 2}

CATEGORIES = ("beef", "pork", "poultry", "fish", "shellfish")


@dataclass
class DietFacts:
    has_beef: bool = False
    has_pork: bool = False
    has_poultry: bool = False
    has_fish: bool = False
    has_shellfish: bool = False
    # Lowest rung of the ladder that permits this item. None means we cannot say,
    # and the app must show that rather than assume anything.
    diet_level: int | None = 1
    conflict: str | None = None

    @property
    def categories(self) -> list[str]:
        return [c for c in CATEGORIES if getattr(self, f"has_{c}")]


def _prepare(text: str) -> str:
    lowered = text.lower()
    for phrase in _NOT_THE_ANIMAL:
        lowered = lowered.replace(phrase, " ")
    # Keep group 1 (the bird), drop the pork-sounding word after it.
    return _POULTRY_STYLED.sub(r"\1", lowered)


def _categories_in(text: str) -> list[str]:
    """Meat categories named in the text, ignoring negated mentions."""
    found = []
    for category, keywords in MEAT_KEYWORDS.items():
        for keyword in keywords:
            hit = False
            for match in re.finditer(rf"\b{re.escape(keyword)}\b", text):
                window = text[max(0, match.start() - _NEGATION_WINDOW) : match.start()]
                if not _NEGATORS.search(window):
                    hit = True
                    break
            if hit:
                found.append(category)
                break
    return found


def classify(name: str, ingredients: str, tags: list[str] | None = None) -> DietFacts:
    """Classify an item from its name, ingredients and tags together."""
    tags = tags or []
    facts = DietFacts()
    has_ingredients = bool((ingredients or "").strip())

    # UMD's own allergen icons outrank everything else: they are an explicit
    # claim about the food, and they are right where the ingredients are silent.
    for tag, category in _TAG_CATEGORY.items():
        if tag in tags:
            setattr(facts, f"has_{category}", True)

    if "vegan" in tags or "vegetarian" in tags:
        # The site asserting vegan/vegetarian outranks a keyword in the name:
        # "Breaded Chicken Cutlet" tagged vegan really is plant protein. Only
        # unnegated meat in the ingredients themselves is enough to dispute it.
        disputed = _categories_in(_prepare(ingredients)) if has_ingredients else []
        if disputed:
            facts.diet_level = None
            facts.conflict = (
                f"tagged {'vegan' if 'vegan' in tags else 'vegetarian'} but "
                f"ingredients name {', '.join(disputed)}"
            )
            return facts
        for category in CATEGORIES:
            setattr(facts, f"has_{category}", False)
        facts.diet_level = 1
        return facts

    if not has_ingredients and not facts.categories:
        # Nothing to go on. Unknown, not vegetarian — an unclassifiable item must
        # never quietly pass a vegetarian filter.
        facts.diet_level = None
        facts.conflict = "no ingredients and no telling tags"
        return facts

    for category in _categories_in(_prepare(f"{name} . {ingredients}")):
        setattr(facts, f"has_{category}", True)

    facts.diet_level = (
        max(_LEVEL_BY_CATEGORY[c] for c in facts.categories) if facts.categories else 1
    )
    return facts


def check_against_tags(facts: DietFacts, tags: list[str]) -> str | None:
    """Compare the classification with the site's pork/fish/shellfish icons.

    Beef and poultry have no icon, so those two run unchecked. This is the only
    free accuracy signal available, and it is worth logging every disagreement.
    """
    disagreements = [
        f"{category}: found={'yes' if getattr(facts, f'has_{category}') else 'no'}, "
        f"icon={'yes' if tag in tags else 'no'}"
        for tag, category in _TAG_CATEGORY.items()
        if getattr(facts, f"has_{category}") != (tag in tags)
    ]
    return "; ".join(disagreements) if disagreements else None
