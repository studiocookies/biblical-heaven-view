# hotelfinder

One command. Two questions. Then it searches the internet for the cheapest
room — and for the room that's actually worth the money.

```
$ hotelfinder
What dates do you want a room for?  dec 12-14
What ZIP code should I search?      78382
```

It comes back with exactly two recommendations:

- **Cheapest option** — the absolute lowest legitimate price it can find,
  shown even if the place looks terrible, with the downsides stated plainly
  (bed bugs, filth, bad area, surprise fees, non-refundable).
- **Best overall value** — the best balance of cheap and actually decent. A
  $61 room with 8.4/10 reviews beats a $52 room with 5.2/10 and bed bug
  reports, and it tells you exactly why.

## Install and run

```bash
pip install -e .
export ANTHROPIC_API_KEY=sk-ant-...      # https://console.anthropic.com/settings/keys
hotelfinder
```

Non-interactive:

```bash
hotelfinder --dates "2026-12-12 to 2026-12-14" --zip 78382
```

Dates are forgiving: `dec 12-14`, `12/12 - 12/14`, `2026-12-12 to 2026-12-14`,
`tonight`, `tomorrow`, or a single date (one night).

## How the search works

The searching runs **server-side via the Claude API's `web_search` and
`web_fetch` tools** — not by scraping from your machine. That matters: OTA
sites block scrapers aggressively, and this sidesteps that entirely while
needing no Booking/Expedia/SerpAPI keys.

Two passes:

1. **Research** (`claude-opus-5`, high effort, up to 30 web searches + 15 page
   fetches). It resolves the ZIP to a city plus nearby towns, then searches
   across deliberately different source families — metasearch and OTAs (Kayak,
   Trivago, Booking, Expedia, Hotels.com, Priceline, Agoda, Hotwire), budget
   brand sites direct (Motel 6, Super 8, Days Inn, Econo Lodge, Rodeway, Red
   Roof, Best Western, La Quinta), independent local motels via their own
   sites, and discount angles (AAA/senior/government, weekly rates, opaque
   deals). Then it goes and reads recent reviews for the cheapest candidates,
   which is where "cheap but awful" gets caught.
2. **Extraction** — a tool-free structured-output pass that turns the research
   into validated records. Prices, review scores, and concerns are schema-bound
   rather than free text.

The research prompt forbids inventing prices: anything it can't verify is
marked low confidence, and **low-confidence prices are never recommended.**

## How "best value" is decided

Deterministic, in `evaluate.py` — not a vague LLM judgment call:

```
value_score = quality_points - 12.0 * (extra_cost / cheapest_cost)
```

`quality_points` starts at the 0-10 review score (6.0 if unknown, with a
penalty), then subtracts for concerns — severe ones (bed bugs, roaches, mold,
filth, safety) cost 1.5 points each, moderate ones 0.5, capped at 4.0. The
price weight means a room 17% pricier has to be about 2 review points better
to win. Cheapest and best value are allowed to be the same property, and it
says so when they are.

## Status

Working and tested (86 tests): input parsing, research/extraction wiring,
value ranking, output, and failure handling all pass. **Not yet exercised
against the live API** — this build environment has no `ANTHROPIC_API_KEY`, so
the one thing not yet proven end-to-end is a real billed search. Everything
around it is verified with stubs.
```
src/hotelfinder/
  models.py     # Stay / SearchInput / Result
  search.py     # the web research engine (the important part)
  evaluate.py   # cheapest + best-value picking
  cli.py        # prompts, rendering, entry point
```
