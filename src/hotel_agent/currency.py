"""Shared currency utilities: ISO-4217 minor-unit exponents and formatting.

All amounts in this codebase are integer minor units ("cents" for exponent-2
currencies). Rendering and any per-major-unit math must go through here so
zero- and three-decimal currencies aren't silently treated as cents.
"""

from __future__ import annotations

# Minor-unit exponents that differ from the default of 2.
CURRENCY_EXPONENTS: dict[str, int] = {
    "JPY": 0, "KRW": 0, "VND": 0, "CLP": 0, "ISK": 0, "PYG": 0,
    "UGX": 0, "RWF": 0, "GNF": 0, "KMF": 0, "DJF": 0, "XOF": 0,
    "XAF": 0, "XPF": 0, "VUV": 0, "BIF": 0,
    "BHD": 3, "JOD": 3, "KWD": 3, "OMR": 3, "TND": 3, "IQD": 3, "LYD": 3,
}


def exponent(currency: str) -> int:
    return CURRENCY_EXPONENTS.get(currency.upper(), 2)


def format_money(minor_units: int, currency: str = "USD") -> str:
    """Render integer minor units as a human amount with the currency code."""
    exp = exponent(currency)
    sign = "-" if minor_units < 0 else ""
    amount = abs(minor_units)
    if exp == 0:
        return f"{sign}{currency} {amount:,d}"
    unit = 10 ** exp
    return f"{sign}{currency} {amount // unit:,d}.{amount % unit:0{exp}d}"
