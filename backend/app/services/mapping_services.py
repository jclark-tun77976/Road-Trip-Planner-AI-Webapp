import os

import httpx

from app.models.trip_models import Coordinate, RoadsideOption, RouteData, RouteLeg, RouteWaypoint, TripStop


GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
PLACES_NEARBY_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
REQUEST_TIMEOUT = 20.0
ROADISDE_SAMPLE_POINTS = 5
ROADSIDE_SEARCH_RADIUS_METERS = 15000
MAX_ROADSIDE_OPTIONS = 5
ROUTES_FIELD_MASK = ",".join(
    [
        "routes.distanceMeters",
        "routes.duration",
        "routes.polyline.encodedPolyline",
        "routes.legs.distanceMeters",
        "routes.legs.duration",
        "routes.legs.startLocation",
        "routes.legs.endLocation",
        "routes.optimizedIntermediateWaypointIndex",
    ]
)
PLACEHOLDER_LOCATIONS = {
    "",
    "your starting location here",
    "your destination here",
    "starting point",
    "final destination",
    "destination",
}

ROADSIDE_SEARCH_PROFILES = [
    {
        "label": "Roadside attraction",
        "type": "tourist_attraction",
        "keyword": "roadside attraction",
    },
    {
        "label": "Odd museum",
        "type": "museum",
        "keyword": "odd museum",
    },
    {
        "label": "Giant roadside art",
        "type": "tourist_attraction",
        "keyword": "giant statue",
    },
]


class GoogleMapsConfigurationError(ValueError):
    pass


def build_route_data(
    start_location: str,
    destination: str,
    trip_stops: list[TripStop],
    vehicle_type: str,
) -> tuple[RouteData | None, list[TripStop], list[str]]:
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_MAPS_API_KEY is not set in the environment.")

    warnings: list[str] = []
    route_inputs = _build_route_inputs(start_location, destination, trip_stops)

    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        geocoded_waypoints: list[RouteWaypoint] = []

        for index, route_input in enumerate(route_inputs, start=1):
            try:
                latitude, longitude = geocode_location(client, route_input["location"], api_key)
            except GoogleMapsConfigurationError as exc:
                warnings.append(str(exc))
                return None, _attach_stop_coordinates(trip_stops, geocoded_waypoints), warnings
            except Exception as exc:
                warnings.append(f"Could not geocode '{route_input['location']}': {exc}")
                continue

            geocoded_waypoints.append(
                RouteWaypoint(
                    order=index,
                    name=route_input["name"],
                    location=route_input["location"],
                    kind=route_input["kind"],
                    latitude=latitude,
                    longitude=longitude,
                )
            )

        if len(geocoded_waypoints) < 2:
            warnings.append("Not enough route points could be geocoded to build a Google Maps route.")
            return None, _attach_stop_coordinates(trip_stops, geocoded_waypoints), warnings

        route_data = fetch_route(client, geocoded_waypoints, _resolve_travel_mode(vehicle_type), api_key)
        enriched_stops = _attach_stop_coordinates(trip_stops, route_data.waypoints)
        enriched_stops = _reorder_trip_stops_to_route(enriched_stops, route_data.waypoints)
        return route_data, enriched_stops, warnings


def geocode_location(client: httpx.Client, location: str, api_key: str) -> tuple[float, float]:
    if not _is_geocodable_location(location):
        raise ValueError("Skipped empty or placeholder location")

    response = client.get(
        GEOCODE_URL,
        params={
            "address": location,
            "key": api_key,
        },
    )
    response.raise_for_status()
    payload = response.json()
    status = payload.get("status", "Unknown geocoding error")

    if status == "REQUEST_DENIED":
        raise GoogleMapsConfigurationError(
            "Google Maps Geocoding API returned REQUEST_DENIED. "
            "Enable Geocoding API and allow this key for backend/server requests."
        )

    if status != "OK":
        raise ValueError(status)

    first_result = payload["results"][0]
    geometry = first_result["geometry"]["location"]
    return float(geometry["lat"]), float(geometry["lng"])


def fetch_route(
    client: httpx.Client,
    waypoints: list[RouteWaypoint],
    travel_mode: str,
    api_key: str,
) -> RouteData:
    intermediate_waypoints = waypoints[1:-1]
    optimize_waypoints = len(intermediate_waypoints) > 1

    response = client.post(
        ROUTES_URL,
        headers={
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": ROUTES_FIELD_MASK,
        },
        json={
            "origin": _build_lat_lng_location(waypoints[0]),
            "destination": _build_lat_lng_location(waypoints[-1]),
            "intermediates": [
                _build_lat_lng_location(waypoint)
                for waypoint in intermediate_waypoints
            ],
            "travelMode": _resolve_routes_travel_mode(travel_mode),
            "optimizeWaypointOrder": optimize_waypoints,
            "polylineQuality": "OVERVIEW",
            "polylineEncoding": "ENCODED_POLYLINE",
        },
    )
    response.raise_for_status()
    payload = response.json()
    routes = payload.get("routes", [])
    if not routes:
        raise ValueError(payload.get("error", {}).get("message", "Unknown routing error"))

    if payload.get("error", {}).get("status") == "PERMISSION_DENIED":
        raise GoogleMapsConfigurationError(
            "Google Maps Routes API returned PERMISSION_DENIED. "
            "Enable Routes API and allow this key for backend/server requests."
        )

    route = routes[0]
    ordered_waypoints = _reorder_waypoints_from_routes_response(
        waypoints,
        route.get("optimizedIntermediateWaypointIndex", []),
    )
    legs_payload = route.get("legs", [])
    route_geometry = decode_polyline(route.get("polyline", {}).get("encodedPolyline", ""))

    legs: list[RouteLeg] = []
    for index, leg in enumerate(legs_payload, start=1):
        from_waypoint = ordered_waypoints[index - 1]
        to_waypoint = ordered_waypoints[index]
        legs.append(
            RouteLeg(
                order=index,
                from_name=from_waypoint.name,
                from_location=from_waypoint.location,
                to_name=to_waypoint.name,
                to_location=to_waypoint.location,
                distance_km=round(leg.get("distanceMeters", 0) / 1000, 1),
                duration_minutes=round(_parse_duration_minutes(leg.get("duration", "0s")), 1),
            )
        )

    total_distance_km = round(sum(leg.distance_km for leg in legs), 1)
    total_duration_minutes = round(sum(leg.duration_minutes for leg in legs), 1)

    return RouteData(
        total_distance_km=total_distance_km,
        total_duration_minutes=total_duration_minutes,
        legs=legs,
        geometry=route_geometry,
        waypoints=_attach_leg_coordinates_to_waypoints(ordered_waypoints, legs_payload),
    )


def _build_lat_lng_location(waypoint: RouteWaypoint) -> dict:
    return {
        "location": {
            "latLng": {
                "latitude": waypoint.latitude,
                "longitude": waypoint.longitude,
            }
        }
    }


def _resolve_routes_travel_mode(travel_mode: str) -> str:
    if travel_mode == "walking":
        return "WALK"
    if travel_mode == "bicycling":
        return "BICYCLE"
    return "DRIVE"


def _reorder_waypoints_from_routes_response(
    waypoints: list[RouteWaypoint],
    optimized_indexes: list[int],
) -> list[RouteWaypoint]:
    if len(waypoints) <= 2 or not optimized_indexes:
        return waypoints

    intermediate_waypoints = waypoints[1:-1]
    if len(intermediate_waypoints) != len(optimized_indexes):
        return waypoints

    reordered_intermediates = [
        intermediate_waypoints[index]
        for index in optimized_indexes
        if 0 <= index < len(intermediate_waypoints)
    ]
    if len(reordered_intermediates) != len(intermediate_waypoints):
        return waypoints

    ordered_waypoints = [waypoints[0], *reordered_intermediates, waypoints[-1]]
    return [
        waypoint.model_copy(update={"order": index})
        for index, waypoint in enumerate(ordered_waypoints, start=1)
    ]


def _attach_leg_coordinates_to_waypoints(
    waypoints: list[RouteWaypoint],
    legs_payload: list[dict],
) -> list[RouteWaypoint]:
    if not legs_payload:
        return waypoints

    ordered_coordinates = [
        _extract_lat_lng(legs_payload[0].get("startLocation", {}))
    ]
    ordered_coordinates.extend(
        _extract_lat_lng(leg.get("endLocation", {}))
        for leg in legs_payload
    )

    enriched_waypoints: list[RouteWaypoint] = []
    for index, waypoint in enumerate(waypoints):
        latitude, longitude = ordered_coordinates[index] if index < len(ordered_coordinates) else (waypoint.latitude, waypoint.longitude)
        if latitude == 0 and longitude == 0:
            latitude, longitude = waypoint.latitude, waypoint.longitude
        enriched_waypoints.append(
            waypoint.model_copy(
                update={
                    "latitude": latitude,
                    "longitude": longitude,
                }
            )
        )

    return enriched_waypoints


def _extract_lat_lng(location: dict) -> tuple[float, float]:
    lat_lng = location.get("latLng", {})
    return (
        float(lat_lng.get("latitude", 0)),
        float(lat_lng.get("longitude", 0)),
    )


def _parse_duration_minutes(duration_value: str) -> float:
    try:
        return float(str(duration_value).rstrip("s")) / 60
    except ValueError:
        return 0


def decode_polyline(encoded_polyline: str) -> list[Coordinate]:
    coordinates: list[Coordinate] = []
    index = 0
    latitude = 0
    longitude = 0

    while index < len(encoded_polyline):
        latitude_change, index = _decode_value(encoded_polyline, index)
        longitude_change, index = _decode_value(encoded_polyline, index)
        latitude += latitude_change
        longitude += longitude_change
        coordinates.append(
            Coordinate(
                latitude=latitude / 1e5,
                longitude=longitude / 1e5,
            )
        )

    return coordinates


def get_route_tool_context(
    start_location: str,
    destination: str,
    stop_locations: list[str],
    vehicle_type: str,
    is_round_trip: bool = False,
) -> dict:
    """Return Google Maps route facts for an ordered trip itinerary.

    Args:
        start_location: Starting point for the trip.
        destination: Final destination for the trip when not returning home.
        stop_locations: Ordered list of intermediate stop locations selected by the model.
        vehicle_type: Vehicle type chosen by the user.
        is_round_trip: Whether the trip should end back at the starting location.

    Returns:
        A JSON-serializable dictionary with route totals, leg summaries, and warnings.
    """
    cleaned_stop_locations = [
        location.strip()
        for location in stop_locations
        if _is_geocodable_location(location)
    ]
    final_destination = start_location if is_round_trip else destination
    synthetic_stops = [
        TripStop(
            day=1,
            order=index,
            name=location,
            location=location,
            reason="Tool-generated route stop.",
        )
        for index, location in enumerate(cleaned_stop_locations, start=1)
    ]

    try:
        route_data, _, warnings = build_route_data(
            start_location=start_location,
            destination=final_destination,
            trip_stops=synthetic_stops,
            vehicle_type=vehicle_type,
        )
    except Exception as exc:
        return {
            "route_available": False,
            "final_destination": final_destination,
            "warnings": [f"Route lookup failed: {exc}"],
        }

    if route_data is None:
        return {
            "route_available": False,
            "final_destination": final_destination,
            "warnings": warnings,
        }

    leg_summaries = [
        (
            f"Leg {leg.order}: {leg.from_name} to {leg.to_name}, "
            f"{leg.distance_km} km, {leg.duration_minutes} min"
        )
        for leg in route_data.legs
    ]

    return {
        "route_available": True,
        "final_destination": final_destination,
        "total_distance_km": route_data.total_distance_km,
        "total_duration_minutes": route_data.total_duration_minutes,
        "optimized_stop_locations": [
            waypoint.location
            for waypoint in route_data.waypoints[1:]
        ],
        "leg_summaries": leg_summaries,
        "warnings": warnings,
    }


def get_roadside_tool_context(
    start_location: str,
    destination: str,
    stop_locations: list[str],
    vehicle_type: str,
    is_round_trip: bool = False,
) -> dict:
    """Return optional roadside attraction suggestions along the route."""
    cleaned_stop_locations = [
        location.strip()
        for location in stop_locations
        if _is_geocodable_location(location)
    ]
    final_destination = start_location if is_round_trip else destination
    synthetic_stops = [
        TripStop(
            day=1,
            order=index,
            name=location,
            location=location,
            reason="Tool-generated route stop.",
        )
        for index, location in enumerate(cleaned_stop_locations, start=1)
    ]

    try:
        route_data, _, route_warnings = build_route_data(
            start_location=start_location,
            destination=final_destination,
            trip_stops=synthetic_stops,
            vehicle_type=vehicle_type,
        )
    except Exception as exc:
        return {
            "suggestions_available": False,
            "suggestions": [],
            "warnings": [f"Roadside lookup failed: {exc}"],
        }

    if route_data is None:
        return {
            "suggestions_available": False,
            "suggestions": [],
            "warnings": route_warnings,
        }

    try:
        suggestions, suggestion_warnings = get_roadside_suggestions_for_route(route_data)
    except Exception as exc:
        return {
            "suggestions_available": False,
            "suggestions": [],
            "warnings": route_warnings + [f"Roadside lookup failed: {exc}"],
        }

    return {
        "suggestions_available": bool(suggestions),
        "suggestions": [suggestion.model_dump() for suggestion in suggestions],
        "warnings": route_warnings + suggestion_warnings,
    }


def get_roadside_suggestions_for_route(route_data: RouteData) -> tuple[list[RoadsideOption], list[str]]:
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_MAPS_API_KEY is not set in the environment.")

    warnings: list[str] = []
    suggestion_lookup: dict[str, RoadsideOption] = {}
    sampled_points = _sample_route_points(route_data)

    if not sampled_points:
        return [], ["No route points were available for roadside suggestions."]

    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        for sampled_point in sampled_points:
            for profile in ROADSIDE_SEARCH_PROFILES:
                response = client.get(
                    PLACES_NEARBY_URL,
                    params={
                        "location": _to_lat_lng_string(sampled_point.latitude, sampled_point.longitude),
                        "radius": ROADSIDE_SEARCH_RADIUS_METERS,
                        "type": profile["type"],
                        "keyword": profile["keyword"],
                        "key": api_key,
                    },
                )
                response.raise_for_status()
                payload = response.json()
                status = payload.get("status", "Unknown Places error")

                if status == "REQUEST_DENIED":
                    raise GoogleMapsConfigurationError(
                        "Google Places API returned REQUEST_DENIED. "
                        "Enable Places API and allow this key for backend/server requests."
                    )

                if status not in {"OK", "ZERO_RESULTS"}:
                    warnings.append(f"Roadside search returned {status}.")
                    continue

                for place in payload.get("results", []):
                    place_id = place.get("place_id")
                    if not place_id or place_id in suggestion_lookup:
                        continue

                    name = str(place.get("name", "")).strip()
                    location = str(place.get("vicinity") or "").strip()
                    if not name or not location:
                        continue

                    rating = place.get("rating")
                    suggestion_lookup[place_id] = RoadsideOption(
                        name=name,
                        location=location,
                        category=_categorize_roadside_place(place, profile["label"]),
                        reason=_build_roadside_reason(profile["label"], rating),
                        rating=float(rating) if isinstance(rating, (int, float)) else None,
                    )

    suggestions = sorted(
        suggestion_lookup.values(),
        key=lambda suggestion: suggestion.rating if suggestion.rating is not None else 0,
        reverse=True,
    )[:MAX_ROADSIDE_OPTIONS]

    return suggestions, warnings


def _decode_value(encoded_polyline: str, index: int) -> tuple[int, int]:
    result = 0
    shift = 0

    while True:
        byte = ord(encoded_polyline[index]) - 63
        index += 1
        result |= (byte & 0x1F) << shift
        shift += 5
        if byte < 0x20:
            break

    decoded = ~(result >> 1) if result & 1 else result >> 1
    return decoded, index


def _build_route_inputs(start_location: str, destination: str, trip_stops: list[TripStop]) -> list[dict[str, str]]:
    route_inputs: list[dict[str, str]] = []

    if _is_geocodable_location(start_location):
        route_inputs.append(
            {
                "name": "Start",
                "location": start_location,
                "kind": "start",
            }
        )

    for stop in sorted(trip_stops, key=lambda item: item.order):
        if not _is_geocodable_location(stop.location):
            continue
        route_inputs.append(
            {
                "name": stop.name,
                "location": stop.location,
                "kind": "stop",
            }
        )

    if _is_geocodable_location(destination) and (
        not route_inputs or _normalize_location(route_inputs[-1]["location"]) != _normalize_location(destination)
    ):
        route_inputs.append(
            {
                "name": "Destination",
                "location": destination,
                "kind": "destination",
            }
        )

    return _dedupe_consecutive_locations(route_inputs)


def _dedupe_consecutive_locations(route_inputs: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: list[dict[str, str]] = []

    for route_input in route_inputs:
        if deduped and _normalize_comparable_location(deduped[-1]["location"]) == _normalize_comparable_location(route_input["location"]):
            if route_input["kind"] == "destination":
                deduped[-1]["kind"] = "destination"
                deduped[-1]["name"] = route_input["name"]
            continue
        deduped.append(route_input)

    return deduped


def _attach_stop_coordinates(trip_stops: list[TripStop], waypoints: list[RouteWaypoint]) -> list[TripStop]:
    coordinate_lookup = {
        _normalize_comparable_location(waypoint.location): waypoint for waypoint in waypoints
    }

    enriched_stops: list[TripStop] = []
    for stop in trip_stops:
        match = coordinate_lookup.get(_normalize_comparable_location(stop.location))
        enriched_stops.append(
            stop.model_copy(
                update={
                    "latitude": match.latitude if match else None,
                    "longitude": match.longitude if match else None,
                }
            )
        )

    return enriched_stops


def _reorder_trip_stops_to_route(trip_stops: list[TripStop], waypoints: list[RouteWaypoint]) -> list[TripStop]:
    if not trip_stops or not waypoints:
        return trip_stops

    max_day = max(stop.day for stop in trip_stops)
    stop_lookup: dict[str, list[TripStop]] = {}
    for stop in sorted(trip_stops, key=lambda item: item.order):
        stop_lookup.setdefault(_normalize_comparable_location(stop.location), []).append(stop)

    reordered_stops: list[TripStop] = []
    for waypoint in waypoints[1:]:
        normalized_location = _normalize_comparable_location(waypoint.location)
        matched_stops = stop_lookup.get(normalized_location, [])
        if not matched_stops:
            continue

        stop = matched_stops.pop(0)
        reordered_stops.append(
            stop.model_copy(
                update={
                    "order": len(reordered_stops) + 1,
                    "day": min(len(reordered_stops) + 1, max_day),
                    "latitude": waypoint.latitude,
                    "longitude": waypoint.longitude,
                }
            )
        )

    for remaining_stops in stop_lookup.values():
        for stop in remaining_stops:
            reordered_stops.append(
                stop.model_copy(
                    update={
                        "order": len(reordered_stops) + 1,
                        "day": min(len(reordered_stops) + 1, max_day),
                    }
                )
            )

    return reordered_stops


def _resolve_travel_mode(vehicle_type: str) -> str:
    normalized_vehicle = vehicle_type.strip().lower()
    if normalized_vehicle == "bicycle":
        return "bicycling"
    if normalized_vehicle == "hitchhiker":
        return "walking"
    return "driving"


def _to_lat_lng_string(latitude: float, longitude: float) -> str:
    return f"{latitude},{longitude}"


def _sample_route_points(route_data: RouteData) -> list[Coordinate]:
    source_points = route_data.geometry or [
        Coordinate(latitude=waypoint.latitude, longitude=waypoint.longitude)
        for waypoint in route_data.waypoints
    ]

    if len(source_points) <= ROADISDE_SAMPLE_POINTS:
        return source_points

    step = (len(source_points) - 1) / (ROADISDE_SAMPLE_POINTS - 1)
    sampled_points = [
        source_points[round(index * step)]
        for index in range(ROADISDE_SAMPLE_POINTS)
    ]

    deduped_points: list[Coordinate] = []
    seen: set[str] = set()

    for point in sampled_points:
        point_key = f"{point.latitude:.4f},{point.longitude:.4f}"
        if point_key in seen:
            continue
        seen.add(point_key)
        deduped_points.append(point)

    return deduped_points


def _categorize_roadside_place(place: dict, fallback_label: str) -> str:
    place_types = place.get("types", [])

    if "museum" in place_types:
        return "Museum"

    if "tourist_attraction" in place_types:
        return "Roadside attraction"

    return fallback_label


def _build_roadside_reason(profile_label: str, rating: object) -> str:
    if isinstance(rating, (int, float)):
        return f"{profile_label} near the route with a Google rating of {float(rating):.1f}."

    return f"{profile_label} near the route worth considering as an optional stop."


def _normalize_location(location: str) -> str:
    return " ".join(location.lower().split())


def _normalize_comparable_location(location: str) -> str:
    normalized = _normalize_location(location)
    normalized = normalized.replace("united states", "").replace("usa", "")
    normalized = "".join(character if character.isalnum() or character.isspace() else " " for character in normalized)
    normalized = " ".join(part for part in normalized.split() if not part.isdigit() or len(part) != 5)
    return " ".join(normalized.split())


def _is_geocodable_location(location: str) -> bool:
    return _normalize_location(location) not in PLACEHOLDER_LOCATIONS
