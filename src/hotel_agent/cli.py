"""Command-line front end for the hotel agent.

Deliberately basic UI — the value is in the pipeline. Usage:

  hotel-agent profile demo            # seed a demo profile (marked as demo)
  hotel-agent profile show
  hotel-agent profile set-points marriott_bonvoy 82000
  hotel-agent profile set-valuation world_of_hyatt 1.8
  hotel-agent search "chicago" --checkin 2026-10-09 --checkout 2026-10-12 [--refundable] [--budget 900]
  hotel-agent history
  hotel-agent book plan --offer <OFFER_ID> [--card <CARD_ID>]
  hotel-agent book confirm --plan <PLAN_ID> --token <BOOK-xxxx>
"""

from __future__ import annotations

import argparse
import sys
from datetime import date

from hotel_agent.booking.executor import ApprovalError, ManualBookingExecutor, make_approval
from hotel_agent.currency import format_money
from hotel_agent.cost_engine import best_card_cost
from hotel_agent.memory.store import MemoryStore
from hotel_agent.models import (
    CardPerk,
    Channel,
    DataSource,
    LoyaltyAccount,
    LoyaltyProgramId,
    PaymentCard,
    PointValuation,
    Recommendation,
    SearchQuery,
    SkepticSeverity,
    UserProfile,
)
from hotel_agent.recommend import recommend, run_search


def _m(cents: int, currency: str = "USD") -> str:
    return format_money(cents, currency)


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

def render(rec: Recommendation, notes: list[str] | None = None, top_n: int = 5) -> str:
    out: list[str] = []
    notes = notes if notes is not None else rec.provider_notes
    if rec.contains_fixture_data:
        all_fixture = all(
            o.offer.data_source == DataSource.FIXTURE for o in rec.options
        ) if rec.options else True
        out.append("=" * 62)
        if all_fixture:
            out.append("!!  MOCK DATA — no live provider was available.            !!")
            out.append("!!  These are NOT real prices. Do not book from this run.  !!")
        else:
            out.append("!!  MIXED DATA — some offers below are MOCK fixtures.      !!")
            out.append("!!  Mock-sourced prices are NOT real; check data sources.  !!")
        out.append("=" * 62)
    q = rec.query
    out.append(f"\nStay: {q.destination} | {q.check_in} -> {q.check_out} "
               f"({q.nights} nights, {q.adults} adults, {q.rooms} room)")
    for n in notes:
        out.append(f"  [provider] {n}")

    if not rec.options:
        out.append("\nNo offers matched your query/filters.")
        return "\n".join(out)

    best = rec.best
    out.append("\n" + "-" * 62)
    out.append(f"RECOMMENDED: {best.offer.hotel.name} ({best.offer.hotel.brand or 'independent'})")
    out.append(f"  {best.offer.room_description or 'room'} — {best.offer.rate_plan or 'standard'} "
               f"via {best.offer.channel.value}"
               + (f" [{best.offer.booking_site}]" if best.offer.booking_site else ""))
    out.append(f"  Refundability: {best.offer.refundability.value}"
               + (f" (cancel by {best.offer.cancel_deadline:%Y-%m-%d})" if best.offer.cancel_deadline else ""))
    out.append(f"  Pay with: {best.cost.card_id}")
    out.append("  Effective-cost breakdown:")
    for line in best.cost.lines:
        out.append(f"    {line.amount_cents:>+10,d}c  {line.label}"
                   + (f"  ({line.note})" if line.note else ""))
    out.append(f"    {'':>10}  ------------------------------")
    out.append(f"  EFFECTIVE COST: {_m(best.cost.effective_cents, best.offer.currency)} "
               f"(cash outlay {_m(best.cost.cash_outlay_cents, best.offer.currency)}"
               + (f", {best.cost.points_spent:,} pts" if best.cost.points_spent else "") + ")")
    if rec.revised:
        out.append("  ** Skeptic revised the original pick: **")
        for note in rec.revision_notes:
            out.append(f"     - {note}")

    out.append("\nTop options by effective cost:")
    for opt in rec.options[:top_n]:
        marker = "->" if rec.best and opt.offer.offer_id == rec.best.offer.offer_id else "  "
        out.append(f" {marker} #{opt.rank} {_m(opt.cost.effective_cents, opt.offer.currency):>12} "
                   f"| {opt.offer.hotel.name} | {opt.rationale}")
        out.append(f"      offer_id: {opt.offer.offer_id}")

    if rec.earn_vs_burn:
        out.append("\nEarn vs burn:")
        for v in rec.earn_vs_burn:
            verdict = {True: "USE POINTS", False: "PAY CASH", None: "N/A"}[v.use_points]
            out.append(f"  [{verdict}] {v.hotel_name}: {v.rationale}")

    if rec.skeptic_findings:
        out.append("\nSkeptic review:")
        order = {SkepticSeverity.BLOCKER: 0, SkepticSeverity.WARNING: 1, SkepticSeverity.INFO: 2}
        for f in sorted(rec.skeptic_findings, key=lambda f: order[f.severity]):
            out.append(f"  [{f.severity.value.upper():7}] ({f.category}) {f.message}")

    out.append("\nTo book:  hotel-agent book plan --offer <OFFER_ID>   (nothing is purchased "
               "without your explicit token approval)")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_search(args: argparse.Namespace) -> int:
    store = MemoryStore(args.db) if args.db else MemoryStore()
    profile = store.load_profile()
    query = SearchQuery(
        destination=args.destination,
        check_in=date.fromisoformat(args.checkin),
        check_out=date.fromisoformat(args.checkout),
        adults=args.adults,
        rooms=args.rooms,
        require_refundable=args.refundable,
        max_total_cents=int(args.budget * 100) if args.budget else None,
    )
    offers, notes = run_search(query, allow_fixtures=not args.no_mock)
    rec = recommend(
        query, profile, offers, run_llm_skeptic=args.llm_skeptic, provider_notes=notes
    )
    store.record_search(query)
    store.record_recommendation(rec)
    print(render(rec, notes))
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    store = MemoryStore(args.db) if args.db else MemoryStore()
    print("Recent searches:")
    for q in store.recent_searches(10):
        print(f"  {q.destination} {q.check_in}->{q.check_out} ({q.adults} adults)")
    print("Bookings:")
    rows = store.bookings()
    if not rows:
        print("  (none)")
    for bid, plan, status in rows:
        print(f"  #{bid} [{status}] {plan.offer.hotel.name} due-now "
              f"{_m(plan.total_due_now_cents, plan.offer.currency)}")
    return 0


def cmd_profile(args: argparse.Namespace) -> int:
    store = MemoryStore(args.db) if args.db else MemoryStore()
    profile = store.load_profile()

    if args.profile_cmd == "show":
        print(profile.model_dump_json(indent=2))
    elif args.profile_cmd == "demo":
        profile = _demo_profile()
        store.save_profile(profile)
        print("Seeded DEMO profile (example loyalty accounts + cards — edit to match reality):")
        print(profile.model_dump_json(indent=2))
    elif args.profile_cmd == "set-points":
        program = LoyaltyProgramId(args.program)
        acct = next((a for a in profile.loyalty if a.program == program), None)
        if acct is None:
            acct = LoyaltyAccount(program=program)
            profile.loyalty.append(acct)
        acct.points_balance = args.points
        store.save_profile(profile)
        print(f"{program.value} balance set to {args.points:,}")
    elif args.profile_cmd == "set-valuation":
        program = LoyaltyProgramId(args.program)
        cpp_x100 = int(round(args.cpp * 100))
        profile.valuation_overrides = [
            v for v in profile.valuation_overrides if v.program != program
        ] + [PointValuation(program=program, value_cpp_x100=cpp_x100, source="user override")]
        store.save_profile(profile)
        print(f"{program.value} valued at {args.cpp}cpp")
    return 0


def cmd_book(args: argparse.Namespace) -> int:
    store = MemoryStore(args.db) if args.db else MemoryStore()
    profile = store.load_profile()
    executor = ManualBookingExecutor()

    recs = store.recent_recommendations(1)
    if not recs:
        print("No recommendation in memory — run a search first.")
        return 1
    rec = recs[0]

    if args.book_cmd == "plan":
        opt = next((o for o in rec.options if o.offer.offer_id == args.offer), None)
        if opt is None:
            print(f"offer_id {args.offer!r} not found in the latest recommendation.")
            return 1
        if opt.offer.data_source == DataSource.FIXTURE:
            print("NOTE: this offer is MOCK DATA — the plan below is a dry run only.\n")
        card_id = args.card or best_card_cost(opt.offer, profile).card_id
        plan = executor.prepare(opt.offer, card_id, profile)
        store.record_booking(plan, status="planned")
        print(f"Booking plan {plan.plan_id}")
        print(f"  {opt.offer.hotel.name} — {opt.offer.room_description or 'room'}")
        print(f"  Due now: {_m(plan.total_due_now_cents, opt.offer.currency)}"
              + (f" + {plan.points_due:,} pts" if plan.points_due else ""))
        if plan.total_due_at_property_cents:
            print(f"  Due at property: {_m(plan.total_due_at_property_cents, opt.offer.currency)}")
        print(f"  Card: {card_id} | Refundability: {plan.refundability.value}")
        print("\nSteps that will be shown on approval:")
        for s in plan.steps:
            print(f"  - {s}")
        print(f"\nAPPROVAL REQUIRED — nothing is booked yet. To approve exactly this plan run:")
        print(f"  hotel-agent book confirm --plan {plan.plan_id} --token {plan.approval_token()}")
        return 0

    if args.book_cmd == "confirm":
        rows = store.bookings()
        # Newest matching row wins: a re-plan after a price change must not
        # resolve to a stale plan the user wasn't shown.
        match = next(
            ((bid, plan) for bid, plan, _ in reversed(rows) if plan.plan_id == args.plan),
            None,
        )
        if match is None:
            print(f"plan {args.plan!r} not found — run `book plan` first.")
            return 1
        bid, plan = match
        if plan.offer.data_source == DataSource.FIXTURE:
            print("=" * 62)
            print("!!  MOCK DATA DRY RUN — this plan is based on fixture prices  !!")
            print("!!  that are NOT real. Nothing below reflects a live rate.    !!")
            print("=" * 62)
        try:
            result = executor.execute(plan, make_approval(plan, args.token))
        except ApprovalError as exc:
            print(f"REJECTED: {exc}")
            store.update_booking_status(bid, "rejected")
            return 1
        store.update_booking_status(bid, result.status.value)
        print(result.message)
        for s in result.instructions:
            print(f"  - {s}")
        return 0
    return 1


def _demo_profile() -> UserProfile:
    return UserProfile(
        profile_id="default",
        loyalty=[
            LoyaltyAccount(program=LoyaltyProgramId.MARRIOTT_BONVOY, tier="gold", points_balance=82000),
            LoyaltyAccount(program=LoyaltyProgramId.WORLD_OF_HYATT, tier="discoverist", points_balance=23000),
            LoyaltyAccount(program=LoyaltyProgramId.HILTON_HONORS, tier="gold", points_balance=61000),
        ],
        cards=[
            PaymentCard(
                card_id="csp", display_name="Chase Sapphire Preferred", network="visa",
                reward_currency="chase_ur", reward_value_cpp_x100=125,
                perks=[
                    CardPerk(name="2x on travel", kind="earn_multiplier", earn_multiplier_x100=200),
                    CardPerk(name="$50 annual hotel credit (Chase Travel)", kind="statement_credit",
                             value_cents=5000, applies_portal="chase_travel"),
                ],
            ),
            PaymentCard(
                card_id="amex-gold", display_name="Amex Gold", network="amex",
                reward_currency="amex_mr", reward_value_cpp_x100=110,
                perks=[CardPerk(name="1x base", kind="earn_multiplier", earn_multiplier_x100=100)],
            ),
            PaymentCard(
                card_id="cash2", display_name="2% cashback card", network="visa",
                reward_currency="cashback", reward_value_cpp_x100=100,
                perks=[CardPerk(name="2% everywhere", kind="earn_multiplier", earn_multiplier_x100=200)],
            ),
        ],
        prefs={"demo": True, "note": "DEMO profile — replace with your real programs/cards"},
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="hotel-agent", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", help="path to sqlite db (default ~/.hotel_agent/agent.db)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("search", help="search and get a recommendation")
    sp.add_argument("destination")
    sp.add_argument("--checkin", required=True)
    sp.add_argument("--checkout", required=True)
    sp.add_argument("--adults", type=int, default=2)
    sp.add_argument("--rooms", type=int, default=1)
    sp.add_argument("--budget", type=float, help="max true total in dollars")
    sp.add_argument("--refundable", action="store_true")
    sp.add_argument("--no-mock", action="store_true", help="fail instead of using fixture data")
    sp.add_argument("--llm-skeptic", action="store_true", help="also run LLM second-opinion (needs ANTHROPIC_API_KEY)")
    sp.set_defaults(func=cmd_search)

    hp = sub.add_parser("history", help="recent searches and bookings")
    hp.set_defaults(func=cmd_history)

    pp = sub.add_parser("profile", help="manage your profile")
    psub = pp.add_subparsers(dest="profile_cmd", required=True)
    psub.add_parser("show")
    psub.add_parser("demo")
    setp = psub.add_parser("set-points")
    setp.add_argument("program"); setp.add_argument("points", type=int)
    setv = psub.add_parser("set-valuation")
    setv.add_argument("program"); setv.add_argument("cpp", type=float, help="cents per point, e.g. 1.7")
    pp.set_defaults(func=cmd_profile)

    bp = sub.add_parser("book", help="plan and confirm a booking (manual executor)")
    bsub = bp.add_subparsers(dest="book_cmd", required=True)
    planp = bsub.add_parser("plan")
    planp.add_argument("--offer", required=True)
    planp.add_argument("--card")
    confp = bsub.add_parser("confirm")
    confp.add_argument("--plan", required=True)
    confp.add_argument("--token", required=True)
    bp.set_defaults(func=cmd_book)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
