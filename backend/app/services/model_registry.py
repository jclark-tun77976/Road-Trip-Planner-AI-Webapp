import os
from dataclasses import dataclass


# Change only this value when you want to switch Gemini models.
ACTIVE_MODEL = "gemini-2.5-flash"


# Optional reference list so it's easy to remember what you can swap to.
MODEL_OPTIONS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]


PROVIDER_LABEL = "Google"
API_KEY_ENV_VAR = "GEMINI_API_KEY"


@dataclass(frozen=True)
class LLMModelConfig:
    provider_label: str
    model: str
    api_key_env_var: str
    api_key: str | None


def get_active_llm_config() -> LLMModelConfig:
    model = ACTIVE_MODEL.strip()
    if not model:
        raise ValueError("ACTIVE_MODEL cannot be empty.")

    api_key = os.getenv(API_KEY_ENV_VAR)

    # Allow GOOGLE_API_KEY as a fallback alias for Google Generative AI.
    if not api_key:
        api_key = os.getenv("GOOGLE_API_KEY")

    return LLMModelConfig(
        provider_label=PROVIDER_LABEL,
        model=model,
        api_key_env_var=API_KEY_ENV_VAR,
        api_key=api_key,
    )


def get_active_model_name() -> str:
    return get_active_llm_config().model
