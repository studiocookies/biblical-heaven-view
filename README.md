# hotel-agent

A personal hotel deal agent. It searches for stays, normalizes offers from
different channels (direct / OTA / award), computes a **deterministic
effective cost** — taxes, mandatory fees, card rewards, statement credits,
portal cashback, hotel points earned, included benefits, and points
opportunity cost — ranks everything, then runs a **skeptical reviewer pass**
that hunts for missed fees, better rates, bad loyalty logic, cancellation
risk, and better payment options before you see a recommendation. If the
skeptic finds a real problem, the recommendation is revised and says so.

Nothing is ever booked without your explicit approval of the exact plan
(offer + card + amounts), enforced by a plan-hash approval token.

## Quick start

```bash
pip install -e ".[dev]"
hotel-agent profile demo          # seed example loyalty accounts + cards
hotel-agent search "chicago" --checkin 2026-10-09 --checkout 2026-10-12
hotel-agent book plan --offer <OFFER_ID>
hotel-agent book confirm --plan <PLAN_ID> --token <BOOK-xxxx>
```

## What is REAL vs PARTIAL vs MOCK

| Piece | Status |
|---|---|
| Effective-cost engine (integer-cents, auditable line items) | REAL |
| Offer normalization (true totals incl. at-property fees) | REAL |
| Earn-vs-burn points reasoning (realized cpp vs baseline, net of forgone earning) | REAL |
| Deterministic skeptic pass + auto-revision | REAL |
| Memory (profile, loyalty, card metadata, searches, bookings; SQLite) | REAL |
| Booking approval flow (token-gated; manual executor gives exact steps) | REAL (manual) |
| Amadeus live-price provider | REAL code, needs `AMADEUS_CLIENT_ID`/`AMADEUS_CLIENT_SECRET` + open network; untested live |
| Fixture provider | MOCK — clearly labelled; used only when no live provider is available |
| LLM second-opinion skeptic | OPTIONAL — runs only with `ANTHROPIC_API_KEY` |
| Automated booking execution (browser/computer-use) | NOT IMPLEMENTED — `BookingExecutor` interface is the plug-in point |
| Cross-currency comparison | PARTIAL — ranks within one currency and discloses exclusions; no FX conversion |
| Zero/three-decimal currencies (JPY, KWD, …) | PARTIAL — true totals only; reward/points adjustments honestly skipped |

When only fixture data is available, every report is bannered `MOCK DATA`
and booking plans are labelled dry-run. The agent never presents mock
prices as live and never fabricates a booking.

## Security posture

- No card numbers, CVVs, or expiry dates anywhere in the data model — cards
  are metadata only (name, reward currency, perks).
- The memory store runs a PAN-redaction pass over everything it persists as
  defense-in-depth.
- The optional LLM skeptic receives only an offer summary — never profile
  balances or card details beyond display names.
- Amadeus credentials are read from env and never logged.

## Architecture

```
providers/ (Amadeus real, fixtures mock)  →  normalize.py  →  cost_engine.py + points.py
        →  recommend.py (rank)  →  skeptic.py (review + revise)  →  cli.py render
memory/store.py (SQLite)  ·  booking/executor.py (token-gated, pluggable)
```

Point valuations and earn rates ship as documented community-consensus
defaults (mid-2025) — override yours with `hotel-agent profile set-valuation`.
