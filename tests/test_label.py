"""Label parser tests. Fixtures only — these never touch the network."""

from __future__ import annotations

from pathlib import Path

import pytest

from umd_nutrition.label import LabelParseError, parse_label
from umd_nutrition.models import normalize_rec_id

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8", errors="replace")


def test_french_toast_ground_truth() -> None:
    """The hand-verified reference item. Every published number, asserted."""
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")

    assert item.rec_num_and_port == "119370*1"
    assert item.name == "French Toast"
    assert item.servings_per_container == 1
    assert item.serving_size == "1 ea"
    assert item.calories == 251
    assert item.total_fat_g == 10.5
    assert item.saturated_fat_g == 4.1
    assert item.trans_fat_g == 0
    assert item.cholesterol_mg == 248.6
    assert item.sodium_mg == 307.7
    assert item.carbs_g == 26
    assert item.fiber_g == 2
    assert item.sugars_g == 6.8
    assert item.added_sugars_g == 0
    assert item.protein_g == 10.9
    assert item.allergens == ["Dairy", "Eggs", "Gluten", "Soybeans", "Alcohol"]


def test_french_toast_serving_size_is_split() -> None:
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")
    assert item.serving_qty == 1.0
    assert item.serving_unit == "ea"


def test_french_toast_ingredients_captured_without_allergen_line() -> None:
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")
    assert item.ingredients.startswith("Liquid Eggs")
    assert "Vanilla Extract" in item.ingredients
    assert "ALLERGENS" not in item.ingredients


def test_calories_uses_panel_not_micronutrient_list() -> None:
    """The micronutrient list repeats calories as 250.8kcal; the panel says 251."""
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")
    assert item.calories == 251


def test_trans_fat_not_confused_with_trans_fatty_acid() -> None:
    """'Trans Fatty Acid' appears further down and must not be matched."""
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")
    assert item.trans_fat_g == 0


def test_empty_allergens_is_empty_list_not_boilerplate() -> None:
    """Chicken thigh genuinely has no allergens; the disclaimer follows the colon."""
    item = parse_label(load("label_126719_1_chicken_thigh.html"), "126719*1")
    assert item.name == "Grilled Blackened Chicken Thigh"
    assert item.allergens == []
    assert item.calories == 165


def test_ingredients_name_the_meat_for_the_diet_classifier() -> None:
    """The diet ladder depends on this: ingredients state the animal outright."""
    beef = parse_label(load("label_050148_4_hunan_beef.html"), "050148*4")
    chicken = parse_label(load("label_126719_1_chicken_thigh.html"), "126719*1")
    assert "BEEF" in beef.ingredients.upper()
    assert "CHICKEN" in chicken.ingredients.upper()


def test_hunan_beef_parses_with_allergens() -> None:
    item = parse_label(load("label_050148_4_hunan_beef.html"), "050148*4")
    assert item.name == "Hunan Beef"
    assert item.calories == 200
    assert "Soybeans" in item.allergens
    assert "Crustacean Shellfish" in item.allergens


def test_same_recipe_different_portions_are_distinct_items() -> None:
    """Why the full RecNumAndPort is the primary key and not the number alone."""
    small = parse_label(load("label_220093_4_smoothie.html"), "220093*4")
    large = parse_label(load("label_220093_5_smoothie.html"), "220093*5")

    assert small.rec_num == large.rec_num == "220093"
    assert small.rec_num_and_port != large.rec_num_and_port
    assert small.calories != large.calories


def test_url_encoded_id_is_normalized() -> None:
    item = parse_label(load("label_119370_1_french_toast.html"), "119370%2A1")
    assert item.rec_num_and_port == "119370*1"


@pytest.mark.parametrize(
    "fixture,rec_id",
    [
        ("label_119370_1_french_toast.html", "119370*1"),
        ("label_050148_4_hunan_beef.html", "050148*4"),
        ("label_126719_1_chicken_thigh.html", "126719*1"),
        ("label_220093_4_smoothie.html", "220093*4"),
        ("label_220093_5_smoothie.html", "220093*5"),
        ("label_102009_1_caramel_sauce.html", "102009*1"),
    ],
)
def test_every_fixture_parses_completely(fixture: str, rec_id: str) -> None:
    """No field may come back None, and nothing may be silently zeroed."""
    item = parse_label(load(fixture), rec_id)

    assert item.name
    assert item.ingredients
    for macro in (
        "calories",
        "protein_g",
        "total_fat_g",
        "saturated_fat_g",
        "trans_fat_g",
        "cholesterol_mg",
        "sodium_mg",
        "carbs_g",
        "fiber_g",
        "sugars_g",
        "added_sugars_g",
    ):
        assert getattr(item, macro) is not None, f"{macro} is None"
        assert getattr(item, macro) >= 0, f"{macro} is negative"


def test_missing_field_raises_naming_the_field() -> None:
    """A truncated page must fail loudly, not return an Item full of zeros."""
    # Break the word itself: the panel value is split across tags, so there is
    # no contiguous "Protein 10.9g" string in the raw HTML to remove.
    html = load("label_119370_1_french_toast.html").replace("Protein", "Protien")

    with pytest.raises(LabelParseError) as excinfo:
        parse_label(html, "119370*1")

    message = str(excinfo.value)
    assert "protein" in message.lower()
    assert "119370*1" in message


def test_unrelated_page_raises() -> None:
    with pytest.raises(LabelParseError):
        parse_label("<html><body><p>nothing here</p></body></html>", "000000*1")


def test_normalize_rec_id_handles_both_encodings() -> None:
    assert normalize_rec_id("119370%2A1") == "119370*1"
    assert normalize_rec_id("119370*1") == "119370*1"
    assert normalize_rec_id(" 119370%2a1 ") == "119370*1"


def test_unavailable_values_are_none_not_zero() -> None:
    """The site prints "- - -" for nutrients it has no figure for."""
    beets = parse_label(load("label_090249_1_beets_dashes.html"), "090249*1")

    assert beets.name == "Beets"
    assert beets.calories == 14
    assert beets.saturated_fat_g is None
    assert beets.trans_fat_g is None
    # Values it does have are unaffected.
    assert beets.total_fat_g == 0
    assert beets.fiber_g == 0.5
    assert beets.allergens == []


def test_dashes_in_a_different_field() -> None:
    hot_dog = parse_label(load("label_126035_1_hot_dog_dashes.html"), "126035*1")

    assert hot_dog.name == "Grilled Hot Dog"
    assert hot_dog.fiber_g is None
    assert hot_dog.saturated_fat_g == 5.0
    assert hot_dog.calories == 168


def test_dash_note_does_not_leak_into_allergens() -> None:
    """A label with dashes adds a Note: line between allergens and disclaimer."""
    hot_dog = parse_label(load("label_126035_1_hot_dog_dashes.html"), "126035*1")

    assert hot_dog.allergens == []
    assert not any("Nutritional Values" in a for a in hot_dog.allergens)


def test_allergens_word_inside_ingredients_is_not_mistaken_for_the_section() -> None:
    """This item's ingredient text contains a literal "Allergens: Wheat"."""
    item = parse_label(load("label_126318_1_quesadilla_allergens_trap.html"), "126318*1")

    assert item.name == "Mushroom Spinach Quesadilla"
    assert item.allergens == ["Dairy", "Gluten"]
    # The decoy is still in the ingredients where it belongs.
    assert "Allergens: Wheat" in item.ingredients
    assert item.ingredients.startswith("Tomato Basil Wrap")
    assert "ALLERGENS:" not in item.ingredients


def test_missing_nutrient_row_still_raises() -> None:
    """Dashes mean "no figure"; an absent row still means the parser broke."""
    html = load("label_119370_1_french_toast.html").replace("Sodium", "Sodiun")

    with pytest.raises(LabelParseError) as excinfo:
        parse_label(html, "119370*1")

    assert "sodium" in str(excinfo.value).lower()


def test_recipe_with_no_nutrition_data_is_flagged_not_raised() -> None:
    """Some labels carry only a name and "information is not available"."""
    item = parse_label(load("label_096369_2_no_data.html"), "096369*2")

    assert item.name == "Mixed Baby Peppers"
    assert item.nutrition_available is False
    assert item.calories is None
    assert item.protein_g is None
    assert item.ingredients == ""
    assert item.allergens == []


def test_normal_labels_are_marked_available() -> None:
    item = parse_label(load("label_119370_1_french_toast.html"), "119370*1")
    assert item.nutrition_available is True
