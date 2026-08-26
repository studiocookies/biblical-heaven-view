"""End-to-end: search (fixtures) -> recommend -> skeptic -> render -> booking flow."""

from __future__ import annotations

from datetime import date

import pytest

from hotel_agent.booking.executor import (
    ApprovalError,
    BookingStatus,
    ManualBookingExecutor,
    make_approval,
)
from hotel_agent.cli import _demo_profile, render
from hotel_agent.memory.store import MemoryStore
from hotel_agent.models import DataSource, Refundability, SearchQuery
from hotel_agent.providers.fixtures import FixtureProvider
from hotel_agent.recommend import recommend, run_search


@pytest.fixture()
def query() -> SearchQuery:
    return SearchQuery(
        destination="chicago",
        check_in=date(2026, 10, 9),
        check_out=date(2026, 10, 12),
        adults=2,
    )


@pytest.fixture()
def profile():
    return _demo_profile()


def test_full_pipeline_on_fixtures(query, profile):
    offers, notes = run_search(query, providers=[FixtureProvider()], allow_fixtures=True)
    assert offers, "fixture provider must produce offers"
    assert all(o.data_source == DataSource.FIXTURE for o in offers)
    assert any("MOCK" in n for n in notes)

    rec = recommend(query, profile, offers)
    assert rec.best is not None
    assert rec.contains_fixture_data is True
    # Ranking must be by effective cost, ascending.
    costs = [o.cost.effective_cents for o in rec.options]
    assert costs == sorted(costs)
    # Skeptic must at least flag mock data.
    assert any(f.category == "data_quality" for f in rec.skeptic_findings)
    # Every option's cost must be auditable: lines sum to effective.
    for opt in rec.options:
        assert sum(l.amount_cents for l in opt.cost.lines) == opt.cost.effective_cents

    text = render(rec, notes)
    assert "MOCK DATA" in text
    assert "EFFECTIVE COST" in text


def test_refundable_requirement_triggers_skeptic_revision_or_refundable_best(query, profile):
    q = query.model_copy(update={"require_refundable": True})
    offers, _ = run_search(q, providers=[FixtureProvider()], allow_fixtures=True)
    rec = recommend(q, profile, offers)
    assert rec.best is not None
    refundable_exists = any(
        o.offer.refundability == Refundability.FULLY_REFUNDABLE for o in rec.options
    )
    if refundable_exists:
        assert rec.best.offer.refundability == Refundability.FULLY_REFUNDABLE
    # And if the raw cheapest was non-refundable, the skeptic must have revised.
    cheapest = min(rec.options, key=lambda o: o.cost.effective_cents)
    if cheapest.offer.refundability != Refundability.FULLY_REFUNDABLE and refundable_exists:
        assert rec.revised is True


def test_booking_flow_token_gate(query, profile, tmp_path):
    offers, _ = run_search(query, providers=[FixtureProvider()], allow_fixtures=True)
    rec = recommend(query, profile, offers)
    offer = rec.best.offer

    ex = ManualBookingExecutor()
    plan = ex.prepare(offer, "csp", profile)

    # due-now + due-at-property must equal the true total.
    assert (
        plan.total_due_now_cents + plan.total_due_at_property_cents
        == offer.total_cash_cents
    )

    # Wrong token is rejected; nothing proceeds.
    with pytest.raises(ApprovalError):
        ex.execute(plan, make_approval(plan, "BOOK-wrong"))

    # Correct token yields manual instructions (never an automatic purchase).
    result = ex.execute(plan, make_approval(plan, plan.approval_token()))
    assert result.status == BookingStatus.MANUAL_ACTION_REQUIRED
    assert result.instructions

    # Changing the card invalidates the old token.
    plan2 = ex.prepare(offer, "amex-gold", profile)
    assert plan2.approval_token() != plan.approval_token() or plan2.plan_id != plan.plan_id
    with pytest.raises(ApprovalError):
        ex.execute(plan2, make_approval(plan2, plan.approval_token()))


def test_memory_roundtrip_of_pipeline_artifacts(query, profile, tmp_path):
    store = MemoryStore(tmp_path / "t.db")
    store.save_profile(profile)
    offers, _ = run_search(query, providers=[FixtureProvider()], allow_fixtures=True)
    rec = recommend(query, store.load_profile(), offers)
    store.record_search(query)
    store.record_recommendation(rec)
    assert store.recent_searches(1)[0].destination == "chicago"
    got = store.recent_recommendations(1)[0]
    assert got.best.offer.offer_id == rec.best.offer.offer_id
