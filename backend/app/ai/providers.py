"""AI provider adapters.

Anthropic is used through the official ``anthropic`` SDK (async, streaming);
Ollama is called directly over its ``/api/chat`` NDJSON stream with httpx.
Keys always come from server-side settings - never from the browser.

Both providers yield plain dict events:

    {"type": "token", "text": "..."}
    {"type": "tool", "name": "propose_edit", "input": {...}}
    {"type": "done", "provider": ..., "model": ..., "tokens_in": ...,
     "tokens_out": ..., "cache_read_tokens": ..., "cache_write_tokens": ...}

The service layer turns those into persisted messages/usage and SSE frames.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol

import httpx

from app.core.config import settings

try:  # pragma: no cover - exercised through the installed dependency
    import anthropic
except Exception:  # pragma: no cover - allows importing the app without the SDK
    anthropic = None  # type: ignore[assignment]


MAX_OUTPUT_TOKENS = 8192
HTTP_TIMEOUT_SECONDS = 120.0
OLLAMA_TAGS_TIMEOUT_SECONDS = 4.0


class ProviderError(RuntimeError):
    """Raised for configuration/transport errors that are safe to show to users."""


# USD per 1M tokens: (input, output).  Cache reads are 0.1x input and cache
# writes are 1.25x input, matching Anthropic's published pricing.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-haiku-4-5": (1.0, 5.0),
}

# Models offered in the UI.  ``settings.anthropic_model`` is always included
# first so an operator can point at a newer/different model without a deploy.
ANTHROPIC_MODELS = [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
]


def anthropic_models() -> list[str]:
    models = [m for m in [settings.anthropic_model, *ANTHROPIC_MODELS] if m]
    return list(dict.fromkeys(models))


def compute_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    """Return an estimated USD cost. Unknown models are reported as 0.0."""
    rates = MODEL_PRICING.get(model)
    if rates is None:
        return 0.0
    input_rate, output_rate = rates
    usd = (
        input_tokens * input_rate
        + cache_read_tokens * input_rate * 0.10
        + cache_write_tokens * input_rate * 1.25
        + output_tokens * output_rate
    ) / 1_000_000
    return round(usd, 6)


class Provider(Protocol):
    id: str
    default_model: str
    supports_tools: bool

    def stream(
        self,
        *,
        model: str,
        system: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:  # pragma: no cover - protocol
        ...


def _safe_anthropic_error(exc: Exception) -> str:
    if anthropic is not None:
        if isinstance(exc, anthropic.AuthenticationError):
            return "Anthropic authentication failed - check ANTHROPIC_API_KEY."
        if isinstance(exc, anthropic.PermissionDeniedError):
            return "Anthropic API key does not have permission for this model."
        if isinstance(exc, anthropic.NotFoundError):
            return "Anthropic model was not found."
        if isinstance(exc, anthropic.RateLimitError):
            return "Anthropic rate limit reached; please retry shortly."
        if isinstance(exc, anthropic.APIConnectionError):
            return "Could not reach the Anthropic API."
        if isinstance(exc, anthropic.APIStatusError):
            detail = getattr(exc, "message", "") or str(exc)
            return f"Anthropic API error ({exc.status_code}): {detail}"[:500]
    return f"Anthropic request failed: {exc}"[:500]


class AnthropicProvider:
    id = "anthropic"
    supports_tools = True

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = settings.anthropic_api_key if api_key is None else api_key
        self.default_model = settings.anthropic_model or ANTHROPIC_MODELS[0]

    async def stream(
        self,
        *,
        model: str,
        system: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if anthropic is None:
            raise ProviderError(
                "The anthropic Python SDK is not installed (pip install 'anthropic>=0.40')."
            )
        if not self.api_key:
            raise ProviderError("ANTHROPIC_API_KEY is not configured on the server.")

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "system": system,
            "messages": messages,
        }
        if tools:
            # ``tool_choice`` is intentionally left at the default ("auto"):
            # forced tool use is rejected by newer Sonnet/Opus models.
            kwargs["tools"] = tools

        try:
            async with client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if event.type != "content_block_delta":
                        continue
                    delta = getattr(event, "delta", None)
                    if getattr(delta, "type", None) == "text_delta":
                        text = getattr(delta, "text", "") or ""
                        if text:
                            yield {"type": "token", "text": text}
                final = await stream.get_final_message()
        except Exception as exc:  # noqa: BLE001 - normalized below
            raise ProviderError(_safe_anthropic_error(exc)) from exc
        finally:
            try:
                await client.close()
            except Exception:  # pragma: no cover - best effort cleanup
                pass

        for block in getattr(final, "content", []):
            if getattr(block, "type", None) == "tool_use":
                yield {
                    "type": "tool",
                    "name": block.name,
                    "input": getattr(block, "input", {}) or {},
                }

        usage = getattr(final, "usage", None)
        yield {
            "type": "done",
            "provider": self.id,
            "model": model,
            "tokens_in": int(getattr(usage, "input_tokens", 0) or 0),
            "tokens_out": int(getattr(usage, "output_tokens", 0) or 0),
            "cache_read_tokens": int(
                getattr(usage, "cache_read_input_tokens", 0) or 0
            ),
            "cache_write_tokens": int(
                getattr(usage, "cache_creation_input_tokens", 0) or 0
            ),
            "stop_reason": getattr(final, "stop_reason", None),
        }


class OllamaProvider:
    id = "ollama"
    supports_tools = False

    def __init__(self, base_url: str | None = None, api_key: str | None = None) -> None:
        self.base_url = (settings.ollama_base_url if base_url is None else base_url).rstrip("/")
        self.api_key = settings.ollama_api_key if api_key is None else api_key
        self.default_model = settings.ollama_model

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    @staticmethod
    def _system_text(system: Any) -> str:
        if isinstance(system, str):
            return system
        if isinstance(system, list):
            parts: list[str] = []
            for block in system:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "\n\n".join(part for part in parts if part)
        return ""

    async def stream(
        self,
        *,
        model: str,
        system: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        ollama_messages: list[dict[str, Any]] = []
        system_text = self._system_text(system)
        if system_text:
            ollama_messages.append({"role": "system", "content": system_text})
        ollama_messages.extend(messages)

        payload = {
            "model": model or self.default_model,
            "messages": ollama_messages,
            "stream": True,
        }
        timeout = httpx.Timeout(
            connect=10.0, read=None, write=HTTP_TIMEOUT_SECONDS, pool=10.0
        )
        url = f"{self.base_url}/api/chat"
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", url, json=payload, headers=self._headers()
                ) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")
                        raise ProviderError(
                            f"Ollama returned {response.status_code}: {body[:400]}"
                        )
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(data, dict):
                            continue
                        if data.get("error"):
                            raise ProviderError(f"Ollama error: {data['error']}")
                        message = data.get("message") or {}
                        text = message.get("content") or ""
                        if text:
                            yield {"type": "token", "text": text}
                        if data.get("done"):
                            yield {
                                "type": "done",
                                "provider": self.id,
                                "model": model or self.default_model,
                                "tokens_in": int(data.get("prompt_eval_count", 0) or 0),
                                "tokens_out": int(data.get("eval_count", 0) or 0),
                                "cache_read_tokens": 0,
                                "cache_write_tokens": 0,
                                "stop_reason": data.get("done_reason"),
                            }
                            return
        except ProviderError:
            raise
        except httpx.HTTPError as exc:
            raise ProviderError(f"Could not reach Ollama at {self.base_url}: {exc}") from exc

        # Some servers close the stream without a final done frame.
        yield {
            "type": "done",
            "provider": self.id,
            "model": model or self.default_model,
            "tokens_in": 0,
            "tokens_out": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "stop_reason": None,
        }


def get_provider(provider_id: str) -> Provider:
    if provider_id == "anthropic":
        return AnthropicProvider()
    if provider_id == "ollama":
        return OllamaProvider()
    raise ValueError(f"Unknown AI provider: {provider_id}")


async def list_ollama_models(
    base_url: str | None = None, api_key: str | None = None
) -> list[str]:
    """Return local/cloud Ollama tags, or an empty list when unavailable."""
    base = (settings.ollama_base_url if base_url is None else base_url).rstrip("/")
    key = settings.ollama_api_key if api_key is None else api_key
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TAGS_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{base}/api/tags", headers=headers)
            response.raise_for_status()
            data = response.json()
    except Exception:  # noqa: BLE001 - graceful degradation is the contract
        return []
    models: list[str] = []
    for item in data.get("models", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("model")
        if isinstance(name, str) and name:
            models.append(name)
    return list(dict.fromkeys(models))


async def available_providers() -> list[dict[str, Any]]:
    # Contract: Ollama's model list comes from /api/tags and degrades to an
    # empty list when the daemon is unreachable. ``default`` remains available
    # separately so the UI can still select the configured model.
    ollama = await list_ollama_models()
    return [
        {
            "id": "anthropic",
            "models": anthropic_models(),
            "default": settings.anthropic_model or ANTHROPIC_MODELS[0],
        },
        {
            "id": "ollama",
            "models": ollama,
            "default": settings.ollama_model,
        },
    ]


def default_model_for(provider_id: str) -> str:
    if provider_id == "anthropic":
        return settings.anthropic_model or ANTHROPIC_MODELS[0]
    if provider_id == "ollama":
        return settings.ollama_model
    raise ValueError(f"Unknown AI provider: {provider_id}")


@dataclass(frozen=True)
class UsageBreakdown:
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float


def usage_from_done(done: dict[str, Any]) -> UsageBreakdown:
    input_tokens = int(done.get("tokens_in", 0) or 0)
    output_tokens = int(done.get("tokens_out", 0) or 0)
    cache_read = int(done.get("cache_read_tokens", 0) or 0)
    cache_write = int(done.get("cache_write_tokens", 0) or 0)
    cost = compute_cost(
        str(done.get("model", "")),
        input_tokens,
        output_tokens,
        cache_read,
        cache_write,
    )
    return UsageBreakdown(
        tokens_in=input_tokens + cache_read + cache_write,
        tokens_out=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        cost_usd=cost,
    )
