"""Tests for the search module's parsing and wiring (no network calls)."""

from __future__ import annotations

import types

import pytest

from hotelfinder import search
from hotelfinder.models import SearchInput
from hotelfinder.search import _cents, _StayOut, _to_stay, _tool_queries

QUERY = SearchInput(check_in="2026-12-12", check_out="2026-12-14", zip_code="78382", nights=2)


def test_cents_rounds_dollars_correctly():
    assert _cents(52.0) == 5200
    assert _cents(61.49) == 6149
    assert _cents(0) == 0
    assert _cents("bad") == 0
    assert _cents(None) == 0


def test_to_stay_maps_fields_and_normalizes():
    raw = _StayOut(
        name="  Sunset Motel  ",
        kind="MOTEL",
        nightly_usd=52.0,
        total_usd=118.40,
        review_score_0_10=5.2,
        review_count=214,
        concerns=["bed bugs", "   "],
        highlights=[],
        price_confidence="HIGH",
    )
    stay = _to_stay(raw)
    assert stay.name == "Sunset Motel"
    assert stay.kind == "motel"
    assert stay.nightly_cents == 5200
    assert stay.total_cents == 11840
    assert stay.review_score == 5.2
    assert stay.concerns == ["bed bugs"]  # blank dropped
    assert stay.price_confidence == "high"


def test_to_stay_tolerates_sparse_records():
    stay = _to_stay(_StayOut(name="Mystery Inn"))
    assert stay.total_cents == 0
    assert stay.review_score is None
    assert stay.price_confidence == "medium"


def test_tool_queries_extracts_searches_and_urls():
    message = types.SimpleNamespace(content=[
        types.SimpleNamespace(type="text", text="notes"),
        types.SimpleNamespace(type="server_tool_use", input={"query": "cheap motels 78382"}),
        types.SimpleNamespace(type="server_tool_use", input={"url": "https://example.com/x"}),
        types.SimpleNamespace(type="server_tool_use", input={}),          # ignored
        types.SimpleNamespace(type="server_tool_use", input=None),        # ignored
    ])
    assert _tool_queries(message) == ["cheap motels 78382", "https://example.com/x"]


def test_tool_queries_on_empty_message():
    assert _tool_queries(types.SimpleNamespace(content=[])) == []
    assert _tool_queries(types.SimpleNamespace()) == []


def test_progress_callback_never_raises_on_odd_events():
    seen = []
    ok = types.SimpleNamespace(
        type="content_block_start",
        content_block=types.SimpleNamespace(type="server_tool_use", name="web_search"),
    )
    search._report_event(ok, lambda k, d: seen.append((k, d)))
    assert seen == [("tool", "web_search")]

    # Malformed events and a raising callback must both be swallowed.
    search._report_event(types.SimpleNamespace(), lambda k, d: seen.append(k))
    search._report_event(ok, None)
    def boom(k, d):
        raise RuntimeError("callback blew up")
    search._report_event(ok, boom)


def test_extract_returns_problem_when_model_gives_nothing(monkeypatch):
    fake = types.SimpleNamespace(
        messages=types.SimpleNamespace(
            parse=lambda **kw: types.SimpleNamespace(parsed_output=None)
        )
    )
    monkeypatch.setattr(search, "_client", lambda: fake)
    stays, sources, problems = search.extract("notes", QUERY)
    assert stays == [] and sources == []
    assert problems and "structure" in problems[0].lower()


def test_extract_converts_parsed_records(monkeypatch):
    parsed = search._Extraction(
        stays=[_StayOut(name="Harbor Inn", total_usd=122.0, review_score_0_10=8.4)],
        sources_searched=["booking.com"],
        problems=["kayak blocked access"],
    )
    fake = types.SimpleNamespace(
        messages=types.SimpleNamespace(
            parse=lambda **kw: types.SimpleNamespace(parsed_output=parsed)
        )
    )
    monkeypatch.setattr(search, "_client", lambda: fake)
    stays, sources, problems = search.extract("notes", QUERY)
    assert len(stays) == 1
    assert stays[0].name == "Harbor Inn" and stays[0].total_cents == 12200
    assert sources == ["booking.com"]
    assert problems == ["kayak blocked access"]


def test_find_stays_falls_back_to_queries_as_sources(monkeypatch):
    monkeypatch.setattr(
        search, "research", lambda q, on_progress=None: ("notes", ["cheap motels 78382"])
    )
    monkeypatch.setattr(search, "extract", lambda notes, q: ([], [], []))
    stays, sources, problems = search.find_stays(QUERY)
    assert sources == ["cheap motels 78382"]


def test_research_uses_web_tools_and_high_effort():
    """The whole point of the tool: it must actually search the web."""
    assert search.WEB_SEARCH_TOOL["type"] == "web_search_20260209"
    assert search.WEB_FETCH_TOOL["type"] == "web_fetch_20260209"
    assert search.WEB_SEARCH_TOOL["max_uses"] >= 20
    assert search.MODEL == "claude-opus-5"
    # The research prompt must push breadth across source families.
    prompt = search.RESEARCH_PROMPT.lower()
    for token in ["booking.com", "expedia", "motel 6", "super 8", "independent", "aaa"]:
        assert token in prompt
    assert "never invent" in search.RESEARCH_SYSTEM.lower()
