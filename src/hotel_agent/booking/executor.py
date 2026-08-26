"""Booking execution behind a clean abstraction.

Design goals:
- NOTHING is ever purchased without an ExplicitApproval whose token matches
  the exact BookingPlan (offer + card + amounts). Changing any of those
  changes the token, so a stale approval can never authorize a new plan.
- The default executor is ManualBookingExecutor: it prepares a precise plan
  and, on approval, emits step-by-step instructions + the deep link for the
  user to complete themselves. It never charges anything.
- A browser/computer-use executor can be added later by subclassing
  BookingExecutor and registering it — the pipeline/CLI only speak to the
  interface. (PARTIAL: no automated executor is implemented yet.)
"""

from __future__ import annotations

import abc
import enum
import hashlib
from datetime import datetime, timezone

from pydantic import BaseModel

from hotel_agent.currency import format_money
from hotel_agent.models import (
    BookingPlan,
    Channel,
    ExplicitApproval,
    NormalizedOffer,
    PayableWhen,
    UserProfile,
)


class BookingStatus(str, enum.Enum):
    PLANNED = "planned"                      # plan built, awaiting approval
    MANUAL_ACTION_REQUIRED = "manual_action_required"  # approved; user completes booking
    EXECUTED = "executed"                    # an automated executor completed it
    REJECTED = "rejected"                    # approval invalid


class BookingResult(BaseModel):
    status: BookingStatus
    plan_id: str
    message: str
    instructions: list[str] = []


class ApprovalError(Exception):
    """Approval missing, stale, or not matching the plan."""


def _plan_id(offer: NormalizedOffer, card_id: str, due_now: int, due_later: int) -> str:
    """Plan identity covers the amounts, so a re-plan after a price change is a
    distinct plan rather than a stale-row collision."""
    material = f"{offer.offer_id}|{card_id}|{due_now}|{due_later}|{offer.points_cost or 0}"
    return "plan-" + hashlib.sha256(material.encode()).hexdigest()[:12]


class BookingExecutor(abc.ABC):
    """Interface every booking backend must implement."""

    name: str = "base"

    def prepare(self, offer: NormalizedOffer, card_id: str, profile: UserProfile) -> BookingPlan:
        """Build the exact plan the user must approve. Deterministic."""
        due_now = offer.base_cents + offer.award_cash_cents
        due_later = 0
        for fee in offer.fees:
            if fee.payable == PayableWhen.AT_PROPERTY:
                due_later += fee.amount_cents
            else:
                due_now += fee.amount_cents

        card = next((c for c in profile.cards if c.card_id == card_id), None)
        card_label = card.display_name if card else card_id

        steps = self._steps(offer, card_label, due_now, due_later)
        return BookingPlan(
            plan_id=_plan_id(offer, card_id, due_now, due_later),
            offer=offer,
            card_id=card_id,
            total_due_now_cents=due_now,
            total_due_at_property_cents=due_later,
            points_due=offer.points_cost or 0,
            refundability=offer.refundability,
            cancel_deadline=offer.cancel_deadline,
            booking_url=offer.booking_url,
            steps=steps,
        )

    def _steps(self, offer: NormalizedOffer, card_label: str, due_now: int, due_later: int) -> list[str]:
        where = offer.booking_url or offer.booking_site or (
            f"the {offer.hotel.brand or offer.hotel.name} website/app"
            if offer.channel in (Channel.DIRECT, Channel.AWARD)
            else "the OTA site"
        )
        steps = [
            f"Open {where}",
            f"Find: {offer.hotel.name} — {offer.room_description or 'selected room'} ({offer.rate_plan or 'standard rate'})",
        ]
        if offer.is_award:
            steps.append(f"Log in to your loyalty account and select the points rate ({offer.points_cost:,} pts)")
        steps.append(f"Pay with: {card_label}")
        steps.append(f"Charge due now: {_money(due_now, offer.currency)}"
                     + (f"; due at property: {_money(due_later, offer.currency)}" if due_later else ""))
        steps.append(f"Verify cancellation terms match: {offer.refundability.value}"
                     + (f" (deadline {offer.cancel_deadline:%Y-%m-%d %H:%M})" if offer.cancel_deadline else ""))
        return steps

    def check_approval(self, plan: BookingPlan, approval: ExplicitApproval | None) -> None:
        if approval is None:
            raise ApprovalError("No approval provided. Booking requires explicit approval.")
        if approval.plan_id != plan.plan_id:
            raise ApprovalError("Approval is for a different plan.")
        if approval.token != plan.approval_token():
            raise ApprovalError(
                "Approval token does not match this exact plan (offer/card/amounts). "
                "Re-review the plan and approve again."
            )

    @abc.abstractmethod
    def execute(self, plan: BookingPlan, approval: ExplicitApproval) -> BookingResult:
        """Execute an approved plan. MUST call check_approval first."""


class ManualBookingExecutor(BookingExecutor):
    """Default executor: hands the user exact instructions; charges nothing."""

    name = "manual"

    def execute(self, plan: BookingPlan, approval: ExplicitApproval) -> BookingResult:
        self.check_approval(plan, approval)
        return BookingResult(
            status=BookingStatus.MANUAL_ACTION_REQUIRED,
            plan_id=plan.plan_id,
            message=(
                "Approved. Automated booking is not enabled — complete these steps "
                "yourself, then mark the booking done."
            ),
            instructions=plan.steps,
        )


def _money(cents: int, currency: str = "USD") -> str:
    return format_money(cents, currency)


def make_approval(plan: BookingPlan, token: str) -> ExplicitApproval:
    """Build an approval from a user-supplied token (validated at execute)."""
    return ExplicitApproval(plan_id=plan.plan_id, token=token, approved_at=datetime.now(timezone.utc))
