import json
import os

from dotenv import load_dotenv
from google import genai

from app.models.trip_models import TripRequest, TripResponse
from app.services.prompt_services import build_full_prompt



load_dotenv()


def clean_model_json(text: str) -> str:
    cleaned = text.strip()

    if cleaned.startswith("```json"):
        cleaned = cleaned.removeprefix("```json").strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```").strip()

    if cleaned.endswith("```"):
        cleaned = cleaned.removesuffix("```").strip()

    return cleaned


def generate_trip_plan(trip_request: TripRequest) -> TripResponse:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in the environment.")

    client = genai.Client(api_key=api_key)
    full_prompt = build_full_prompt(trip_request.profile, trip_request.request)

    response = client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=(
            f"{full_prompt}\n\n"
            "Return valid JSON with exactly these keys: "
            "summary, recommendations, budget_notes. "
            "The recommendations value must be an array of 3 strings."
        ),
    )

    response_text = clean_model_json(response.text or "")

    try:
        parsed = json.loads(response_text)
    except json.JSONDecodeError:
        parsed = {
            "summary": response_text,
            "recommendations": [],
            "budget_notes": "Model did not return valid JSON, so the raw response was used.",
        }

    return TripResponse(
        summary=parsed.get("summary", ""),
        recommendations=parsed.get("recommendations", []),
        budget_notes=parsed.get("budget_notes", ""),
        prompt_used=full_prompt,
    )