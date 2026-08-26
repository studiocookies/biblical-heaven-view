"""Pick/ranking logic for the hotel-deal finder.

Two picks come out of this module:

- ``pick_cheapest``   -- the absolute lowest legitimate price, no quality filter.
- ``pick_best_value`` -- the best balance of price vs. quality; may equal the
  cheapest when nothing beats it, but is never chosen by price alone.

Plain functions only, no I/O, no network, no printing. Money stays integer
cents throughout; only the derived "quality" and "value" scores are floats.
"""

from __future__ import annotations

from .models import Pick, Result, SearchInput, Stay

# ---------------------------------------------------------------------------
# Concern keyword tables
# ---------------------------------------------------------------------------

SEVERE_CONCERN_KEYWORDS: frozenset[str] = frozenset(
    {
        "bed bug",
        "bedbug",
        "roach",
        "cockroach",
        "mold",
        "filthy",
        "feces",
        "unsafe",
        "crime",
        "prostitution",
        "drug",
        "no running water",
        "black mold",
        "sewage",
        "infestation",
        "human trafficking",
        "condemned",
    }
)

MODERATE_CONCERN_KEYWORDS: frozenset[str] = frozenset(
    {
        "dirty",
        "dated",
        "noisy",
        "noise",
        "thin walls",
        "smell",
        "smoke",
        "worn",
        "rude",
        "slow wifi",
        "no breakfast",
        "parking fee",
        "construction",
        "stained",
        "broken",
    }
)

# ---------------------------------------------------------------------------
# Scoring constants
# ---------------------------------------------------------------------------

SEVERE_CONCERN_PENALTY = -1.5
MODERATE_CONCERN_PENALTY = -0.5
CONCERN_PENALTY_CAP = -4.0

DEFAULT_REVIEW_SCORE = 6.0
UNKNOWN_REVIEW_PENALTY = -0.3
PRICE_WEIGHT = 12.0
THIN_REVIEW_COUNT = 15
THIN_REVIEW_PENALTY = -0.4


def concern_penalty(stay: Stay) -> float:
    """Penalty from ``stay.concerns`` text. Always <= 0.0, capped at -4.0.

    Each concern string contributes at most one hit: a severe keyword match
    (-1.5) takes precedence over a moderate keyword match (-0.5) within that
    same string, so a single string never counts twice.
    """
    total = 0.0
    for concern in stay.concerns:
        text = concern.lower()
        if any(keyword in text for keyword in SEVERE_CONCERN_KEYWORDS):
            total += SEVERE_CONCERN_PENALTY
        elif any(keyword in text for keyword in MODERATE_CONCERN_KEYWORDS):
            total += MODERATE_CONCERN_PENALTY
    return max(total, CONCERN_PENALTY_CAP)


def quality_points(stay: Stay) -> float:
    """A 0-10 "how decent is this place, honestly" score."""
    if stay.review_score is not None:
        points = stay.review_score
    else:
        points = DEFAULT_REVIEW_SCORE + UNKNOWN_REVIEW_PENALTY

    if stay.review_count is not None and stay.review_count < THIN_REVIEW_COUNT:
        points += THIN_REVIEW_PENALTY

    points += concern_penalty(stay)

    return max(0.0, min(10.0, points))


def is_legitimate(stay: Stay) -> bool:
    """A stay is a candidate for recommendation only if we trust it exists
    and trust its price. Low-confidence prices are ones we could not
    corroborate, so they never become a recommendation.
    """
    return (
        stay.total_cents > 0
        and bool(stay.name.strip())
        and stay.price_confidence != "low"
    )


def pick_cheapest(stays: list[Stay]) -> Stay | None:
    """The lowest total price among legitimate stays, quality be damned."""
    legitimate = [s for s in stays if is_legitimate(s)]
    if not legitimate:
        return None
    return min(legitimate, key=lambda s: (s.total_cents, s.name))


def value_score(stay: Stay, cheapest_total_cents: int) -> float:
    """Quality points minus a penalty proportional to how much pricier this
    stay is than the cheapest option. A stay that costs 17% more than the
    cheapest needs to be roughly 12.0 * 0.17 =~ 2.1 quality points better to
    come out ahead.
    """
    if cheapest_total_cents <= 0:
        extra_cost_ratio = 0.0
    else:
        extra_cost_ratio = (stay.total_cents - cheapest_total_cents) / cheapest_total_cents
        extra_cost_ratio = max(0.0, extra_cost_ratio)
    return quality_points(stay) - PRICE_WEIGHT * extra_cost_ratio


def pick_best_value(stays: list[Stay], cheapest: Stay | None = None) -> Stay | None:
    """The best balance of price vs. quality among legitimate stays.

    May legitimately return the same stay as ``pick_cheapest`` when nothing
    beats it on value -- but it is never chosen for being cheap alone.
    """
    legitimate = [s for s in stays if is_legitimate(s)]
    if not legitimate:
        return None

    if cheapest is None:
        cheapest = pick_cheapest(stays)
    if cheapest is None:
        return None

    baseline_cents = cheapest.total_cents
    return min(
        legitimate,
        key=lambda s: (-value_score(s, baseline_cents), s.total_cents, s.name),
    )


def _review_summary(stay: Stay) -> str | None:
    """A short, honest note about review trustworthiness, or None if fine."""
    if stay.review_score is None:
        return "no review score is available"
    if stay.review_count is not None and stay.review_count < THIN_REVIEW_COUNT:
        return f"only {stay.review_count} review(s) back up its {stay.review_score:.1f}/10 score"
    return None


def explain_cheapest(stay: Stay) -> str:
    """One or two plain, honest sentences about the cheapest pick."""
    price = stay.dollars(stay.total_cents)
    sentence_one = f"{stay.name} is the cheapest legitimate option at {price} total."

    downsides: list[str] = []
    if stay.concerns:
        downsides.append("reported concerns: " + "; ".join(stay.concerns))
    review_note = _review_summary(stay)
    if review_note:
        downsides.append(review_note)
    if stay.fees_note:
        downsides.append(stay.fees_note)

    if downsides:
        sentence_two = "Before booking, know that " + "; ".join(downsides) + "."
    else:
        sentence_two = "No notable downsides were reported."

    return f"{sentence_one} {sentence_two}"


def _score_label(stay: Stay) -> str:
    if stay.review_score is None:
        return "unknown"
    return f"{stay.review_score:.1f}/10"


def explain_best_value(stay: Stay, cheapest: Stay | None) -> str:
    """Explain why this pick beats (or equals) the cheapest option."""
    if cheapest is None or stay == cheapest:
        price = stay.dollars(stay.total_cents)
        return f"{stay.name} is both the cheapest option and the best overall value, at {price} total."

    extra_cents = max(0, stay.total_cents - cheapest.total_cents)
    extra_dollars = stay.dollars(extra_cents)
    extra_pct = round(extra_cents / cheapest.total_cents * 100) if cheapest.total_cents > 0 else 0

    return (
        f"{stay.name} costs {extra_dollars} ({extra_pct}%) more than the cheapest option "
        f"({cheapest.name}) but reviews are {_score_label(stay)} vs {_score_label(cheapest)}."
    )


def evaluate(stays: list[Stay], query: SearchInput) -> Result:
    """Build the final Result: the two picks, all stays for reference, and
    plain-language notes about what happened during evaluation.
    """
    legitimate = [s for s in stays if is_legitimate(s)]
    dropped_count = len(stays) - len(legitimate)

    cheapest = pick_cheapest(stays)
    best_value = pick_best_value(stays, cheapest)

    notes: list[str] = [f"Considered {len(stays)} candidate stay(s)."]
    if dropped_count:
        notes.append(
            f"Dropped {dropped_count} candidate(s) as illegitimate "
            "(no valid price, no name, or unconfirmed low-confidence pricing)."
        )
    if not legitimate:
        notes.append("No legitimate stays were found; no picks could be made.")
    elif cheapest is not None and best_value is not None and best_value == cheapest:
        notes.append("The cheapest stay is also the best overall value.")

    result = Result(
        query=query,
        all_stays=sorted(stays, key=lambda s: s.total_cents),
        notes=notes,
    )
    if cheapest is not None:
        result.cheapest = Pick(stay=cheapest, why=explain_cheapest(cheapest))
    if best_value is not None:
        result.best_value = Pick(stay=best_value, why=explain_best_value(best_value, cheapest))

    return result
