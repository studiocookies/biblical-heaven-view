"""Tests for the deterministic cost engine (cost_engine.py + points.py)."""

from __future__ import annotations

import pytest

from hotel_agent.cost_engine import best_card_cost, compute_effective_cost, earn_vs_burn
from hotel_agent.models import (
    CardPerk,
    Channel,
    DataSource,
    FeeKind,
    FeeLine,
    Hotel,
    IncludedBenefit,
    LoyaltyAccount,
    LoyaltyProgramId,
    NormalizedOffer,
    PaymentCard,
    PayableWhen,
    PointValuation,
    UserProfile,
)
from hotel_agent.points import (
    DEFAULT_VALUATIONS,
    get_earn_per_usd_x100,
    get_valuation_cpp_x100,
)


def make_offer(**kwargs) -> NormalizedOffer:
    defaults = dict(
        offer_id="offer-1",
        provider="fixtures",
        data_source=DataSource.FIXTURE,
        channel=Channel.DIRECT,
        booking_site="",
        hotel=Hotel(name="Test Hotel", program=LoyaltyProgramId.NONE),
        currency="USD",
        base_cents=10000,
        fees=[],
    )
    defaults.update(kwargs)
    return NormalizedOffer(**defaults)


def make_card(**kwargs) -> PaymentCard:
    defaults = dict(card_id="card", display_name="Test Card", reward_value_cpp_x100=100, perks=[])
    defaults.update(kwargs)
    return PaymentCard(**defaults)


def find_line(cost, label_substr):
    for line in cost.lines:
        if label_substr in line.label:
            return line
    return None


def assert_no_line(cost, label_substr):
    assert find_line(cost, label_substr) is None, f"unexpected line matching {label_substr!r}"


# ---------------------------------------------------------------------------
# Valuation override precedence
# ---------------------------------------------------------------------------

def test_valuation_override_wins_over_default():
    profile = UserProfile(
        valuation_overrides=[
            PointValuation(program=LoyaltyProgramId.MARRIOTT_BONVOY, value_cpp_x100=120)
        ]
    )
    assert get_valuation_cpp_x100(LoyaltyProgramId.MARRIOTT_BONVOY, profile) == 120


def test_valuation_falls_back_to_default_when_no_override():
    profile = UserProfile()
    assert get_valuation_cpp_x100(LoyaltyProgramId.HILTON_HONORS, profile) == (
        DEFAULT_VALUATIONS[LoyaltyProgramId.HILTON_HONORS].value_cpp_x100
    )
    assert get_valuation_cpp_x100(LoyaltyProgramId.HILTON_HONORS, profile) == 50


def test_valuation_none_program_always_zero_even_with_override():
    profile = UserProfile(
        valuation_overrides=[PointValuation(program=LoyaltyProgramId.NONE, value_cpp_x100=999)]
    )
    assert get_valuation_cpp_x100(LoyaltyProgramId.NONE, profile) == 0


def test_earn_per_usd_unknown_tier_falls_back_to_base_rate():
    assert get_earn_per_usd_x100(LoyaltyProgramId.MARRIOTT_BONVOY, "") == 1000
    assert get_earn_per_usd_x100(LoyaltyProgramId.MARRIOTT_BONVOY, "nonexistent-tier") == 1000


def test_earn_per_usd_applies_elite_bonus_case_insensitive():
    # Marriott Platinum: base 1000 x (100+50)/100 = 1500
    assert get_earn_per_usd_x100(LoyaltyProgramId.MARRIOTT_BONVOY, "Platinum") == 1500
    assert get_earn_per_usd_x100(LoyaltyProgramId.MARRIOTT_BONVOY, "PLATINUM") == 1500


# ---------------------------------------------------------------------------
# Card earn-multiplier channel / portal gating
# ---------------------------------------------------------------------------

def test_earn_multiplier_applies_when_channel_and_portal_match():
    card = make_card(
        reward_value_cpp_x100=100,
        perks=[
            CardPerk(
                name="3x Hyatt direct",
                kind="earn_multiplier",
                earn_multiplier_x100=300,
                applies_channel=Channel.DIRECT,
                applies_portal="hyatt.com",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(channel=Channel.DIRECT, booking_site="hyatt.com", base_cents=10000)
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Card rewards earned")
    # 10000 cash * 300 mult_x100 * 100 reward_value_cpp_x100 // 1_000_000 = 300
    assert line.amount_cents == -300


def test_earn_multiplier_does_not_apply_on_wrong_channel():
    card = make_card(
        reward_value_cpp_x100=100,
        perks=[
            CardPerk(
                name="3x Hyatt direct",
                kind="earn_multiplier",
                earn_multiplier_x100=300,
                applies_channel=Channel.DIRECT,
                applies_portal="hyatt.com",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(channel=Channel.OTA, booking_site="hyatt.com", base_cents=10000)
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Card rewards earned")
    # falls back to base 1x: 10000 * 100 * 100 // 1_000_000 = 100
    assert line.amount_cents == -100


def test_earn_multiplier_does_not_apply_on_wrong_portal():
    card = make_card(
        reward_value_cpp_x100=100,
        perks=[
            CardPerk(
                name="3x Hyatt direct",
                kind="earn_multiplier",
                earn_multiplier_x100=300,
                applies_channel=Channel.DIRECT,
                applies_portal="hyatt.com",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(channel=Channel.DIRECT, booking_site="marriott.com", base_cents=10000)
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Card rewards earned")
    assert line.amount_cents == -100


def test_earn_multiplier_none_channel_matches_any_channel():
    card = make_card(
        reward_value_cpp_x100=100,
        perks=[
            CardPerk(
                name="2x everywhere",
                kind="earn_multiplier",
                earn_multiplier_x100=200,
                applies_channel=None,
                applies_portal="",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(channel=Channel.OTA, booking_site="expedia.com", base_cents=10000)
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Card rewards earned")
    # 10000 * 200 * 100 // 1_000_000 = 200
    assert line.amount_cents == -200


# ---------------------------------------------------------------------------
# Statement credit capping
# ---------------------------------------------------------------------------

def test_statement_credit_caps_at_cash_owed():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[CardPerk(name="$100 hotel credit", kind="statement_credit", value_cents=10000)],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=5000, fees=[])  # total cash = 5000
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Statement credit")
    assert line.amount_cents == -5000  # capped, not -10000


def test_statement_credits_stack_and_cap_cumulatively():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[
            CardPerk(name="Credit A", kind="statement_credit", value_cents=3000),
            CardPerk(name="Credit B", kind="statement_credit", value_cents=3000),
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=5000, fees=[])  # total cash = 5000
    cost = compute_effective_cost(offer, card, profile)
    line_a = find_line(cost, "Credit A")
    line_b = find_line(cost, "Credit B")
    assert line_a.amount_cents == -3000
    assert line_b.amount_cents == -2000  # only 2000 remaining after credit A
    total_statement_credit = line_a.amount_cents + line_b.amount_cents
    assert total_statement_credit == -5000  # never exceeds cash owed


def test_statement_credit_respects_portal_gating():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[
            CardPerk(
                name="Chase Travel credit",
                kind="statement_credit",
                value_cents=5000,
                applies_portal="chase_travel",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=5000, booking_site="expedia.com")
    cost = compute_effective_cost(offer, card, profile)
    assert_no_line(cost, "Statement credit")


# ---------------------------------------------------------------------------
# Portal cashback
# ---------------------------------------------------------------------------

def test_portal_cashback_percentage():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[
            CardPerk(
                name="5% Chase Travel",
                kind="portal_cashback",
                earn_multiplier_x100=500,  # 5%
                applies_portal="chase_travel",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=10000, booking_site="chase_travel")
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Portal cashback")
    # 10000 * 500 // 10000 = 500
    assert line.amount_cents == -500


def test_portal_cashback_flat_value_when_no_multiplier():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[
            CardPerk(
                name="Flat $20 portal credit",
                kind="portal_cashback",
                value_cents=2000,
                applies_portal="chase_travel",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=10000, booking_site="chase_travel")
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Portal cashback")
    assert line.amount_cents == -2000


def test_portal_cashback_does_not_apply_on_wrong_portal():
    card = make_card(
        reward_value_cpp_x100=0,
        perks=[
            CardPerk(
                name="5% Chase Travel",
                kind="portal_cashback",
                earn_multiplier_x100=500,
                applies_portal="chase_travel",
            )
        ],
    )
    profile = UserProfile(cards=[card])
    offer = make_offer(base_cents=10000, booking_site="expedia.com")
    cost = compute_effective_cost(offer, card, profile)
    assert_no_line(cost, "Portal cashback")


# ---------------------------------------------------------------------------
# Hotel points earned: gating + math
# ---------------------------------------------------------------------------

def test_hotel_points_not_earned_on_ota_no_loyalty():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile()
    offer = make_offer(
        earns_loyalty=False,
        base_cents=20000,
        hotel=Hotel(name="H", program=LoyaltyProgramId.MARRIOTT_BONVOY),
    )
    cost = compute_effective_cost(offer, card, profile)
    assert_no_line(cost, "Hotel points earned")
    assert cost.points_earned_value_cents == 0


def test_hotel_points_not_earned_on_award_offer():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile()
    offer = make_offer(
        earns_loyalty=True,
        base_cents=0,
        points_cost=15000,
        hotel=Hotel(name="H", program=LoyaltyProgramId.MARRIOTT_BONVOY),
    )
    cost = compute_effective_cost(offer, card, profile)
    assert_no_line(cost, "Hotel points earned")


def test_hotel_points_not_earned_when_program_none():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile()
    offer = make_offer(
        earns_loyalty=True,
        base_cents=20000,
        hotel=Hotel(name="Independent Inn", program=LoyaltyProgramId.NONE),
    )
    cost = compute_effective_cost(offer, card, profile)
    assert_no_line(cost, "Hotel points earned")


def test_hotel_points_earned_math_with_tier_bonus():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile(
        loyalty=[
            LoyaltyAccount(
                program=LoyaltyProgramId.MARRIOTT_BONVOY, tier="Platinum", points_balance=0
            )
        ]
    )
    offer = make_offer(
        earns_loyalty=True,
        base_cents=40000,  # $400 eligible room rate
        fees=[FeeLine(kind=FeeKind.TAX, description="tax", amount_cents=5000)],
        hotel=Hotel(name="Marriott Test", program=LoyaltyProgramId.MARRIOTT_BONVOY),
    )
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Hotel points earned")
    # earn_per_usd_x100 platinum = 1000 * 150/100 = 1500
    # pts = 40000 * 1500 // 10000 = 6000 pts (taxes excluded from eligible spend)
    # value = 6000 * 80 (default Marriott cpp_x100) // 100 = 4800 cents
    assert "6000 pts" in line.label
    assert line.amount_cents == -4800
    assert cost.points_earned_value_cents == 4800


# ---------------------------------------------------------------------------
# Award opportunity cost
# ---------------------------------------------------------------------------

def test_award_offer_opportunity_cost_line():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile()
    offer = make_offer(
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        award_cash_cents=5000,
        hotel=Hotel(name="Hyatt Test", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    cost = compute_effective_cost(offer, card, profile)
    opp_line = find_line(cost, "Points opportunity cost")
    # 20000 pts * 170 cpp_x100 (default Hyatt) // 100 = 34000 cents
    assert opp_line.amount_cents == 34000
    cash_line = find_line(cost, "Cash total")
    assert cash_line.amount_cents == 5000
    assert cost.points_spent == 20000
    assert cost.effective_cents == 5000 + 34000
    assert cost.redemption_cpp_x100 is None  # left to earn_vs_burn


# ---------------------------------------------------------------------------
# Included benefits
# ---------------------------------------------------------------------------

def test_included_benefit_reduces_effective_cost():
    card = make_card(reward_value_cpp_x100=0)
    profile = UserProfile()
    offer = make_offer(
        base_cents=10000,
        included_benefits=[IncludedBenefit(name="Breakfast for 2", est_value_cents=2500)],
    )
    cost = compute_effective_cost(offer, card, profile)
    line = find_line(cost, "Included benefit: Breakfast for 2")
    assert line.amount_cents == -2500
    assert cost.effective_cents == 10000 - 2500


# ---------------------------------------------------------------------------
# best_card_cost
# ---------------------------------------------------------------------------

def test_best_card_cost_picks_higher_value_card():
    card_a = make_card(card_id="card_a", reward_value_cpp_x100=100)
    card_b = make_card(card_id="card_b", reward_value_cpp_x100=200)
    profile = UserProfile(cards=[card_a, card_b])
    offer = make_offer(base_cents=10000, fees=[])
    result = best_card_cost(offer, profile)
    # card_a: 10000 - (10000*100*100//1_000_000)=10000-100=9900
    # card_b: 10000 - (10000*100*200//1_000_000)=10000-200=9800
    assert result.card_id == "card_b"
    assert result.effective_cents == 9800


def test_best_card_cost_falls_back_to_cash_when_no_cards():
    profile = UserProfile(cards=[])
    offer = make_offer(base_cents=10000, fees=[])
    result = best_card_cost(offer, profile)
    assert result.card_id == "cash"
    assert result.effective_cents == 10000


def test_best_card_cost_tie_break_deterministic_by_card_id():
    card_z = make_card(card_id="zzz", reward_value_cpp_x100=0)
    card_a = make_card(card_id="aaa", reward_value_cpp_x100=0)
    profile = UserProfile(cards=[card_z, card_a])
    offer = make_offer(base_cents=10000, fees=[])
    result = best_card_cost(offer, profile)
    assert result.card_id == "aaa"


# ---------------------------------------------------------------------------
# earn_vs_burn
# ---------------------------------------------------------------------------

def test_earn_vs_burn_good_redemption_uses_points():
    cash_offer = make_offer(
        offer_id="cash-1",
        channel=Channel.DIRECT,
        base_cents=40000,
        fees=[FeeLine(kind=FeeKind.TAX, description="tax", amount_cents=5000)],
        hotel=Hotel(name="Hyatt Test", program=LoyaltyProgramId.WORLD_OF_HYATT),
        earns_loyalty=True,
    )
    award_offer = make_offer(
        offer_id="award-1",
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        award_cash_cents=5000,
        hotel=Hotel(name="Hyatt Test", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    profile = UserProfile(
        loyalty=[
            LoyaltyAccount(
                program=LoyaltyProgramId.WORLD_OF_HYATT, tier="", points_balance=30000
            )
        ]
    )
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    # cash total = 45000, award total = 5000 -> cents_saved = 40000
    # forgone: base_cents=40000 * earn_rate(500 base, no tier bonus) // 10000 = 2000 pts
    #          value = 2000 * 170 // 100 = 3400 cents
    # net_saved = 40000 - 3400 = 36600
    # redemption_cpp_x100 = 36600 * 100 // 20000 = 183
    assert verdict.redemption_cpp_x100 == 183
    assert verdict.baseline_cpp_x100 == 170
    assert verdict.use_points is True
    assert "pts" in verdict.rationale
    assert verdict.hotel_name == "Hyatt Test"


def test_earn_vs_burn_bad_redemption_uses_cash_matches_worked_example():
    cash_offer = make_offer(
        offer_id="cash-2",
        channel=Channel.DIRECT,
        base_cents=31200,
        fees=[],
        hotel=Hotel(name="Hyatt Test 2", program=LoyaltyProgramId.WORLD_OF_HYATT),
        earns_loyalty=False,  # isolate: no forgone-earning complication
    )
    award_offer = make_offer(
        offer_id="award-2",
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        award_cash_cents=0,
        hotel=Hotel(name="Hyatt Test 2", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    profile = UserProfile()
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    # cents_saved = 31200 - 0 = 31200, no forgone (earns_loyalty False)
    # redemption_cpp_x100 = 31200 * 100 // 20000 = 156 (i.e. 1.56cpp)
    assert verdict.redemption_cpp_x100 == 156
    assert verdict.baseline_cpp_x100 == 170  # 1.70cpp
    assert verdict.use_points is False
    assert "pay cash" in verdict.rationale


def test_earn_vs_burn_use_points_false_when_balance_insufficient():
    cash_offer = make_offer(
        offer_id="cash-3",
        channel=Channel.DIRECT,
        base_cents=40000,
        fees=[FeeLine(kind=FeeKind.TAX, description="tax", amount_cents=5000)],
        hotel=Hotel(name="Hyatt Test 3", program=LoyaltyProgramId.WORLD_OF_HYATT),
        earns_loyalty=True,
    )
    award_offer = make_offer(
        offer_id="award-3",
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        award_cash_cents=5000,
        hotel=Hotel(name="Hyatt Test 3", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    profile = UserProfile(
        loyalty=[
            LoyaltyAccount(program=LoyaltyProgramId.WORLD_OF_HYATT, tier="", points_balance=100)
        ]
    )
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    assert verdict.redemption_cpp_x100 == 183  # cpp favors points...
    assert verdict.use_points is False  # ...but balance is insufficient
    assert "insufficient" in verdict.rationale


def test_earn_vs_burn_notes_balance_unknown_when_no_loyalty_account():
    cash_offer = make_offer(
        offer_id="cash-4",
        channel=Channel.DIRECT,
        base_cents=40000,
        fees=[FeeLine(kind=FeeKind.TAX, description="tax", amount_cents=5000)],
        hotel=Hotel(name="Hyatt Test 4", program=LoyaltyProgramId.WORLD_OF_HYATT),
        earns_loyalty=True,
    )
    award_offer = make_offer(
        offer_id="award-4",
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        award_cash_cents=5000,
        hotel=Hotel(name="Hyatt Test 4", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    profile = UserProfile(loyalty=[])  # no account on file
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    assert verdict.use_points is True  # cpp comparison alone still favors points
    assert "balance unknown" in verdict.rationale


def test_earn_vs_burn_zero_points_guard():
    cash_offer = make_offer(offer_id="cash-5", base_cents=10000)
    award_offer = make_offer(
        offer_id="award-5", channel=Channel.AWARD, base_cents=0, points_cost=None
    )
    profile = UserProfile()
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    assert verdict.use_points is None
    assert verdict.redemption_cpp_x100 is None


def test_earn_vs_burn_currency_mismatch_returns_none():
    cash_offer = make_offer(offer_id="cash-6", base_cents=10000, currency="USD")
    award_offer = make_offer(
        offer_id="award-6",
        channel=Channel.AWARD,
        base_cents=0,
        points_cost=20000,
        currency="EUR",
    )
    profile = UserProfile()
    verdict = earn_vs_burn(cash_offer, award_offer, profile)
    assert verdict.use_points is None
    assert "currenc" in verdict.rationale.lower()
