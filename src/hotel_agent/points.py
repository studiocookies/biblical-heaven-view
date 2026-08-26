"""Default point valuations and earn rates for supported loyalty programs.

All community-consensus numbers here are estimates, mid-2025, and should be
overridden by the user's own valuation in `UserProfile.valuation_overrides`
where they have a more informed view (e.g. from a specific redemption they
are eyeing, or a personal valuation model).
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel

from hotel_agent.models import LoyaltyProgramId, PointValuation, UserProfile

_AS_OF = date(2025, 6, 1)
_SOURCE = "community consensus estimates, mid-2025 — user should override with their own"


# ---------------------------------------------------------------------------
# Point valuations (value_cpp_x100 = hundredths of a cent per point)
# ---------------------------------------------------------------------------

DEFAULT_VALUATIONS: dict[LoyaltyProgramId, PointValuation] = {
    LoyaltyProgramId.WORLD_OF_HYATT: PointValuation(
        program=LoyaltyProgramId.WORLD_OF_HYATT,
        value_cpp_x100=170,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.MARRIOTT_BONVOY: PointValuation(
        program=LoyaltyProgramId.MARRIOTT_BONVOY,
        value_cpp_x100=80,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.HILTON_HONORS: PointValuation(
        program=LoyaltyProgramId.HILTON_HONORS,
        value_cpp_x100=50,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.IHG_ONE_REWARDS: PointValuation(
        program=LoyaltyProgramId.IHG_ONE_REWARDS,
        value_cpp_x100=60,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.WYNDHAM_REWARDS: PointValuation(
        program=LoyaltyProgramId.WYNDHAM_REWARDS,
        value_cpp_x100=100,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.CHOICE_PRIVILEGES: PointValuation(
        program=LoyaltyProgramId.CHOICE_PRIVILEGES,
        value_cpp_x100=60,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    # Accor points are worth ~2c each (e.g. 2000 pts = EUR 40 reward voucher),
    # far higher cpp than US hotel programs since Accor uses a low points-per-
    # dollar earn rate to compensate.
    LoyaltyProgramId.ACCOR_ALL: PointValuation(
        program=LoyaltyProgramId.ACCOR_ALL,
        value_cpp_x100=2000,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.BEST_WESTERN: PointValuation(
        program=LoyaltyProgramId.BEST_WESTERN,
        value_cpp_x100=60,
        source=_SOURCE,
        as_of=_AS_OF,
    ),
    LoyaltyProgramId.NONE: PointValuation(
        program=LoyaltyProgramId.NONE,
        value_cpp_x100=0,
        source="no program",
        as_of=_AS_OF,
    ),
}


def get_valuation_cpp_x100(program: LoyaltyProgramId, profile: UserProfile) -> int:
    """Return the cents-per-point*100 to use for `program`.

    A matching entry in `profile.valuation_overrides` wins over the default.
    `LoyaltyProgramId.NONE` is always 0 (no program, no points value).
    """
    if program == LoyaltyProgramId.NONE:
        return 0
    for override in profile.valuation_overrides:
        if override.program == program:
            return override.value_cpp_x100
    default = DEFAULT_VALUATIONS.get(program)
    return default.value_cpp_x100 if default is not None else 0


# ---------------------------------------------------------------------------
# Base earn rates (points earned per USD of eligible spend)
# ---------------------------------------------------------------------------

class _BaseEarnRate(BaseModel):
    program: LoyaltyProgramId
    earn_per_usd_x100: int  # e.g. 1000 = 10 points per USD


BASE_EARN_RATES: dict[LoyaltyProgramId, _BaseEarnRate] = {
    LoyaltyProgramId.MARRIOTT_BONVOY: _BaseEarnRate(
        program=LoyaltyProgramId.MARRIOTT_BONVOY, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.HILTON_HONORS: _BaseEarnRate(
        program=LoyaltyProgramId.HILTON_HONORS, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.WORLD_OF_HYATT: _BaseEarnRate(
        program=LoyaltyProgramId.WORLD_OF_HYATT, earn_per_usd_x100=500
    ),
    LoyaltyProgramId.IHG_ONE_REWARDS: _BaseEarnRate(
        program=LoyaltyProgramId.IHG_ONE_REWARDS, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.WYNDHAM_REWARDS: _BaseEarnRate(
        program=LoyaltyProgramId.WYNDHAM_REWARDS, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.CHOICE_PRIVILEGES: _BaseEarnRate(
        program=LoyaltyProgramId.CHOICE_PRIVILEGES, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.ACCOR_ALL: _BaseEarnRate(
        program=LoyaltyProgramId.ACCOR_ALL, earn_per_usd_x100=250
    ),
    LoyaltyProgramId.BEST_WESTERN: _BaseEarnRate(
        program=LoyaltyProgramId.BEST_WESTERN, earn_per_usd_x100=1000
    ),
    LoyaltyProgramId.NONE: _BaseEarnRate(
        program=LoyaltyProgramId.NONE, earn_per_usd_x100=0
    ),
}


# Elite tier earn bonuses, in percent, keyed by lowercased tier name.
# An unknown/unlisted tier (including "") resolves to 0 bonus (base rate).
ELITE_BONUS: dict[LoyaltyProgramId, dict[str, int]] = {
    LoyaltyProgramId.MARRIOTT_BONVOY: {
        "silver": 10,
        "gold": 25,
        "platinum": 50,
        "titanium": 75,
        "ambassador": 75,
    },
    LoyaltyProgramId.HILTON_HONORS: {
        "silver": 20,
        "gold": 80,
        "diamond": 100,
    },
    LoyaltyProgramId.WORLD_OF_HYATT: {
        "discoverist": 10,
        "explorist": 20,
        "globalist": 30,
    },
    LoyaltyProgramId.IHG_ONE_REWARDS: {
        "silver": 20,
        "gold": 40,
        "platinum": 60,
        "diamond": 100,
    },
    LoyaltyProgramId.WYNDHAM_REWARDS: {
        "gold": 10,
        "platinum": 15,
        "diamond": 25,
    },
    LoyaltyProgramId.CHOICE_PRIVILEGES: {
        "gold": 10,
        "platinum": 20,
        "diamond": 30,
    },
    LoyaltyProgramId.ACCOR_ALL: {
        "silver": 10,
        "gold": 25,
        "platinum": 50,
        "diamond": 50,
    },
    LoyaltyProgramId.BEST_WESTERN: {
        "gold": 10,
        "platinum": 20,
        "diamond": 30,
    },
    LoyaltyProgramId.NONE: {},
}


def get_earn_per_usd_x100(program: LoyaltyProgramId, tier: str) -> int:
    """Points earned per USD of eligible spend (x100), including elite bonus.

    `base * (100 + bonus_percent) / 100`, integer division. Unknown program
    or unknown/blank tier falls back to base rate with no bonus.
    """
    base_entry = BASE_EARN_RATES.get(program)
    base = base_entry.earn_per_usd_x100 if base_entry is not None else 0
    bonus = ELITE_BONUS.get(program, {}).get((tier or "").strip().lower(), 0)
    return base * (100 + bonus) // 100
