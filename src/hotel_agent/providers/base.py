"""Provider abstraction: anything that can produce hotel offers.

Providers return RawOffers; `normalize.py` turns them into NormalizedOffers.
A provider must declare availability honestly: `is_available()` returns False
(with a reason) when credentials or network access are missing, so the
pipeline can fall back and *label* the fallback instead of faking liveness.
"""

from __future__ import annotations

import abc

from hotel_agent.models import RawOffer, SearchQuery


class ProviderUnavailable(Exception):
    """Raised when a provider is called despite not being available."""


class HotelSearchProvider(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    def is_available(self) -> tuple[bool, str]:
        """(available, reason). Reason explains unavailability for the report."""

    @abc.abstractmethod
    def search(self, query: SearchQuery) -> list[RawOffer]:
        """Return raw offers. Must raise ProviderUnavailable if not available."""
