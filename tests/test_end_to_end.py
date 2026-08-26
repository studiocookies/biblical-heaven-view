"""End-to-end: one command in, two recommendations out (search stubbed)."""

from __future__ import annotations

from hotelfinder import cli
from hotelfinder.models import Stay
from hotelfinder.search import MissingCredentials

CHEAP_BUT_AWFUL = Stay(
    name="Sunset Motel", kind="motel", city="Rockport TX",
    nightly_cents=5200, total_cents=5200,
    source="booking.com", source_url="https://booking.com/sunset",
    review_score=5.2, review_count=214, review_source="Google",
    concerns=["recent reviews report bed bugs", "reviews mention dirty rooms"],
    cancellation="non-refundable", price_confidence="high",
)
DECENT = Stay(
    name="Harbor Inn", kind="hotel", city="Rockport TX",
    nightly_cents=6100, total_cents=6100,
    source="hotels.com", source_url="https://hotels.com/harbor",
    review_score=8.4, review_count=930, review_source="Google",
    highlights=["free breakfast", "renovated 2024"],
    cancellation="free cancellation", price_confidence="high",
)
PRICEY = Stay(
    name="Bayfront Suites", total_cents=14900, nightly_cents=14900,
    review_score=9.0, review_count=400, source="expedia.com", price_confidence="high",
)


def test_one_command_produces_both_picks(monkeypatch, capsys):
    monkeypatch.setattr(
        cli, "find_stays",
        lambda q, on_progress=None: ([CHEAP_BUT_AWFUL, DECENT, PRICEY], ["booking.com"], []),
    )
    code = cli.main(["--dates", "2026-12-12 to 2026-12-13", "--zip", "78382"])
    out = capsys.readouterr().out

    assert code == 0
    # The cheapest is shown even though it is awful.
    assert "CHEAPEST OPTION" in out and "Sunset Motel" in out and "$52.00" in out
    assert "bed bugs" in out
    # Best value is the pricier-but-decent one, not the cheapest.
    assert "BEST OVERALL VALUE" in out and "Harbor Inn" in out
    # And not the most expensive either.
    assert "Bayfront Suites" not in out.split("BEST OVERALL VALUE")[1].split("Also found")[0]


def test_cheapest_wins_when_it_is_also_good(monkeypatch, capsys):
    good_and_cheap = DECENT.model_copy(update={"total_cents": 4900, "nightly_cents": 4900})
    monkeypatch.setattr(
        cli, "find_stays",
        lambda q, on_progress=None: ([good_and_cheap, PRICEY], [], []),
    )
    cli.main(["--dates", "tonight", "--zip", "90210"])
    out = capsys.readouterr().out
    assert "same property" in out


def test_missing_credentials_is_a_clear_message_not_a_traceback(monkeypatch, capsys):
    def boom(q, on_progress=None):
        raise MissingCredentials("No Anthropic credentials found. Set ANTHROPIC_API_KEY")
    monkeypatch.setattr(cli, "find_stays", boom)
    code = cli.main(["--dates", "tonight", "--zip", "78382"])
    out = capsys.readouterr().out
    assert code == 3
    assert "ANTHROPIC_API_KEY" in out
    assert "Traceback" not in out


def test_api_failure_is_reported_cleanly(monkeypatch, capsys):
    def boom(q, on_progress=None):
        raise RuntimeError("connection reset")
    monkeypatch.setattr(cli, "find_stays", boom)
    code = cli.main(["--dates", "tonight", "--zip", "78382"])
    out = capsys.readouterr().out
    assert code == 1 and "Search failed" in out and "Traceback" not in out


def test_no_results_does_not_crash(monkeypatch, capsys):
    monkeypatch.setattr(
        cli, "find_stays",
        lambda q, on_progress=None: ([], [], ["every site blocked live rates"]),
    )
    code = cli.main(["--dates", "tonight", "--zip", "78382"])
    out = capsys.readouterr().out
    assert code == 0
    assert "No bookable prices" in out and "every site blocked live rates" in out


def test_low_confidence_prices_are_not_recommended(monkeypatch, capsys):
    unverified = Stay(name="Ghost Motel", total_cents=1000, price_confidence="low")
    monkeypatch.setattr(
        cli, "find_stays",
        lambda q, on_progress=None: ([unverified, DECENT], [], []),
    )
    cli.main(["--dates", "tonight", "--zip", "78382"])
    out = capsys.readouterr().out
    # A price we could not verify must never become the headline recommendation.
    assert "CHEAPEST OPTION" in out
    assert "Harbor Inn" in out.split("CHEAPEST OPTION")[1].split("BEST OVERALL")[0]


def test_invalid_zip_flag_exits_cleanly(capsys):
    assert cli.main(["--dates", "tonight", "--zip", "abc"]) == 2
    assert "Invalid ZIP" in capsys.readouterr().out
