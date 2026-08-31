"""Polite HTTP client: rate limited, disk-cached, retried on 5xx.

Every page ever fetched is written to `cache/` keyed by a hash of its URL, so
re-parsing during development costs nothing and the site is hit once per page.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import requests

log = logging.getLogger(__name__)

# A contact route is the point of a descriptive UA. The repo link serves that
# without putting a personal address in a public repository.
USER_AGENT = (
    "UMD-Nutrition-StudentProject/0.1 "
    "(personal student project; https://github.com/Aysinghal/umd-nutrition)"
)

RETRY_STATUSES = {500, 502, 503, 504, 408, 429}


class FetchError(RuntimeError):
    """A page could not be fetched after exhausting retries."""


@dataclass
class FetchResult:
    url: str
    html: str
    from_cache: bool


class Client:
    """Single-threaded, rate-limited, caching HTTP client."""

    def __init__(
        self,
        cache_dir: Path | str = "cache",
        *,
        delay: float = 0.5,
        timeout: float = 30.0,
        max_retries: int = 4,
        session: requests.Session | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # 2/sec, single threaded. The site publishes no robots.txt and so no
        # crawl-delay; this is well inside what one browser page load does.
        self.delay = delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})

        self.pages_fetched = 0
        self.cache_hits = 0
        self._last_request_at: float | None = None

    def _paths(self, url: str) -> tuple[Path, Path]:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.cache_dir / f"{digest}.html", self.cache_dir / f"{digest}.json"

    def cached_html(self, url: str) -> str | None:
        body, _ = self._paths(url)
        if body.exists():
            return body.read_text(encoding="utf-8", errors="replace")
        return None

    def _write_cache(self, url: str, html: str) -> None:
        body, meta = self._paths(url)
        body.write_text(html, encoding="utf-8", errors="replace")
        # The sidecar exists purely so a cache directory of hashes stays legible.
        meta.write_text(
            json.dumps({"url": url, "fetched_at": time.time(), "bytes": len(html)}),
            encoding="utf-8",
        )

    def _wait_turn(self) -> None:
        """Hold the minimum gap between network requests. Cache hits never wait."""
        if self._last_request_at is None:
            return
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)

    def get(self, url: str, *, cache_ok: bool = True) -> FetchResult:
        """Fetch a URL, preferring the disk cache.

        `cache_ok=False` forces a network hit but still writes the cache: menu
        pages change from day to day, label pages never do.
        """
        if cache_ok:
            cached = self.cached_html(url)
            if cached is not None:
                self.cache_hits += 1
                return FetchResult(url=url, html=cached, from_cache=True)

        last_error: str | None = None
        for attempt in range(self.max_retries):
            self._wait_turn()
            try:
                response = self.session.get(url, timeout=self.timeout)
                self._last_request_at = time.monotonic()

                if response.status_code in RETRY_STATUSES:
                    last_error = f"HTTP {response.status_code}"
                elif not response.ok:
                    # 404 and friends will not improve by asking again.
                    raise FetchError(f"{url}: HTTP {response.status_code}")
                else:
                    html = response.text
                    self._write_cache(url, html)
                    self.pages_fetched += 1
                    return FetchResult(url=url, html=html, from_cache=False)
            except requests.RequestException as exc:
                self._last_request_at = time.monotonic()
                last_error = f"{type(exc).__name__}: {exc}"

            if attempt < self.max_retries - 1:
                backoff = 2.0**attempt
                log.warning(
                    "%s: %s — retrying in %.0fs (attempt %d/%d)",
                    url,
                    last_error,
                    backoff,
                    attempt + 2,
                    self.max_retries,
                )
                time.sleep(backoff)

        raise FetchError(f"{url}: gave up after {self.max_retries} attempts ({last_error})")
