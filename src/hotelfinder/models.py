"""Small shared data types. Deliberately flat and simple.

Money is integer cents so comparisons are exact.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SearchInput(BaseModel):
    check_in: str          # YYYY-MM-DD
    check_out: str         # YYYY-MM-DD
    zip_code: str
    nights: int

    @property
    def label(self) -> str:
        return f"{self.zip_code}, {self.check_in} -> {self.check_out} ({self.nights} night(s))"


class Stay(BaseModel):
    """One hotel/motel option found on the internet."""

    name: str
    kind: str = "hotel"                     # hotel | motel | inn
    city: str = ""

    nightly_cents: int = 0
    total_cents: int = 0                    # whole stay, incl. taxes/fees when known
    fees_note: str = ""                     # e.g. "+$25/night resort fee at property"

    source: str = ""                        # where the price came from, e.g. "booking.com"
    source_url: str = ""

    review_score: Optional[float] = None    # normalized to 0-10
    review_count: Optional[int] = None
    review_source: str = ""

    concerns: list[str] = Field(default_factory=list)     # downsides worth knowing
    highlights: list[str] = Field(default_factory=list)

    distance_note: str = ""                 # e.g. "3 mi from ZIP centroid"
    cancellation: str = ""                  # free cancellation | non-refundable | unknown
    price_confidence: str = "medium"        # high | medium | low

    def dollars(self, cents: int) -> str:
        return f"${cents / 100:,.2f}"


class Pick(BaseModel):
    stay: Stay
    why: str = ""


class Result(BaseModel):
    query: SearchInput
    cheapest: Optional[Pick] = None
    best_value: Optional[Pick] = None
    all_stays: list[Stay] = Field(default_factory=list)
    sources_searched: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
