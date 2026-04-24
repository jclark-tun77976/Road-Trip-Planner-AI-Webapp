import ast
import json
import re

from app.models.trip_models import GeneratedTripPlan, Profile, RoadsideOption, TripStop

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
        payload = _extract_section_payload(cleaned)
        if payload is not None:
            warnings.append("Model returned prose instead of strict JSON. Structured trip data was recovered.")

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
    recommendations = _build_fallback_recommendations(stops, profile)

    return GeneratedTripPlan(
        summary=_build_fallback_summary(summary_text, profile),
        recommendations=recommendations,
        budget_notes=_build_fallback_budget_notes(profile),
        trip_stops=stops,
        roadside_options=[],
    )


def _build_fallback_summary(summary_text: str, profile: Profile) -> str:
    cleaned_summary = summary_text.strip()
    if cleaned_summary and not _looks_like_model_failure(cleaned_summary):
        return cleaned_summary

    destination = profile.destination.strip() or "your destination"
    start = profile.start_location.strip() or "your starting point"
    round_trip_text = " round trip" if profile.is_round_trip else ""
    return f"A practical{round_trip_text} road trip from {start} to {destination} was created from your profile."


def _looks_like_model_failure(summary_text: str) -> bool:
    normalized = summary_text.lower()
    failure_markers = (
        "i'm sorry",
        "i am sorry",
        "encountered an issue",
        "could not be geocoded",
        "couldn't be geocoded",
        "unable to geocode",
        "verify the address",
    )
    return any(marker in normalized for marker in failure_markers)


def _build_fallback_recommendations(stops: list[TripStop], profile: Profile) -> list[str]:
    recommendations: list[str] = []

    if profile.interests.strip():
        recommendations.append(
            f"Use your interests ({profile.interests.strip()}) to choose optional stops along the mapped route."
        )

    if profile.max_daily_driving_miles:
        recommendations.append(
            f"Keep each driving day under {profile.max_daily_driving_miles} miles."
        )

    recommendations.extend(stop.reason for stop in stops[:3])
    return recommendations[:3]


def _build_fallback_budget_notes(profile: Profile) -> str:
    travel_style = profile.travel_style.strip().lower()
    lodging_note = (
        "Include lodging costs for overnight stops."
        if travel_style in {"hotel", "rv sleeping", "camping"}
        else "Estimate fuel, food, parking, and any attraction fees before leaving."
    )
    return f"Route details were generated from your profile because the model output was incomplete. {lodging_note}"


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
        "roadside_options": _normalize_roadside_options(payload.get("roadside_options", [])),
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


def _normalize_roadside_options(raw_options: object) -> list[RoadsideOption]:
    if not isinstance(raw_options, list):
        return []

    normalized_options: list[RoadsideOption] = []

    for option in raw_options[:5]:
        if not isinstance(option, dict):
            continue

        normalized_option = _normalize_object_keys(option)
        name = str(normalized_option.get("name", "")).strip()
        location = str(normalized_option.get("location", "")).strip()
        category = str(normalized_option.get("category", "")).strip() or "Roadside stop"
        reason = str(normalized_option.get("reason", "")).strip()
        rating = normalized_option.get("rating")

        if not name or not location or not reason:
            continue

        normalized_options.append(
            RoadsideOption(
                name=name,
                location=location,
                category=category,
                reason=reason,
                rating=float(rating) if isinstance(rating, (int, float)) else None,
            )
        )

    return normalized_options


def _coerce_positive_int(value: object, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _sanitize_trip_stops(trip_stops: list[dict], profile: Profile) -> list[dict]:
    sanitized: list[dict] = []
    trip_length_days = _get_trip_length_days(profile)
    normalized_start = _normalize_comparable_location(profile.start_location)
    destination_location = profile.destination.strip()
    normalized_destination = _normalize_comparable_location(destination_location)

    for stop in trip_stops:
        normalized_location = _normalize_comparable_location(stop["location"])
        if not normalized_location or normalized_location in PLACEHOLDER_LOCATIONS:
            continue

        if normalized_location == normalized_start:
            continue

        if sanitized and _normalize_comparable_location(sanitized[-1]["location"]) == normalized_location:
            continue

        sanitized.append(stop)

    if normalized_destination:
        has_destination = any(
            _normalize_comparable_location(stop["location"]) == normalized_destination
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


def _normalize_comparable_location(location: str) -> str:
    normalized = _normalize_location(location)
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


def _extract_section_payload(text: str) -> dict | None:
    if not text.strip():
        return None

    normalized_text = text.replace("**", "").strip()
    section_labels = [
        "Recommendations:",
        "Budget Notes:",
        "Trip Stops:",
        "Roadside Options:",
    ]
    label_positions = {
        label: normalized_text.find(label)
        for label in section_labels
    }
    if all(position == -1 for position in label_positions.values()):
        return None

    recommendations_text = _extract_labeled_section(
        normalized_text,
        "Recommendations:",
        "Budget Notes:",
    )
    budget_notes = _extract_labeled_section(
        normalized_text,
        "Budget Notes:",
        "Trip Stops:",
    )
    trip_stops_text = _extract_labeled_section(
        normalized_text,
        "Trip Stops:",
        "Roadside Options:",
    )
    roadside_options_text = _extract_labeled_section(
        normalized_text,
        "Roadside Options:",
        None,
    )

    summary_end_candidates = [
        position
        for label, position in label_positions.items()
        if label != "Recommendations:" and position != -1
    ]
    summary_end = label_positions["Recommendations:"]
    if summary_end == -1:
        summary_end = min(summary_end_candidates) if summary_end_candidates else len(normalized_text)
    summary = normalized_text[:summary_end].strip(" :-\n")

    trip_stop_items = _extract_object_list(trip_stops_text)
    roadside_option_items = _extract_object_list(roadside_options_text)

    if not any([summary, recommendations_text, budget_notes, trip_stop_items, roadside_option_items]):
        return None

    return {
        "summary": summary,
        "recommendations": _extract_bullet_list(recommendations_text),
        "budget_notes": budget_notes.strip(),
        "trip_stops": trip_stop_items,
        "roadside_options": roadside_option_items,
    }


def _extract_labeled_section(text: str, start_label: str, end_label: str | None) -> str:
    start = text.find(start_label)
    if start == -1:
        return ""

    start += len(start_label)
    if end_label is None:
        return text[start:].strip()

    end = text.find(end_label, start)
    if end == -1:
        return text[start:].strip()

    return text[start:end].strip()


def _extract_bullet_list(text: str) -> list[str]:
    items: list[str] = []

    for line in text.splitlines():
        cleaned_line = line.strip()
        if cleaned_line.startswith("*"):
            cleaned_line = cleaned_line[1:].strip()
        if cleaned_line.startswith("-"):
            cleaned_line = cleaned_line[1:].strip()
        if cleaned_line:
            items.append(cleaned_line)

    return items[:3]


def _extract_object_list(text: str) -> list[dict]:
    object_strings = re.findall(r"\{[^{}]*\}", text, flags=re.DOTALL)
    parsed_objects: list[dict] = []

    for object_text in object_strings:
        parsed = _parse_candidate(object_text)
        if isinstance(parsed, dict):
            parsed_objects.append(parsed)

    return parsed_objects


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

    if "roadside_options" not in normalized and "roadside_suggestions" in normalized:
        normalized["roadside_options"] = normalized["roadside_suggestions"]

    if "roadside_options" not in normalized and "attraction_options" in normalized:
        normalized["roadside_options"] = normalized["attraction_options"]

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
