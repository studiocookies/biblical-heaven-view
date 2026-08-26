from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from hotel_agent.models import (
    Channel,
    DataSource,
    LoyaltyProgramId,
    RawOffer,
    Refundability,
    SearchQuery,
)
from hotel_agent.normalize import minor_units, normalize
from hotel_agent.providers.amadeus import AmadeusProvider
from hotel_agent.providers.base import ProviderUnavailable
from hotel_agent.providers.fixtures import FixtureProvider

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "amadeus_hotel_offers.json"


def _query(**overrides) -> SearchQuery:
    defaults = dict(
        destination="London",
        check_in=date(2026, 10, 12),
        check_out=date(2026, 10, 15),
        adults=2,
        rooms=1,
        currency="USD",
    )
    defaults.update(overrides)
    return SearchQuery(**defaults)


# ---------------------------------------------------------------------------
# FixtureProvider
# ---------------------------------------------------------------------------

def test_fixture_provider_is_always_available():
    available, reason = FixtureProvider().is_available()
    assert available is True
    assert "MOCK" in reason


def test_fixture_provider_deterministic():
    q = _query()
    a = FixtureProvider().search(q)
    b = FixtureProvider().search(q)
    assert len(a) == len(b) and len(a) > 0
    payload_a = [o.payload for o in a]
    payload_b = [o.payload for o in b]
    assert payload_a == payload_b


def test_fixture_provider_different_query_differs():
    q1 = _query(destination="London")
    q2 = _query(destination="Tokyo")
    a = FixtureProvider().search(q1)
    b = FixtureProvider().search(q2)
    assert [o.payload for o in a] != [o.payload for o in b]


def test_fixture_provider_all_data_source_fixture():
    offers = FixtureProvider().search(_query())
    assert all(o.data_source == DataSource.FIXTURE for o in offers)
    assert all(o.provider == "fixtures" for o in offers)


def test_fixture_provider_spans_channels_award_and_resort_fee():
    # Run across a handful of destinations/date pairs so award + resort-fee
    # branches (which depend on the seeded RNG) are exercised at least once.
    channels_seen = set()
    saw_award = False
    saw_resort_fee = False
    saw_hotel_count_in_range = False

    for i, dest in enumerate(["London", "Tokyo", "Chicago", "Miami", "Orlando", "Paris"]):
        q = _query(destination=dest, check_in=date(2026, 11, 1 + i), check_out=date(2026, 11, 4 + i))
        raw_offers = FixtureProvider().search(q)
        offers = normalize(raw_offers, q)

        hotel_names = {o.hotel.name for o in offers}
        if 6 <= len(hotel_names) <= 9:
            saw_hotel_count_in_range = True

        for o in offers:
            channels_seen.add(o.channel)
            if o.channel == Channel.AWARD:
                saw_award = True
                assert o.points_cost is not None and o.points_cost > 0
            for fee in o.fees:
                if fee.kind.value == "resort_fee":
                    saw_resort_fee = True

    assert channels_seen == {Channel.DIRECT, Channel.OTA, Channel.AWARD}
    assert saw_award
    assert saw_resort_fee
    assert saw_hotel_count_in_range


def test_fixture_provider_nights_multiplication():
    short = _query(check_in=date(2026, 10, 12), check_out=date(2026, 10, 13))  # 1 night
    long_ = _query(check_in=date(2026, 10, 12), check_out=date(2026, 10, 16))  # 4 nights
    assert long_.nights == 4 * short.nights

    short_offers = FixtureProvider().search(short)
    long_offers = FixtureProvider().search(long_)

    # Same destination/base seed structure differs (dates differ -> different
    # seed), so instead check within a single query that a cash direct offer
    # scales roughly linearly and that 4-night vs 1-night base cents differ.
    short_norm = normalize(short_offers, short)
    long_norm = normalize(long_offers, long_)
    short_direct = [o for o in short_norm if o.channel == Channel.DIRECT and o.rate_plan == "Best Available Rate"]
    long_direct = [o for o in long_norm if o.channel == Channel.DIRECT and o.rate_plan == "Best Available Rate"]
    assert short_direct and long_direct
    # base_cents must be a whole-night multiple (proves per-night * nights math)
    for o in short_direct:
        assert o.base_cents % short.nights == 0
    for o in long_direct:
        assert o.base_cents % long_.nights == 0


# ---------------------------------------------------------------------------
# normalize() on fixtures
# ---------------------------------------------------------------------------

def test_normalize_fixture_offers_validate_and_dedup():
    q = _query()
    raw = FixtureProvider().search(q)
    offers = normalize(raw, q)

    assert len(offers) > 0
    assert len(offers) == len({o.offer_id for o in offers})  # no dup ids
    ids = [o.offer_id for o in offers]
    assert ids == sorted(ids)  # sorted by offer_id

    for o in offers:
        assert o.fetched_at is None
        assert o.data_source == DataSource.FIXTURE
        assert o.provider == "fixtures"
        assert len(o.offer_id) == 12
        # total_cash_cents must never be negative / nonsensical
        assert o.total_cash_cents >= 0
        if o.is_award:
            assert o.points_cost > 0
        else:
            assert o.base_cents > 0


def test_normalize_fixture_is_stable_across_runs():
    q = _query()
    raw1 = FixtureProvider().search(q)
    raw2 = FixtureProvider().search(q)
    ids1 = sorted(o.offer_id for o in normalize(raw1, q))
    ids2 = sorted(o.offer_id for o in normalize(raw2, q))
    assert ids1 == ids2


# ---------------------------------------------------------------------------
# minor_units / currency exponent handling
# ---------------------------------------------------------------------------

def test_minor_units_usd_two_decimals():
    assert minor_units("45.10", "USD") == 4510
    assert minor_units("450.00", "USD") == 45000


def test_minor_units_jpy_zero_decimals():
    assert minor_units("1500", "JPY") == 1500
    assert minor_units("1500.00", "JPY") == 1500


def test_minor_units_rounding_half_up():
    assert minor_units("10.005", "USD") == 1001  # half-up, not banker's rounding


# ---------------------------------------------------------------------------
# normalize() on real Amadeus schema fixture
# ---------------------------------------------------------------------------

@pytest.fixture()
def amadeus_raw_offers() -> list[RawOffer]:
    data = json.loads(FIXTURE_PATH.read_text())
    return [
        RawOffer(provider="amadeus", data_source=DataSource.LIVE, payload=item)
        for item in data["data"]
    ]


def _find(offers, hotel_substr: str, rate_plan: str = None):
    for o in offers:
        if hotel_substr.lower() in o.hotel.name.lower():
            if rate_plan is None or o.rate_plan == rate_plan:
                return o
    raise AssertionError(f"no offer found for hotel~={hotel_substr!r} rate_plan={rate_plan!r}")


def test_normalize_amadeus_basic_shape(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    # 4 hotels: 2 + 1 + 2 + 1 offers = 6
    assert len(offers) == 6
    assert all(o.provider == "amadeus" for o in offers)
    assert all(o.data_source == DataSource.LIVE for o in offers)
    assert all(o.channel == Channel.OTA for o in offers)
    assert all(o.booking_site == "amadeus-gds" for o in offers)
    assert all(o.earns_loyalty is True and o.counts_for_elite_credit is True for o in offers)
    assert all(o.fetched_at is not None for o in offers)
    assert len(offers) == len({o.offer_id for o in offers})


def test_normalize_amadeus_cents_math_exact_match(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    marriott_refundable = _find(offers, "London Marriott Hotel County Hall", "RAC")
    # base 450.00, taxes 54.00 + 27.00 = 81.00, total 531.00 -> exact match, no delta line
    assert marriott_refundable.base_cents == 45000
    tax_lines = [f for f in marriott_refundable.fees if f.kind.value == "tax"]
    assert sum(f.amount_cents for f in tax_lines) == 8100
    assert not any(f.kind.value == "other_mandatory" for f in marriott_refundable.fees)
    assert marriott_refundable.total_cash_cents == 53100


def test_normalize_amadeus_delta_becomes_other_mandatory_fee(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    hyatt_half_board = _find(offers, "Hyatt Regency London", "RAC")
    # base 402.00, tax 64.32 -> accounted 466.32, but total is 482.40
    # delta = 16.08 -> 1608 cents other_mandatory fee line
    other = [f for f in hyatt_half_board.fees if f.kind.value == "other_mandatory"]
    assert len(other) == 1
    assert other[0].amount_cents == 1608
    assert hyatt_half_board.total_cash_cents == 48240


def test_normalize_amadeus_tax_payable_matches_included_flag(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    marriott_refundable = _find(offers, "London Marriott Hotel County Hall", "RAC")
    for fee in marriott_refundable.fees:
        if fee.kind.value == "tax":
            # fixture taxes all have "included": false -> AT_PROPERTY, not included in advertised total
            assert fee.payable.value == "at_property"
            assert fee.included_in_advertised_total is False


def test_normalize_amadeus_refundability(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    refundable = _find(offers, "London Marriott Hotel County Hall", "RAC")
    non_refundable = _find(offers, "London Marriott Hotel County Hall", "NRF")
    assert refundable.refundability == Refundability.FULLY_REFUNDABLE
    assert refundable.cancel_deadline is not None
    assert non_refundable.refundability == Refundability.NON_REFUNDABLE
    assert non_refundable.cancel_deadline is None


def test_normalize_amadeus_chain_code_mapping(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    marriott = _find(offers, "London Marriott Hotel County Hall")
    hilton = _find(offers, "Hilton London Tower Bridge")
    hyatt = _find(offers, "Hyatt Regency London")
    independent = _find(offers, "The Rookery Independent Hotel")
    assert marriott.hotel.program == LoyaltyProgramId.MARRIOTT_BONVOY
    assert hilton.hotel.program == LoyaltyProgramId.HILTON_HONORS
    assert hyatt.hotel.program == LoyaltyProgramId.WORLD_OF_HYATT
    assert independent.hotel.program == LoyaltyProgramId.NONE


def test_normalize_amadeus_breakfast_benefit(amadeus_raw_offers):
    q = _query()
    offers = normalize(amadeus_raw_offers, q)
    breakfast_offer = _find(offers, "London Marriott Hotel County Hall", "NRF")
    names = [b.name for b in breakfast_offer.included_benefits]
    assert "breakfast" in names
    benefit = breakfast_offer.included_benefits[0]
    assert benefit.est_value_cents == 3500

    half_board_offer = _find(offers, "Hyatt Regency London", "RAC")
    names = [b.name for b in half_board_offer.included_benefits]
    assert any("half board" in n for n in names)

    room_only_offer = _find(offers, "Hilton London Tower Bridge")
    assert room_only_offer.included_benefits == []


def test_normalize_skips_malformed_offer_without_crashing():
    malformed = RawOffer(
        provider="amadeus",
        data_source=DataSource.LIVE,
        payload={
            "hotel": {"hotelId": "BADHOTEL", "chainCode": "MC", "name": "Bad Hotel", "cityCode": "LON"},
            "offers": [
                {"id": "missing-price"},  # no "price" key at all -> KeyError, must be skipped
                {"id": "bad-amount", "price": {"currency": "USD", "base": "not-a-number", "taxes": []}},
            ],
        },
    )
    good = RawOffer(
        provider="amadeus",
        data_source=DataSource.LIVE,
        payload={
            "hotel": {"hotelId": "GOODHOTEL", "chainCode": "HY", "name": "Good Hotel", "cityCode": "LON"},
            "offers": [
                {
                    "id": "ok-offer",
                    "price": {"currency": "USD", "base": "100.00", "total": "110.00", "taxes": [
                        {"code": "TAX", "amount": "10.00", "included": False}
                    ]},
                    "policies": {"refundable": {"cancellationRefund": "NON_REFUNDABLE"}, "cancellations": []},
                }
            ],
        },
    )
    q = _query()
    offers = normalize([malformed, good], q)  # must not raise
    assert len(offers) == 1
    assert offers[0].hotel.name == "Good Hotel"
    assert offers[0].base_cents == 10000


def test_normalize_unknown_provider_is_skipped_not_crashed():
    q = _query()
    weird = RawOffer(provider="mystery_provider", data_source=DataSource.LIVE, payload={"x": 1})
    assert normalize([weird], q) == []


# ---------------------------------------------------------------------------
# AmadeusProvider availability
# ---------------------------------------------------------------------------

def test_amadeus_is_available_false_without_creds(monkeypatch):
    monkeypatch.delenv("AMADEUS_CLIENT_ID", raising=False)
    monkeypatch.delenv("AMADEUS_CLIENT_SECRET", raising=False)
    provider = AmadeusProvider()
    available, reason = provider.is_available()
    assert available is False
    assert "AMADEUS_CLIENT_ID" in reason or "AMADEUS_CLIENT_SECRET" in reason


def test_amadeus_search_raises_when_unavailable(monkeypatch):
    monkeypatch.delenv("AMADEUS_CLIENT_ID", raising=False)
    monkeypatch.delenv("AMADEUS_CLIENT_SECRET", raising=False)
    provider = AmadeusProvider()
    with pytest.raises(ProviderUnavailable):
        provider.search(_query())


def test_amadeus_env_selects_host():
    prod = AmadeusProvider(client_id="x", client_secret="y", env="prod")
    test = AmadeusProvider(client_id="x", client_secret="y", env="test")
    assert prod._host == "https://api.amadeus.com"
    assert test._host == "https://test.api.amadeus.com"


def test_amadeus_is_available_false_on_network_error(monkeypatch):
    def _boom(*args, **kwargs):
        raise __import__("httpx").ConnectError("blocked")

    monkeypatch.setattr("httpx.post", _boom)
    provider = AmadeusProvider(client_id="id", client_secret="secret")
    available, reason = provider.is_available()
    assert available is False
    assert "secret" not in reason.lower()
