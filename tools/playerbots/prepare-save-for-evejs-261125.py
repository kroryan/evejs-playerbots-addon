#!/usr/bin/env python3
"""Prepare a Playerbots save for EveJS 261125.3's save upgrade.

EveJS 261125.3 converts the save into a strict typed schema and checks that
every row reads back unchanged. Two things in a save played with earlier
Playerbots releases stop that upgrade:

1. Add-on releases before 261125.3 stored an orderID on every wallet market
   transaction. The new schema has no such field: "Invalid
   character_market_transactions field or shape".
2. A ship told to fly in a direction gets a target point 1e17 m away
   (space/destiny/simulation/evolve.js). JSON writes such a whole-number
   coordinate as a long integer literal, the upgrade's check reads it back as
   a BigInt, the typed column returns a float, and the row "differs after
   conversion". Bots fly a lot, so their saves have many of these.

3. The roster reset kept a retiredFoundingOperationID on bot corporations it
   emptied. The new corporation profile has no such field: "Invalid
   corporation_profiles field or shape".
4. Planet launch receipts were kept in planetRuntimeState under
   launchOperationReceiptsByKey. The new schema has no such root:
   "Unrecognized planetRuntimeState record key". The add-on now keeps them
   in memory.

This removes (1) from walletAuthorityState, (3) from corporations and the
row in (4), and rewrites the coordinates in (2) as floating-point numbers of
the same value.
Nothing else changes.

Stop the server first and keep a backup of the save.

    python3 prepare-save-for-evejs-261125.py /path/to/gameStore/gamestore.sqlite
    python3 prepare-save-for-evejs-261125.py --check /path/to/gamestore.sqlite
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

MAX_SAFE = 2 ** 53 - 1
VECTOR_KEYS = {"x", "y", "z"}


def strip_order_ids(value) -> int:
    removed = 0
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "marketTransactions" and isinstance(child, list):
                for entry in child:
                    if isinstance(entry, dict) and "orderID" in entry:
                        del entry["orderID"]
                        removed += 1
            else:
                removed += strip_order_ids(child)
    elif isinstance(value, list):
        for child in value:
            removed += strip_order_ids(child)
    return removed


def strip_key(value, name: str) -> int:
    removed = 0
    if isinstance(value, dict):
        if name in value:
            del value[name]
            removed += 1
        for child in value.values():
            removed += strip_key(child, name)
    elif isinstance(value, list):
        for child in value:
            removed += strip_key(child, name)
    return removed


def float_vectors(value) -> int:
    """Turn unsafe whole-number x/y/z coordinates into floats; return the count."""
    changed = 0
    if isinstance(value, dict):
        if value and set(value) <= VECTOR_KEYS:
            for key, number in value.items():
                if type(number) is int and abs(number) > MAX_SAFE:
                    value[key] = float(number)
                    changed += 1
            return changed
        for child in value.values():
            changed += float_vectors(child)
    elif isinstance(value, list):
        for child in value:
            changed += float_vectors(child)
    return changed


def legacy_tables(db) -> list[str]:
    names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    return [name for name in names if not name.startswith(("_", "sqlite_")) and
            [row[1] for row in db.execute(f'PRAGMA table_info("{name}")')][:2] == ["key", "json"]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("database")
    parser.add_argument("--check", action="store_true", help="report what would change and write nothing")
    args = parser.parse_args()
    db = sqlite3.connect(args.database)
    totals = {"orderID fields": 0, "coordinates": 0, "corporation fields": 0, "rows": 0, "receipt rows": 0}
    with db:
        if "planetRuntimeState" in legacy_tables(db):
            where = "FROM planetRuntimeState WHERE key = 'launchOperationReceiptsByKey'"
            totals["receipt rows"] = db.execute(f"SELECT COUNT(*) {where}").fetchone()[0]
            if totals["receipt rows"] and not args.check:
                db.execute(f"DELETE {where}")
        for table in legacy_tables(db):
            wallets = table == "walletAuthorityState"
            corporations = table == "corporations"
            for key, text in db.execute(f'SELECT key, json FROM "{table}"').fetchall():
                if not wallets and not corporations and '"x":' not in (text or ""):
                    continue
                try:
                    record = json.loads(text)
                except (TypeError, ValueError):
                    continue
                order_ids = strip_order_ids(record) if wallets else 0
                coordinates = float_vectors(record)
                corporation_fields = strip_key(record, "retiredFoundingOperationID") if corporations else 0
                if not order_ids and not coordinates and not corporation_fields:
                    continue
                totals["corporation fields"] += corporation_fields
                totals["orderID fields"] += order_ids
                totals["coordinates"] += coordinates
                totals["rows"] += 1
                if not args.check:
                    db.execute(f'UPDATE "{table}" SET json = ? WHERE key = ?',
                               (json.dumps(record, separators=(",", ":")), key))
    verb = "Would change" if args.check else "Changed"
    print(f"{verb} {totals['rows']} row(s): {totals['orderID fields']} orderID field(s) removed, "
          f"{totals['coordinates']} coordinate(s) written as floats, "
          f"{totals['corporation fields']} retiredFoundingOperationID field(s) removed, "
          f"{totals['receipt rows']} planet launch receipt row(s) removed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
