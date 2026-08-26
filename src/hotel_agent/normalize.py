"""Turn provider `RawOffer`s into comparable `NormalizedOffer`s.

Dispatches on `RawOffer.provider`:

- "fixtures": the payload is already shaped like
  `NormalizedOffer.model_dump(mode="json")` (minus `offer_id`/`fetched_at` —
  see `providers/fixtures.py`). We compute a stable `offer_id` and validate.
  `fetched_at` stays `None`: fixture data was generated, not fetched.

- "amadeus": the payload is one raw Amadeus v3 `hotel-offers` response item
  (`{"hotel": {...}, "offers": [...]}`), possibly containing several rate
  offers for one hotel. Each offer is mapped to a `NormalizedOffer` using
  `decimal.Decimal` for currency-minor-unit math (never floats).

Parsing is tolerant everywhere: a malformed individual offer is skipped with
`logging.warning` rather than raising, so one bad record never takes down a
whole search. Output is deduped by `offer_id` and sorted by it for
deterministic ordering.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from pydantic import ValidationError

from hotel_agent.currency import CURRENCY_EXPONENTS, exponent
from hotel_agent.models import (
    Channel,
    DataSource,
    FeeKind,
    FeeLine,
    Hotel,
    IncludedBenefit,
    LoyaltyProgramId,
    NormalizedOffer,
    PayableWhen,
    RawOffer,
    Refundability,
    SearchQuery,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Currency minor-unit exponents (ISO 4217). Sourced from hotel_agent.currency
# (the frozen, shared source of truth); `CURRENCY_EXPONENTS` is re-exported
# here only for back-compat with code/tests that import it from this module.
# ---------------------------------------------------------------------------


def minor_units(amount: str | float | int, currency: str) -> int:
    """Convert a decimal-string amount into integer minor units (cents).

    Uses `decimal.Decimal` (never float) so e.g. "45.10" USD -> 4510, and
    a zero-decimal currency like JPY treats "1500" as 1500 (not 150000).
    """
    exp = exponent(currency or "")
    value = Decimal(str(amount))
    scaled = value * (Decimal(10) ** exp)
    return int(scaled.to_integral_value(rounding="ROUND_HALF_UP"))


# ---------------------------------------------------------------------------
# chainCode (Amadeus/GDS 2-letter chain code) -> LoyaltyProgramId
# ---------------------------------------------------------------------------

_CHAIN_CODE_TO_PROGRAM: dict[str, LoyaltyProgramId] = {
    "MC": LoyaltyProgramId.MARRIOTT_BONVOY,
    "MA": LoyaltyProgramId.MARRIOTT_BONVOY,
    "RZ": LoyaltyProgramId.MARRIOTT_BONVOY,
    "WH": LoyaltyProgramId.MARRIOTT_BONVOY,
    "SI": LoyaltyProgramId.MARRIOTT_BONVOY,
    "WI": LoyaltyProgramId.MARRIOTT_BONVOY,
    "HL": LoyaltyProgramId.HILTON_HONORS,
    "HH": LoyaltyProgramId.HILTON_HONORS,
    "CN": LoyaltyProgramId.HILTON_HONORS,
    "WA": LoyaltyProgramId.HILTON_HONORS,
    "HY": LoyaltyProgramId.WORLD_OF_HYATT,
    "HU": LoyaltyProgramId.WORLD_OF_HYATT,
    "IC": LoyaltyProgramId.IHG_ONE_REWARDS,
    "HI": LoyaltyProgramId.IHG_ONE_REWARDS,
    "CP": LoyaltyProgramId.IHG_ONE_REWARDS,
    "YZ": LoyaltyProgramId.IHG_ONE_REWARDS,
    "WY": LoyaltyProgramId.WYNDHAM_REWARDS,
    "RA": LoyaltyProgramId.WYNDHAM_REWARDS,
}

_BOARD_TYPE_BENEFIT: dict[str, str] = {
    "BREAKFAST": "breakfast",
    "HALF_BOARD": "half board (breakfast & dinner)",
    "FULL_BOARD": "full board (all meals)",
    "ALL_INCLUSIVE": "all-inclusive meals & drinks",
}

_CONSERVATIVE_BOARD_VALUE_CENTS = 3500


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def normalize(raw_offers: list[RawOffer], query: SearchQuery) -> list[NormalizedOffer]:
    """Normalize + dedup (by offer_id) + sort (by offer_id) provider output."""
    by_id: dict[str, NormalizedOffer] = {}

    for raw in raw_offers:
        if raw.provider == "fixtures":
            offers = _normalize_fixture_offer(raw)
        elif raw.provider == "amadeus":
            offers = _normalize_amadeus_item(raw, query)
        else:
            logger.warning("normalize: unknown provider %r, skipping raw offer", raw.provider)
            offers = []

        for offer in offers:
            by_id.setdefault(offer.offer_id, offer)

    return sorted(by_id.values(), key=lambda o: o.offer_id)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def _normalize_fixture_offer(raw: RawOffer) -> list[NormalizedOffer]:
    try:
        payload = dict(raw.payload)
        hotel = payload.get("hotel") or {}
        hotel_key = f"{hotel.get('name', '')}@{hotel.get('address', '')}"
        id_source = "|".join(
            [
                raw.provider,
                hotel_key,
                str(payload.get("channel", "")),
                str(payload.get("rate_plan", "")),
                str(payload.get("room_description", "")),
            ]
        )
        payload["offer_id"] = hashlib.sha1(id_source.encode("utf-8")).hexdigest()[:12]
        # Fixture data was generated, not fetched from a live provider.
        payload["fetched_at"] = None
        return [NormalizedOffer.model_validate(payload)]
    except (ValidationError, TypeError, KeyError) as exc:
        logger.warning("normalize(fixtures): skipping malformed offer: %s", exc)
        return []


# ---------------------------------------------------------------------------
# amadeus
# ---------------------------------------------------------------------------

def _normalize_amadeus_item(raw: RawOffer, query: SearchQuery) -> list[NormalizedOffer]:
    item = raw.payload or {}
    hotel_payload = item.get("hotel") or {}

    chain_code = str(hotel_payload.get("chainCode") or "").upper()
    program = _CHAIN_CODE_TO_PROGRAM.get(chain_code, LoyaltyProgramId.NONE)
    hotel = Hotel(
        name=str(hotel_payload.get("name") or "Unknown Hotel").title(),
        brand="",
        program=program,
        city=str(hotel_payload.get("cityCode") or ""),
        address="",
        stars=None,
        latitude=hotel_payload.get("latitude"),
        longitude=hotel_payload.get("longitude"),
    )
    hotel_id = str(hotel_payload.get("hotelId") or "")

    results: list[NormalizedOffer] = []
    for offer in item.get("offers") or []:
        try:
            results.append(_normalize_one_amadeus_offer(raw, hotel, hotel_id, hotel_payload, offer, query))
        except (KeyError, TypeError, ValueError, InvalidOperation, ValidationError) as exc:
            logger.warning(
                "normalize(amadeus): skipping malformed offer id=%r for hotel=%r: %s",
                (offer or {}).get("id") if isinstance(offer, dict) else None,
                hotel_id,
                exc,
            )
            continue
    return results


def _normalize_one_amadeus_offer(
    raw: RawOffer,
    hotel: Hotel,
    hotel_id: str,
    hotel_payload: dict[str, Any],
    offer: dict[str, Any],
) -> NormalizedOffer:
    price = offer["price"]
    currency = str(price["currency"])
    base_cents = minor_units(price["base"], currency)

    fees: list[FeeLine] = []
    tax_total_cents = 0
    for tax in price.get("taxes") or []:
        amount = tax.get("amount")
        if amount is None:
            continue
        cents = minor_units(amount, tax.get("currency", currency))
        included = bool(tax.get("included", False))
        fees.append(
            FeeLine(
                kind=FeeKind.TAX,
                description=str(tax.get("code") or "Tax"),
                amount_cents=cents,
                payable=PayableWhen.AT_BOOKING if included else PayableWhen.AT_PROPERTY,
                included_in_advertised_total=included,
            )
        )
        tax_total_cents += cents

    total_raw = price.get("total")
    if total_raw is not None:
        total_cents = minor_units(total_raw, currency)
        delta = total_cents - (base_cents + tax_total_cents)
        if delta > 0:
            fees.append(
                FeeLine(
                    kind=FeeKind.OTHER_MANDATORY,
                    description="rate difference/fees",
                    amount_cents=delta,
                    payable=PayableWhen.AT_BOOKING,
                    included_in_advertised_total=True,
                )
            )
        elif delta < 0:
            logger.warning(
                "normalize(amadeus): offer %r total (%s) is less than base+taxes for hotel=%r; "
                "not adding a negative fee line",
                offer.get("id"),
                total_raw,
                hotel_id,
            )

    room = offer.get("room") or {}
    room_desc = (
        (room.get("description") or {}).get("text")
        or (room.get("typeEstimated") or {}).get("category")
        or ""
    )
    rate_plan = str(
        offer.get("rateCode") or (offer.get("rateFamilyEstimated") or {}).get("code") or ""
    )

    included_benefits: list[IncludedBenefit] = []
    board_type = str(offer.get("boardType") or "").upper()
    if board_type in _BOARD_TYPE_BENEFIT:
        included_benefits.append(
            IncludedBenefit(
                name=_BOARD_TYPE_BENEFIT[board_type],
                est_value_cents=_CONSERVATIVE_BOARD_VALUE_CENTS,
                note="valued conservatively",
            )
        )

    policies = offer.get("policies") or {}
    refundability = _map_refundability(policies)
    cancel_deadline = _parse_cancel_deadline(policies)

    offer_id_source = f"amadeus|{hotel_id}|{offer.get('id', '')}"
    offer_id = hashlib.sha1(offer_id_source.encode("utf-8")).hexdigest()[:12]

    # Amadeus is a GDS aggregator, not a direct-brand channel. GDS rates are
    # bookable through the chain's own reservation system and, per Amadeus/
    # chain documentation, generally do earn points and count toward elite
    # night credit like any other qualifying paid stay — but this cannot be
    # verified per-rate from the API response alone (some negotiated/opaque
    # GDS rates do not earn). We keep both True and are explicit about that
    # uncertainty here rather than silently guessing.
    return NormalizedOffer(
        offer_id=offer_id,
        provider="amadeus",
        data_source=raw.data_source,
        channel=Channel.OTA,
        booking_site="amadeus-gds",
        hotel=hotel,
        room_description=str(room_desc) or "",
        rate_plan=rate_plan,
        currency=currency,
        base_cents=base_cents,
        fees=fees,
        refundability=refundability,
        cancel_deadline=cancel_deadline,
        included_benefits=included_benefits,
        earns_loyalty=True,
        counts_for_elite_credit=True,
        booking_url=str(offer.get("self") or ""),
        raw={"hotel": hotel_payload, "offer": offer},
        fetched_at=datetime.now(timezone.utc) if raw.data_source == DataSource.LIVE else None,
    )


def _map_refundability(policies: dict[str, Any]) -> Refundability:
    refundable = (policies.get("refundable") or {}).get("cancellationRefund")
    refundable = str(refundable or "").upper()
    if refundable == "NON_REFUNDABLE":
        return Refundability.NON_REFUNDABLE
    if refundable in ("REFUNDABLE_UP_TO_DEADLINE", "FULLY_REFUNDABLE", "REFUNDABLE"):
        return Refundability.FULLY_REFUNDABLE
    if refundable == "PARTIALLY_REFUNDABLE":
        return Refundability.PARTIALLY_REFUNDABLE
    return Refundability.UNKNOWN


def _parse_cancel_deadline(policies: dict[str, Any]) -> Optional[datetime]:
    cancellations = policies.get("cancellations") or []
    if not cancellations:
        return None
    deadline_str = cancellations[0].get("deadline")
    if not deadline_str:
        return None
    try:
        return datetime.fromisoformat(str(deadline_str).replace("Z", "+00:00"))
    except ValueError:
        logger.warning("normalize(amadeus): unparsable cancel deadline %r", deadline_str)
        return None
