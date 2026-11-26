#!/usr/bin/env python3
"""Prepare a Playerbots save for EveJS 261125.3's save upgrade.

Add-on releases before EveJS 261125.3 stored an orderID on every wallet market
transaction. 261125.3 converts the save into a strict schema that has no such
field, and its upgrade stops with "Invalid character_market_transactions field
or shape". This removes that one field from character and corporation market
transactions in walletAuthorityState and changes nothing else.

Stop the server first and keep a backup of the save.

    python3 strip-transaction-order-ids.py /path/to/gameStore/gamestore.sqlite
    python3 strip-transaction-order-ids.py --check /path/to/gamestore.sqlite
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys


def strip(value) -> int:
    """Remove orderID from entries of every marketTransactions list; return the count."""
    removed = 0
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "marketTransactions" and isinstance(child, list):
                for entry in child:
                    if isinstance(entry, dict) and "orderID" in entry:
                        del entry["orderID"]
                        removed += 1
            else:
                removed += strip(child)
    elif isinstance(value, list):
        for child in value:
            removed += strip(child)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("database")
    parser.add_argument("--check", action="store_true", help="report what would change and write nothing")
    args = parser.parse_args()
    db = sqlite3.connect(args.database)
    columns = [row[1] for row in db.execute("PRAGMA table_info(walletAuthorityState)")]
    if not columns:
        print("No walletAuthorityState table: nothing to do.")
        return 0
    if columns[:2] != ["key", "json"]:
        print(f"walletAuthorityState has columns {columns}; this save is already in the new format.")
        return 0
    rows = changed = removed = 0
    with db:
        for key, text in db.execute("SELECT key, json FROM walletAuthorityState").fetchall():
            rows += 1
            try:
                record = json.loads(text)
            except (TypeError, ValueError):
                continue
            count = strip(record)
            if not count:
                continue
            changed += 1
            removed += count
            if not args.check:
                db.execute("UPDATE walletAuthorityState SET json = ? WHERE key = ?",
                           (json.dumps(record, separators=(",", ":")), key))
    verb = "Would remove" if args.check else "Removed"
    print(f"{verb} {removed} orderID field(s) from {changed} of {rows} wallet records.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
