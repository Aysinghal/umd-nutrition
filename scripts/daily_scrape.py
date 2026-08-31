"""Daily scrape and export. Run by the GitHub Action, or by hand.

    python scripts/daily_scrape.py [--days 7] [--db umd.db] [--out site/data]

Labels are fetched once ever, so a normal day fetches the menu pages plus whatever
handful of items are genuinely new. A cold run with no database fetches every
label — about 1,600 pages, roughly 13 minutes at two requests a second.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from umd_nutrition import db  # noqa: E402
from umd_nutrition.client import Client  # noqa: E402
from umd_nutrition.export import export  # noqa: E402
from umd_nutrition.scrape import DEFAULT_HALLS, date_range, scrape  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="days ahead, from today")
    parser.add_argument("--db", default="umd.db")
    parser.add_argument("--cache", default="cache")
    parser.add_argument("--out", default="docs/data")
    parser.add_argument("--keep-days", type=int, default=31, help="menu history to keep")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds per request")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S"
    )

    today = date.today()
    conn = db.connect(args.db)
    client = Client(args.cache, delay=args.delay)

    summary = scrape(
        conn,
        client,
        dates=date_range(today, args.days),
        halls=DEFAULT_HALLS,
        use_cached_menus=False,
        prune_keep_days=args.keep_days,
        today=today,
    )
    print("\n=== scrape ===")
    print(summary.report())

    exported = export(conn, args.out)
    print("\n=== export ===")
    print(exported.report())
    conn.close()

    # Parse failures are worth surfacing, but they are per item: the rest of the
    # run is still good and the export is still worth publishing. Fail the job
    # only if nothing at all came back.
    if summary.menu_pages == 0:
        print("\nFAILED: no menu pages parsed at all", file=sys.stderr)
        return 1
    if summary.errors:
        print(f"\n{len(summary.errors)} item(s) failed; export published anyway")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
