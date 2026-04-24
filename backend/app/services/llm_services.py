import re

from dotenv import load_dotenv
from google import genai
from google.genai import types

from app.models.trip_models import Profile, RoadsideOption, TripRequest, TripResponse, TripStop
from app.services.mapping_services import (
    build_interest_search_profiles,
    build_route_data,
    get_roadside_suggestions_for_route,
)
from app.services.model_registry import get_active_llm_config
from app.services.prompt_services import build_full_prompt
from app.services.trip_parser import parse_trip_plan


load_dotenv()

TRIP_PLAN_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "recommendations": {
            "type": "array",
            "items": {"type": "string"},
        },
        "budget_notes": {"type": "string"},
        "trip_stops": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "integer"},
                    "order": {"type": "integer"},
                    "name": {"type": "string"},
                    "location": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["day", "order", "name", "location", "reason"],
            },
        },
        "roadside_options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "location": {"type": "string"},
                    "category": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["name", "location", "category", "reason"],
            },
        },
    },
    "required": [
        "summary",
        "recommendations",
        "budget_notes",
        "trip_stops",
        "roadside_options",
    ],
}


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
NO_STOP_REQUEST_PATTERNS = (
    r"\bno stops?\b",
    r"\bdirect route\b",
    r"\bstraight through\b",
    r"\bnon[- ]?stop\b",
)
INTEREST_SPLIT_PATTERN = re.compile(r"[,;/]|\band\b|\b&\b", flags=re.IGNORECASE)
INTEREST_ALIGNMENT_RULES = (
    (
        re.compile(r"hik|trail|nature|outdoor|waterfall|mountain", flags=re.IGNORECASE),
        re.compile(
            r"hik|trail|trailhead|state park|national park|nature preserve|waterfall|mountain|outdoor|park",
            flags=re.IGNORECASE,
        ),
    ),
    (
        re.compile(r"\bfood\b|restaurant|cuisine|eat|culinary|diner", flags=re.IGNORECASE),
        re.compile(
            r"restaurant|food|diner|bbq|barbecue|cafe|bakery|eatery|brewery|culinary",
            flags=re.IGNORECASE,
        ),
    ),
    (
        re.compile(r"live music|concert|\bmusic\b|jazz|blues", flags=re.IGNORECASE),
        re.compile(r"live music|music venue|concert|jazz|blues|amphitheater", flags=re.IGNORECASE),
    ),
    (
        re.compile(r"nightlife|brewery|brew pub", flags=re.IGNORECASE),
        re.compile(r"nightlife|brewery|bar|club|cocktail|taproom", flags=re.IGNORECASE),
    ),
    (
        re.compile(r"history|historic|civil war|battlefield", flags=re.IGNORECASE),
        re.compile(r"history|historic|battlefield|museum|monument|heritage", flags=re.IGNORECASE),
    ),
    (
        re.compile(r"beach|coast|ocean|shore", flags=re.IGNORECASE),
        re.compile(r"beach|coast|ocean|shore|boardwalk", flags=re.IGNORECASE),
    ),
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


def _user_requested_no_stops(request_text: str) -> bool:
    normalized_request = request_text.lower()
    return any(re.search(pattern, normalized_request) for pattern in NO_STOP_REQUEST_PATTERNS)


def _split_interests(interests: str) -> list[str]:
    if not interests:
        return []

    return [
        piece.strip()
        for piece in INTEREST_SPLIT_PATTERN.split(interests)
        if piece.strip()
    ]


def _get_interest_stop_patterns(interests: str) -> list[re.Pattern[str]]:
    patterns: list[re.Pattern[str]] = []
    seen_patterns: set[str] = set()

    for interest_item in _split_interests(interests):
        for interest_pattern, stop_pattern in INTEREST_ALIGNMENT_RULES:
            if not interest_pattern.search(interest_item):
                continue
            if stop_pattern.pattern in seen_patterns:
                break
            seen_patterns.add(stop_pattern.pattern)
            patterns.append(stop_pattern)
            break

    return patterns


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


def _promote_options_into_trip_stops(
    trip_stops: list[TripStop],
    candidate_options: list[RoadsideOption],
    profile: Profile,
    *,
    max_promoted_stops: int,
    reason_prefix: str,
) -> list[TripStop]:
    if not candidate_options:
        return trip_stops

    normalized_start = _normalize_location(profile.start_location)
    normalized_destination = _normalize_location(profile.destination)
    existing_locations = {
        _normalize_location(stop.location)
        for stop in trip_stops
    }
    existing_locations.add(normalized_start)
    existing_locations.add(normalized_destination)

    promoted_stops: list[TripStop] = []

    for option in candidate_options:
        normalized_option_location = _normalize_location(option.location)
        if not normalized_option_location or normalized_option_location in existing_locations:
            continue

        promoted_stops.append(
            TripStop(
                day=1,
                order=1,
                name=option.name,
                location=option.location,
                reason=f"{reason_prefix}{option.reason}",
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


def _promote_recommended_stops(
    trip_stops: list[TripStop],
    roadside_options: list[RoadsideOption],
    profile: Profile,
) -> list[TripStop]:
    return _promote_options_into_trip_stops(
        trip_stops,
        roadside_options,
        profile,
        max_promoted_stops=min(max(_get_trip_length_days(profile) - 2, 1), 3),
        reason_prefix="Recommended stop on the way: ",
    )


def _has_interest_aligned_stop(trip_stops: list[TripStop], profile: Profile) -> bool:
    stop_patterns = _get_interest_stop_patterns(profile.interests)
    if not stop_patterns:
        return False

    normalized_start = _normalize_location(profile.start_location)
    normalized_destination = _normalize_location(profile.destination)

    for stop in trip_stops:
        normalized_location = _normalize_location(stop.location)
        if normalized_location in {normalized_start, normalized_destination}:
            continue

        combined_text = f"{stop.name} {stop.location} {stop.reason}"
        if any(pattern.search(combined_text) for pattern in stop_patterns):
            return True

    return False


def _select_interest_aligned_options(
    roadside_options: list[RoadsideOption],
    profile: Profile,
) -> list[RoadsideOption]:
    stop_patterns = _get_interest_stop_patterns(profile.interests)
    if not stop_patterns:
        return []

    ranked_options: list[tuple[int, float, RoadsideOption]] = []

    for option in roadside_options:
        combined_text = f"{option.name} {option.location} {option.category} {option.reason}"
        matched_index = next(
            (
                index
                for index, pattern in enumerate(stop_patterns)
                if pattern.search(combined_text)
            ),
            None,
        )
        if matched_index is None:
            continue

        ranked_options.append(
            (
                matched_index,
                -(option.rating if option.rating is not None else 0.0),
                option,
            )
        )

    ranked_options.sort(key=lambda item: (item[0], item[1]))
    return [option for _, _, option in ranked_options]


def _merge_roadside_options(
    existing_options: list[RoadsideOption],
    new_options: list[RoadsideOption],
) -> list[RoadsideOption]:
    merged_options = list(existing_options)
    seen_locations = {
        _normalize_location(option.location)
        for option in merged_options
    }

    for option in new_options:
        normalized_location = _normalize_location(option.location)
        if not normalized_location or normalized_location in seen_locations:
            continue
        merged_options.append(option)
        seen_locations.add(normalized_location)

    return merged_options[:5]


def _promote_interest_aligned_stop(
    trip_stops: list[TripStop],
    roadside_options: list[RoadsideOption],
    profile: Profile,
) -> list[TripStop]:
    if _get_trip_length_days(profile) <= 1 or _has_interest_aligned_stop(trip_stops, profile):
        return trip_stops

    candidate_options = _select_interest_aligned_options(roadside_options, profile)
    if not candidate_options:
        return trip_stops

    return _promote_options_into_trip_stops(
        trip_stops,
        candidate_options[:1],
        profile,
        max_promoted_stops=1,
        reason_prefix="Interest-matched stop: ",
    )


def _generate_google_content(client: genai.Client, model: str, full_prompt: str) -> str:
    # Gemini 2.5 has "thinking" turned on by default; for a structured-output
    # JSON task the extra reasoning tokens dominate latency. Disabling it keeps
    # the demo responsive while the backend validates route data afterward.
    config_kwargs = {
        "response_mime_type": "application/json",
        "response_schema": TRIP_PLAN_RESPONSE_SCHEMA,
        # Keep creativity low enough for schema adherence while still allowing
        # the model to choose useful stops.
        "temperature": 0.4,
        "max_output_tokens": 2048,
    }
    try:
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except AttributeError:
        # Older google-genai builds don't expose ThinkingConfig; safe to skip.
        pass

    response = client.models.generate_content(
        model=model,
        contents=full_prompt,
        config=types.GenerateContentConfig(**config_kwargs),
    )
    return response.text or ""


def _resolve_route_destination(profile: Profile) -> str:
    return profile.start_location if profile.is_round_trip else profile.destination


def generate_trip_plan(trip_request: TripRequest) -> TripResponse:
    llm_config = get_active_llm_config()
    if not llm_config.api_key:
        raise ValueError(
            f"{llm_config.api_key_env_var} is not set. Add it to backend/.env before generating a trip."
        )

    full_prompt = build_full_prompt(
        trip_request.profile,
        trip_request.request,
        trip_request.conversation_history,
    )
    tool_usage = {
        "summaries": [],
    }
    route_cache: dict = {}
    interest_profiles = build_interest_search_profiles(trip_request.profile.interests)

    warnings: list[str] = []
    raw_plan_text = ""

    try:
        client = genai.Client(api_key=llm_config.api_key)
        raw_plan_text = _generate_google_content(
            client,
            llm_config.model,
            full_prompt,
        )
    except Exception as exc:
        # Surface a readable message but keep going with the fallback plan so
        # the UI can still render profile-based stops and the user's inputs.
        warnings.append(f"{llm_config.provider_label} model call failed: {exc}")

    generated_plan, parse_warnings = parse_trip_plan(raw_plan_text, trip_request.profile)
    warnings.extend(parse_warnings)

    route = None
    enriched_stops = generated_plan.trip_stops
    route_warnings: list[str] = []
    roadside_warnings: list[str] = []
    roadside_options = generated_plan.roadside_options
    route_destination = _resolve_route_destination(trip_request.profile)

    try:
        route, enriched_stops, route_warnings = build_route_data(
            start_location=trip_request.profile.start_location,
            destination=route_destination,
            trip_stops=generated_plan.trip_stops,
            vehicle_type=trip_request.profile.vehicle_type,
            route_cache=route_cache,
        )
        if route is not None:
            tool_usage["summaries"].append(
                f"Google Maps route data was calculated for {len(enriched_stops)} planned stops."
            )
    except Exception as exc:
        route_warnings.append(f"Google Maps route data is unavailable right now: {exc}")

    needs_interest_scan = (
        route is not None
        and bool(interest_profiles)
        and not _has_interest_aligned_stop(enriched_stops, trip_request.profile)
        and not _select_interest_aligned_options(roadside_options, trip_request.profile)
    )

    if route is not None and (not roadside_options or needs_interest_scan):
        try:
            generated_roadside_options, generated_roadside_warnings = get_roadside_suggestions_for_route(
                route,
                extra_search_profiles=interest_profiles,
                recommendation_radius_miles=trip_request.profile.recommendation_radius_miles,
            )
            roadside_options = _merge_roadside_options(
                roadside_options,
                generated_roadside_options,
            )
            roadside_warnings.extend(generated_roadside_warnings)
            if generated_roadside_options:
                tool_usage["summaries"].append(
                    f"Google Places found {len(generated_roadside_options)} route-adjacent optional stops."
                )
        except Exception as exc:
            roadside_warnings.append(
                f"Roadside attraction suggestions are unavailable right now: {exc}"
            )

    if not _user_requested_no_stops(trip_request.request):
        interest_promoted_trip_stops = _promote_interest_aligned_stop(
            enriched_stops,
            roadside_options,
            trip_request.profile,
        )
        if len(interest_promoted_trip_stops) > len(enriched_stops):
            enriched_stops = interest_promoted_trip_stops
            warnings.append(
                "An interest-matched stop was automatically added to the route "
                "because the original itinerary did not reflect the profile interests."
            )

            try:
                route, enriched_stops, promoted_route_warnings = build_route_data(
                    start_location=trip_request.profile.start_location,
                    destination=route_destination,
                    trip_stops=enriched_stops,
                    vehicle_type=trip_request.profile.vehicle_type,
                    route_cache=route_cache,
                )
                route_warnings.extend(promoted_route_warnings)
            except Exception as exc:
                route_warnings.append(
                    "An interest-matched stop was added, but the route could not be rebuilt right now: "
                    f"{exc}"
                )

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

        # Only rebuild the route when the promotion actually added a new stop;
        # otherwise the existing route is already correct for the stop list.
        if len(promoted_trip_stops) > len(enriched_stops):
            enriched_stops = promoted_trip_stops
            warnings.append(
                "Recommended stops were automatically added to the mapped route "
                "because your request asked for stops on the way."
            )

            try:
                route, enriched_stops, promoted_route_warnings = build_route_data(
                    start_location=trip_request.profile.start_location,
                    destination=route_destination,
                    trip_stops=enriched_stops,
                    vehicle_type=trip_request.profile.vehicle_type,
                    route_cache=route_cache,
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
