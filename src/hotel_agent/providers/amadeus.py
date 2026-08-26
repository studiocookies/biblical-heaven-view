"""Amadeus Self-Service (test/production) hotel search provider.

Real API client built from Amadeus for Developers documentation:
  - OAuth2 client-credentials:  POST /v1/security/oauth2/token
  - City lookup (fallback):     GET  /v1/reference-data/locations?subType=CITY&keyword=...
  - Hotels in a city:           GET  /v1/reference-data/locations/hotels/by-city?cityCode=...
  - Hotel offers:                GET  /v3/shopping/hotel-offers?hotelIds=...&checkInDate=...

Outbound network to real hotel APIs is blocked in this dev/CI environment, so
this client has never been live-tested end to end. Parsing is written
defensively (schema-tolerant, skip-and-log on the unexpected) against the
documented/observed v3 hotel-offers response shape, and exercised in tests
against a realistic recorded-schema fixture
(tests/fixtures/amadeus_hotel_offers.json) rather than a live call.

Every offer this provider returns carries `DataSource.LIVE` because it is
only ever constructed from an actual Amadeus API response.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import httpx

from hotel_agent.models import DataSource, RawOffer, SearchQuery
from hotel_agent.providers.base import HotelSearchProvider, ProviderUnavailable

logger = logging.getLogger(__name__)

_TEST_HOST = "https://test.api.amadeus.com"
_PROD_HOST = "https://api.amadeus.com"

_DEFAULT_TIMEOUT = 8.0
_MAX_HOTEL_IDS = 20

# Static destination -> IATA city code map for ~25 major cities. Free-text
# destinations that don't match are resolved via the reference-data/locations
# search endpoint as a fallback.
CITY_CODE_MAP: dict[str, str] = {
    "new york": "NYC",
    "new york city": "NYC",
    "nyc": "NYC",
    "chicago": "CHI",
    "miami": "MIA",
    "los angeles": "LAX",
    "san francisco": "SFO",
    "las vegas": "LAS",
    "boston": "BOS",
    "washington": "WAS",
    "washington dc": "WAS",
    "seattle": "SEA",
    "orlando": "ORL",
    "london": "LON",
    "paris": "PAR",
    "tokyo": "TYO",
    "rome": "ROM",
    "madrid": "MAD",
    "barcelona": "BCN",
    "amsterdam": "AMS",
    "berlin": "BER",
    "dubai": "DXB",
    "singapore": "SIN",
    "hong kong": "HKG",
    "sydney": "SYD",
    "toronto": "YTO",
    "mexico city": "MEX",
    "cancun": "CUN",
    "bangkok": "BKK",
}

# chainCode (2-letter Amadeus/GDS chain code) -> LoyaltyProgramId name string.
# Kept here (not in normalize.py) since it is Amadeus-specific vocabulary;
# normalize.py owns the actual LoyaltyProgramId mapping table it imports.
CHAIN_CODE_TO_PROGRAM: dict[str, str] = {
    "MC": "marriott_bonvoy", "MA": "marriott_bonvoy", "RZ": "marriott_bonvoy",
    "WH": "marriott_bonvoy", "SI": "marriott_bonvoy", "WI": "marriott_bonvoy",
    "HL": "hilton_honors", "HH": "hilton_honors", "CN": "hilton_honors", "WA": "hilton_honors",
    "HY": "world_of_hyatt", "HU": "world_of_hyatt",
    "IC": "ihg_one_rewards", "HI": "ihg_one_rewards", "CP": "ihg_one_rewards", "YZ": "ihg_one_rewards",
    "WY": "wyndham_rewards", "RA": "wyndham_rewards",
}


class AmadeusProvider(HotelSearchProvider):
    """Hotel search backed by the real Amadeus Self-Service API."""

    name = "amadeus"

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        env: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> None:
        self._client_id = client_id if client_id is not None else os.environ.get("AMADEUS_CLIENT_ID")
        self._client_secret = client_secret if client_secret is not None else os.environ.get("AMADEUS_CLIENT_SECRET")
        env_name = (env if env is not None else os.environ.get("AMADEUS_ENV", "test")) or "test"
        self._host = _PROD_HOST if env_name.strip().lower() == "prod" else _TEST_HOST
        self._timeout = timeout

        self._token: Optional[str] = None
        self._token_expires_at: float = 0.0

    # -- availability / auth ------------------------------------------------

    def is_available(self) -> tuple[bool, str]:
        if not self._client_id or not self._client_secret:
            return False, "AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET not set"
        try:
            self._ensure_token()
        except ProviderUnavailable as exc:
            return False, str(exc)
        return True, f"amadeus OAuth token acquired ({self._host})"

    def _ensure_token(self) -> str:
        """Return a cached or freshly fetched OAuth2 access token."""
        now = time.monotonic()
        if self._token and now < self._token_expires_at:
            return self._token

        if not self._client_id or not self._client_secret:
            raise ProviderUnavailable("AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET not set")

        try:
            resp = httpx.post(
                f"{self._host}/v1/security/oauth2/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            # Never include the secret in the log/exception message.
            raise ProviderUnavailable(f"amadeus auth network error: {exc.__class__.__name__}") from exc

        if resp.status_code != 200:
            raise ProviderUnavailable(f"amadeus auth failed: HTTP {resp.status_code}")

        try:
            body = resp.json()
            token = body["access_token"]
            expires_in = float(body.get("expires_in", 1800))
        except (ValueError, KeyError) as exc:
            raise ProviderUnavailable("amadeus auth response malformed") from exc

        self._token = token
        # Refresh a little early to avoid racing expiry mid-request.
        self._token_expires_at = now + max(expires_in - 30.0, 30.0)
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._ensure_token()}"}

    # -- search ---------------------------------------------------------

    def search(self, query: SearchQuery) -> list[RawOffer]:
        available, reason = self.is_available()
        if not available:
            raise ProviderUnavailable(reason)

        city_code = self._resolve_city_code(query.destination)
        if not city_code:
            logger.warning("amadeus: could not resolve destination %r to a city code", query.destination)
            return []

        hotel_ids = self._hotels_by_city(city_code)
        if not hotel_ids:
            logger.warning("amadeus: no hotels found for city code %s", city_code)
            return []

        offers_data = self._hotel_offers(hotel_ids, query)
        raw: list[RawOffer] = []
        for item in offers_data:
            if not isinstance(item, dict):
                continue
            raw.append(RawOffer(provider=self.name, data_source=DataSource.LIVE, payload=item))
        return raw

    def _resolve_city_code(self, destination: str) -> Optional[str]:
        key = destination.strip().lower()
        if key in CITY_CODE_MAP:
            return CITY_CODE_MAP[key]

        try:
            resp = httpx.get(
                f"{self._host}/v1/reference-data/locations",
                params={"subType": "CITY", "keyword": destination},
                headers=self._headers(),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            logger.warning("amadeus: city lookup network error: %s", exc.__class__.__name__)
            return None

        if resp.status_code == 429:
            logger.warning("amadeus: city lookup rate limited (429)")
            return None
        if resp.status_code != 200:
            logger.warning("amadeus: city lookup failed: HTTP %s", resp.status_code)
            return None

        try:
            data = resp.json().get("data", [])
            for entry in data:
                code = entry.get("iataCode") or entry.get("address", {}).get("cityCode")
                if code:
                    return code
        except (ValueError, AttributeError) as exc:
            logger.warning("amadeus: city lookup response malformed: %s", exc)
        return None

    def _hotels_by_city(self, city_code: str) -> list[str]:
        try:
            resp = httpx.get(
                f"{self._host}/v1/reference-data/locations/hotels/by-city",
                params={"cityCode": city_code},
                headers=self._headers(),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            logger.warning("amadeus: hotels-by-city network error: %s", exc.__class__.__name__)
            return []

        if resp.status_code == 429:
            logger.warning("amadeus: hotels-by-city rate limited (429)")
            return []
        if resp.status_code != 200:
            logger.warning("amadeus: hotels-by-city failed: HTTP %s", resp.status_code)
            return []

        try:
            data = resp.json().get("data", [])
        except ValueError as exc:
            logger.warning("amadeus: hotels-by-city response malformed: %s", exc)
            return []

        ids: list[str] = []
        for entry in data:
            hotel_id = entry.get("hotelId") if isinstance(entry, dict) else None
            if hotel_id:
                ids.append(hotel_id)
            if len(ids) >= _MAX_HOTEL_IDS:
                break
        return ids

    def _hotel_offers(self, hotel_ids: list[str], query: SearchQuery) -> list[dict[str, Any]]:
        try:
            resp = httpx.get(
                f"{self._host}/v3/shopping/hotel-offers",
                params={
                    "hotelIds": ",".join(hotel_ids),
                    "checkInDate": query.check_in.isoformat(),
                    "checkOutDate": query.check_out.isoformat(),
                    "adults": query.adults,
                    "roomQuantity": query.rooms,
                    "currency": query.currency,
                    "bestRateOnly": "false",
                },
                headers=self._headers(),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            logger.warning("amadeus: hotel-offers network error: %s", exc.__class__.__name__)
            return []

        if resp.status_code == 429:
            logger.warning("amadeus: hotel-offers rate limited (429)")
            return []
        if resp.status_code != 200:
            logger.warning("amadeus: hotel-offers failed: HTTP %s (%s)", resp.status_code, resp.text[:200])
            return []

        try:
            return resp.json().get("data", [])
        except ValueError as exc:
            logger.warning("amadeus: hotel-offers response malformed: %s", exc)
            return []
