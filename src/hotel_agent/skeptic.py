"""The skeptical reviewer: an independent pass that runs AFTER ranking and
BEFORE the user ever sees a recommendation.

`review()` is fully deterministic — no network access, no LLM — and is the
pass that must always run. `apply_findings()` takes those findings and
(when it's safe and unambiguous) produces a revised `Recommendation` with a
corrected `best` pick; it never silently drops a BLOCKER finding even when
it manages to route around the underlying problem.

`LlmSkeptic` is a completely optional second opinion that calls the
Anthropic API directly (raw HTTP via httpx, no SDK) to catch anything the
deterministic rules missed. It is skipped cleanly whenever no API key is
configured, and any failure degrades to "no additional findings" rather
than raising.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import date
from typing import Optional

import httpx

from hotel_agent.models import (
    Channel,
    FeeKind,
    PayableWhen,
    RankedOption,
    Recommendation,
    Refundability,
    SkepticFinding,
    SkepticSeverity,
    UserProfile,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _dollars(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def _same_hotel(a: str, b: str) -> bool:
    return a.strip().lower() == b.strip().lower()


def _matching_verdict(rec: Recommendation, hotel_name: str):
    for v in rec.earn_vs_burn:
        if _same_hotel(v.hotel_name, hotel_name):
            return v
    return None


def _cheapest_matching(options: list[RankedOption]) -> Optional[RankedOption]:
    if not options:
        return None
    return min(options, key=lambda o: o.cost.effective_cents)


def _cheapest_refundable_alt_same_hotel(
    rec: Recommendation, best: RankedOption
) -> Optional[RankedOption]:
    candidates = [
        opt
        for opt in rec.options
        if opt.offer.offer_id != best.offer.offer_id
        and _same_hotel(opt.offer.hotel.name, best.offer.hotel.name)
        and opt.offer.refundability == Refundability.FULLY_REFUNDABLE
        and opt.cost.effective_cents <= best.cost.effective_cents * 1.15
    ]
    return _cheapest_matching(candidates)


def _cheapest_direct_alt_same_hotel(
    rec: Recommendation, best: RankedOption
) -> Optional[RankedOption]:
    candidates = [
        opt
        for opt in rec.options
        if opt.offer.offer_id != best.offer.offer_id
        and opt.offer.channel == Channel.DIRECT
        and _same_hotel(opt.offer.hotel.name, best.offer.hotel.name)
        and opt.cost.effective_cents <= best.cost.effective_cents * 1.05
    ]
    return _cheapest_matching(candidates)


# ---------------------------------------------------------------------------
# deterministic review
# ---------------------------------------------------------------------------

def _check_better_rate(rec: Recommendation, best: RankedOption) -> list[SkepticFinding]:
    findings = []
    for opt in rec.options:
        if opt.offer.offer_id == best.offer.offer_id:
            continue
        if opt.offer.currency != best.offer.currency:
            continue
        if opt.cost.effective_cents < best.cost.effective_cents:
            findings.append(
                SkepticFinding(
                    severity=SkepticSeverity.BLOCKER,
                    category="better_rate",
                    message=(
                        f"Ranker missed a better rate: offer {opt.offer.offer_id} has "
                        f"effective cost {_dollars(opt.cost.effective_cents)} vs. the "
                        f"chosen {_dollars(best.cost.effective_cents)}."
                    ),
                    offer_id=opt.offer.offer_id,
                )
            )
    return findings


def _check_missed_fees(best: RankedOption) -> list[SkepticFinding]:
    findings = []
    offer = best.offer

    hidden_fees = [
        f
        for f in offer.fees
        if f.payable == PayableWhen.AT_PROPERTY or not f.included_in_advertised_total
    ]
    if hidden_fees:
        total = sum(f.amount_cents for f in hidden_fees)
        findings.append(
            SkepticFinding(
                severity=SkepticSeverity.WARNING,
                category="missed_fee",
                message=(
                    f"Advertised price excludes {_dollars(total)} payable at property "
                    "or otherwise not included in the advertised total."
                ),
                offer_id=offer.offer_id,
            )
        )

    tax_lines = [f for f in offer.fees if f.kind == FeeKind.TAX]
    if not tax_lines and offer.base_cents > 0:
        findings.append(
            SkepticFinding(
                severity=SkepticSeverity.WARNING,
                category="missed_fee",
                message=(
                    f"No tax line items found on a {_dollars(offer.base_cents)} base "
                    "rate — taxes are likely missing from the data."
                ),
                offer_id=offer.offer_id,
            )
        )
    return findings


def _check_cancellation(rec: Recommendation, best: RankedOption) -> list[SkepticFinding]:
    findings = []
    offer = best.offer
    query = rec.query

    if query.require_refundable and offer.refundability != Refundability.FULLY_REFUNDABLE:
        findings.append(
            SkepticFinding(
                severity=SkepticSeverity.BLOCKER,
                category="cancellation_risk",
                message=(
                    "Query requires a fully refundable rate but the chosen offer is "
                    f"{offer.refundability.value}."
                ),
                offer_id=offer.offer_id,
            )
        )

    if offer.refundability == Refundability.NON_REFUNDABLE:
        days_out = (query.check_in - date.today()).days
        if days_out > 30:
            findings.append(
                SkepticFinding(
                    severity=SkepticSeverity.WARNING,
                    category="cancellation_risk",
                    message=(
                        f"Chosen offer is non-refundable and check-in is {days_out} "
                        "days away — plans could change before then."
                    ),
                    offer_id=offer.offer_id,
                )
            )
            alt = _cheapest_refundable_alt_same_hotel(rec, best)
            if alt is not None:
                delta = alt.cost.effective_cents - best.cost.effective_cents
                sign = "+" if delta >= 0 else "-"
                findings.append(
                    SkepticFinding(
                        severity=SkepticSeverity.INFO,
                        category="cancellation_risk",
                        message=(
                            "A fully refundable option at the same hotel is available "
                            f"for {_dollars(alt.cost.effective_cents)} ({sign}"
                            f"{_dollars(abs(delta))} vs. the non-refundable pick)."
                        ),
                        offer_id=alt.offer.offer_id,
                    )
                )
    return findings


def _check_loyalty(
    rec: Recommendation, best: RankedOption, profile: UserProfile
) -> list[SkepticFinding]:
    findings = []
    offer = best.offer

    if offer.channel == Channel.OTA:
        direct_alt = _cheapest_direct_alt_same_hotel(rec, best)
        if direct_alt is not None:
            program = direct_alt.offer.hotel.program
            has_account = any(la.program == program for la in profile.loyalty)
            if has_account:
                findings.append(
                    SkepticFinding(
                        severity=SkepticSeverity.WARNING,
                        category="loyalty_logic",
                        message=(
                            "Booking via OTA forfeits points/elite credit — a direct "
                            f"rate at {direct_alt.offer.hotel.name} is available for "
                            f"{_dollars(direct_alt.cost.effective_cents)} (within 5% of "
                            "the chosen price)."
                        ),
                        offer_id=direct_alt.offer.offer_id,
                    )
                )

    if offer.is_award:
        verdict = _matching_verdict(rec, offer.hotel.name)
        if verdict is not None and verdict.use_points is False:
            findings.append(
                SkepticFinding(
                    severity=SkepticSeverity.BLOCKER,
                    category="loyalty_logic",
                    message=(
                        "Earn-vs-burn analysis says paying cash beats redeeming points "
                        f"for {offer.hotel.name}: "
                        f"{verdict.rationale or 'points redemption value is poor'}."
                    ),
                    offer_id=offer.offer_id,
                )
            )

        program = offer.hotel.program
        account = next((la for la in profile.loyalty if la.program == program), None)
        balance = account.points_balance if account is not None else 0
        points_cost = offer.points_cost or 0
        if balance < points_cost:
            findings.append(
                SkepticFinding(
                    severity=SkepticSeverity.WARNING,
                    category="loyalty_logic",
                    message=(
                        f"Chosen award offer needs {points_cost:,} points but the "
                        f"profile's {program.value} balance is only {balance:,}."
                    ),
                    offer_id=offer.offer_id,
                )
            )
    return findings


def _check_payment_option(
    best: RankedOption, profile: UserProfile
) -> list[SkepticFinding]:
    if not profile.cards:
        return [
            SkepticFinding(
                severity=SkepticSeverity.WARNING,
                category="payment_option",
                message=(
                    "No payment cards configured in the profile — card-specific value "
                    "(points earn, credits, portal bonuses) could not be evaluated."
                ),
                offer_id=best.offer.offer_id,
            )
        ]

    card = next((c for c in profile.cards if c.card_id == best.cost.card_id), None)
    card_label = card.display_name if card is not None else best.cost.card_id
    line_bits = "; ".join(
        f"{line.label} {'+' if line.amount_cents >= 0 else '-'}{_dollars(abs(line.amount_cents))}"
        for line in best.cost.lines
    )
    message = f"Chosen card: {card_label}."
    if line_bits:
        message += f" Effective cost breakdown — {line_bits}."
    return [
        SkepticFinding(
            severity=SkepticSeverity.INFO,
            category="payment_option",
            message=message,
            offer_id=best.offer.offer_id,
        )
    ]


def _check_data_quality(rec: Recommendation) -> list[SkepticFinding]:
    findings = []
    if rec.contains_fixture_data:
        findings.append(
            SkepticFinding(
                severity=SkepticSeverity.INFO,
                category="data_quality",
                message="MOCK DATA — not real prices.",
            )
        )

    for opt in rec.options:
        if opt.cost.effective_cents <= 0 or opt.offer.total_cash_cents == 0:
            findings.append(
                SkepticFinding(
                    severity=SkepticSeverity.WARNING,
                    category="data_quality",
                    message=(
                        f"Offer {opt.offer.offer_id} has a suspicious cost of "
                        f"{_dollars(opt.cost.effective_cents)} effective / "
                        f"{_dollars(opt.offer.total_cash_cents)} cash — looks like bad "
                        "or incomplete data."
                    ),
                    offer_id=opt.offer.offer_id,
                )
            )
    return findings


def review(rec: Recommendation, profile: UserProfile) -> list[SkepticFinding]:
    """Run every deterministic rule and return the findings, in rule order."""
    findings: list[SkepticFinding] = []
    best = rec.best

    if best is not None:
        findings.extend(_check_better_rate(rec, best))
        findings.extend(_check_missed_fees(best))
        findings.extend(_check_cancellation(rec, best))
        findings.extend(_check_loyalty(rec, best, profile))
        findings.extend(_check_payment_option(best, profile))

    findings.extend(_check_data_quality(rec))
    return findings


def apply_findings(
    rec: Recommendation, findings: list[SkepticFinding], profile: UserProfile
) -> Recommendation:
    """Pure function: returns a possibly-revised copy of `rec`.

    Never mutates `rec`. Every finding is attached to the copy's
    `skeptic_findings` regardless of whether it triggers a revision — a
    BLOCKER that can't be automatically routed around stays visible.
    """
    out = rec.model_copy(deep=True)
    out.skeptic_findings = list(findings)
    notes: list[str] = list(out.revision_notes)
    revised = out.revised

    # (a) better_rate: re-sort options by effective cost, fix ranks, new best.
    if any(f.category == "better_rate" for f in findings):
        sorted_options = sorted(out.options, key=lambda o: o.cost.effective_cents)
        for i, opt in enumerate(sorted_options, start=1):
            opt.rank = i
        old_best_id = out.best.offer.offer_id if out.best else None
        out.options = sorted_options
        out.best = sorted_options[0]
        revised = True
        notes.append(
            "Re-ranked options by effective cost after the skeptic found a cheaper "
            f"offer than the original pick ({old_best_id!r}); new best is "
            f"{out.best.offer.offer_id!r}."
        )

    # (d) cancellation_risk BLOCKER: promote a fully refundable option if one exists.
    if any(
        f.category == "cancellation_risk" and f.severity == SkepticSeverity.BLOCKER
        for f in findings
    ):
        refundable_opts = [
            o for o in out.options if o.offer.refundability == Refundability.FULLY_REFUNDABLE
        ]
        if refundable_opts:
            cheapest = min(refundable_opts, key=lambda o: o.cost.effective_cents)
            old_best_id = out.best.offer.offer_id if out.best else None
            out.best = cheapest
            revised = True
            notes.append(
                f"Query required a refundable rate; promoted {cheapest.offer.offer_id!r} "
                f"over {old_best_id!r}, which was not fully refundable."
            )
        # else: no refundable alternative exists — leave best as-is, BLOCKER stays
        # visible in skeptic_findings for the user to see.

    # (g) loyalty_logic BLOCKER (award beaten by cash): promote the matching cash twin.
    if any(
        f.category == "loyalty_logic" and f.severity == SkepticSeverity.BLOCKER
        for f in findings
    ):
        best_before = out.best
        if best_before is not None:
            cash_opts = [
                o
                for o in out.options
                if o.offer.channel != Channel.AWARD
                and _same_hotel(o.offer.hotel.name, best_before.offer.hotel.name)
            ]
            if cash_opts:
                cheapest_cash = min(cash_opts, key=lambda o: o.cost.effective_cents)
                old_best_id = best_before.offer.offer_id
                out.best = cheapest_cash
                revised = True
                notes.append(
                    f"Earn-vs-burn said the points redemption {old_best_id!r} was a "
                    f"poor value; promoted cash offer {cheapest_cash.offer.offer_id!r} "
                    "instead."
                )
            # else: no cash twin available — leave best as-is, BLOCKER stays visible.

    out.revised = revised
    out.revision_notes = notes
    return out


# ---------------------------------------------------------------------------
# optional LLM second opinion
# ---------------------------------------------------------------------------

class LlmSkeptic:
    """Optional second-opinion reviewer.

    This is NOT part of the required skeptic pass — `review()`/
    `apply_findings()` above are fully deterministic and are what actually
    gates what the user sees. `LlmSkeptic` is an additional, best-effort
    pass that asks Claude (via a direct HTTPS call to the Anthropic Messages
    API — no SDK) whether it can spot anything the deterministic rules
    missed. It is skipped cleanly whenever `ANTHROPIC_API_KEY` is not set
    (`is_available()` reports why), and any failure — network error, bad
    status code, unparseable response — is logged as a warning and degrades
    to an empty finding list rather than raising or blocking the pipeline.

    Only a compact summary of the ranked options is ever sent: hotel name,
    channel, totals, effective cost, refundability, and points figures. The
    full `UserProfile` is never sent, and no `PaymentCard` field beyond
    `display_name` is included.
    """

    API_URL = "https://api.anthropic.com/v1/messages"
    MODEL = "claude-opus-5"
    ANTHROPIC_VERSION = "2023-06-01"
    MAX_TOKENS = 1500

    def __init__(self, api_key: Optional[str] = None, timeout: float = 30.0):
        self.api_key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY")
        self.timeout = timeout

    def is_available(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "ANTHROPIC_API_KEY is not set — LLM second-opinion review skipped"
        return True, ""

    @staticmethod
    def _summarize(rec: Recommendation) -> list[dict]:
        summary = []
        for opt in rec.options:
            offer = opt.offer
            summary.append(
                {
                    "offer_id": offer.offer_id,
                    "hotel": offer.hotel.name,
                    "channel": offer.channel.value,
                    "total_cash_cents": offer.total_cash_cents,
                    "effective_cents": opt.cost.effective_cents,
                    "refundability": offer.refundability.value,
                    "points_cost": offer.points_cost,
                    "rank": opt.rank,
                    "is_best": bool(rec.best and rec.best.offer.offer_id == offer.offer_id),
                }
            )
        return summary

    def review(self, rec: Recommendation, profile: UserProfile) -> list[SkepticFinding]:
        available, reason = self.is_available()
        if not available:
            logger.warning("LlmSkeptic unavailable: %s", reason)
            return []

        options_summary = self._summarize(rec)
        # Card display names only — never numbers, CVVs, expiry, or perk details
        # tied to a specific account.
        card_names = [c.display_name for c in profile.cards]

        prompt = (
            "You are a skeptical second reviewer for a hotel booking recommendation "
            "produced by an automated ranking system. Below is a compact JSON summary "
            "of the ranked options and which one was chosen as best. Look for anything "
            "the automated ranking might have missed: a cheaper option, a fee or "
            "refund-policy trap, a loyalty/points mistake, or any other reason a "
            "careful traveler would object.\n\n"
            f"Options: {json.dumps(options_summary)}\n"
            f"Cards on file (names only, no account details): {json.dumps(card_names)}\n\n"
            "Respond with ONLY a JSON array of findings, each of the shape "
            '{"severity": "blocker"|"warning"|"info", "category": "...", '
            '"message": "..."}. Return an empty array [] if you find nothing new.'
        )

        try:
            response = httpx.post(
                self.API_URL,
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": self.ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                json={
                    "model": self.MODEL,
                    "max_tokens": self.MAX_TOKENS,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
            data = response.json()
            text = "".join(
                block.get("text", "")
                for block in data.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            )
            return self._parse_findings(text)
        except Exception:  # noqa: BLE001 - any failure degrades to "no extra findings"
            logger.warning(
                "LlmSkeptic.review failed; continuing without LLM findings", exc_info=True
            )
            return []

    @staticmethod
    def _parse_findings(text: str) -> list[SkepticFinding]:
        text = text.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end < start:
            return []
        try:
            raw_items = json.loads(text[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            logger.warning("LlmSkeptic: could not parse JSON findings from response")
            return []

        findings: list[SkepticFinding] = []
        if not isinstance(raw_items, list):
            return findings
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            severity_raw = str(item.get("severity", "info")).lower()
            try:
                severity = SkepticSeverity(severity_raw)
            except ValueError:
                severity = SkepticSeverity.INFO
            message = str(item.get("message", "")).strip()
            if not message:
                continue
            findings.append(
                SkepticFinding(
                    severity=severity,
                    category=str(item.get("category", "llm_review")),
                    message=message,
                    offer_id=item.get("offer_id"),
                )
            )
        return findings
