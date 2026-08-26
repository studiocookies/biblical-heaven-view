"""Recommendation pipeline: search → normalize → cost → rank → skeptic → report.

The pipeline never does vague math: every number in the output comes from the
deterministic cost engine, and the skeptic pass runs before anything is shown.
Fixture (mock) data is tracked end-to-end and flagged in the result.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from hotel_agent import skeptic as skeptic_mod
from hotel_agent.cost_engine import best_card_cost, earn_vs_burn
from hotel_agent.models import (
    Channel,
    DataSource,
    EarnVsBurnVerdict,
    NormalizedOffer,
    RankedOption,
    Recommendation,
    SearchQuery,
    UserProfile,
)
from hotel_agent.normalize import normalize
from hotel_agent.providers.amadeus import AmadeusProvider
from hotel_agent.providers.base import HotelSearchProvider
from hotel_agent.providers.fixtures import FixtureProvider

log = logging.getLogger(__name__)


def default_providers() -> list[HotelSearchProvider]:
    return [AmadeusProvider(), FixtureProvider()]


def run_search(
    query: SearchQuery,
    providers: list[HotelSearchProvider] | None = None,
    allow_fixtures: bool = True,
) -> tuple[list[NormalizedOffer], list[str]]:
    """Query every available provider; fall back to fixtures only when no live
    provider is available (and say so). Returns (offers, provider_notes)."""
    providers = providers if providers is not None else default_providers()
    notes: list[str] = []
    raw = []
    live_used = False

    for p in providers:
        if isinstance(p, FixtureProvider):
            continue  # fixtures are fallback-only, handled below
        ok, reason = p.is_available()
        if not ok:
            notes.append(f"provider '{p.name}' unavailable: {reason}")
            continue
        try:
            results = p.search(query)
            raw.extend(results)
            live_used = live_used or any(r.data_source == DataSource.LIVE for r in results)
            notes.append(f"provider '{p.name}': {len(results)} raw offers (LIVE)")
        except Exception as exc:  # provider errors must not kill the run
            log.warning("provider %s failed: %s", p.name, exc)
            notes.append(f"provider '{p.name}' failed: {exc}")

    if not live_used and allow_fixtures:
        fx = next((p for p in providers if isinstance(p, FixtureProvider)), FixtureProvider())
        results = fx.search(query)
        raw.extend(results)
        notes.append(
            f"provider 'fixtures': {len(results)} raw offers — MOCK DATA "
            "(no live provider available; prices are NOT real)"
        )

    return normalize(raw, query), notes


def _budget_filter(offers: list[NormalizedOffer], query: SearchQuery) -> list[NormalizedOffer]:
    if query.max_total_cents is None:
        return offers
    kept = []
    for o in offers:
        # Awards are judged on their cash component; cash offers on true total.
        if o.is_award or o.total_cash_cents <= query.max_total_cents:
            kept.append(o)
    return kept


def _build_earn_vs_burn(
    offers: list[NormalizedOffer], profile: UserProfile
) -> list[EarnVsBurnVerdict]:
    verdicts: list[EarnVsBurnVerdict] = []
    awards = [o for o in offers if o.is_award]
    for award in awards:
        cash_twins = [
            o for o in offers
            if not o.is_award and o.hotel.name == award.hotel.name and o.currency == award.currency
        ]
        if not cash_twins:
            continue
        cheapest_cash = min(cash_twins, key=lambda o: o.total_cash_cents)
        try:
            verdicts.append(earn_vs_burn(cheapest_cash, award, profile))
        except Exception as exc:
            log.warning("earn_vs_burn failed for %s: %s", award.hotel.name, exc)
    return verdicts


def recommend(
    query: SearchQuery,
    profile: UserProfile,
    offers: list[NormalizedOffer],
    run_llm_skeptic: bool = False,
) -> Recommendation:
    offers = _budget_filter(offers, query)

    options: list[RankedOption] = []
    for offer in offers:
        try:
            cost = best_card_cost(offer, profile)
        except Exception as exc:
            log.warning("cost engine failed for %s: %s", offer.offer_id, exc)
            continue
        options.append(RankedOption(offer=offer, cost=cost, rank=0))

    # Deterministic ranking: effective cost, then true cash total, then id.
    options.sort(key=lambda o: (o.cost.effective_cents, o.offer.total_cash_cents, o.offer.offer_id))
    for i, opt in enumerate(options):
        opt.rank = i + 1
        opt.rationale = _rationale(opt)

    rec = Recommendation(
        query=query,
        options=options,
        best=options[0] if options else None,
        earn_vs_burn=_build_earn_vs_burn(offers, profile),
        contains_fixture_data=any(o.data_source == DataSource.FIXTURE for o in offers),
        generated_at=datetime.now(timezone.utc),
    )

    # Skeptic pass — always runs before the user sees anything.
    findings = skeptic_mod.review(rec, profile)
    if run_llm_skeptic:
        llm = skeptic_mod.LlmSkeptic()
        ok, reason = llm.is_available()
        if ok:
            findings.extend(llm.review(rec, profile))
        else:
            log.info("LLM skeptic skipped: %s", reason)
    rec = skeptic_mod.apply_findings(rec, findings, profile)
    return rec


def _rationale(opt: RankedOption) -> str:
    o = opt.offer
    bits = []
    if o.is_award:
        bits.append(f"{o.points_cost:,} pts + {_m(o.award_cash_cents, o.currency)}")
    else:
        bits.append(f"true total {_m(o.total_cash_cents, o.currency)}")
    bits.append(f"effective {_m(opt.cost.effective_cents, o.currency)} on {opt.cost.card_id}")
    if o.channel == Channel.OTA and not o.earns_loyalty:
        bits.append("no loyalty earning (OTA)")
    if o.included_benefits:
        bits.append("includes " + ", ".join(b.name for b in o.included_benefits))
    return "; ".join(bits)


def _m(cents: int, currency: str) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}{currency} {abs(cents) / 100:,.2f}"
