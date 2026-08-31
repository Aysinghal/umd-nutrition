"""Diet classifier tests. Every case here came from real UMD data."""

from __future__ import annotations

import pytest

from umd_nutrition.diet import classify, check_against_tags

VEG = ["vegetarian"]
VEGAN = ["vegan", "vegetarian"]


def level(name: str, ingredients: str, tags: list[str] | None = None) -> int | None:
    return classify(name, ingredients, tags).diet_level


# --- the ladder itself ------------------------------------------------------

def test_plain_vegetarian_item_is_level_1() -> None:
    assert level("French Toast", "Liquid Eggs, Club White Bread, Milk 2%, Butter") == 1


def test_poultry_is_level_2() -> None:
    facts = classify("Grilled Chicken Thigh", "Chicken Thigh Boneless Skinless, Garlic")
    assert facts.diet_level == 2
    assert facts.has_poultry


def test_pork_is_level_3() -> None:
    assert level("Sausage Patty", "Pork, Water, Salt, Spices") == 3


def test_fish_is_level_3_not_2() -> None:
    """Level 2 is vegetarian plus chicken and turkey only — fish waits for 3."""
    assert level("Baked Salmon", "Salmon Fillet, Olive Oil, Lemon") == 3


def test_shellfish_is_level_3() -> None:
    assert level("Shrimp Scampi", "Shrimp, Butter, Garlic, White Wine") == 3


def test_beef_is_level_4() -> None:
    facts = classify("Hunan Beef", "SLICED BEEF (Beef), Red Onions, Green Peppers")
    assert facts.diet_level == 4
    assert facts.has_beef


def test_item_takes_the_highest_level_it_demands() -> None:
    """Chicken and beef together is beef: the strictest constraint wins."""
    facts = classify("Surf and Turf Bowl", "Beef Strip, Chicken Breast, Rice")
    assert facts.has_beef and facts.has_poultry
    assert facts.diet_level == 4


def test_ladder_filter_is_a_single_comparison() -> None:
    """diet_level <= my_level is the whole filter."""
    items = {
        "Tofu": classify("Tofu", "Soybeans, Water"),
        "Chicken": classify("Roast Chicken", "Chicken Breast"),
        "Pork": classify("Pulled Pork", "Pork Shoulder"),
        "Beef": classify("Beef Chili", "Ground Beef, Beans"),
    }
    eats_poultry = {n for n, f in items.items() if f.diet_level <= 2}
    assert eats_poultry == {"Tofu", "Chicken"}
    no_beef = {n for n, f in items.items() if f.diet_level <= 3}
    assert no_beef == {"Tofu", "Chicken", "Pork"}


# --- strictness -------------------------------------------------------------

def test_broth_counts_as_the_meat() -> None:
    """Strict rule: any mention counts, including stocks and bases."""
    assert level("Vegetable Soup", "Water, Carrots, Chicken Broth, Celery") == 2
    assert level("Brown Gravy", "Water, Beef Base, Flour, Onion") == 4


# --- false positives seen in the real data ----------------------------------

def test_vegan_analogues_are_not_meat() -> None:
    """"Vegan Beef Strip" is plant protein and must stay at level 1."""
    assert level("Vegan Beef Barbacoa", "Vegan Beef Strip (Water, Vital Wheat Gluten)",
                 VEGAN) == 1
    assert level("Vegan Chicken Slider", "Vegan Breaded Chicken Cutlet (Water, Wheat)",
                 VEGAN) == 1


def test_vegan_tag_outranks_a_meat_word_in_the_name() -> None:
    """This item really is called "Breaded Chicken Cutlet" and really is vegan."""
    assert level("Breaded Chicken Cutlet", "Vegan Breaded Chicken Cutlet (Water)",
                 VEGAN) == 1


def test_allergen_absence_statement_is_not_a_meat_mention() -> None:
    """A supplier writing "Free from ... Fish" means the opposite of a match."""
    assert level("Cornbread", "Cornmeal, Eggs, Milk, Wheat Free from Crustaceans, "
                              "Fish, Molluscs, Peanuts", VEG) == 1


def test_oyster_crackers_contain_no_oysters() -> None:
    assert level("Oyster Crackers", "Oyster Crackers (Enriched Flour, Oil, Salt)",
                 VEG) == 1


def test_turkey_bacon_is_poultry_not_pork() -> None:
    facts = classify("Turkey Bacon", "Turkey Bacon (Turkey Thigh, Turkey, Water, Salt)")
    assert facts.has_poultry
    assert not facts.has_pork
    assert facts.diet_level == 2


@pytest.mark.parametrize(
    "name,ingredients",
    [
        ("Beefsteak Tomato Salad", "Beefsteak Tomato, Basil, Olive Oil"),
        ("Hamburger Bun", "Hamburger Bun (Enriched Flour, Water, Yeast)"),
    ],
)
def test_phrases_that_are_not_the_animal(name: str, ingredients: str) -> None:
    assert level(name, ingredients) == 1


# --- where ingredients are not enough ---------------------------------------

def test_site_icon_catches_meat_the_ingredients_omit() -> None:
    """UMD lists no fish for Escovitch Tilapia. The fish icon is the only clue."""
    ingredients = "Olive Blend Shortening, White Vinegar, Spanish Onions, Carrots"
    assert level("Escovitch Tilapia", ingredients, ["fish"]) == 3


def test_name_catches_meat_the_ingredients_omit() -> None:
    """No pork in the ingredient list; the dish is called "& Pork"."""
    assert level("Stir Fry Green Beans & Pork", "Green Beans, Onions, Ginger") == 3


def test_icons_are_trusted_even_with_empty_ingredients() -> None:
    facts = classify("Maryland Crab Soup", "", ["shellfish"])
    assert facts.has_shellfish
    assert facts.diet_level == 3


# --- refusing to guess ------------------------------------------------------

def test_unclassifiable_item_is_unknown_not_vegetarian() -> None:
    """An item with nothing to go on must never pass a vegetarian filter."""
    facts = classify("Mixed Baby Peppers", "", [])

    assert facts.diet_level is None
    assert facts.conflict
    # The filter is `diet_level <= my_level`; NULL fails that in SQL, which is
    # the behaviour we want. In Python it must be checked explicitly.
    assert facts.diet_level is not 1


def test_tag_and_ingredients_conflict_is_surfaced_not_resolved() -> None:
    """Tagged vegetarian but naming real meat: flag it, do not pick a winner."""
    facts = classify("Mystery Stew", "Water, Pork Shoulder, Carrots", VEG)

    assert facts.diet_level is None
    assert "vegetarian" in facts.conflict
    assert "pork" in facts.conflict


# --- the cross-check --------------------------------------------------------

def test_check_against_tags_reports_disagreement() -> None:
    facts = classify("Pulled Pork", "Pork Shoulder, Barbecue Sauce")
    assert check_against_tags(facts, ["pork"]) is None
    assert "pork" in check_against_tags(facts, [])


def test_check_against_tags_ignores_beef_and_poultry() -> None:
    """Neither has an icon, so neither can be cross-checked."""
    facts = classify("Beef Chili", "Ground Beef, Beans")
    assert check_against_tags(facts, []) is None
