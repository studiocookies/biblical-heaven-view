"""Regression tests for defects found by the adversarial review pass."""

from __future__ import annotations

from datetime import date, datetime, timezone

from hotel_agent.booking.executor import ManualBookingExecutor
from hotel_agent.cli import _demo_profile
from hotel_agent.currency import format_money
from hotel_agent.models import (
    Channel,
    DataSource,
    FeeKind,
    FeeLine,
    Hotel,
    LoyaltyProgramId,
    NormalizedOffer,
    PayableWhen,
    Refundability,
    SearchQuery,
    UserProfile,
)
from hotel_agent.recommend import recommend


def make_offer(**kw) -> NormalizedOffer:
    base = dict(
        offer_id="o1",
        provider="fixtures",
        data_source=DataSource.FIXTURE,
        channel=Channel.DIRECT,
        hotel=Hotel(name="Testotel", program=LoyaltyProgramId.NONE),
        currency="USD",
        base_cents=50000,
        refundability=Refundability.FULLY_REFUNDABLE,
    )
    base.update(kw)
    return NormalizedOffer(**base)


QUERY = SearchQuery(destination="x", check_in=date(2026, 11, 1), check_out=date(2026, 11, 3))


# --- Finding 3: approval token must cover all material plan fields ----------

def test_approval_token_covers_at_property_currency_refundability_room():
    ex = ManualBookingExecutor()
    profile = UserProfile()
    base = make_offer()
    variants = [
        make_offer(fees=[FeeLine(kind=FeeKind.RESORT_FEE, description="resort",
                                 amount_cents=45000, payable=PayableWhen.AT_PROPERTY)]),
        make_offer(currency="EUR"),
        make_offer(refundability=Refundability.NON_REFUNDABLE),
        make_offer(cancel_deadline=datetime(2026, 10, 20, tzinfo=timezone.utc)),
        make_offer(room_description="Windowless Bunk"),
        make_offer(hotel=Hotel(name="Other Hotel")),
    ]
    base_token = ex.prepare(base, "csp", profile).approval_token()
    for v in variants:
        assert ex.prepare(v, "csp", profile).approval_token() != base_token


# --- Finding 9: plan identity covers amounts; re-plans don't collide --------

def test_plan_id_changes_when_amounts_change():
    ex = ManualBookingExecutor()
    profile = UserProfile()
    cheap = make_offer(base_cents=20000)
    pricey = make_offer(base_cents=35000)  # same offer_id, new price
    assert ex.prepare(cheap, "csp", profile).plan_id != ex.prepare(pricey, "csp", profile).plan_id


# --- Finding 2: currencies are never ranked against each other --------------

def test_cross_currency_offers_not_ranked_together():
    profile = UserProfile()
    eur = make_offer(offer_id="eur1", currency="EUR", base_cents=99000)
    usd = make_offer(offer_id="usd1", currency="USD", base_cents=103455)
    rec = recommend(QUERY, profile, [eur, usd])
    currencies = {o.offer.currency for o in rec.options}
    assert len(currencies) == 1
    assert currencies == {"USD"}  # query currency preferred
    assert any("other currencies" in f.message for f in rec.skeptic_findings)


def test_all_foreign_currency_still_yields_results_with_disclosure():
    profile = UserProfile()
    offers = [make_offer(offer_id=f"e{i}", currency="EUR", base_cents=90000 + i)
              for i in range(3)]
    rec = recommend(QUERY, profile, offers)
    assert rec.best is not None
    assert all(o.offer.currency == "EUR" for o in rec.options)
    assert any("ranking in EUR" in f.message for f in rec.skeptic_findings)


# --- Finding 4: awards respect the cash budget on their cash component ------

def test_award_with_cash_over_budget_is_dropped():
    profile = UserProfile()
    q = QUERY.model_copy(update={"max_total_cents": 50000})
    cash_ok = make_offer(offer_id="c1", base_cents=45000)
    award_over = make_offer(
        offer_id="a1", channel=Channel.AWARD, base_cents=0,
        points_cost=30000, award_cash_cents=120000,
        hotel=Hotel(name="Pointsotel", program=LoyaltyProgramId.WORLD_OF_HYATT),
    )
    rec = recommend(q, profile, [cash_ok, award_over])
    ids = {o.offer.offer_id for o in rec.options}
    assert "a1" not in ids and "c1" in ids


# --- Finding 7: zero-decimal currencies render and rank honestly ------------

def test_jpy_formatting_and_partial_cost():
    assert format_money(49500, "JPY") == "JPY 49,500"
    assert format_money(49500, "USD") == "USD 495.00"
    assert format_money(12345, "KWD") == "KWD 12.345"

    profile = _demo_profile()
    jpy = make_offer(offer_id="j1", currency="JPY", base_cents=45000,
                     hotel=Hotel(name="Tokyo Inn", program=LoyaltyProgramId.MARRIOTT_BONVOY))
    q = QUERY.model_copy(update={"currency": "JPY"})
    rec = recommend(q, profile, [jpy])
    cost = rec.best.cost
    # No reward/points adjustments may be applied to a non-exponent-2 currency.
    assert cost.effective_cents == jpy.total_cash_cents
    assert any("PARTIAL" in l.label for l in cost.lines)


# --- Finding 10: LLM findings can never drive a revision --------------------

def test_llm_findings_do_not_revise(monkeypatch):
    from hotel_agent import skeptic as skeptic_mod

    profile = UserProfile()
    cheap = make_offer(offer_id="c1", base_cents=22000,
                       refundability=Refundability.NON_REFUNDABLE)
    pricey = make_offer(offer_id="c2", base_cents=108900)

    monkeypatch.setattr(skeptic_mod.LlmSkeptic, "is_available", lambda self: (True, "ok"))
    monkeypatch.setattr(
        skeptic_mod.LlmSkeptic,
        "review",
        lambda self, rec, prof: [
            skeptic_mod.SkepticFinding(
                severity=skeptic_mod.SkepticSeverity.BLOCKER,
                category="cancellation_risk",
                message="model says promote the expensive one",
            )
        ],
    )
    rec = recommend(QUERY, profile, [cheap, pricey], run_llm_skeptic=True)
    assert rec.best.offer.offer_id == "c1"  # unchanged by the LLM blocker
    assert rec.revised is False
    assert any("[LLM second opinion]" in f.message for f in rec.skeptic_findings)
