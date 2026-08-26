"""Local SQLite-backed memory for the hotel agent.

Stores the user profile, search history, recommendations, and booking
plans/status. Nothing here ever stores card numbers, CVVs, or expiry dates —
the domain models (`PaymentCard`, `BookingPlan`) simply don't carry those
fields, and `redact()` is a defense-in-depth backstop applied to every string
persisted, in case a stray value (e.g. a user pref, a raw provider payload)
happens to contain something that looks like a PAN or CVV.
"""

from __future__ import annotations

import json
import pathlib
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional, Union

from pydantic import BaseModel

from hotel_agent.models import BookingPlan, Recommendation, SearchQuery, UserProfile

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# 13-19 consecutive digits, allowing space/dash/dot/slash/no-break-space and
# various unicode hyphen separators between digit groups (e.g.
# "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111",
# "4111.1111.1111.1111", "4111/1111/1111/1111", using U+00A0/U+2011/U+2012/
# U+2013 as the separator). We match on a run of digit-groups separated by an
# optional single separator character, then check the total digit count so we
# don't clobber unrelated long numbers such as a 10-digit phone number or a
# 7-digit points balance.
_PAN_SEP_CHARS = [
    " ",        # ASCII space
    "-",        # ASCII hyphen-minus
    ".",        # period
    "/",        # slash
    "\u00a0",  # no-break space
    "\u2011",  # non-breaking hyphen
    "\u2012",  # figure dash
    "\u2013",  # en dash
]
_PAN_SEP_CLASS = "[" + "".join(re.escape(c) for c in _PAN_SEP_CHARS) + "]"
_PAN_CANDIDATE_RE = re.compile(
    r"(?<!\d)(?:\d" + _PAN_SEP_CLASS + r"?){13,19}(?!\d)"
)

# CVV/CSC markers followed by a 3-4 digit code, e.g. "cvv: 123", "CVC=1234".
_CVV_RE = re.compile(
    r"(?i)\b(cvv2?|cvc2?|csc)\b\s*[:=]?\s*(\d{3,4})\b"
)

_PAN_PLACEHOLDER = "[REDACTED-PAN]"
_CVV_PLACEHOLDER_TEMPLATE = r"\1: [REDACTED-CVV]"


def redact(text: str) -> str:
    """Mask anything that looks like a card PAN or a CVV/CSC code, in a
    plain string (NOT a serialized-JSON blob — see `_redact_model_json` for
    that, which is what persistence actually uses).

    - PAN: 13-19 consecutive digits, digits may be separated by a space,
      ASCII hyphen, '.', '/', no-break space (U+00A0), or one of the unicode
      hyphen variants (U+2011/U+2012/U+2013) between groups (e.g.
      "4111 1111 1111 1111", "4111-1111-1111-1111"). Shorter/longer digit
      runs (phone numbers, points balances, IDs) are left untouched.
    - CVV: a "cvv"/"cvc"/"csc" marker (optionally followed by a digit, e.g.
      "cvv2") immediately followed by a 3-4 digit code.
    """
    if not text:
        return text

    def _pan_sub(match: "re.Match[str]") -> str:
        candidate = match.group(0)
        digit_count = sum(1 for c in candidate if c.isdigit())
        if 13 <= digit_count <= 19:
            return _PAN_PLACEHOLDER
        return candidate

    redacted = _PAN_CANDIDATE_RE.sub(_pan_sub, text)
    redacted = _CVV_RE.sub(_CVV_PLACEHOLDER_TEMPLATE, redacted)
    return redacted


def _redact_value(value: Any) -> Any:
    """Recursively walk a JSON-compatible value (as produced by
    `model_dump(mode="json")`), applying `redact()` only to string leaves
    (and dict keys, defensively). Numbers/bools/None pass through untouched
    so the result always remains valid, re-validatable JSON."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {redact(k) if isinstance(k, str) else k: _redact_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, tuple):
        return [_redact_value(v) for v in value]
    # int, float, bool, None - left untouched
    return value


def _redact_model_json(model: BaseModel) -> str:
    """Serialize a pydantic model to a redacted JSON string, redacting only
    string values (never numerics), so the output is always valid JSON the
    same model can re-validate via `model_validate_json`."""
    data = model.model_dump(mode="json")
    redacted = _redact_value(data)
    return json.dumps(redacted)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

DEFAULT_DB_PATH = pathlib.Path.home() / ".hotel_agent" / "agent.db"


class MemoryStore:
    """Stdlib-sqlite3-backed persistence for profile, searches,
    recommendations, and bookings."""

    def __init__(self, db_path: Optional[Union[str, pathlib.Path]] = None):
        self.db_path = pathlib.Path(db_path) if db_path is not None else DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profile (
                profile_id TEXT PRIMARY KEY,
                json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS recommendations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bookings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plan_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    # -- profile ------------------------------------------------------

    def load_profile(self, profile_id: str = "default") -> UserProfile:
        row = self._conn.execute(
            "SELECT json FROM profile WHERE profile_id = ?", (profile_id,)
        ).fetchone()
        if row is None:
            return UserProfile(profile_id=profile_id)
        return UserProfile.model_validate_json(row[0])

    def save_profile(self, p: UserProfile) -> None:
        payload = _redact_model_json(p)
        now = _now_iso()
        self._conn.execute(
            """
            INSERT INTO profile (profile_id, json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
                json = excluded.json,
                updated_at = excluded.updated_at
            """,
            (p.profile_id, payload, now),
        )
        self._conn.commit()

    # -- searches -------------------------------------------------------

    def record_search(self, q: SearchQuery) -> int:
        payload = _redact_model_json(q)
        cur = self._conn.execute(
            "INSERT INTO searches (json, created_at) VALUES (?, ?)",
            (payload, _now_iso()),
        )
        self._conn.commit()
        return cur.lastrowid

    def recent_searches(self, n: int = 10) -> list[SearchQuery]:
        rows = self._conn.execute(
            "SELECT json FROM searches ORDER BY id DESC LIMIT ?", (n,)
        ).fetchall()
        return [SearchQuery.model_validate_json(r[0]) for r in rows]

    # -- recommendations --------------------------------------------------

    def record_recommendation(self, r: Recommendation) -> int:
        payload = _redact_model_json(r)
        cur = self._conn.execute(
            "INSERT INTO recommendations (json, created_at) VALUES (?, ?)",
            (payload, _now_iso()),
        )
        self._conn.commit()
        return cur.lastrowid

    def recent_recommendations(self, n: int = 5) -> list[Recommendation]:
        rows = self._conn.execute(
            "SELECT json FROM recommendations ORDER BY id DESC LIMIT ?", (n,)
        ).fetchall()
        return [Recommendation.model_validate_json(r[0]) for r in rows]

    # -- bookings ---------------------------------------------------------

    def record_booking(self, plan: BookingPlan, status: str) -> int:
        payload = _redact_model_json(plan)
        now = _now_iso()
        cur = self._conn.execute(
            "INSERT INTO bookings (plan_json, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (payload, status, now, now),
        )
        self._conn.commit()
        return cur.lastrowid

    def update_booking_status(self, booking_id: int, status: str) -> None:
        self._conn.execute(
            "UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?",
            (status, _now_iso(), booking_id),
        )
        self._conn.commit()

    def bookings(self) -> list[tuple[int, BookingPlan, str]]:
        rows = self._conn.execute(
            "SELECT id, plan_json, status FROM bookings ORDER BY id ASC"
        ).fetchall()
        return [
            (row[0], BookingPlan.model_validate_json(row[1]), row[2]) for row in rows
        ]

    # -- lifecycle ----------------------------------------------------------

    def close(self) -> None:
        self._conn.close()
