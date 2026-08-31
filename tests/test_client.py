"""HTTP client tests: caching, rate limiting, retries. A fake session, no sockets."""

from __future__ import annotations

import json

import pytest
import requests

from umd_nutrition.client import USER_AGENT, Client, FetchError


class FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "<html>ok</html>"):
        self.status_code = status_code
        self.text = text

    @property
    def ok(self) -> bool:
        return self.status_code < 400


class FakeSession:
    """Replays a scripted list of responses (or exceptions) in order."""

    def __init__(self, script):
        self.script = list(script)
        self.headers: dict[str, str] = {}
        self.calls: list[str] = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        outcome = self.script.pop(0) if self.script else FakeResponse()
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def no_sleep(monkeypatch):
    """Record sleeps instead of taking them, so retry tests stay fast."""
    slept: list[float] = []
    monkeypatch.setattr("umd_nutrition.client.time.sleep", slept.append)
    return slept


def make_client(tmp_path, script=(), **kwargs) -> Client:
    return Client(cache_dir=tmp_path / "cache", session=FakeSession(script), **kwargs)


def test_user_agent_identifies_the_project(tmp_path) -> None:
    client = make_client(tmp_path)
    assert client.session.headers["User-Agent"] == USER_AGENT
    assert "student project" in USER_AGENT
    assert "github.com" in USER_AGENT, "a contact route is the point of a descriptive UA"


def test_fetch_writes_html_and_a_readable_sidecar(tmp_path, no_sleep) -> None:
    client = make_client(tmp_path, [FakeResponse(text="<html>hi</html>")])
    result = client.get("https://example.test/page")

    assert result.html == "<html>hi</html>"
    assert result.from_cache is False

    bodies = list((tmp_path / "cache").glob("*.html"))
    sidecars = list((tmp_path / "cache").glob("*.json"))
    assert len(bodies) == 1 and len(sidecars) == 1
    assert json.loads(sidecars[0].read_text())["url"] == "https://example.test/page"


def test_second_get_is_served_from_cache(tmp_path, no_sleep) -> None:
    client = make_client(tmp_path, [FakeResponse(text="<html>one</html>")])
    client.get("https://example.test/page")
    result = client.get("https://example.test/page")

    assert result.from_cache is True
    assert result.html == "<html>one</html>"
    assert len(client.session.calls) == 1
    assert client.pages_fetched == 1
    assert client.cache_hits == 1


def test_cache_ok_false_refetches_but_still_writes(tmp_path, no_sleep) -> None:
    """Menu pages change daily, so they are re-fetched and the cache refreshed."""
    client = make_client(
        tmp_path, [FakeResponse(text="<html>day one</html>"), FakeResponse(text="<html>day two</html>")]
    )
    client.get("https://example.test/menu")
    result = client.get("https://example.test/menu", cache_ok=False)

    assert result.html == "<html>day two</html>"
    assert result.from_cache is False
    assert client.cached_html("https://example.test/menu") == "<html>day two</html>"


def test_different_urls_do_not_collide(tmp_path, no_sleep) -> None:
    client = make_client(
        tmp_path, [FakeResponse(text="<html>a</html>"), FakeResponse(text="<html>b</html>")]
    )
    client.get("https://example.test/a")
    client.get("https://example.test/b")

    assert client.cached_html("https://example.test/a") == "<html>a</html>"
    assert client.cached_html("https://example.test/b") == "<html>b</html>"


def test_waits_between_network_requests(tmp_path, no_sleep) -> None:
    client = make_client(
        tmp_path,
        [FakeResponse(text="<html>a</html>"), FakeResponse(text="<html>b</html>")],
        delay=1.0,
    )
    client.get("https://example.test/a")
    client.get("https://example.test/b")

    assert no_sleep, "second request should have waited"
    assert 0 < no_sleep[0] <= 1.0


def test_cache_hits_do_not_wait(tmp_path, no_sleep) -> None:
    client = make_client(tmp_path, [FakeResponse(text="<html>a</html>")], delay=1.0)
    client.get("https://example.test/a")
    no_sleep.clear()
    client.get("https://example.test/a")

    assert no_sleep == []


def test_retries_5xx_then_succeeds(tmp_path, no_sleep) -> None:
    client = make_client(
        tmp_path,
        [FakeResponse(500), FakeResponse(503), FakeResponse(200, "<html>finally</html>")],
        delay=0,
    )
    result = client.get("https://example.test/flaky")

    assert result.html == "<html>finally</html>"
    assert len(client.session.calls) == 3
    assert no_sleep == [1.0, 2.0], "backoff should double"


def test_retries_timeouts(tmp_path, no_sleep) -> None:
    client = make_client(
        tmp_path,
        [requests.Timeout("timed out"), FakeResponse(200, "<html>ok</html>")],
        delay=0,
    )
    assert client.get("https://example.test/slow").html == "<html>ok</html>"


def test_gives_up_after_max_retries(tmp_path, no_sleep) -> None:
    client = make_client(
        tmp_path, [FakeResponse(500)] * 4, delay=0, max_retries=4
    )
    with pytest.raises(FetchError) as excinfo:
        client.get("https://example.test/down")

    assert "gave up after 4" in str(excinfo.value)
    assert "500" in str(excinfo.value)
    assert client.pages_fetched == 0


def test_404_fails_immediately_without_retrying(tmp_path, no_sleep) -> None:
    """A missing page will not become present by asking four times."""
    client = make_client(tmp_path, [FakeResponse(404)], delay=0)

    with pytest.raises(FetchError) as excinfo:
        client.get("https://example.test/gone")

    assert "404" in str(excinfo.value)
    assert len(client.session.calls) == 1
