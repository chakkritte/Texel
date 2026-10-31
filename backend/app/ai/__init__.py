"""AI side panel: providers, context builder, tools and streaming service."""

from app.ai.context import ContextBundle, build_context
from app.ai.providers import get_provider, available_providers
from app.ai.tools import TOOLS, parse_text_tool_calls

__all__ = [
    "ContextBundle",
    "TOOLS",
    "available_providers",
    "build_context",
    "get_provider",
    "parse_text_tool_calls",
]
