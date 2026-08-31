"""Plausibility tests. The bad rows are UMD's data entry, not our parsing."""

from __future__ import annotations

from umd_nutrition.models import Item
from umd_nutrition.quality import implausible_reason, serving_grams


def item(**kwargs) -> Item:
    base = dict(
        rec_num_and_port="000000*1", name="Test", serving_size="4 oz", serving_qty=4.0,
        serving_unit="oz", servings_per_container=1.0, calories=200.0, protein_g=10.0,
        total_fat_g=5.0, saturated_fat_g=1.0, trans_fat_g=0.0, cholesterol_mg=10.0,
        sodium_mg=100.0, carbs_g=20.0, fiber_g=2.0, sugars_g=3.0, added_sugars_g=0.0,
        ingredients="Things", allergens=[],
    )
    base.update(kwargs)
    return Item(**base)


def test_serving_grams_converts_units() -> None:
    assert round(serving_grams("4 oz")) == 113
    assert round(serving_grams("1 lb")) == 454
    assert serving_grams("50 g") == 50
    assert serving_grams("1 slice") is None
    assert serving_grams("1 ea") is None
    assert serving_grams(None) is None


def test_normal_item_is_plausible() -> None:
    assert implausible_reason(item()) is None


def test_macros_heavier_than_the_serving_are_impossible() -> None:
    """Rigatoni Alla Vodka: 889g of macros in a 113g serving."""
    reason = implausible_reason(
        item(name="Rigatoni Alla Vodka", protein_g=127.5, carbs_g=600.0,
             total_fat_g=161.6, calories=3748.0)
    )
    assert reason and "weigh" in reason
    assert "113g" in reason


def test_energy_density_above_pure_fat_is_impossible() -> None:
    """Nothing beats 9 cal/g, so 4 oz cannot be 3,700 calories."""
    reason = implausible_reason(
        item(name="Hot Pepper Oil", serving_size="3 oz", calories=1619.0,
             protein_g=0.6, carbs_g=0.0, total_fat_g=60.0)
    )
    assert reason and "cal/g" in reason


def test_unweighed_serving_uses_the_calorie_ceiling() -> None:
    """"1 slice" has no weight to check, so the ceiling is the only rule."""
    reason = implausible_reason(
        item(name="ROTI", serving_size="1 ea", serving_unit="ea", calories=20160.0,
             protein_g=520.8, carbs_g=3024.0, total_fat_g=621.6)
    )
    assert reason and "20160 calories" in reason


def test_believable_unweighed_item_passes() -> None:
    """A big flatbread slice is allowed to be 800 calories."""
    assert implausible_reason(
        item(serving_size="1 slice", calories=800.0, protein_g=30.0,
             carbs_g=80.0, total_fat_g=35.0)
    ) is None


def test_missing_macros_do_not_trigger_the_mass_check() -> None:
    """A NULL macro means unknown, and unknown is not evidence of anything."""
    assert implausible_reason(item(protein_g=None, calories=200.0)) is None


def test_no_data_items_are_not_flagged() -> None:
    """They have no numbers at all, so there is nothing to disbelieve."""
    assert implausible_reason(
        item(nutrition_available=False, calories=None, protein_g=None,
             carbs_g=None, total_fat_g=None, serving_size=None)
    ) is None
