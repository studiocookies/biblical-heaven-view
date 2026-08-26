"""Deterministic effective-cost engine.

Turns a NormalizedOffer + PaymentCard + UserProfile into an auditable
EffectiveCost: a list of CostLine entries (positive = money/value leaving
you, negative = money/value coming back) that sum to `effective_cents`,
the single number used to rank offers against each other.

All money math is integer cents. Where a formula divides (e.g. converting
points to cents via cents-per-point), we either follow the exact integer
formula specified for that line, or round half-up via `(a + half) // b`
when the spec expresses the relationship as a plain ratio rather than an
explicit floor-division formula. Never floats.
"""

from __future__ import annotations

from hotel_agent.models import (
    Channel,
    CostLine,
    EarnVsBurnVerdict,
    EffectiveCost,
    LoyaltyProgramId,
    NormalizedOffer,
    PaymentCard,
    UserProfile,
)
from hotel_agent.points import get_earn_per_usd_x100, get_valuation_cpp_x100

_CASH_CARD_ID = "cash"


def _cash_fallback_card() -> PaymentCard:
    return PaymentCard(
        card_id=_CASH_CARD_ID,
        display_name="Cash / debit (no rewards)",
        reward_value_cpp_x100=0,
    )


def _tier_for_program(profile: UserProfile, program: LoyaltyProgramId) -> str:
    for account in profile.loyalty:
        if account.program == program:
            return account.tier
    return ""


def _perk_applies(perk_channel, perk_portal: str, offer: NormalizedOffer) -> bool:
    if perk_channel is not None and perk_channel != offer.channel:
        return False
    if perk_portal and perk_portal != offer.booking_site:
        return False
    return True


def _hotel_points_earned_line(
    offer: NormalizedOffer, profile: UserProfile
) -> tuple[CostLine, int] | None:
    """Return (CostLine, value_cents) for hotel points earned, or None."""
    if not offer.earns_loyalty or offer.is_award:
        return None
    program = offer.hotel.program
    if program == LoyaltyProgramId.NONE:
        return None

    tier = _tier_for_program(profile, program)
    earn_rate_x100 = get_earn_per_usd_x100(program, tier)
    eligible_cents = offer.base_cents
    pts = eligible_cents * earn_rate_x100 // (100 * 100)
    cpp_x100 = get_valuation_cpp_x100(program, profile)
    # cpp_x100 is cents-per-point * 100 ("hundredths of a cent" per point per
    # PointValuation's docstring), so cents = pts * cpp_x100 / 100.
    value_cents = (pts * cpp_x100 + 50) // 100

    line = CostLine(
        label=f"Hotel points earned (~{pts} pts)",
        amount_cents=-value_cents,
        note=(
            f"eligible spend ${eligible_cents / 100:.2f} (room rate only) x "
            f"{earn_rate_x100 / 100:.2f} pts/$ (program={program.value}, tier="
            f"'{tier}') = {pts} pts x {cpp_x100 / 100:.2f}cpp = "
            f"${value_cents / 100:.2f} value"
        ),
    )
    return line, value_cents


def compute_effective_cost(
    offer: NormalizedOffer, card: PaymentCard, profile: UserProfile
) -> EffectiveCost:
    lines: list[CostLine] = []
    total_cash = offer.total_cash_cents

    lines.append(
        CostLine(
            label="Cash total (room + taxes + fees)",
            amount_cents=total_cash,
            note=(
                f"base ${offer.base_cents / 100:.2f} + fees "
                f"${sum(f.amount_cents for f in offer.fees) / 100:.2f} + award cash "
                f"${offer.award_cash_cents / 100:.2f} = ${total_cash / 100:.2f}"
            ),
        )
    )

    points_spent = 0
    if offer.is_award:
        points_spent = offer.points_cost or 0
        cpp_x100 = get_valuation_cpp_x100(offer.hotel.program, profile)
        # Same points -> cents scaling as hotel points earned (cpp_x100/100).
        opp_cost = (points_spent * cpp_x100 + 50) // 100
        lines.append(
            CostLine(
                label="Points opportunity cost",
                amount_cents=opp_cost,
                note=(
                    f"{points_spent:,} pts spent x baseline "
                    f"{cpp_x100 / 100:.2f}cpp valuation = ${opp_cost / 100:.2f} "
                    "opportunity cost of the points given up"
                ),
            )
        )

    # -- Card rewards earned: best applicable earn_multiplier perk, else 1x --
    mult_x100 = 100
    best_perk_name = "base rate (1x)"
    for perk in card.perks:
        if perk.kind != "earn_multiplier":
            continue
        if not _perk_applies(perk.applies_channel, perk.applies_portal, offer):
            continue
        if perk.earn_multiplier_x100 > mult_x100:
            mult_x100 = perk.earn_multiplier_x100
            best_perk_name = perk.name

    card_value_cents = total_cash * mult_x100 * card.reward_value_cpp_x100 // 1_000_000
    lines.append(
        CostLine(
            label="Card rewards earned",
            amount_cents=-card_value_cents,
            note=(
                f"${total_cash / 100:.2f} charged x {mult_x100 / 100:.2f}x "
                f"({best_perk_name}) x {card.reward_value_cpp_x100 / 100:.2f}cpp "
                f"card reward value = ${card_value_cents / 100:.2f} value back"
            ),
        )
    )

    # -- Statement credits (stack, capped by remaining cash) --
    remaining_cash = total_cash
    for perk in card.perks:
        if perk.kind != "statement_credit":
            continue
        if not _perk_applies(perk.applies_channel, perk.applies_portal, offer):
            continue
        credit = min(perk.value_cents, remaining_cash) if remaining_cash > 0 else 0
        remaining_cash -= credit
        lines.append(
            CostLine(
                label=f"Statement credit: {perk.name}",
                amount_cents=-credit,
                note=(
                    f"credit worth up to ${perk.value_cents / 100:.2f}, capped by "
                    f"remaining cash owed -> applied ${credit / 100:.2f}"
                ),
            )
        )

    # -- Portal cashback (only when the perk names this exact booking portal) --
    for perk in card.perks:
        if perk.kind != "portal_cashback":
            continue
        if not perk.applies_portal or perk.applies_portal != offer.booking_site:
            continue
        if perk.earn_multiplier_x100:
            cashback = total_cash * perk.earn_multiplier_x100 // 10000
            note = (
                f"${total_cash / 100:.2f} x {perk.earn_multiplier_x100 / 100:.2f}% "
                f"portal cashback = ${cashback / 100:.2f}"
            )
        else:
            cashback = perk.value_cents
            note = f"flat portal cashback ${cashback / 100:.2f}"
        lines.append(
            CostLine(
                label=f"Portal cashback: {perk.name}",
                amount_cents=-cashback,
                note=note,
            )
        )

    # -- Hotel loyalty points earned on the room rate (not taxes/fees) --
    points_earned_value_cents = 0
    hotel_pts_result = _hotel_points_earned_line(offer, profile)
    if hotel_pts_result is not None:
        line, value_cents = hotel_pts_result
        lines.append(line)
        points_earned_value_cents = value_cents

    # -- Bundled included benefits (breakfast, credits, etc) --
    for benefit in offer.included_benefits:
        lines.append(
            CostLine(
                label=f"Included benefit: {benefit.name}",
                amount_cents=-benefit.est_value_cents,
                note=benefit.note
                or f"bundled benefit conservatively valued at ${benefit.est_value_cents / 100:.2f}",
            )
        )

    effective_cents = sum(line.amount_cents for line in lines)

    return EffectiveCost(
        offer_id=offer.offer_id,
        card_id=card.card_id,
        lines=lines,
        effective_cents=effective_cents,
        cash_outlay_cents=total_cash,
        points_spent=points_spent,
        points_earned_value_cents=points_earned_value_cents,
        redemption_cpp_x100=None,
    )


def best_card_cost(offer: NormalizedOffer, profile: UserProfile) -> EffectiveCost:
    """Effective cost for the single best card in the profile (or cash)."""
    cards = list(profile.cards) if profile.cards else [_cash_fallback_card()]
    costs = [compute_effective_cost(offer, card, profile) for card in cards]
    costs.sort(key=lambda c: (c.effective_cents, c.card_id))
    return costs[0]


def earn_vs_burn(
    cash_offer: NormalizedOffer, award_offer: NormalizedOffer, profile: UserProfile
) -> EarnVsBurnVerdict:
    """Compare paying cash vs redeeming points for (nominally) the same stay."""
    hotel_name = award_offer.hotel.name or cash_offer.hotel.name

    if cash_offer.currency != award_offer.currency:
        return EarnVsBurnVerdict(
            hotel_name=hotel_name,
            cash_offer_id=cash_offer.offer_id,
            award_offer_id=award_offer.offer_id,
            redemption_cpp_x100=None,
            baseline_cpp_x100=None,
            use_points=None,
            rationale=(
                f"Cannot compare: cash offer is in {cash_offer.currency} but award "
                f"offer is in {award_offer.currency} — mismatched currencies."
            ),
        )

    program = award_offer.hotel.program
    baseline_cpp_x100 = get_valuation_cpp_x100(program, profile)
    points_cost = award_offer.points_cost or 0

    if points_cost <= 0:
        return EarnVsBurnVerdict(
            hotel_name=hotel_name,
            cash_offer_id=cash_offer.offer_id,
            award_offer_id=award_offer.offer_id,
            redemption_cpp_x100=None,
            baseline_cpp_x100=baseline_cpp_x100,
            use_points=None,
            rationale=(
                "Award offer has no points cost to evaluate — cannot compute a "
                "redemption value."
            ),
        )

    cents_saved = cash_offer.total_cash_cents - award_offer.total_cash_cents

    forgone_value_cents = 0
    forgone_pts = 0
    hotel_pts_result = _hotel_points_earned_line(cash_offer, profile)
    if hotel_pts_result is not None:
        _line, forgone_value_cents = hotel_pts_result
        earn_rate_x100 = get_earn_per_usd_x100(
            cash_offer.hotel.program, _tier_for_program(profile, cash_offer.hotel.program)
        )
        forgone_pts = cash_offer.base_cents * earn_rate_x100 // (100 * 100)

    net_saved_cents = cents_saved - forgone_value_cents
    # Inverse of the points -> cents scaling above: cpp_x100 = cents*100/points.
    redemption_cpp_x100 = net_saved_cents * 100 // points_cost

    account = next(
        (a for a in profile.loyalty if a.program == program), None
    )
    cpp_favors_points = redemption_cpp_x100 > baseline_cpp_x100

    balance_note = ""
    if account is None:
        use_points = cpp_favors_points
        balance_note = " (points balance unknown — no loyalty account on file)"
    else:
        sufficient = account.points_balance >= points_cost
        use_points = cpp_favors_points and sufficient
        if not sufficient:
            balance_note = (
                f" — but balance is insufficient (have {account.points_balance:,}, "
                f"need {points_cost:,} pts), so pay cash regardless of cpp"
            )

    verdict_word = "use points" if use_points else "pay cash"
    rationale = (
        f"Redeeming {points_cost:,} pts saves ${cents_saved / 100:.0f} gross, "
        f"minus ${forgone_value_cents / 100:.2f} of forgone earning "
        f"({forgone_pts} pts not earned) = ${net_saved_cents / 100:.2f} net = "
        f"{redemption_cpp_x100 / 100:.2f}cpp vs {baseline_cpp_x100 / 100:.2f}cpp "
        f"baseline{balance_note} — {verdict_word}"
    )

    return EarnVsBurnVerdict(
        hotel_name=hotel_name,
        cash_offer_id=cash_offer.offer_id,
        award_offer_id=award_offer.offer_id,
        redemption_cpp_x100=redemption_cpp_x100,
        baseline_cpp_x100=baseline_cpp_x100,
        use_points=use_points,
        rationale=rationale,
    )
