"""Core domain models for the hotel agent.

These are the shared contracts between providers, the cost engine, the
memory store, the skeptic, and the recommendation pipeline. All money is
integer minor units (cents) plus an ISO currency code — never floats.

Every offer carries provenance (`DataSource`): LIVE means it came from a
real provider call; FIXTURE means mock/demo data and must be surfaced as
such in any user-facing output. Nothing may present FIXTURE data as live.
"""

from __future__ import annotations

import enum
import hashlib
from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class DataSource(str, enum.Enum):
    LIVE = "live"          # fetched from a real provider during this run
    FIXTURE = "fixture"    # mock/demo data — must be labelled in output


class Channel(str, enum.Enum):
    DIRECT = "direct"      # hotel/brand direct booking
    OTA = "ota"            # online travel agency (Expedia, Booking.com, ...)
    AWARD = "award"        # points/certificate redemption via the program


class Refundability(str, enum.Enum):
    FULLY_REFUNDABLE = "fully_refundable"
    PARTIALLY_REFUNDABLE = "partially_refundable"
    NON_REFUNDABLE = "non_refundable"
    UNKNOWN = "unknown"


class FeeKind(str, enum.Enum):
    TAX = "tax"                    # government taxes (occupancy, VAT, city tax)
    RESORT_FEE = "resort_fee"      # mandatory resort/destination/amenity fee
    SERVICE_FEE = "service_fee"    # booking/service charges
    CLEANING_FEE = "cleaning_fee"
    OTHER_MANDATORY = "other_mandatory"


class PayableWhen(str, enum.Enum):
    AT_BOOKING = "at_booking"
    AT_PROPERTY = "at_property"    # e.g. resort fees, city tax collected on site
    UNKNOWN = "unknown"


class LoyaltyProgramId(str, enum.Enum):
    MARRIOTT_BONVOY = "marriott_bonvoy"
    HILTON_HONORS = "hilton_honors"
    WORLD_OF_HYATT = "world_of_hyatt"
    IHG_ONE_REWARDS = "ihg_one_rewards"
    WYNDHAM_REWARDS = "wyndham_rewards"
    CHOICE_PRIVILEGES = "choice_privileges"
    ACCOR_ALL = "accor_all"
    BEST_WESTERN = "best_western_rewards"
    NONE = "none"                  # independent hotel / no program


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

class SearchQuery(BaseModel):
    destination: str                       # free text: city, area, or hotel name
    check_in: date
    check_out: date
    adults: int = 2
    rooms: int = 1
    max_total_cents: Optional[int] = None  # optional cash budget for the stay
    currency: str = "USD"
    require_refundable: bool = False

    @model_validator(mode="after")
    def _dates_ok(self) -> "SearchQuery":
        if self.check_out <= self.check_in:
            raise ValueError("check_out must be after check_in")
        return self

    @property
    def nights(self) -> int:
        return (self.check_out - self.check_in).days


# ---------------------------------------------------------------------------
# Offers
# ---------------------------------------------------------------------------

class FeeLine(BaseModel):
    kind: FeeKind
    description: str
    amount_cents: int
    payable: PayableWhen = PayableWhen.UNKNOWN
    included_in_advertised_total: bool = True


class IncludedBenefit(BaseModel):
    """A concrete benefit bundled with the rate (not a card perk)."""
    name: str                              # e.g. "breakfast for 2", "$50 property credit"
    est_value_cents: int = 0               # conservative cash value; 0 if not valued
    note: str = ""


class Hotel(BaseModel):
    name: str
    brand: str = ""                        # e.g. "Hyatt Place"
    program: LoyaltyProgramId = LoyaltyProgramId.NONE
    city: str = ""
    address: str = ""
    stars: Optional[float] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class NormalizedOffer(BaseModel):
    """A hotel offer normalized so different providers/channels compare fairly.

    `base_cents` + sum of FeeLine amounts (all mandatory) = true total cash
    cost of the stay, regardless of what the provider chose to advertise.
    Award offers set `points_cost` (+ optional `award_cash_cents` for taxes
    or cash-copay) and may leave base at 0.
    """
    offer_id: str                          # stable id for dedup/reference
    provider: str                          # e.g. "amadeus", "fixtures"
    data_source: DataSource
    channel: Channel
    booking_site: str = ""                 # e.g. "hilton.com", "expedia.com"
    hotel: Hotel
    room_description: str = ""
    rate_plan: str = ""                    # e.g. "AAA", "Member Rate", "Standard"

    currency: str = "USD"
    base_cents: int = 0                    # room rate for the whole stay, pre-tax/fee
    fees: list[FeeLine] = Field(default_factory=list)

    points_cost: Optional[int] = None      # total points for the stay (award offers)
    award_cash_cents: int = 0              # cash due alongside points (taxes/copay)

    refundability: Refundability = Refundability.UNKNOWN
    cancel_deadline: Optional[datetime] = None
    included_benefits: list[IncludedBenefit] = Field(default_factory=list)

    # Loyalty mechanics — OTA bookings usually earn nothing and get no elite perks
    earns_loyalty: bool = True
    counts_for_elite_credit: bool = True

    booking_url: str = ""                  # deep link for manual/automated booking
    raw: dict[str, Any] = Field(default_factory=dict)  # provider payload (debug)
    fetched_at: Optional[datetime] = None

    @property
    def total_cash_cents(self) -> int:
        """True all-in cash cost including every mandatory fee, however payable."""
        return self.base_cents + sum(f.amount_cents for f in self.fees) + self.award_cash_cents

    @property
    def is_award(self) -> bool:
        return self.points_cost is not None and self.points_cost > 0


class RawOffer(BaseModel):
    """Provider output before normalization."""
    provider: str
    data_source: DataSource
    payload: dict[str, Any]


# ---------------------------------------------------------------------------
# User profile / memory
# ---------------------------------------------------------------------------

class LoyaltyAccount(BaseModel):
    program: LoyaltyProgramId
    member_number_last4: str = ""          # never store full numbers
    tier: str = ""                         # e.g. "Gold", "Globalist"
    points_balance: int = 0
    free_night_certs: int = 0
    cert_max_points_value: Optional[int] = None  # e.g. Marriott 35k cert


class CardPerk(BaseModel):
    """Machine-usable metadata about one benefit of a payment card."""
    name: str                              # e.g. "$50 quarterly hotel credit"
    kind: str                              # "statement_credit" | "earn_multiplier" | "portal_cashback" | "protection" | "status"
    value_cents: int = 0                   # for credits: face value applicable to this booking domain
    earn_multiplier_x100: int = 0          # e.g. 300 = 3x points per dollar
    applies_channel: Optional[Channel] = None  # None = any channel
    applies_portal: str = ""               # e.g. "chase_travel" if portal-only
    note: str = ""


class PaymentCard(BaseModel):
    """Card metadata only — NEVER card numbers, CVVs, or expiry dates."""
    card_id: str                           # user-chosen handle, e.g. "csr"
    display_name: str                      # e.g. "Chase Sapphire Reserve"
    network: str = ""                      # visa/mc/amex — cosmetic only
    reward_currency: str = ""              # e.g. "chase_ur", "amex_mr", "cashback"
    reward_value_cpp_x100: int = 100       # cents-per-point * 100 (100 = 1.0cpp)
    perks: list[CardPerk] = Field(default_factory=list)


class PointValuation(BaseModel):
    """How much one point of a program is worth, in hundredths of a cent.

    e.g. Hyatt ~1.7cpp -> value_cpp_x100 = 170. Defaults ship in points.py
    with a source and as-of date; users can override.
    """
    program: LoyaltyProgramId
    value_cpp_x100: int
    source: str = ""
    as_of: Optional[date] = None


class UserProfile(BaseModel):
    profile_id: str = "default"
    home_currency: str = "USD"
    loyalty: list[LoyaltyAccount] = Field(default_factory=list)
    cards: list[PaymentCard] = Field(default_factory=list)
    valuation_overrides: list[PointValuation] = Field(default_factory=list)
    prefs: dict[str, Any] = Field(default_factory=dict)  # e.g. {"needs_breakfast": true}


# ---------------------------------------------------------------------------
# Cost engine output
# ---------------------------------------------------------------------------

class CostLine(BaseModel):
    """One auditable line in the effective-cost calculation."""
    label: str
    amount_cents: int                      # positive = cost, negative = value back
    note: str = ""


class EffectiveCost(BaseModel):
    """Deterministic effective-cost result for one offer + one payment card."""
    offer_id: str
    card_id: str
    lines: list[CostLine]
    effective_cents: int                   # sum of lines — the comparison number
    cash_outlay_cents: int                 # what actually leaves your account
    points_spent: int = 0
    points_earned_value_cents: int = 0
    redemption_cpp_x100: Optional[int] = None  # for awards: realized cents/point


class EarnVsBurnVerdict(BaseModel):
    """Comparison of paying cash vs burning points for the same hotel/room."""
    hotel_name: str
    cash_offer_id: Optional[str] = None
    award_offer_id: Optional[str] = None
    redemption_cpp_x100: Optional[int] = None
    baseline_cpp_x100: Optional[int] = None
    use_points: Optional[bool] = None      # None = cannot compare
    rationale: str = ""


# ---------------------------------------------------------------------------
# Skeptic & recommendation
# ---------------------------------------------------------------------------

class SkepticSeverity(str, enum.Enum):
    BLOCKER = "blocker"
    WARNING = "warning"
    INFO = "info"


class SkepticFinding(BaseModel):
    severity: SkepticSeverity
    category: str      # missed_fee | better_rate | loyalty_logic | cancellation_risk | payment_option | data_quality
    message: str
    offer_id: Optional[str] = None


class RankedOption(BaseModel):
    offer: NormalizedOffer
    cost: EffectiveCost
    rank: int
    rationale: str = ""


class Recommendation(BaseModel):
    query: SearchQuery
    options: list[RankedOption]
    best: Optional[RankedOption] = None
    earn_vs_burn: list[EarnVsBurnVerdict] = Field(default_factory=list)
    skeptic_findings: list[SkepticFinding] = Field(default_factory=list)
    revised: bool = False                   # True if skeptic pass changed the pick
    revision_notes: list[str] = Field(default_factory=list)
    contains_fixture_data: bool = False     # True → output must be labelled MOCK
    generated_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Booking abstraction
# ---------------------------------------------------------------------------

class BookingPlan(BaseModel):
    """The exact thing the user must approve before any execution."""
    plan_id: str
    offer: NormalizedOffer
    card_id: str
    total_due_now_cents: int
    total_due_at_property_cents: int
    points_due: int = 0
    refundability: Refundability
    cancel_deadline: Optional[datetime] = None
    booking_url: str = ""
    steps: list[str] = Field(default_factory=list)  # human-readable execution steps

    def approval_token(self) -> str:
        """Token the user must echo back to approve exactly this plan."""
        digest = hashlib.sha256(
            f"{self.offer.offer_id}|{self.card_id}|{self.total_due_now_cents}|{self.points_due}".encode()
        ).hexdigest()[:10]
        return f"BOOK-{digest}"


class ExplicitApproval(BaseModel):
    plan_id: str
    token: str          # must equal BookingPlan.approval_token()
    approved_at: datetime
