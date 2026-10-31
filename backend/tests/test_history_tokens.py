from datetime import datetime, timedelta, timezone

from app.routers.share import (
    hash_share_token,
    is_share_link_active,
    new_share_token,
)


def test_new_share_token_is_32_bytes_urlsafe():
    token = new_share_token()
    # token_urlsafe(32) => ceil(32 * 4 / 3) == 43 characters, no padding
    assert len(token) == 43
    assert "/" not in token
    assert "+" not in token
    assert new_share_token() != token


def test_hash_share_token_is_stable_sha256_hex():
    token = "example-token"
    digest = hash_share_token(token)
    assert digest == hash_share_token(token)
    assert len(digest) == 64
    assert int(digest, 16) >= 0  # hex
    assert digest != hash_share_token("example-token-2")


def test_token_hash_does_not_leak_raw_token():
    token = new_share_token()
    assert token not in hash_share_token(token)


def test_is_share_link_active():
    now = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
    assert is_share_link_active(None, None, now)
    assert is_share_link_active(None, now + timedelta(days=1), now)
    assert not is_share_link_active(None, now, now)
    assert not is_share_link_active(None, now - timedelta(seconds=1), now)
    assert not is_share_link_active(now, None, now)
    assert not is_share_link_active(now, now + timedelta(days=1), now)
