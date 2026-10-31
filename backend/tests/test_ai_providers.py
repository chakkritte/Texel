import asyncio

import pytest

from app.ai.providers import (
    AnthropicProvider,
    OllamaProvider,
    UsageBreakdown,
    available_providers,
    compute_cost,
    default_model_for,
    get_provider,
    list_ollama_models,
    usage_from_done,
)


def test_compute_cost_sonnet():
    assert compute_cost("claude-sonnet-5-5", 1_000_000, 1_000_000) == pytest.approx(12.0)


def test_compute_cost_applies_cache_multipliers():
    cost = compute_cost(
        "claude-sonnet-5-5",
        input_tokens=0,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000,
    )
    # 10 (output) + 0.2 (cache read) + 2.5 (cache write)
    assert cost == pytest.approx(12.7)


def test_compute_cost_unknown_model_is_zero():
    assert compute_cost("some-local-model", 100, 100) == 0.0


def test_usage_from_done_counts_cache_tokens_as_input():
    usage = usage_from_done(
        {
            "model": "claude-sonnet-5-5",
            "tokens_in": 100,
            "tokens_out": 50,
            "cache_read_tokens": 1000,
            "cache_write_tokens": 20,
        }
    )
    assert usage == UsageBreakdown(
        tokens_in=1120,
        tokens_out=50,
        cache_read_tokens=1000,
        cache_write_tokens=20,
        cost_usd=compute_cost("claude-sonnet-5-5", 100, 50, 1000, 20),
    )


def test_get_provider():
    assert isinstance(get_provider("anthropic"), AnthropicProvider)
    assert isinstance(get_provider("ollama"), OllamaProvider)
    with pytest.raises(ValueError):
        get_provider("openai")


def test_default_model_for():
    assert default_model_for("anthropic")
    assert default_model_for("ollama")
    with pytest.raises(ValueError):
        default_model_for("nope")


def test_list_ollama_models_is_graceful_when_unreachable():
    # Port 9 (discard) should refuse quickly; the contract is an empty list.
    assert asyncio.run(list_ollama_models(base_url="http://127.0.0.1:9")) == []


def test_available_providers_contains_both_providers(monkeypatch):
    async def fake_list_ollama_models(base_url=None, api_key=None):
        return ["qwen3:8b"]

    monkeypatch.setattr(
        "app.ai.providers.list_ollama_models", fake_list_ollama_models
    )
    providers = asyncio.run(available_providers())
    ids = {provider["id"] for provider in providers}
    assert ids == {"anthropic", "ollama"}
    anthropic = next(provider for provider in providers if provider["id"] == "anthropic")
    assert anthropic["models"]
    assert anthropic["default"] in anthropic["models"]
    ollama = next(provider for provider in providers if provider["id"] == "ollama")
    assert ollama["models"] == ["qwen3:8b"]


def test_available_providers_ollama_failure_is_empty(monkeypatch):
    async def failing_list(base_url=None, api_key=None):
        return []

    monkeypatch.setattr("app.ai.providers.list_ollama_models", failing_list)
    providers = asyncio.run(available_providers())
    ollama = next(provider for provider in providers if provider["id"] == "ollama")
    assert ollama["models"] == []
    # The configured default remains available for the UI to select.
    assert ollama["default"]
