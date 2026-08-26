"""Tests for the memory store and the deterministic skeptic pass.

Offers/costs are built by hand with literal numbers — this module
deliberately does NOT import cost_engine or providers, which are being
written concurrently.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from hotel_agent.memory.store import MemoryStore, redact
from hotel_agent.models import (
    Channel,
    CostLine,
    DataSource,
    EarnVsBurnVerdict,
    EffectiveCost,
    FeeKind,
    FeeLine,
    Hotel,
    LoyaltyAccount,
    LoyaltyProgramId,
    NormalizedOffer,
    PayableWhen,
    PaymentCard,
    PointValuation,
    RankedOption,
    Recommendation,
    Refundability,
    SearchQuery,
    BookingPlan,
    UserProfile,
)
from hotel_agent.skeptic import LlmSkeptic, apply_findings, review

TODAY = date(2026, 8, 26)


# ---------------------------------------------------------------------------
# factories
# ---------------------------------------------------------------------------

def make_hotel(name: str = "Grand Test Hotel", program: LoyaltyProgramId = LoyaltyProgramId.NONE) -> Hotel:
    return Hotel(name=name, program=program, city="Testville")


def make_offer(
    offer_id: str,
    *,
    hotel: Hotel | None = None,
    channel: Channel = Channel.DIRECT,
    base_cents: int = 20000,
    fees: list[FeeLine] | None = None,
    currency: str = "USD",
    refundability: Refundability = Refundability.UNKNOWN,
    points_cost: int | None = None,
    award_cash_cents: int = 0,
    earns_loyalty: bool = True,
    data_source: DataSource = DataSource.FIXTURE,
) -> NormalizedOffer:
    return NormalizedOffer(
        offer_id=offer_id,
        provider="testprovider",
        data_source=data_source,
        channel=channel,
        hotel=hotel or make_hotel(),
        currency=currency,
        base_cents=base_cents,
        fees=fees or [],
        refundability=refundability,
        points_cost=points_cost,
        award_cash_cents=award_cash_cents,
        earns_loyalty=earns_loyalty,
    )


def make_cost(
    offer_id: str,
    effective_cents: int,
    *,
    card_id: str = "cash",
    cash_outlay_cents: int | None = None,
    lines: list[CostLine] | None = None,
    points_spent: int = 0,
) -> EffectiveCost:
    return EffectiveCost(
        offer_id=offer_id,
        card_id=card_id,
        lines=lines or [CostLine(label="base cost", amount_cents=effective_cents)],
        effective_cents=effective_cents,
        cash_outlay_cents=cash_outlay_cents if cash_outlay_cents is not None else effective_cents,
        points_spent=points_spent,
    )


def make_option(offer: NormalizedOffer, cost: EffectiveCost, rank: int) -> RankedOption:
    return RankedOption(offer=offer, cost=cost, rank=rank)


def make_query(**kwargs) -> SearchQuery:
    defaults = dict(
        destination="Testville",
        check_in=TODAY + timedelta(days=45),
        check_out=TODAY + timedelta(days=47),
    )
    defaults.update(kwargs)
    return SearchQuery(**defaults)


def make_rec(query: SearchQuery, options: list[RankedOption], best: RankedOption, **kwargs) -> Recommendation:
    defaults = dict(earn_vs_burn=[], contains_fixture_data=True)
    defaults.update(kwargs)
    return Recommendation(query=query, options=options, best=best, **defaults)


# ---------------------------------------------------------------------------
# memory store: profile roundtrip
# ---------------------------------------------------------------------------

def test_profile_roundtrip_with_loyalty_cards_valuations(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        profile = UserProfile(
            profile_id="default",
            home_currency="USD",
            loyalty=[
                LoyaltyAccount(
                    program=LoyaltyProgramId.WORLD_OF_HYATT,
                    member_number_last4="1234",
                    tier="Globalist",
                    points_balance=1200000,
                    free_night_certs=1,
                    cert_max_points_value=35000,
                )
            ],
            cards=[
                PaymentCard(
                    card_id="csr",
                    display_name="Chase Sapphire Reserve",
                    network="visa",
                    reward_currency="chase_ur",
                    reward_value_cpp_x100=200,
                )
            ],
            valuation_overrides=[
                PointValuation(
                    program=LoyaltyProgramId.WORLD_OF_HYATT,
                    value_cpp_x100=180,
                    source="user override",
                    as_of=TODAY,
                )
            ],
            prefs={"needs_breakfast": True, "phone": "5551234567"},
        )

        store.save_profile(profile)
        loaded = store.load_profile("default")

        assert loaded.model_dump() == profile.model_dump()
    finally:
        store.close()


def test_load_profile_missing_returns_fresh_default(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        loaded = store.load_profile("nobody")
        assert loaded == UserProfile(profile_id="nobody")
        assert loaded.loyalty == []
        assert loaded.cards == []
    finally:
        store.close()


def test_save_profile_redacts_pan_like_strings_in_prefs(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        profile = UserProfile(
            profile_id="default",
            prefs={"note": "accidentally pasted card 4111 1111 1111 1111 here"},
        )
        store.save_profile(profile)
        loaded = store.load_profile("default")

        assert "4111 1111 1111 1111" not in loaded.prefs["note"]
        assert "[REDACTED-PAN]" in loaded.prefs["note"]
    finally:
        store.close()


# ---------------------------------------------------------------------------
# memory store: search / recommendation / booking persistence
# ---------------------------------------------------------------------------

def test_search_persistence_roundtrip(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        q1 = make_query(destination="Austin, TX")
        q2 = make_query(destination="Denver, CO", require_refundable=True)

        id1 = store.record_search(q1)
        id2 = store.record_search(q2)
        assert id2 > id1

        recent = store.recent_searches(n=10)
        assert len(recent) == 2
        # most recent first
        assert recent[0].destination == "Denver, CO"
        assert recent[1].destination == "Austin, TX"
    finally:
        store.close()


def test_recommendation_persistence_roundtrip(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        offer = make_offer("off-1")
        cost = make_cost("off-1", 20000)
        option = make_option(offer, cost, 1)
        rec = make_rec(make_query(), [option], option)

        rec_id = store.record_recommendation(rec)
        assert isinstance(rec_id, int)

        recent = store.recent_recommendations(n=5)
        assert len(recent) == 1
        assert recent[0].best.offer.offer_id == "off-1"
        assert recent[0].query.destination == rec.query.destination
    finally:
        store.close()


def test_booking_persistence_roundtrip(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        offer = make_offer("off-1", refundability=Refundability.FULLY_REFUNDABLE)
        plan = BookingPlan(
            plan_id="plan-1",
            offer=offer,
            card_id="csr",
            total_due_now_cents=20000,
            total_due_at_property_cents=0,
            refundability=Refundability.FULLY_REFUNDABLE,
            steps=["Go to hotel.com", "Enter dates", "Confirm"],
        )

        booking_id = store.record_booking(plan, status="pending_approval")
        store.update_booking_status(booking_id, "approved")

        all_bookings = store.bookings()
        assert len(all_bookings) == 1
        got_id, got_plan, got_status = all_bookings[0]
        assert got_id == booking_id
        assert got_status == "approved"
        assert got_plan.plan_id == "plan-1"
        assert got_plan.approval_token() == plan.approval_token()
    finally:
        store.close()


# ---------------------------------------------------------------------------
# redact()
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "4111111111111111",
        "card on file: 4916-3792-8471-2039-5 exp 12/28",  # 17 digits, dashed
    ],
)
def test_redact_masks_pan_like_sequences(text):
    result = redact(text)
    assert "[REDACTED-PAN]" in result
    # no 13+ run of digits survives
    import re

    assert not re.search(r"(?:\d[ -]?){13,19}", result.replace("[REDACTED-PAN]", ""))


def test_redact_leaves_short_or_unrelated_numbers_alone():
    text = '"points_balance": 1200000, "phone": "5551234567"'
    result = redact(text)
    assert result == text


def test_redact_masks_cvv_markers():
    assert "[REDACTED-CVV]" in redact("cvv: 123")
    assert "[REDACTED-CVV]" in redact("CVC=4567")
    assert "[REDACTED-CVV]" in redact("csc 999")
    assert "123" not in redact("cvv: 123")


def test_redact_empty_string():
    assert redact("") == ""


# ---------------------------------------------------------------------------
# skeptic: rule (a) better_rate / ranking bug
# ---------------------------------------------------------------------------

def test_rule_a_better_rate_flags_and_reranks():
    hotel = make_hotel()
    offer_best = make_offer("chosen", hotel=hotel, base_cents=25000)
    cost_best = make_cost("chosen", 25000)
    opt_best = make_option(offer_best, cost_best, 1)

    offer_cheap = make_offer("cheaper", hotel=hotel, base_cents=18000)
    cost_cheap = make_cost("cheaper", 18000)
    opt_cheap = make_option(offer_cheap, cost_cheap, 2)

    rec = make_rec(make_query(), [opt_best, opt_cheap], opt_best)

    findings = review(rec, UserProfile())
    better_rate = [f for f in findings if f.category == "better_rate"]
    assert len(better_rate) == 1
    assert better_rate[0].severity.value == "blocker"
    assert better_rate[0].offer_id == "cheaper"

    revised = apply_findings(rec, findings, UserProfile())
    assert revised.revised is True
    assert revised.best.offer.offer_id == "cheaper"
    assert [o.rank for o in revised.options] == [1, 2]
    assert revised.options[0].offer.offer_id == "cheaper"
    assert len(revised.revision_notes) >= 1
    # original rec is untouched
    assert rec.best.offer.offer_id == "chosen"
    assert rec.revised is False


# ---------------------------------------------------------------------------
# skeptic: rule (b) missed_fee
# ---------------------------------------------------------------------------

def test_rule_b_missed_fee_at_property():
    hotel = make_hotel()
    fee = FeeLine(
        kind=FeeKind.RESORT_FEE,
        description="resort fee",
        amount_cents=4500,
        payable=PayableWhen.AT_PROPERTY,
        included_in_advertised_total=False,
    )
    offer = make_offer("off-1", hotel=hotel, base_cents=20000, fees=[fee])
    cost = make_cost("off-1", 20000)
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt)

    findings = review(rec, UserProfile())
    missed_fee = [f for f in findings if f.category == "missed_fee"]
    assert any("45.00" in f.message and "at property" in f.message for f in missed_fee)
    assert all(f.severity.value == "warning" for f in missed_fee)


def test_rule_c_missing_tax_lines():
    offer = make_offer("off-1", base_cents=20000, fees=[])
    cost = make_cost("off-1", 20000)
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt)

    findings = review(rec, UserProfile())
    assert any(
        f.category == "missed_fee" and "tax" in f.message.lower() for f in findings
    )


# ---------------------------------------------------------------------------
# skeptic: rule (d) cancellation_risk BLOCKER + refundable promotion
# ---------------------------------------------------------------------------

def test_rule_d_requires_refundable_blocks_and_promotes():
    hotel = make_hotel()
    offer_nonref = make_offer(
        "nonref", hotel=hotel, base_cents=15000, refundability=Refundability.NON_REFUNDABLE
    )
    cost_nonref = make_cost("nonref", 15000)
    opt_nonref = make_option(offer_nonref, cost_nonref, 1)

    offer_ref = make_offer(
        "refundable", hotel=hotel, base_cents=17000, refundability=Refundability.FULLY_REFUNDABLE
    )
    cost_ref = make_cost("refundable", 17000)
    opt_ref = make_option(offer_ref, cost_ref, 2)

    query = make_query(require_refundable=True)
    rec = make_rec(query, [opt_nonref, opt_ref], opt_nonref)

    findings = review(rec, UserProfile())
    blockers = [
        f for f in findings if f.category == "cancellation_risk" and f.severity.value == "blocker"
    ]
    assert len(blockers) == 1

    revised = apply_findings(rec, findings, UserProfile())
    assert revised.revised is True
    assert revised.best.offer.offer_id == "refundable"
    # BLOCKER still visible even though it was routed around
    assert any(
        f.category == "cancellation_risk" and f.severity.value == "blocker"
        for f in revised.skeptic_findings
    )


def test_rule_d_no_refundable_alternative_leaves_blocker_unresolved():
    offer_nonref = make_offer(
        "nonref", base_cents=15000, refundability=Refundability.NON_REFUNDABLE
    )
    cost_nonref = make_cost("nonref", 15000)
    opt_nonref = make_option(offer_nonref, cost_nonref, 1)

    query = make_query(require_refundable=True)
    rec = make_rec(query, [opt_nonref], opt_nonref)

    findings = review(rec, UserProfile())
    revised = apply_findings(rec, findings, UserProfile())

    # nothing to promote to - best stays, but blocker stays visible
    assert revised.best.offer.offer_id == "nonref"
    assert any(
        f.category == "cancellation_risk" and f.severity.value == "blocker"
        for f in revised.skeptic_findings
    )


# ---------------------------------------------------------------------------
# skeptic: rule (f) loyalty_logic — OTA forfeits points
# ---------------------------------------------------------------------------

def test_rule_f_ota_forfeits_loyalty():
    hotel = make_hotel(program=LoyaltyProgramId.HILTON_HONORS)
    offer_ota = make_offer("ota-1", hotel=hotel, channel=Channel.OTA, base_cents=20000, earns_loyalty=False)
    cost_ota = make_cost("ota-1", 20000)
    opt_ota = make_option(offer_ota, cost_ota, 1)

    offer_direct = make_offer("direct-1", hotel=hotel, channel=Channel.DIRECT, base_cents=20500)
    cost_direct = make_cost("direct-1", 20500)
    opt_direct = make_option(offer_direct, cost_direct, 2)

    profile = UserProfile(
        loyalty=[LoyaltyAccount(program=LoyaltyProgramId.HILTON_HONORS, points_balance=5000)]
    )

    rec = make_rec(make_query(), [opt_ota, opt_direct], opt_ota)

    findings = review(rec, profile)
    loyalty_findings = [f for f in findings if f.category == "loyalty_logic"]
    assert len(loyalty_findings) == 1
    assert loyalty_findings[0].severity.value == "warning"
    assert "direct-1" == loyalty_findings[0].offer_id


def test_rule_f_no_finding_without_loyalty_account():
    hotel = make_hotel(program=LoyaltyProgramId.HILTON_HONORS)
    offer_ota = make_offer("ota-1", hotel=hotel, channel=Channel.OTA, base_cents=20000)
    cost_ota = make_cost("ota-1", 20000)
    opt_ota = make_option(offer_ota, cost_ota, 1)

    offer_direct = make_offer("direct-1", hotel=hotel, channel=Channel.DIRECT, base_cents=20500)
    cost_direct = make_cost("direct-1", 20500)
    opt_direct = make_option(offer_direct, cost_direct, 2)

    rec = make_rec(make_query(), [opt_ota, opt_direct], opt_ota)
    findings = review(rec, UserProfile())  # no loyalty accounts
    assert not [f for f in findings if f.category == "loyalty_logic"]


# ---------------------------------------------------------------------------
# skeptic: rule (g) award beaten by cash (earn-vs-burn) + promotion
# ---------------------------------------------------------------------------

def test_rule_g_earn_vs_burn_says_use_cash_and_promotes():
    hotel = make_hotel(program=LoyaltyProgramId.MARRIOTT_BONVOY)
    offer_award = make_offer(
        "award-1", hotel=hotel, channel=Channel.AWARD, base_cents=0, points_cost=60000
    )
    cost_award = make_cost("award-1", 22000, card_id="points", points_spent=60000)
    opt_award = make_option(offer_award, cost_award, 1)

    offer_cash = make_offer("cash-1", hotel=hotel, channel=Channel.DIRECT, base_cents=24000)
    cost_cash = make_cost("cash-1", 24000)
    opt_cash = make_option(offer_cash, cost_cash, 2)

    verdict = EarnVsBurnVerdict(
        hotel_name=hotel.name,
        cash_offer_id="cash-1",
        award_offer_id="award-1",
        use_points=False,
        rationale="redemption value is below baseline cpp",
    )

    profile = UserProfile(
        loyalty=[LoyaltyAccount(program=LoyaltyProgramId.MARRIOTT_BONVOY, points_balance=100000)]
    )

    rec = make_rec(make_query(), [opt_award, opt_cash], opt_award, earn_vs_burn=[verdict])

    findings = review(rec, profile)
    blockers = [
        f for f in findings if f.category == "loyalty_logic" and f.severity.value == "blocker"
    ]
    assert len(blockers) == 1
    assert blockers[0].offer_id == "award-1"

    revised = apply_findings(rec, findings, profile)
    assert revised.revised is True
    assert revised.best.offer.offer_id == "cash-1"
    assert any(
        f.category == "loyalty_logic" and f.severity.value == "blocker"
        for f in revised.skeptic_findings
    )


# ---------------------------------------------------------------------------
# skeptic: rule (h) insufficient points balance
# ---------------------------------------------------------------------------

def test_rule_h_insufficient_points_balance():
    hotel = make_hotel(program=LoyaltyProgramId.MARRIOTT_BONVOY)
    offer_award = make_offer(
        "award-1", hotel=hotel, channel=Channel.AWARD, base_cents=0, points_cost=60000
    )
    cost_award = make_cost("award-1", 22000, card_id="points", points_spent=60000)
    opt_award = make_option(offer_award, cost_award, 1)

    profile = UserProfile(
        loyalty=[LoyaltyAccount(program=LoyaltyProgramId.MARRIOTT_BONVOY, points_balance=10000)]
    )

    rec = make_rec(make_query(), [opt_award], opt_award)

    findings = review(rec, profile)
    warnings = [
        f
        for f in findings
        if f.category == "loyalty_logic" and f.severity.value == "warning" and f.offer_id == "award-1"
    ]
    assert len(warnings) == 1
    assert "10,000" in warnings[0].message
    assert "60,000" in warnings[0].message


# ---------------------------------------------------------------------------
# skeptic: rule (j) fixture/mock data label
# ---------------------------------------------------------------------------

def test_rule_j_flags_fixture_data():
    offer = make_offer("off-1", data_source=DataSource.FIXTURE)
    cost = make_cost("off-1", 20000)
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt, contains_fixture_data=True)

    findings = review(rec, UserProfile())
    mock_findings = [f for f in findings if f.category == "data_quality" and "MOCK DATA" in f.message]
    assert len(mock_findings) == 1
    assert mock_findings[0].severity.value == "info"


def test_rule_k_zero_cost_flagged():
    offer = make_offer("off-1", base_cents=0)
    cost = make_cost("off-1", 0)
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt, contains_fixture_data=False)

    findings = review(rec, UserProfile())
    zero_findings = [
        f for f in findings if f.category == "data_quality" and f.severity.value == "warning"
    ]
    assert len(zero_findings) == 1


# ---------------------------------------------------------------------------
# skeptic: payment_option rule
# ---------------------------------------------------------------------------

def test_payment_option_warns_when_no_cards():
    offer = make_offer("off-1")
    cost = make_cost("off-1", 20000, card_id="csr")
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt)

    findings = review(rec, UserProfile(cards=[]))
    assert any(
        f.category == "payment_option" and f.severity.value == "warning" for f in findings
    )


def test_payment_option_info_when_card_present():
    offer = make_offer("off-1")
    cost = make_cost("off-1", 20000, card_id="csr")
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt)

    profile = UserProfile(cards=[PaymentCard(card_id="csr", display_name="Chase Sapphire Reserve")])
    findings = review(rec, profile)
    info_findings = [f for f in findings if f.category == "payment_option"]
    assert len(info_findings) == 1
    assert info_findings[0].severity.value == "info"
    assert "Chase Sapphire Reserve" in info_findings[0].message


# ---------------------------------------------------------------------------
# LlmSkeptic — optional, no key configured
# ---------------------------------------------------------------------------

def test_llm_skeptic_unavailable_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    skeptic = LlmSkeptic(api_key=None)
    available, reason = skeptic.is_available()
    assert available is False
    assert reason

    offer = make_offer("off-1")
    cost = make_cost("off-1", 20000)
    opt = make_option(offer, cost, 1)
    rec = make_rec(make_query(), [opt], opt)

    # review() must degrade to [] cleanly rather than raising
    assert skeptic.review(rec, UserProfile()) == []


def test_llm_skeptic_parses_tolerant_json():
    skeptic = LlmSkeptic(api_key="fake-key-for-parsing-test")
    text = '```json\n[{"severity": "warning", "category": "missed_fee", "message": "test"}]\n```'
    findings = skeptic._parse_findings(text)
    assert len(findings) == 1
    assert findings[0].category == "missed_fee"
    assert findings[0].severity.value == "warning"


def test_llm_skeptic_parse_failure_returns_empty():
    skeptic = LlmSkeptic(api_key="fake-key-for-parsing-test")
    assert skeptic._parse_findings("not json at all") == []
