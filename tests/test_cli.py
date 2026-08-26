"""Tests for input parsing and output rendering (no network)."""

from __future__ import annotations

from datetime import date

import pytest

from hotelfinder.cli import (
    DateParseError,
    ask_dates,
    ask_zip,
    parse_dates,
    render,
    valid_zip,
)
from hotelfinder.models import Pick, Result, SearchInput, Stay

TODAY = date(2026, 8, 26)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("2026-12-12 to 2026-12-14", (date(2026, 12, 12), date(2026, 12, 14))),
        ("2026-12-12 2026-12-14", (date(2026, 12, 12), date(2026, 12, 14))),
        ("12/12/2026 - 12/14/2026", (date(2026, 12, 12), date(2026, 12, 14))),
        ("dec 12-14", (date(2026, 12, 12), date(2026, 12, 14))),
        ("december 12 to 14", (date(2026, 12, 12), date(2026, 12, 14))),
        ("tonight", (TODAY, date(2026, 8, 27))),
        ("tomorrow", (date(2026, 8, 27), date(2026, 8, 28))),
        ("2026-12-12", (date(2026, 12, 12), date(2026, 12, 13))),
    ],
)
def test_parse_dates_understands_human_input(text, expected):
    assert parse_dates(text, today=TODAY) == expected


def test_month_day_in_the_past_rolls_to_next_year():
    # Jan 5 is behind Aug 2026, so it means Jan 2027.
    start, end = parse_dates("jan 5-7", today=TODAY)
    assert (start, end) == (date(2027, 1, 5), date(2027, 1, 7))


def test_parse_dates_rejects_garbage_and_backwards_ranges():
    with pytest.raises(DateParseError):
        parse_dates("whenever", today=TODAY)
    with pytest.raises(DateParseError):
        parse_dates("", today=TODAY)
    with pytest.raises(DateParseError):
        parse_dates("2026-12-14 to 2026-12-12", today=TODAY)


@pytest.mark.parametrize(
    "text,expected",
    [("78382", "78382"), ("  90210 ", "90210"), ("78382-1234", "78382"),
     ("7838", None), ("abcde", None), ("", None)],
)
def test_valid_zip(text, expected):
    assert valid_zip(text) == expected


def test_prompts_reask_until_valid():
    answers = iter(["not a date", "dec 12-14"])
    assert ask_dates(reader=lambda _: next(answers))[0].month == 12

    zips = iter(["nope", "123", "78382"])
    assert ask_zip(reader=lambda _: next(zips)) == "78382"


def _stay(name, total, score=None, **kw):
    return Stay(name=name, total_cents=total, nightly_cents=total, review_score=score, **kw)


QUERY = SearchInput(check_in="2026-12-12", check_out="2026-12-13", zip_code="78382", nights=1)


def test_render_shows_both_picks_and_downsides():
    cheap = _stay("Sunset Motel", 5200, 5.2, concerns=["recent bed bug reports"],
                  source="booking.com", kind="motel", city="Rockport TX")
    good = _stay("Harbor Inn", 6100, 8.4, source="hotels.com", city="Rockport TX")
    result = Result(
        query=QUERY,
        cheapest=Pick(stay=cheap, why="cheapest but bed bugs"),
        best_value=Pick(stay=good, why="$9.00 (17%) more, far better reviews"),
        all_stays=[cheap, good],
        sources_searched=["booking.com search"],
    )
    text = render(result)
    assert "CHEAPEST OPTION" in text and "$52.00" in text
    assert "BEST OVERALL VALUE" in text and "$61.00" in text
    assert "recent bed bug reports" in text
    assert "5.2/10" in text and "8.4/10" in text
    assert "booking.com" in text


def test_render_collapses_when_cheapest_is_also_best_value():
    only = _stay("Harbor Inn", 6100, 8.4)
    result = Result(
        query=QUERY,
        cheapest=Pick(stay=only, why="cheapest"),
        best_value=Pick(stay=only, why="also best value"),
        all_stays=[only],
    )
    text = render(result)
    assert "same property" in text
    assert text.count("Harbor Inn") == 1


def test_render_handles_no_results():
    result = Result(query=QUERY, notes=["every site blocked live rates"])
    text = render(result)
    assert "No bookable prices" in text
    assert "every site blocked live rates" in text


def test_render_reports_missing_reviews_honestly():
    s = _stay("Mystery Motel", 4000)
    result = Result(query=QUERY, cheapest=Pick(stay=s), best_value=Pick(stay=s), all_stays=[s])
    assert "Reviews: none found" in render(result)
