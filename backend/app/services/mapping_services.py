import os

import httpx

from app.models.trip_models import Coordinate, RouteData, RouteLeg, RouteWaypoint, TripStop


GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json"
REQUEST_TIMEOUT = 20.0
PLACEHOLDER_LOCATIONS = {
    "",
    "your starting location here",
    "your destination here",
    "starting point",
    "final destination",
    "destination",
}


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
        enriched_stops = _attach_stop_coordinates(trip_stops, geocoded_waypoints)
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
    origin = _to_lat_lng_string(waypoints[0].latitude, waypoints[0].longitude)
    destination = _to_lat_lng_string(waypoints[-1].latitude, waypoints[-1].longitude)
    intermediate_waypoints = [
        _to_lat_lng_string(waypoint.latitude, waypoint.longitude)
        for waypoint in waypoints[1:-1]
    ]

    response = client.get(
        DIRECTIONS_URL,
        params={
            "origin": origin,
            "destination": destination,
            "waypoints": "|".join(intermediate_waypoints) if intermediate_waypoints else None,
            "mode": travel_mode,
            "key": api_key,
        },
    )
    response.raise_for_status()
    payload = response.json()
    status = payload.get("status", "Unknown routing error")

    if status == "REQUEST_DENIED":
        raise GoogleMapsConfigurationError(
            "Google Maps Directions API returned REQUEST_DENIED. "
            "Enable Directions API and allow this key for backend/server requests."
        )

    if status != "OK":
        raise ValueError(status)

    route = payload["routes"][0]
    legs_payload = route.get("legs", [])
    route_geometry = decode_polyline(route.get("overview_polyline", {}).get("points", ""))

    legs: list[RouteLeg] = []
    for index, leg in enumerate(legs_payload, start=1):
        from_waypoint = waypoints[index - 1]
        to_waypoint = waypoints[index]
        legs.append(
            RouteLeg(
                order=index,
                from_name=from_waypoint.name,
                from_location=from_waypoint.location,
                to_name=to_waypoint.name,
                to_location=to_waypoint.location,
                distance_km=round(leg.get("distance", {}).get("value", 0) / 1000, 1),
                duration_minutes=round(leg.get("duration", {}).get("value", 0) / 60, 1),
            )
        )

    total_distance_km = round(sum(leg.distance_km for leg in legs), 1)
    total_duration_minutes = round(sum(leg.duration_minutes for leg in legs), 1)

    return RouteData(
        total_distance_km=total_distance_km,
        total_duration_minutes=total_duration_minutes,
        legs=legs,
        geometry=route_geometry,
        waypoints=waypoints,
    )


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
        "leg_summaries": leg_summaries,
        "warnings": warnings,
    }


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
        if deduped and _normalize_location(deduped[-1]["location"]) == _normalize_location(route_input["location"]):
            if route_input["kind"] == "destination":
                deduped[-1]["kind"] = "destination"
                deduped[-1]["name"] = route_input["name"]
            continue
        deduped.append(route_input)

    return deduped


def _attach_stop_coordinates(trip_stops: list[TripStop], waypoints: list[RouteWaypoint]) -> list[TripStop]:
    coordinate_lookup = {
        _normalize_location(waypoint.location): waypoint for waypoint in waypoints
    }

    enriched_stops: list[TripStop] = []
    for stop in trip_stops:
        match = coordinate_lookup.get(_normalize_location(stop.location))
        enriched_stops.append(
            stop.model_copy(
                update={
                    "latitude": match.latitude if match else None,
                    "longitude": match.longitude if match else None,
                }
            )
        )

    return enriched_stops


def _resolve_travel_mode(vehicle_type: str) -> str:
    normalized_vehicle = vehicle_type.strip().lower()
    if normalized_vehicle == "bicycle":
        return "bicycling"
    if normalized_vehicle == "hitchhiker":
        return "walking"
    return "driving"


def _to_lat_lng_string(latitude: float, longitude: float) -> str:
    return f"{latitude},{longitude}"


def _normalize_location(location: str) -> str:
    return " ".join(location.lower().split())


def _is_geocodable_location(location: str) -> bool:
    return _normalize_location(location) not in PLACEHOLDER_LOCATIONS
