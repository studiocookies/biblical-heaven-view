"""One command. Two questions. Then it goes and searches the internet.

    $ hotelfinder
    When do you need the room?  dec 12-14
    What ZIP code?              78382
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime, timedelta

from hotelfinder.evaluate import evaluate
from hotelfinder.models import Result, SearchInput, Stay
from hotelfinder.search import MissingCredentials, find_stays

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

class DateParseError(ValueError):
    pass


def parse_dates(text: str, today: date | None = None) -> tuple[date, date]:
    """Understand the ways a person actually types dates.

    Accepts: '2026-12-12 to 2026-12-14', '12/12 - 12/14', 'dec 12-14',
    'tonight', 'tomorrow', or a single date (treated as one night).
    """
    today = today or date.today()
    raw = " ".join(text.strip().lower().split())
    if not raw:
        raise DateParseError("no dates given")

    if raw in ("tonight", "today"):
        return today, today + timedelta(days=1)
    if raw in ("tomorrow", "tomorrow night"):
        start = today + timedelta(days=1)
        return start, start + timedelta(days=1)

    # "dec 12-14" / "december 12 - 14" (one month, day range)
    m = re.match(r"^([a-z]{3,9})\.?\s+(\d{1,2})\s*(?:-|to|through|until)\s*(\d{1,2})$", raw)
    if m and m.group(1)[:3] in MONTHS:
        month = MONTHS[m.group(1)[:3]]
        d1, d2 = int(m.group(2)), int(m.group(3))
        start = _with_year(month, d1, today)
        end = _with_year(month, d2, today)
        if end <= start:
            end = end.replace(year=end.year + 1)
        return start, end

    # Scan for date-shaped chunks in order. (Don't split on '-': it is both a
    # range separator and part of an ISO date.)
    dates: list[date] = []
    for match in _DATE_RE.finditer(raw):
        parsed = _from_match(match, today)
        if parsed:
            dates.append(parsed)
        if len(dates) == 2:
            break

    if not dates:
        raise DateParseError(f"could not understand {text!r}")
    if len(dates) == 1:
        return dates[0], dates[0] + timedelta(days=1)
    start, end = dates[0], dates[1]
    if end <= start:
        raise DateParseError("check-out must be after check-in")
    return start, end


_DATE_RE = re.compile(
    r"(?P<iso>\d{4}[-/]\d{1,2}[-/]\d{1,2})"
    r"|(?P<us>\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)"
    r"|(?P<mon>(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})"
)


def _from_match(match: re.Match, today: date) -> date | None:
    token = match.group(0)
    if match.group("mon"):
        word, _, day = token.replace(".", " ").partition(" ")
        return _with_year(MONTHS[word[:3]], int(day.strip()), today)

    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%m-%d-%y"):
        try:
            return datetime.strptime(token, fmt).date()
        except ValueError:
            continue

    m = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})", token)
    if m:
        return _with_year(int(m.group(1)), int(m.group(2)), today)
    return None


def _with_year(month: int, day: int, today: date) -> date:
    """Assume the next occurrence of month/day."""
    try:
        candidate = date(today.year, month, day)
    except ValueError as exc:
        raise DateParseError(f"invalid date {month}/{day}") from exc
    if candidate < today:
        candidate = date(today.year + 1, month, day)
    return candidate


def valid_zip(text: str) -> str | None:
    m = re.match(r"^\s*(\d{5})(?:-\d{4})?\s*$", text or "")
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def render(result: Result) -> str:
    q = result.query
    out: list[str] = ["", "=" * 66, f"  {q.label}", "=" * 66]

    if not result.cheapest and not result.best_value:
        out.append("\nNo bookable prices were found for those dates.")
        for note in result.notes:
            out.append(f"  - {note}")
        return "\n".join(out)

    same = (
        result.cheapest and result.best_value
        and result.cheapest.stay.name == result.best_value.stay.name
    )

    out.append("")
    out.extend(_block("CHEAPEST OPTION", result.cheapest))
    if same:
        out.append("")
        out.append("BEST OVERALL VALUE — same property: nothing better was worth the extra money.")
    else:
        out.append("")
        out.extend(_block("BEST OVERALL VALUE", result.best_value))

    others = [
        s for s in result.all_stays
        if not (result.cheapest and s.name == result.cheapest.stay.name)
        and not (result.best_value and s.name == result.best_value.stay.name)
    ]
    if others:
        out.append("")
        out.append("Also found:")
        for s in others[:6]:
            score = f"{s.review_score:.1f}/10" if s.review_score is not None else "no reviews"
            out.append(f"  {money(s.total_cents):>10}  {s.name} ({score}) — {s.source}")

    if result.sources_searched:
        out.append("")
        out.append(f"Searched {len(result.sources_searched)} lookups across the web, including:")
        for s in result.sources_searched[:6]:
            out.append(f"  - {s}")

    if result.notes:
        out.append("")
        for note in result.notes:
            out.append(f"Note: {note}")

    out.append("")
    return "\n".join(out)


def _block(title: str, pick) -> list[str]:
    s: Stay = pick.stay
    nightly = f" ({money(s.nightly_cents)}/night)" if s.nightly_cents else ""
    lines = [
        f"{title} — {money(s.total_cents)} total{nightly}",
        f"  {s.name}" + (f" ({s.kind})" if s.kind else "") + (f", {s.city}" if s.city else ""),
    ]
    if s.source:
        lines.append(f"  Price from: {s.source}" + (f"  {s.source_url}" if s.source_url else ""))
    if s.review_score is not None:
        count = f", {s.review_count:,} reviews" if s.review_count else ""
        src = f", {s.review_source}" if s.review_source else ""
        lines.append(f"  Reviews: {s.review_score:.1f}/10{count}{src}")
    else:
        lines.append("  Reviews: none found")
    if s.fees_note:
        lines.append(f"  Fees: {s.fees_note}")
    if s.concerns:
        lines.append(f"  Watch out: {'; '.join(s.concerns[:4])}")
    if s.highlights:
        lines.append(f"  Good: {'; '.join(s.highlights[:3])}")
    if s.cancellation:
        lines.append(f"  Cancellation: {s.cancellation}")
    if s.distance_note:
        lines.append(f"  Location: {s.distance_note}")
    if s.price_confidence and s.price_confidence != "high":
        lines.append(f"  Price confidence: {s.price_confidence}")
    if pick.why:
        lines.append(f"  Why: {pick.why}")
    return lines


# ---------------------------------------------------------------------------
# Prompts + entry point
# ---------------------------------------------------------------------------

def ask_dates(reader=input) -> tuple[date, date]:
    while True:
        raw = reader("What dates do you want a room for?  ").strip()
        try:
            return parse_dates(raw)
        except DateParseError as exc:
            print(f"  Sorry — {exc}. Try '2026-12-12 to 2026-12-14', 'dec 12-14', or 'tonight'.")


def ask_zip(reader=input) -> str:
    while True:
        raw = reader("What ZIP code should I search?      ").strip()
        z = valid_zip(raw)
        if z:
            return z
        print("  Please enter a 5-digit US ZIP code.")


def _progress(kind: str, detail: str) -> None:
    if kind == "tool":
        print(".", end="", flush=True)
    else:
        print(f"\n  {detail}", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="hotelfinder",
        description="Find the cheapest room and the best-value room for your dates and ZIP.",
    )
    ap.add_argument("--dates", help="skip the prompt, e.g. '2026-12-12 to 2026-12-14'")
    ap.add_argument("--zip", dest="zip_code", help="skip the prompt, e.g. 78382")
    args = ap.parse_args(argv)

    try:
        if args.dates:
            check_in, check_out = parse_dates(args.dates)
        else:
            check_in, check_out = ask_dates()
        if args.zip_code:
            z = valid_zip(args.zip_code)
            if not z:
                print("Invalid ZIP code.")
                return 2
        else:
            z = ask_zip()
    except (DateParseError, EOFError, KeyboardInterrupt) as exc:
        print(f"\n{exc}" if str(exc) else "\nCancelled.")
        return 2

    query = SearchInput(
        check_in=check_in.isoformat(),
        check_out=check_out.isoformat(),
        zip_code=z,
        nights=(check_out - check_in).days,
    )

    print(f"\nSearching the web for rooms in {z}, {query.check_in} to {query.check_out}.")
    print("This takes a couple of minutes — it checks OTAs, brand sites, local")
    print("motels, and then goes and reads the reviews.\n")

    try:
        stays, sources, problems = find_stays(query, on_progress=_progress)
    except MissingCredentials as exc:
        print(f"\n{exc}")
        return 3
    except KeyboardInterrupt:
        print("\nCancelled.")
        return 2
    except Exception as exc:  # network/API failure — report, don't traceback
        print(f"\nSearch failed: {exc}")
        return 1

    result = evaluate(stays, query)
    result.sources_searched = sources or result.sources_searched
    result.notes.extend(problems)
    print(render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
