import os
from dataclasses import dataclass


# Change only these 2 values when you want to switch the active LLM.
ACTIVE_PROVIDER = "google"
ACTIVE_MODEL = "gemini-2.5-flash"


# Optional reference list so it's easy to remember what you can swap to.
MODEL_OPTIONS = {
    "google": [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
    ],
    "openai": [
        "gpt-5",
        "gpt-5-mini",
        "gpt-4.1",
    ],
    "claude": [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
    ],
}


PROVIDER_LABELS = {
    "google": "Google",
    "openai": "OpenAI",
    "claude": "Claude",
}


API_KEY_ENV_VARS = {
    "google": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
}


SUPPORTED_LLM_PROVIDERS = tuple(PROVIDER_LABELS.keys())


@dataclass(frozen=True)
class LLMModelConfig:
    provider: str
    provider_label: str
    model: str
    api_key_env_var: str
    api_key: str | None


def get_active_llm_config() -> LLMModelConfig:
    provider = ACTIVE_PROVIDER.strip().lower()
    model = ACTIVE_MODEL.strip()

    if provider not in SUPPORTED_LLM_PROVIDERS:
        supported_values = ", ".join(SUPPORTED_LLM_PROVIDERS)
        raise ValueError(
            f"Unsupported ACTIVE_PROVIDER '{ACTIVE_PROVIDER}'. Use one of: {supported_values}."
        )

    if not model:
        raise ValueError("ACTIVE_MODEL cannot be empty.")

    api_key_env_var = API_KEY_ENV_VARS[provider]
    api_key = os.getenv(api_key_env_var)

    # Allow GOOGLE_API_KEY as a fallback alias for Google Generative AI.
    if provider == "google" and not api_key:
        api_key = os.getenv("GOOGLE_API_KEY")

    return LLMModelConfig(
        provider=provider,
        provider_label=PROVIDER_LABELS[provider],
        model=model,
        api_key_env_var=api_key_env_var,
        api_key=api_key,
    )


def get_active_model_name() -> str:
    return get_active_llm_config().model
