import os

from dotenv import load_dotenv
from google import genai

from app.models.trip_models import TripRequest, TripResponse
from app.services.mapping_services import build_route_data
from app.services.prompt_services import build_full_prompt
from app.services.trip_parser import parse_trip_plan


load_dotenv()


def generate_trip_plan(trip_request: TripRequest) -> TripResponse:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in the environment.")

    client = genai.Client(api_key=api_key)
    full_prompt = build_full_prompt(trip_request.profile, trip_request.request)

    response = client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=full_prompt,
    )

    generated_plan, warnings = parse_trip_plan(response.text or "", trip_request.profile)
    route = None
    enriched_stops = generated_plan.trip_stops
    route_warnings: list[str] = []

    try:
        route, enriched_stops, route_warnings = build_route_data(
            start_location=trip_request.profile.start_location,
            destination=(
                trip_request.profile.start_location
                if trip_request.profile.is_round_trip
                else trip_request.profile.destination
            ),
            trip_stops=generated_plan.trip_stops,
            vehicle_type=trip_request.profile.vehicle_type,
        )
    except Exception as exc:
        route_warnings.append(f"Google Maps route data is unavailable right now: {exc}")

    return TripResponse(
        summary=generated_plan.summary,
        recommendations=generated_plan.recommendations,
        budget_notes=generated_plan.budget_notes,
        trip_stops=enriched_stops,
        route=route,
        warnings=warnings + route_warnings,
        prompt_used=full_prompt,
    )
