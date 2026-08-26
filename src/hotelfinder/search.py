"""Internet research for hotel/motel deals.

The search itself runs on Anthropic's servers via the Messages API's
server-side `web_search` and `web_fetch` tools, so this works from any
machine that can reach api.anthropic.com — no scraping, no OTA API keys,
no bot-blocked requests from your own IP.

Two phases, deliberately:
  1. research()  — broad, tool-driven web research. This is where the real
                   work happens: many queries across many source families.
  2. extract()   — a cheap, tool-free pass that turns the research notes
                   into validated Stay records (structured output).

Splitting them keeps the research pass free to roam and the extraction pass
strictly schema-bound.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from pydantic import BaseModel, Field

from hotelfinder.models import SearchInput, Stay

MODEL = "claude-opus-5"

# Server-side tool definitions (dynamic-filtering variants; no beta header).
WEB_SEARCH_TOOL = {
    "type": "web_search_20260209",
    "name": "web_search",
    "max_uses": 30,
}
WEB_FETCH_TOOL = {
    "type": "web_fetch_20260209",
    "name": "web_fetch",
    "max_uses": 15,
}

ProgressFn = Callable[[str, str], None]


class MissingCredentials(RuntimeError):
    """No Anthropic credentials available."""


def _client():
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - install-time problem
        raise MissingCredentials(
            "The 'anthropic' package is not installed. Run: pip install anthropic"
        ) from exc

    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        # The SDK can also pick up an `ant auth login` profile; only fail loudly
        # if constructing the client finds nothing at all.
        try:
            return anthropic.Anthropic()
        except Exception as exc:
            raise MissingCredentials(
                "No Anthropic credentials found. Set ANTHROPIC_API_KEY "
                "(https://console.anthropic.com/settings/keys) and re-run."
            ) from exc
    return anthropic.Anthropic()


# ---------------------------------------------------------------------------
# Phase 1: research
# ---------------------------------------------------------------------------

RESEARCH_SYSTEM = """\
You are a relentless budget-travel deal hunter. Your job is to find what a real \
person would actually pay for a hotel or motel room on specific dates in a \
specific ZIP code, and to find the unflattering truth about the cheap ones.

Ground rules, in order of importance:
1. NEVER invent a price, a hotel, a review score, or a URL. Every price you \
report must come from a page you actually searched or fetched. If you cannot \
verify a price, say so explicitly and mark it low confidence.
2. Search BROADLY before you go deep. Budget rooms hide in places a single \
Google query never surfaces.
3. The advertised nightly rate is not the price. Hunt for taxes, resort/ \
destination fees, cleaning fees, parking fees, and pet fees, and report the \
realistic all-in total for the whole stay.
4. For the cheapest options especially, go find out what is wrong with them. \
Recent reviews mentioning bed bugs, roaches, mold, filth, or safety problems \
are the single most valuable thing you can report.
"""

RESEARCH_PROMPT = """\
Find the best hotel/motel deals for this stay:

  ZIP code:  {zip_code}
  Check-in:  {check_in}
  Check-out: {check_out}
  Nights:    {nights}

Work through these steps.

STEP 1 — Locate. Determine the city/state for ZIP {zip_code}, and list nearby \
towns within roughly 20 miles. Cheap motels are often one town over; include \
them, noting the distance.

STEP 2 — Search broadly. Run MANY distinct searches across these different \
families of sources (do not stop after one or two):
  * Metasearch and OTAs: Kayak, Trivago, Booking.com, Expedia, Hotels.com, \
Priceline, Agoda, Orbitz, Travelocity, Hotwire
  * Google Hotels / general web: e.g. "cheap motels {city_hint} {check_in}", \
"hotels near {zip_code} under $60", "{city_hint} motel deals"
  * Budget brand sites directly: Motel 6 / Studio 6, Super 8, Days Inn, \
Travelodge, Howard Johnson, Econo Lodge, Rodeway Inn, Quality Inn, Red Roof \
Inn, Americas Best Value, La Quinta, Best Western, Extended Stay America
  * Independent and local motels: find them by name via local listings/maps, \
then check their own websites — independents are frequently the cheapest and \
are invisible to OTAs
  * Discount angles: AAA/senior/military/government rates, weekly rates for \
longer stays, and opaque deals (Hotwire Hot Rate, Priceline Express)

STEP 3 — Price it honestly. For each promising property, capture: exact \
property name, the nightly rate, the realistic ALL-IN total for {nights} \
night(s) including taxes and mandatory fees, which site the price came from, \
the URL, and the cancellation policy. If a site would not show live rates for \
these dates, say that rather than guessing.

STEP 4 — Investigate quality, especially for the cheapest. For each candidate \
find a review score (note the scale and convert to a 0-10 scale) and the \
review count, and dig into RECENT negative reviews for concrete red flags: \
bed bugs, roaches, mold, filth, broken AC/heat, no hot water, sketchy area, \
crime, noise, surprise fees, rude staff. Also note genuine positives \
(free breakfast, recently renovated, unusually clean for the price).

STEP 5 — Report. Write up EVERY viable option you found (aim for at least 6-10 \
if they exist), each with: name, type (hotel/motel/inn), city, nightly rate, \
all-in total, fees, source site + URL, review score/count + source, concerns, \
highlights, distance, cancellation policy, and how confident you are that the \
price is real and bookable (high/medium/low).

Be thorough — this is the whole point of the tool. Then finish with a short \
list of which source families you actually searched, and anything that \
blocked you.
"""


def research(
    query: SearchInput,
    on_progress: Optional[ProgressFn] = None,
    max_tokens: int = 32000,
) -> tuple[str, list[str]]:
    """Run the broad web research pass. Returns (notes_text, queries_used)."""
    client = _client()
    prompt = RESEARCH_PROMPT.format(
        zip_code=query.zip_code,
        check_in=query.check_in,
        check_out=query.check_out,
        nights=query.nights,
        city_hint=query.zip_code,
    )

    with client.messages.stream(
        model=MODEL,
        max_tokens=max_tokens,
        system=RESEARCH_SYSTEM,
        output_config={"effort": "high"},
        tools=[WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        for event in stream:
            _report_event(event, on_progress)
        final = stream.get_final_message()

    notes = "\n".join(b.text for b in final.content if getattr(b, "type", "") == "text")
    queries = _tool_queries(final)
    return notes, queries


def _report_event(event, on_progress: Optional[ProgressFn]) -> None:
    """Surface server-tool activity as progress. Defensive: never raise."""
    if on_progress is None:
        return
    try:
        if getattr(event, "type", "") != "content_block_start":
            return
        block = getattr(event, "content_block", None)
        if getattr(block, "type", "") == "server_tool_use":
            name = getattr(block, "name", "") or "web"
            on_progress("tool", name)
    except Exception:
        pass


def _tool_queries(message) -> list[str]:
    """Pull the actual search queries / fetched URLs out of the response."""
    out: list[str] = []
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", "") != "server_tool_use":
            continue
        payload = getattr(block, "input", None) or {}
        if isinstance(payload, dict):
            value = payload.get("query") or payload.get("url")
            if value:
                out.append(str(value))
    return out


# ---------------------------------------------------------------------------
# Phase 2: extraction into validated records
# ---------------------------------------------------------------------------

class _StayOut(BaseModel):
    name: str
    kind: str = "hotel"
    city: str = ""
    nightly_usd: float = 0.0
    total_usd: float = 0.0
    fees_note: str = ""
    source: str = ""
    source_url: str = ""
    review_score_0_10: Optional[float] = None
    review_count: Optional[int] = None
    review_source: str = ""
    concerns: list[str] = Field(default_factory=list)
    highlights: list[str] = Field(default_factory=list)
    distance_note: str = ""
    cancellation: str = ""
    price_confidence: str = "medium"


class _Extraction(BaseModel):
    stays: list[_StayOut] = Field(default_factory=list)
    sources_searched: list[str] = Field(default_factory=list)
    problems: list[str] = Field(default_factory=list)


EXTRACT_PROMPT = """\
Convert the research notes below into structured records.

Rules:
- Include ONLY properties with a real price found during research. Skip any \
property with no price.
- total_usd must be the all-in total for the whole {nights}-night stay \
(including taxes and mandatory fees when the notes state them). If only a \
nightly rate is known, multiply by {nights} and note that in fees_note.
- Convert any review score to a 0-10 scale (a 4.2/5 becomes 8.4; an 8.6/10 \
stays 8.6). Leave it null if the notes give none.
- price_confidence: "high" if the price came from a live rate for these exact \
dates, "medium" if it is a typical/approximate rate, "low" if it could not be \
verified.
- concerns: short, concrete phrases drawn from the notes ("recent bed bug \
reports", "reviews mention mold"), not vague hedging.
- problems: anything that limited the research (sites that blocked access, \
dates too far out for live rates, etc).

RESEARCH NOTES:
---
{notes}
---
"""


def extract(notes: str, query: SearchInput) -> tuple[list[Stay], list[str], list[str]]:
    """Turn research notes into (stays, sources_searched, problems)."""
    client = _client()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        messages=[{
            "role": "user",
            "content": EXTRACT_PROMPT.format(nights=query.nights, notes=notes),
        }],
        output_format=_Extraction,
    )
    parsed = response.parsed_output
    if parsed is None:
        return [], [], ["Could not structure the research results."]
    return (
        [_to_stay(s) for s in parsed.stays],
        list(parsed.sources_searched),
        list(parsed.problems),
    )


def _to_stay(raw: _StayOut) -> Stay:
    nightly = _cents(raw.nightly_usd)
    total = _cents(raw.total_usd)
    return Stay(
        name=raw.name.strip(),
        kind=(raw.kind or "hotel").strip().lower(),
        city=raw.city,
        nightly_cents=nightly,
        total_cents=total,
        fees_note=raw.fees_note,
        source=raw.source,
        source_url=raw.source_url,
        review_score=raw.review_score_0_10,
        review_count=raw.review_count,
        review_source=raw.review_source,
        concerns=[c for c in raw.concerns if c.strip()],
        highlights=[h for h in raw.highlights if h.strip()],
        distance_note=raw.distance_note,
        cancellation=raw.cancellation,
        price_confidence=(raw.price_confidence or "medium").strip().lower(),
    )


def _cents(dollars: float) -> int:
    try:
        return int(round(float(dollars) * 100))
    except (TypeError, ValueError):
        return 0


def find_stays(
    query: SearchInput, on_progress: Optional[ProgressFn] = None
) -> tuple[list[Stay], list[str], list[str]]:
    """Full pipeline: research the web, then structure what was found."""
    notes, queries = research(query, on_progress=on_progress)
    if on_progress:
        on_progress("phase", f"ran {len(queries)} web lookups; reading results")
    stays, sources, problems = extract(notes, query)
    if queries and not sources:
        sources = queries[:12]
    return stays, sources, problems
