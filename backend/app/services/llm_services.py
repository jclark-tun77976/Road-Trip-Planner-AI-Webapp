import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

from app.models.trip_models import TripRequest, TripResponse
from app.services.mapping_services import (
    build_route_data,
    get_roadside_suggestions_for_route,
    get_roadside_tool_context,
    get_route_tool_context,
)
from app.services.prompt_services import build_full_prompt
from app.services.trip_parser import parse_trip_plan


load_dotenv()


def generate_trip_plan(trip_request: TripRequest) -> TripResponse:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in the environment.")

    client = genai.Client(api_key=api_key)
    full_prompt = build_full_prompt(
        trip_request.profile,
        trip_request.request,
        trip_request.conversation_history,
    )
    tool_usage = {
        "summaries": [],
    }
    roadside_tool_result = {
        "suggestions": [],
        "warnings": [],
    }

    def get_route_context(
        start_location: str,
        destination: str,
        stop_locations: list[str],
        vehicle_type: str,
        is_round_trip: bool = False,
    ) -> dict:
        """Get Google Maps route distance and duration facts for an ordered road trip.

        Args:
            start_location: Starting point for the trip.
            destination: Final destination when the trip is not a round trip.
            stop_locations: Ordered list of stop locations selected for the itinerary.
            vehicle_type: Vehicle type from the user profile.
            is_round_trip: Whether the trip should end where it started.

        Returns:
            Route totals, leg summaries, and any warnings from Google Maps lookups.
        """
        result = get_route_tool_context(
            start_location=start_location,
            destination=destination,
            stop_locations=stop_locations,
            vehicle_type=vehicle_type,
            is_round_trip=is_round_trip,
        )
        tool_usage["summaries"].append(
            "Gemini used the Google Maps route tool."
        )
        if result.get("route_available"):
            tool_usage["summaries"][-1] = (
                "Gemini used the Google Maps route tool "
                f"for {len(stop_locations)} planned stops, "
                f"{result.get('total_distance_km', 0)} km total."
            )
        else:
            tool_usage["summaries"][-1] = (
                "Gemini attempted the Google Maps route tool, but route facts were unavailable."
            )
        return result

    def get_roadside_options(
        start_location: str,
        destination: str,
        stop_locations: list[str],
        vehicle_type: str,
        is_round_trip: bool = False,
    ) -> dict:
        result = get_roadside_tool_context(
            start_location=start_location,
            destination=destination,
            stop_locations=stop_locations,
            vehicle_type=vehicle_type,
            is_round_trip=is_round_trip,
        )
        roadside_tool_result["suggestions"] = result.get("suggestions", [])
        roadside_tool_result["warnings"] = result.get("warnings", [])

        if result.get("suggestions_available"):
            tool_usage["summaries"].append(
                "Gemini used the roadside attractions tool "
                f"and found {len(result.get('suggestions', []))} optional stops."
            )
        else:
            tool_usage["summaries"].append(
                "Gemini attempted the roadside attractions tool, but no suggestions were available."
            )

        return result

    response = client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=full_prompt,
        config=types.GenerateContentConfig(
            tools=[get_route_context, get_roadside_options],
            toolConfig=types.ToolConfig(
                functionCallingConfig=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.AUTO,
                )
            ),
        ),
    )

    generated_plan, warnings = parse_trip_plan(response.text or "", trip_request.profile)
    route = None
    enriched_stops = generated_plan.trip_stops
    route_warnings: list[str] = []
    roadside_warnings: list[str] = roadside_tool_result["warnings"]
    roadside_options = generated_plan.roadside_options

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

    if not roadside_options and route is not None:
        try:
            roadside_options, generated_roadside_warnings = get_roadside_suggestions_for_route(route)
            roadside_warnings.extend(generated_roadside_warnings)
        except Exception as exc:
            roadside_warnings.append(f"Roadside attraction suggestions are unavailable right now: {exc}")

    return TripResponse(
        summary=generated_plan.summary,
        recommendations=generated_plan.recommendations,
        budget_notes=generated_plan.budget_notes,
        trip_stops=enriched_stops,
        roadside_options=roadside_options,
        route=route,
        warnings=warnings + route_warnings + roadside_warnings,
        tool_calling_used=bool(tool_usage["summaries"]),
        tool_calling_summary=" ".join(tool_usage["summaries"]),
        prompt_used=full_prompt,
    )
