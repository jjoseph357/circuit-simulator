"""
LLM access for the Circuit Lab copilot (Doctor explanations, Architect, Tutor).

Standalone: settings live in circuit_simulator/settings.json (git-ignored, written by the app's
Settings dialog) and can be overridden with environment variables:

    CIRCUIT_LLM_PROVIDER   local | ollama | openai | anthropic | gemini
    CIRCUIT_LLM_MODEL      provider-specific model name
    OLLAMA_BASE_URL        default http://localhost:11434
    OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY

With provider "local" (the default) no network call is made; callers get an offline answer and
can tell from `is_offline()` that they should prefer their deterministic fallbacks.
"""
import json
import os
from typing import Any, Dict, Optional

import requests

_SETTINGS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "settings.json")

PROVIDERS = ("local", "ollama", "openai", "anthropic", "gemini")
DEFAULT_MODELS = {
    "ollama": "llama3.2",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-sonnet-5",
    "gemini": "gemini-2.0-flash",
}
_KEY_FIELDS = ("openai_api_key", "anthropic_api_key", "gemini_api_key")
_ENV = {
    "provider": "CIRCUIT_LLM_PROVIDER",
    "model": "CIRCUIT_LLM_MODEL",
    "ollama_base_url": "OLLAMA_BASE_URL",
    "openai_api_key": "OPENAI_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "gemini_api_key": "GEMINI_API_KEY",
}

SYSTEM_PROMPT = (
    "You are the AI copilot inside Circuit Lab, a teaching circuit simulator built on "
    "Modified Nodal Analysis (MNA). Students range from complete beginners to graduate students. "
    "Be precise and concise, use LaTeX math ($...$) where helpful, and never invent simulation "
    "numbers: the simulator's own results are provided when they matter."
)


def load_settings() -> Dict[str, str]:
    """File settings with environment variables taking precedence."""
    settings: Dict[str, str] = {"provider": "local", "model": "", "ollama_base_url": "http://localhost:11434"}
    try:
        with open(_SETTINGS_PATH, encoding="utf-8") as f:
            settings.update({k: str(v) for k, v in json.load(f).items() if v is not None})
    except (OSError, ValueError):
        pass
    for key, env in _ENV.items():
        if os.environ.get(env):
            settings[key] = os.environ[env]
    if settings.get("provider") not in PROVIDERS:
        settings["provider"] = "local"
    return settings


def save_settings(update: Dict[str, Any]) -> Dict[str, str]:
    """Merges `update` into settings.json. Empty key fields keep the stored key."""
    current: Dict[str, Any] = {}
    try:
        with open(_SETTINGS_PATH, encoding="utf-8") as f:
            current = json.load(f)
    except (OSError, ValueError):
        pass
    for key in ("provider", "model", "ollama_base_url", *_KEY_FIELDS):
        if key not in update:
            continue
        value = str(update[key] or "").strip()
        if key in _KEY_FIELDS and not value:
            continue  # blank means "unchanged"; use clear_keys to remove
        current[key] = value
    for key in update.get("clear_keys", []) or []:
        current.pop(key, None)
    if current.get("provider") not in PROVIDERS:
        current["provider"] = "local"
    with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return load_settings()


def public_settings() -> Dict[str, Any]:
    """Settings safe to send to the browser: keys are reported as present/absent only."""
    s = load_settings()
    return {
        "provider": s["provider"],
        "model": s.get("model") or DEFAULT_MODELS.get(s["provider"], ""),
        "ollama_base_url": s.get("ollama_base_url", ""),
        "keys": {k: bool(s.get(k)) for k in _KEY_FIELDS},
        "env_overrides": [k for k, env in _ENV.items() if os.environ.get(env)],
        "providers": list(PROVIDERS),
        "default_models": DEFAULT_MODELS,
    }


def is_offline(settings: Optional[Dict[str, str]] = None) -> bool:
    return (settings or load_settings()).get("provider", "local") == "local"


def _gemini(prompt: str, system: str, key: str, model: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    resp = requests.post(url, json={"contents": [{"parts": [{"text": f"{system}\n\n{prompt}"}]}]}, timeout=60)
    if resp.status_code == 200:
        parts = resp.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        if parts:
            return parts[0].get("text", "")
    raise RuntimeError(f"Gemini API error ({resp.status_code}): {resp.text[:300]}")


def _openai(prompt: str, system: str, key: str, model: str) -> str:
    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "temperature": 0.3,
              "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]},
        timeout=60,
    )
    if resp.status_code == 200:
        choices = resp.json().get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
    raise RuntimeError(f"OpenAI API error ({resp.status_code}): {resp.text[:300]}")


def _anthropic(prompt: str, system: str, key: str, model: str) -> str:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
        json={"model": model, "max_tokens": 2048, "system": system, "messages": [{"role": "user", "content": prompt}]},
        timeout=60,
    )
    if resp.status_code == 200:
        content = resp.json().get("content", [])
        if content:
            return content[0].get("text", "")
    raise RuntimeError(f"Anthropic API error ({resp.status_code}): {resp.text[:300]}")


def _ollama(prompt: str, system: str, base_url: str, model: str) -> str:
    resp = requests.post(f"{base_url.rstrip('/')}/api/generate",
                         json={"model": model, "prompt": prompt, "system": system, "stream": False}, timeout=120)
    if resp.status_code == 200:
        return resp.json().get("response", "")
    raise RuntimeError(f"Ollama error ({resp.status_code}): {resp.text[:300]}")


def _offline_answer(query: str, mode: str) -> str:
    """Honest local answer when no provider is configured (no pretend reasoning)."""
    if mode == "socratic_tutor":
        return (
            "*(Offline tutor: no AI provider is configured, so here is a general guiding question.)*\n\n"
            "Pick one node and list every element touching it. For each one, which way does current flow, "
            "and what sets its size: Ohm's law $I = (V_a - V_b)/R$, a source, or a device equation? "
            "Kirchhoff's Current Law says those currents must add to zero. Which unknown voltages appear in that "
            "equation, and which row of $G$ does it become?\n\n"
            "Configure an AI provider in **Settings** for answers tailored to your question."
        )
    return (
        "*(No AI provider is configured: open **Settings** to choose Ollama, OpenAI, Anthropic or Gemini. "
        "The simulator's deterministic tools, the Circuit Doctor, the offline designer and the tuner, still work.)*"
    )


def ask_ai(query: str, context: str = "", mode: str = "general", settings: Optional[Dict[str, str]] = None) -> str:
    """Sends a prompt to the configured provider; falls back to an offline answer on error."""
    s = settings or load_settings()
    provider = s.get("provider", "local")
    prompt = f"Context:\n```\n{context}\n```\n\nRequest:\n{query}" if context else query
    model = s.get("model") or DEFAULT_MODELS.get(provider, "")
    try:
        if provider == "ollama":
            return _ollama(prompt, SYSTEM_PROMPT, s.get("ollama_base_url") or "http://localhost:11434", model)
        if provider == "openai" and s.get("openai_api_key"):
            return _openai(prompt, SYSTEM_PROMPT, s["openai_api_key"], model)
        if provider == "anthropic" and s.get("anthropic_api_key"):
            return _anthropic(prompt, SYSTEM_PROMPT, s["anthropic_api_key"], model)
        if provider == "gemini" and s.get("gemini_api_key"):
            return _gemini(prompt, SYSTEM_PROMPT, s["gemini_api_key"], model)
    except Exception as e:  # network/provider failure: stay usable offline
        return f"{_offline_answer(query, mode)}\n\n*(Provider '{provider}' failed: {str(e)[:200]})*"
    return _offline_answer(query, mode)
