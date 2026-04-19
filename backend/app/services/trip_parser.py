import ast
import json
import re

from app.models.trip_models import GeneratedTripPlan, Profile, TripStop

PLACEHOLDER_LOCATIONS = {
    "your starting location here",
    "your destination here",
    "starting point",
    "final destination",
    "destination",
}


def clean_model_json(text: str) -> str:
    cleaned = text.strip()

    if cleaned.startswith("```json"):
        cleaned = cleaned.removeprefix("```json").strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```").strip()

    if cleaned.endswith("```"):
        cleaned = cleaned.removesuffix("```").strip()

    return cleaned


def parse_trip_plan(raw_text: str, profile: Profile) -> tuple[GeneratedTripPlan, list[str]]:
    warnings: list[str] = []
    cleaned = clean_model_json(raw_text or "")

    payload = _load_json_payload(cleaned)
    if payload is None:
        warnings.append("Model did not return valid JSON. A fallback itinerary was created.")
        return build_fallback_trip_plan(cleaned, profile), warnings

    try:
        plan = GeneratedTripPlan.model_validate(_normalize_payload(payload, profile))
    except Exception:
        warnings.append("Model JSON was incomplete. A fallback itinerary was created.")
        return build_fallback_trip_plan(cleaned, profile), warnings

    if not plan.trip_stops:
        warnings.append("Model returned no trip stops. A fallback itinerary was created.")
        fallback_plan = build_fallback_trip_plan(plan.summary, profile)
        fallback_plan.recommendations = plan.recommendations
        fallback_plan.budget_notes = plan.budget_notes
        return fallback_plan, warnings

    return plan, warnings


def build_fallback_trip_plan(summary_text: str, profile: Profile) -> GeneratedTripPlan:
    stops = build_fallback_stops(profile)
    recommendations = [stop.reason for stop in stops[:3]]

    return GeneratedTripPlan(
        summary=summary_text.strip() or "A direct road trip itinerary was generated from your profile.",
        recommendations=recommendations,
        budget_notes="Route details were generated from your profile because the model output was incomplete.",
        trip_stops=stops,
    )


def build_fallback_stops(profile: Profile) -> list[TripStop]:
    requested_locations = [location.strip() for location in profile.stops if location.strip()]
    destination_location = profile.destination.strip()
    start_location = profile.start_location.strip()

    if destination_location and (
        not requested_locations
        or _normalize_location(requested_locations[-1]) != _normalize_location(destination_location)
    ):
        requested_locations.append(destination_location)

    if profile.is_round_trip and start_location and (
        not requested_locations
        or _normalize_location(requested_locations[-1]) != _normalize_location(start_location)
    ):
        requested_locations.append(start_location)

    total_days = _get_trip_length_days(profile)
    fallback_stops: list[TripStop] = []

    for index, location in enumerate(requested_locations, start=1):
        is_return_to_start = profile.is_round_trip and _normalize_location(location) == _normalize_location(start_location)
        is_destination = _normalize_location(location) == _normalize_location(destination_location)
        fallback_stops.append(
            TripStop(
                day=min(index, total_days),
                order=index,
                name=location,
                location=location,
                reason=(
                    "Return to your starting location to complete the round trip."
                    if is_return_to_start
                    else (
                        "Destination chosen from your trip profile."
                        if is_destination
                        else "Requested stop from your trip profile."
                    )
                ),
            )
        )

    return fallback_stops


def _normalize_payload(payload: dict, profile: Profile) -> dict:
    payload = _normalize_top_level_keys(payload)
    trip_length_days = _get_trip_length_days(profile)
    trip_stops = [_normalize_stop(stop, index, trip_length_days) for index, stop in enumerate(payload.get("trip_stops", []), start=1)]
    trip_stops = sorted(trip_stops, key=lambda stop: (stop["order"], stop["day"]))
    trip_stops = _sanitize_trip_stops(trip_stops, profile)

    return {
        "summary": str(payload.get("summary", "")).strip(),
        "recommendations": _normalize_recommendations(payload.get("recommendations", [])),
        "budget_notes": str(payload.get("budget_notes", "")).strip(),
        "trip_stops": trip_stops,
    }


def _normalize_recommendations(raw_recommendations: object) -> list[str]:
    if not isinstance(raw_recommendations, list):
        return []

    return [
        str(item).strip()
        for item in raw_recommendations
        if str(item).strip()
    ][:3]


def _normalize_stop(raw_stop: object, fallback_order: int, trip_length_days: int) -> dict:
    if not isinstance(raw_stop, dict):
        raise ValueError("Trip stop must be an object.")

    stop = _normalize_object_keys(raw_stop)
    location = str(stop.get("location", "")).strip()
    name = str(stop.get("name", location)).strip() or location
    reason = str(
        stop.get("reason")
        or stop.get("description")
        or stop.get("short_description")
        or ""
    ).strip()

    if not location or not reason:
        raise ValueError("Trip stop is missing required fields.")

    order = _coerce_positive_int(stop.get("order"), fallback_order)
    day = _coerce_positive_int(stop.get("day"), min(order, max(trip_length_days, 1)))

    return {
        "day": day,
        "order": order,
        "name": name,
        "location": location,
        "reason": reason,
    }


def _coerce_positive_int(value: object, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _sanitize_trip_stops(trip_stops: list[dict], profile: Profile) -> list[dict]:
    sanitized: list[dict] = []
    trip_length_days = _get_trip_length_days(profile)
    normalized_start = _normalize_location(profile.start_location)
    destination_location = profile.destination.strip()
    normalized_destination = _normalize_location(destination_location)

    for stop in trip_stops:
        normalized_location = _normalize_location(stop["location"])
        if not normalized_location or normalized_location in PLACEHOLDER_LOCATIONS:
            continue

        if normalized_location == normalized_start:
            continue

        if sanitized and _normalize_location(sanitized[-1]["location"]) == normalized_location:
            continue

        sanitized.append(stop)

    if normalized_destination:
        has_destination = any(
            _normalize_location(stop["location"]) == normalized_destination
            for stop in sanitized
        )

        if not has_destination:
            sanitized.append(
                {
                    "day": min(len(sanitized) + 1, trip_length_days),
                    "order": len(sanitized) + 1,
                    "name": destination_location,
                    "location": destination_location,
                    "reason": "Destination chosen from your trip profile.",
                }
            )

    if profile.is_round_trip and normalized_start:
        sanitized.append(
            {
                "day": min(len(sanitized) + 1, trip_length_days),
                "order": len(sanitized) + 1,
                "name": profile.start_location,
                "location": profile.start_location,
                "reason": "Return to your starting location to complete the round trip.",
            }
        )

    for index, stop in enumerate(sanitized, start=1):
        stop["order"] = index
        stop["day"] = min(_coerce_positive_int(stop.get("day"), index), trip_length_days)

    return sanitized


def _normalize_location(location: str) -> str:
    return " ".join(location.lower().split())


def _get_trip_length_days(profile: Profile) -> int:
    unit = profile.trip_length_unit.strip().lower()
    value = max(profile.trip_length_value, 1)

    if unit == "hours":
        return 1 if value <= 24 else max((value + 23) // 24, 1)

    if unit == "weeks":
        return value * 7

    return value


def _load_json_payload(cleaned: str) -> dict | None:
    candidates = [cleaned]

    extracted = _extract_json_object(cleaned)
    if extracted and extracted not in candidates:
        candidates.append(extracted)

    for candidate in candidates:
        parsed = _parse_candidate(candidate)
        if isinstance(parsed, dict):
            return parsed

    return None


def _extract_json_object(text: str) -> str | None:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return text[start : end + 1]


def _parse_candidate(candidate: str) -> dict | None:
    normalized = _normalize_json_text(candidate)

    for parser in (json.loads, ast.literal_eval):
        try:
            parsed = parser(normalized)
        except Exception:
            continue

        if isinstance(parsed, dict):
            return parsed

    return None


def _normalize_json_text(text: str) -> str:
    normalized = text.strip()
    normalized = normalized.replace("“", '"').replace("”", '"')
    normalized = normalized.replace("’", "'").replace("‘", "'")
    normalized = re.sub(r",\s*([}\]])", r"\1", normalized)
    return normalized


def _normalize_top_level_keys(payload: dict) -> dict:
    normalized = _normalize_object_keys(payload)

    if "budget_notes" not in normalized and "budget" in normalized:
        normalized["budget_notes"] = normalized["budget"]

    if "trip_stops" not in normalized and "stops" in normalized:
        normalized["trip_stops"] = normalized["stops"]

    return normalized


def _normalize_object_keys(payload: dict) -> dict:
    return {
        _canonicalize_key(key): value
        for key, value in payload.items()
    }


def _canonicalize_key(key: object) -> str:
    key_text = str(key).strip().lower()
    key_text = key_text.replace("-", "_").replace(" ", "_")
    key_text = re.sub(r"_+", "_", key_text)
    return key_text
