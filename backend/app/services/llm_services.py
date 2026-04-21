import os
import re

from dotenv import load_dotenv
from google import genai
from google.genai import types

from app.models.trip_models import Profile, TripRequest, TripResponse, TripStop
from app.services.mapping_services import (
    build_route_data,
    get_roadside_suggestions_for_route,
    get_roadside_tool_context,
    get_route_tool_context,
)
from app.services.prompt_services import build_full_prompt
from app.services.trip_parser import parse_trip_plan


load_dotenv()


AUTO_ADD_STOP_PATTERNS = (
    r"\bstops?\b",
    r"\bon the way\b",
    r"\balong the way\b",
    r"\brecommend(?:ed)?\b",
    r"\bthings to do\b",
    r"\bplaces to see\b",
    r"\bdetours?\b",
    r"\bscenic\b",
    r"\battractions?\b",
)


def _normalize_location(value: str) -> str:
    normalized = " ".join(value.lower().split())
    normalized = re.sub(r"\busa\b", "", normalized)
    normalized = re.sub(r"\bunited states\b", "", normalized)
    normalized = re.sub(r"\b\d{5}(?:-\d{4})?\b", "", normalized)
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())


def _get_trip_length_days(profile: Profile) -> int:
    unit = profile.trip_length_unit.strip().lower()
    value = max(profile.trip_length_value, 1)

    if unit == "hours":
        return 1 if value <= 24 else max((value + 23) // 24, 1)

    if unit == "weeks":
        return value * 7

    return value


def _count_intermediate_stops(trip_stops: list[TripStop], profile: Profile) -> int:
    normalized_start = _normalize_location(profile.start_location)
    normalized_destination = _normalize_location(profile.destination)

    return sum(
        1
        for stop in trip_stops
        if (
            _normalize_location(stop.location) != normalized_start
            and _normalize_location(stop.location) != normalized_destination
        )
    )


def _should_auto_add_recommended_stops(
    request_text: str,
    trip_stops: list[TripStop],
    profile: Profile,
) -> bool:
    if _count_intermediate_stops(trip_stops, profile) > 0:
        return False

    normalized_request = request_text.lower()
    wants_stops = any(re.search(pattern, normalized_request) for pattern in AUTO_ADD_STOP_PATTERNS)
    if not wants_stops:
        return False

    return _get_trip_length_days(profile) > 1


def _resequence_trip_stops(trip_stops: list[TripStop], profile: Profile) -> list[TripStop]:
    trip_length_days = _get_trip_length_days(profile)
    resequenced_stops: list[TripStop] = []

    for index, stop in enumerate(trip_stops, start=1):
        resequenced_stops.append(
            stop.model_copy(
                update={
                    "order": index,
                    "day": min(index, trip_length_days),
                }
            )
        )

    return resequenced_stops


def _promote_recommended_stops(
    trip_stops: list[TripStop],
    roadside_options,
    profile: Profile,
) -> list[TripStop]:
    if not roadside_options:
        return trip_stops

    normalized_start = _normalize_location(profile.start_location)
    normalized_destination = _normalize_location(profile.destination)
    existing_locations = {
        _normalize_location(stop.location)
        for stop in trip_stops
    }
    existing_locations.add(normalized_start)
    existing_locations.add(normalized_destination)

    max_promoted_stops = min(max(_get_trip_length_days(profile) - 2, 1), 3)
    promoted_stops: list[TripStop] = []

    for option in roadside_options:
        normalized_option_location = _normalize_location(option.location)
        if not normalized_option_location or normalized_option_location in existing_locations:
            continue

        promoted_stops.append(
            TripStop(
                day=1,
                order=1,
                name=option.name,
                location=option.location,
                reason=f"Recommended stop on the way: {option.reason}",
            )
        )
        existing_locations.add(normalized_option_location)

        if len(promoted_stops) >= max_promoted_stops:
            break

    if not promoted_stops:
        return trip_stops

    insert_at = len(trip_stops)
    for index, stop in enumerate(trip_stops):
        normalized_stop_location = _normalize_location(stop.location)
        if normalized_stop_location == normalized_destination:
            insert_at = index
            break

    next_trip_stops = list(trip_stops)
    next_trip_stops[insert_at:insert_at] = promoted_stops
    return _resequence_trip_stops(next_trip_stops, profile)


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
            optimized_stop_count = max(len(result.get("optimized_stop_locations", [])) - 1, 0)
            tool_usage["summaries"][-1] = (
                "Gemini used the Google Maps route and waypoint optimization tool "
                f"for {len(stop_locations)} planned stops, "
                f"{result.get('total_distance_km', 0)} km total"
                + (
                    f", with {optimized_stop_count} optimized stops."
                    if optimized_stop_count > 1
                    else "."
                )
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
        model="gemini-2.5-flash",
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

    if _should_auto_add_recommended_stops(
        trip_request.request,
        enriched_stops,
        trip_request.profile,
    ):
        promoted_trip_stops = _promote_recommended_stops(
            enriched_stops,
            roadside_options,
            trip_request.profile,
        )

        if len(promoted_trip_stops) > len(enriched_stops):
            enriched_stops = promoted_trip_stops
            warnings.append(
                "Recommended stops were automatically added to the mapped route because your request asked for stops on the way."
            )

            try:
                route, enriched_stops, promoted_route_warnings = build_route_data(
                    start_location=trip_request.profile.start_location,
                    destination=(
                        trip_request.profile.start_location
                        if trip_request.profile.is_round_trip
                        else trip_request.profile.destination
                    ),
                    trip_stops=enriched_stops,
                    vehicle_type=trip_request.profile.vehicle_type,
                )
                route_warnings.extend(promoted_route_warnings)
            except Exception as exc:
                route_warnings.append(
                    "Recommended stops were added, but the route could not be rebuilt right now: "
                    f"{exc}"
                )

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
