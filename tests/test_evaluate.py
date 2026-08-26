"""Tests for src/hotelfinder/evaluate.py."""

from __future__ import annotations

import pytest

from hotelfinder.evaluate import (
    CONCERN_PENALTY_CAP,
    DEFAULT_REVIEW_SCORE,
    MODERATE_CONCERN_KEYWORDS,
    MODERATE_CONCERN_PENALTY,
    PRICE_WEIGHT,
    SEVERE_CONCERN_KEYWORDS,
    SEVERE_CONCERN_PENALTY,
    THIN_REVIEW_COUNT,
    THIN_REVIEW_PENALTY,
    UNKNOWN_REVIEW_PENALTY,
    concern_penalty,
    evaluate,
    explain_best_value,
    explain_cheapest,
    is_legitimate,
    pick_best_value,
    pick_cheapest,
    quality_points,
    value_score,
)
from hotelfinder.models import SearchInput, Stay

QUERY = SearchInput(check_in="2026-09-01", check_out="2026-09-03", zip_code="90210", nights=2)


def make_stay(
    name: str = "Test Hotel",
    total_cents: int = 10_000,
    review_score: float | None = 8.0,
    review_count: int | None = 100,
    concerns: list[str] | None = None,
    price_confidence: str = "high",
    fees_note: str = "",
) -> Stay:
    return Stay(
        name=name,
        total_cents=total_cents,
        nightly_cents=total_cents,
        review_score=review_score,
        review_count=review_count,
        concerns=concerns or [],
        price_confidence=price_confidence,
        fees_note=fees_note,
    )


# ---------------------------------------------------------------------------
# concern_penalty
# ---------------------------------------------------------------------------


def test_concern_penalty_no_concerns_is_zero():
    stay = make_stay(concerns=[])
    assert concern_penalty(stay) == 0.0


def test_concern_penalty_severe_hit():
    stay = make_stay(concerns=["Guests reported bed bugs in the mattress."])
    assert concern_penalty(stay) == pytest.approx(SEVERE_CONCERN_PENALTY)


def test_concern_penalty_moderate_hit():
    stay = make_stay(concerns=["Room was a bit dirty on arrival."])
    assert concern_penalty(stay) == pytest.approx(MODERATE_CONCERN_PENALTY)


def test_concern_penalty_severe_takes_precedence_over_moderate_in_same_string():
    # Contains both a severe keyword ("roach") and a moderate one ("dirty"):
    # a single string must only ever count once, as the severe hit.
    stay = make_stay(concerns=["Dirty room, also saw a roach."])
    assert concern_penalty(stay) == pytest.approx(SEVERE_CONCERN_PENALTY)


def test_concern_penalty_multiple_strings_sum():
    stay = make_stay(concerns=["mold in the bathroom", "noisy hallway at night"])
    expected = SEVERE_CONCERN_PENALTY + MODERATE_CONCERN_PENALTY
    assert concern_penalty(stay) == pytest.approx(expected)


def test_concern_penalty_is_capped():
    stay = make_stay(
        concerns=[
            "bed bugs",
            "cockroach infestation",
            "black mold everywhere",
            "unsafe neighborhood",
            "feces on the carpet",
        ]
    )
    # 5 severe hits would be -7.5 uncapped; must clamp to the cap.
    assert concern_penalty(stay) == pytest.approx(CONCERN_PENALTY_CAP)
    assert concern_penalty(stay) >= CONCERN_PENALTY_CAP


def test_concern_penalty_is_never_positive():
    stay = make_stay(concerns=["lovely staff, very clean"])
    assert concern_penalty(stay) <= 0.0


def test_severe_and_moderate_keyword_sets_are_disjoint_and_lowercase():
    assert SEVERE_CONCERN_KEYWORDS.isdisjoint(MODERATE_CONCERN_KEYWORDS)
    for kw in SEVERE_CONCERN_KEYWORDS | MODERATE_CONCERN_KEYWORDS:
        assert kw == kw.lower()


# ---------------------------------------------------------------------------
# quality_points
# ---------------------------------------------------------------------------


def test_quality_points_uses_known_review_score():
    stay = make_stay(review_score=7.5, review_count=100, concerns=[])
    assert quality_points(stay) == pytest.approx(7.5)


def test_quality_points_unknown_review_score_uses_default_minus_penalty():
    stay = make_stay(review_score=None, review_count=None, concerns=[])
    expected = DEFAULT_REVIEW_SCORE + UNKNOWN_REVIEW_PENALTY
    assert quality_points(stay) == pytest.approx(expected)


def test_quality_points_thin_review_count_penalized():
    stay = make_stay(review_score=7.0, review_count=THIN_REVIEW_COUNT - 1, concerns=[])
    assert quality_points(stay) == pytest.approx(7.0 + THIN_REVIEW_PENALTY)


def test_quality_points_review_count_at_threshold_not_penalized():
    stay = make_stay(review_score=7.0, review_count=THIN_REVIEW_COUNT, concerns=[])
    assert quality_points(stay) == pytest.approx(7.0)


def test_quality_points_combines_concerns_and_thin_reviews():
    stay = make_stay(review_score=7.0, review_count=3, concerns=["dirty carpets"])
    expected = 7.0 + THIN_REVIEW_PENALTY + MODERATE_CONCERN_PENALTY
    assert quality_points(stay) == pytest.approx(expected)


def test_quality_points_clamped_to_zero_floor():
    stay = make_stay(
        review_score=1.0,
        review_count=2,
        concerns=["bed bugs", "roaches", "mold", "feces", "unsafe"],
    )
    assert quality_points(stay) == 0.0


def test_quality_points_never_exceeds_ten():
    stay = make_stay(review_score=10.0, review_count=1000, concerns=[])
    assert quality_points(stay) == pytest.approx(10.0)


# ---------------------------------------------------------------------------
# is_legitimate
# ---------------------------------------------------------------------------


def test_is_legitimate_true_for_normal_stay():
    assert is_legitimate(make_stay()) is True


def test_is_legitimate_rejects_zero_price():
    stay = make_stay(total_cents=0)
    assert is_legitimate(stay) is False


def test_is_legitimate_rejects_negative_price():
    stay = make_stay(total_cents=-500)
    assert is_legitimate(stay) is False


def test_is_legitimate_rejects_blank_name():
    stay = make_stay(name="   ")
    assert is_legitimate(stay) is False


def test_is_legitimate_rejects_low_confidence_price():
    stay = make_stay(price_confidence="low")
    assert is_legitimate(stay) is False


def test_is_legitimate_accepts_medium_and_high_confidence():
    assert is_legitimate(make_stay(price_confidence="medium")) is True
    assert is_legitimate(make_stay(price_confidence="high")) is True


# ---------------------------------------------------------------------------
# pick_cheapest
# ---------------------------------------------------------------------------


def test_pick_cheapest_returns_awful_but_cheapest_stay():
    awful = make_stay(
        name="Awful Cheap Motel",
        total_cents=4_000,
        review_score=2.0,
        review_count=200,
        concerns=["bed bugs", "roaches", "unsafe area at night"],
    )
    nice = make_stay(name="Nice Pricier Hotel", total_cents=9_000, review_score=9.0, review_count=500)
    result = pick_cheapest([awful, nice])
    assert result is not None
    assert result.name == "Awful Cheap Motel"


def test_pick_cheapest_ignores_illegitimate_lower_price():
    fake = make_stay(name="Fake Zero Price", total_cents=0)
    real = make_stay(name="Real Stay", total_cents=5_000)
    assert pick_cheapest([fake, real]).name == "Real Stay"


def test_pick_cheapest_ignores_low_confidence_price():
    unverified = make_stay(name="Unverified", total_cents=1_000, price_confidence="low")
    real = make_stay(name="Verified", total_cents=5_000, price_confidence="high")
    assert pick_cheapest([unverified, real]).name == "Verified"


def test_pick_cheapest_empty_list_returns_none():
    assert pick_cheapest([]) is None


def test_pick_cheapest_all_illegitimate_returns_none():
    stays = [make_stay(total_cents=0), make_stay(name=""), make_stay(price_confidence="low")]
    assert pick_cheapest(stays) is None


def test_pick_cheapest_tie_break_is_deterministic_by_name():
    a = make_stay(name="Zebra Inn", total_cents=5_000)
    b = make_stay(name="Alpha Inn", total_cents=5_000)
    assert pick_cheapest([a, b]).name == "Alpha Inn"
    assert pick_cheapest([b, a]).name == "Alpha Inn"


# ---------------------------------------------------------------------------
# value_score / pick_best_value
# ---------------------------------------------------------------------------


def test_value_score_equal_price_is_just_quality():
    stay = make_stay(total_cents=5_000, review_score=7.0, review_count=100, concerns=[])
    assert value_score(stay, cheapest_total_cents=5_000) == pytest.approx(7.0)


def test_value_score_pricier_stay_is_penalized_proportionally():
    stay = make_stay(total_cents=6_000, review_score=8.0, review_count=100, concerns=[])
    # 20% pricier than a 5000-cent baseline.
    expected = 8.0 - PRICE_WEIGHT * 0.2
    assert value_score(stay, cheapest_total_cents=5_000) == pytest.approx(expected)


def test_value_score_guards_against_non_positive_baseline():
    stay = make_stay(total_cents=6_000, review_score=8.0, review_count=100, concerns=[])
    assert value_score(stay, cheapest_total_cents=0) == pytest.approx(quality_points(stay))


def test_value_score_never_negative_ratio_for_cheaper_than_baseline():
    stay = make_stay(total_cents=4_000, review_score=8.0, review_count=100, concerns=[])
    # stay is cheaper than the "baseline" -- ratio must clamp to 0, not go negative.
    assert value_score(stay, cheapest_total_cents=5_000) == pytest.approx(8.0)


def test_flagship_cheap_bedbugs_vs_pricier_good_stay():
    """The core product rule: cheapest != best value."""
    cheap_bad = make_stay(
        name="Bargain Bunk",
        total_cents=5_200,  # $52.00
        review_score=5.2,
        review_count=80,
        concerns=["Multiple guests reported bed bugs."],
    )
    pricier_good = make_stay(
        name="Solid Choice Inn",
        total_cents=6_100,  # $61.00
        review_score=8.4,
        review_count=300,
        concerns=[],
    )
    stays = [cheap_bad, pricier_good]

    cheapest = pick_cheapest(stays)
    assert cheapest is not None
    assert cheapest.name == "Bargain Bunk"

    best_value = pick_best_value(stays, cheapest)
    assert best_value is not None
    assert best_value.name == "Solid Choice Inn"

    # Hand-computed expected scores.
    cheap_quality = 5.2 + SEVERE_CONCERN_PENALTY  # 5.2 - 1.5 = 3.7
    assert quality_points(cheap_bad) == pytest.approx(cheap_quality)
    assert quality_points(pricier_good) == pytest.approx(8.4)

    cheap_value = value_score(cheap_bad, cheapest_total_cents=5_200)
    good_value = value_score(pricier_good, cheapest_total_cents=5_200)
    assert cheap_value == pytest.approx(3.7)
    # extra_cost_ratio = 900/5200; value = 8.4 - 12.0 * (900/5200)
    assert good_value == pytest.approx(8.4 - 12.0 * (900 / 5200))
    assert good_value > cheap_value

    result = evaluate(stays, QUERY)
    assert result.cheapest.stay.name == "Bargain Bunk"
    assert result.best_value.stay.name == "Solid Choice Inn"
    assert "9.00" in result.best_value.why or "$9.00" in result.best_value.why
    assert "17%" in result.best_value.why
    assert "8.4/10" in result.best_value.why
    assert "5.2/10" in result.best_value.why


def test_cheapest_is_also_best_value_when_it_is_well_reviewed():
    cheap_and_good = make_stay(
        name="Great Deal Inn",
        total_cents=5_000,
        review_score=9.0,
        review_count=400,
        concerns=[],
    )
    pricier_not_worth_it = make_stay(
        name="Marginally Better Hotel",
        total_cents=7_000,  # 40% pricier
        review_score=9.3,
        review_count=400,
        concerns=[],
    )
    stays = [cheap_and_good, pricier_not_worth_it]

    cheapest = pick_cheapest(stays)
    assert cheapest.name == "Great Deal Inn"

    best_value = pick_best_value(stays, cheapest)
    assert best_value.name == "Great Deal Inn"
    assert best_value == cheapest

    result = evaluate(stays, QUERY)
    assert result.cheapest.stay.name == "Great Deal Inn"
    assert result.best_value.stay.name == "Great Deal Inn"
    assert any("also the best" in note.lower() for note in result.notes)
    assert "best overall value" in result.best_value.why.lower()


def test_pick_best_value_empty_list_returns_none():
    assert pick_best_value([]) is None


def test_pick_best_value_all_illegitimate_returns_none():
    stays = [make_stay(total_cents=0), make_stay(price_confidence="low")]
    assert pick_best_value(stays) is None


def test_pick_best_value_computes_cheapest_when_not_provided():
    a = make_stay(name="A", total_cents=5_000, review_score=6.0, review_count=100)
    b = make_stay(name="B", total_cents=5_500, review_score=9.5, review_count=100)
    assert pick_best_value([a, b]) == pick_best_value([a, b], pick_cheapest([a, b]))


def test_pick_best_value_tie_break_is_deterministic():
    # Identical everything except name -> identical value_score -> tie-break by name.
    a = make_stay(name="Zebra Suites", total_cents=5_000, review_score=8.0, review_count=100)
    b = make_stay(name="Alpha Suites", total_cents=5_000, review_score=8.0, review_count=100)
    assert pick_best_value([a, b]).name == "Alpha Suites"
    assert pick_best_value([b, a]).name == "Alpha Suites"


# ---------------------------------------------------------------------------
# explanations
# ---------------------------------------------------------------------------


def test_explain_cheapest_mentions_price_and_concerns():
    stay = make_stay(
        name="Bargain Bunk",
        total_cents=5_200,
        review_score=5.2,
        review_count=80,
        concerns=["Multiple guests reported bed bugs."],
    )
    text = explain_cheapest(stay)
    assert "$52.00" in text
    assert "Bargain Bunk" in text
    assert "bed bugs" in text.lower()


def test_explain_cheapest_flags_unknown_reviews():
    stay = make_stay(name="Mystery Motel", total_cents=3_000, review_score=None, review_count=None, concerns=[])
    text = explain_cheapest(stay)
    assert "no review score" in text.lower()


def test_explain_cheapest_flags_thin_reviews_and_fees():
    stay = make_stay(
        name="New Spot",
        total_cents=3_000,
        review_score=8.0,
        review_count=3,
        concerns=[],
        fees_note="+$25/night resort fee at property",
    )
    text = explain_cheapest(stay)
    assert "3 review" in text
    assert "resort fee" in text


def test_explain_cheapest_no_downsides_case():
    stay = make_stay(name="Clean Sweep", total_cents=5_000, review_score=9.5, review_count=500, concerns=[])
    text = explain_cheapest(stay)
    assert "no notable downsides" in text.lower()


def test_explain_best_value_when_it_is_the_cheapest():
    stay = make_stay(name="Great Deal Inn", total_cents=5_000, review_score=9.0, review_count=400)
    text = explain_best_value(stay, stay)
    assert "cheapest" in text.lower()
    assert "best overall value" in text.lower()


def test_explain_best_value_reports_dollar_and_percent_difference():
    cheapest = make_stay(name="Bargain Bunk", total_cents=5_200, review_score=5.2, review_count=80)
    best = make_stay(name="Solid Choice Inn", total_cents=6_100, review_score=8.4, review_count=300)
    text = explain_best_value(best, cheapest)
    assert "$9.00" in text
    assert "17%" in text
    assert "8.4/10" in text
    assert "5.2/10" in text


# ---------------------------------------------------------------------------
# evaluate
# ---------------------------------------------------------------------------


def test_evaluate_empty_stays_returns_no_picks_safely():
    result = evaluate([], QUERY)
    assert result.cheapest is None
    assert result.best_value is None
    assert result.all_stays == []
    assert any("0 candidate" in note for note in result.notes)


def test_evaluate_all_illegitimate_returns_no_picks_safely():
    stays = [make_stay(total_cents=0), make_stay(name="  "), make_stay(price_confidence="low")]
    result = evaluate(stays, QUERY)
    assert result.cheapest is None
    assert result.best_value is None
    assert any("no legitimate stays" in note.lower() for note in result.notes)


def test_evaluate_notes_report_considered_and_dropped_counts():
    stays = [
        make_stay(name="Good", total_cents=5_000),
        make_stay(name="Bad Price", total_cents=0),
        make_stay(name="Low Confidence", total_cents=1_000, price_confidence="low"),
    ]
    result = evaluate(stays, QUERY)
    assert any("3 candidate" in note for note in result.notes)
    assert any("dropped 2" in note.lower() for note in result.notes)


def test_evaluate_all_stays_sorted_by_price_ascending():
    stays = [
        make_stay(name="Pricey", total_cents=9_000),
        make_stay(name="Cheapo", total_cents=3_000),
        make_stay(name="Mid", total_cents=6_000),
    ]
    result = evaluate(stays, QUERY)
    prices = [s.total_cents for s in result.all_stays]
    assert prices == sorted(prices)
    assert [s.name for s in result.all_stays] == ["Cheapo", "Mid", "Pricey"]


def test_evaluate_result_query_is_preserved():
    result = evaluate([make_stay()], QUERY)
    assert result.query == QUERY
