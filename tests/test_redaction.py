"""Structural-redaction regression tests.

These cover the bug where `redact()` was applied to whole serialized-JSON
strings, turning legitimate long numeric JSON values (epoch-millis
timestamps, points balances) into invalid JSON by replacing the unquoted
digit run with the (quoted-string-shaped) text "[REDACTED-PAN]". Persistence
must now redact structurally (string leaves only), never numerics, so
persisted rows always remain valid, re-validatable JSON.
"""

from __future__ import annotations

from datetime import date, timedelta

from hotel_agent.memory.store import MemoryStore, redact
from hotel_agent.models import (
    Channel,
    DataSource,
    Hotel,
    LoyaltyAccount,
    LoyaltyProgramId,
    NormalizedOffer,
    RankedOption,
    Recommendation,
    Refundability,
    SearchQuery,
    UserProfile,
)
from hotel_agent.models import EffectiveCost, CostLine

TODAY = date(2026, 8, 26)


def make_query(**kwargs) -> SearchQuery:
    defaults = dict(
        destination="Testville",
        check_in=TODAY + timedelta(days=45),
        check_out=TODAY + timedelta(days=47),
    )
    defaults.update(kwargs)
    return SearchQuery(**defaults)


def make_hotel() -> Hotel:
    return Hotel(name="Grand Test Hotel", program=LoyaltyProgramId.NONE, city="Testville")


def make_cost(offer_id: str, effective_cents: int) -> EffectiveCost:
    return EffectiveCost(
        offer_id=offer_id,
        card_id="cash",
        lines=[CostLine(label="base cost", amount_cents=effective_cents)],
        effective_cents=effective_cents,
        cash_outlay_cents=effective_cents,
        points_spent=0,
    )


# ---------------------------------------------------------------------------
# Structural round-trip: nested numeric values must survive untouched.
# ---------------------------------------------------------------------------

def test_epoch_millis_in_nested_dict_survives_roundtrip_exactly(tmp_path):
    """A 13-digit epoch-millis value nested inside a dict (e.g. offer.raw)
    must persist and load back as the exact same int -- not get mangled
    into the unquoted string [REDACTED-PAN], which would corrupt the JSON."""
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        offer = NormalizedOffer(
            offer_id="off-1",
            provider="testprovider",
            data_source=DataSource.FIXTURE,
            channel=Channel.DIRECT,
            hotel=make_hotel(),
            base_cents=20000,
            raw={"ts": 1700000000000},  # 13-digit epoch millis
        )
        cost = make_cost("off-1", 20000)
        option = RankedOption(offer=offer, cost=cost, rank=1)
        rec = Recommendation(
            query=make_query(),
            options=[option],
            best=option,
            earn_vs_burn=[],
            contains_fixture_data=True,
        )

        rec_id = store.record_recommendation(rec)
        assert isinstance(rec_id, int)

        recent = store.recent_recommendations(n=5)
        assert len(recent) == 1
        loaded_raw = recent[0].best.offer.raw
        assert loaded_raw["ts"] == 1700000000000
        assert isinstance(loaded_raw["ts"], int)
    finally:
        store.close()


def test_profile_points_balance_1200000_roundtrips(tmp_path):
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        profile = UserProfile(
            profile_id="default",
            loyalty=[
                LoyaltyAccount(
                    program=LoyaltyProgramId.WORLD_OF_HYATT,
                    points_balance=1200000,
                )
            ],
        )
        store.save_profile(profile)
        loaded = store.load_profile("default")

        assert loaded.loyalty[0].points_balance == 1200000
        assert loaded.model_dump() == profile.model_dump()
    finally:
        store.close()


def test_recommendation_offer_raw_with_ts_and_embedded_pan(tmp_path):
    """offer.raw containing both a legitimate 13-digit numeric timestamp and
    a string with an embedded PAN: the row must persist, reload as valid
    JSON, the PAN must be masked in the string, and the numeric ts must be
    untouched."""
    store = MemoryStore(db_path=tmp_path / "agent.db")
    try:
        offer = NormalizedOffer(
            offer_id="off-1",
            provider="testprovider",
            data_source=DataSource.FIXTURE,
            channel=Channel.DIRECT,
            hotel=make_hotel(),
            base_cents=20000,
            raw={"ts": 1700000000000, "note": "card 4111 1111 1111 1111"},
        )
        cost = make_cost("off-1", 20000)
        option = RankedOption(offer=offer, cost=cost, rank=1)
        rec = Recommendation(
            query=make_query(),
            options=[option],
            best=option,
            earn_vs_burn=[],
            contains_fixture_data=True,
        )

        store.record_recommendation(rec)
        recent = store.recent_recommendations(n=5)
        assert len(recent) == 1

        loaded_raw = recent[0].best.offer.raw
        assert loaded_raw["ts"] == 1700000000000
        assert "4111 1111 1111 1111" not in loaded_raw["note"]
        assert "[REDACTED-PAN]" in loaded_raw["note"]
    finally:
        store.close()


# ---------------------------------------------------------------------------
# redact(): broadened separators
# ---------------------------------------------------------------------------

def test_redact_handles_dot_slash_nbsp_and_unicode_hyphen_separators():
    cases = [
        "4111.1111.1111.1111",
        "4111/1111/1111/1111",
        "4111 1111 1111 1111",  # no-break space
        "4111‑1111‑1111‑1111",  # non-breaking hyphen
    ]
    for text in cases:
        result = redact(text)
        assert "[REDACTED-PAN]" in result, f"failed to redact: {text!r}"
        assert "4111" not in result or result.count("4111") == 0
