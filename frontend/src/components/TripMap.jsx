import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../utils/googleMaps";

const UNITED_STATES_CENTER = { lat: 39.8283, lng: -98.5795 };
const UNITED_STATES_ZOOM = 4;
const MAX_ROUTE_SAMPLE_POINTS = 4;
const DEFAULT_PLACE_SEARCH_RADIUS_METERS = 12000;
// Google Places Nearby Search hard-caps radius at 50km. Bigger values get
// silently clamped or return zero results, which is why a 75 mi profile
// radius used to produce an empty hiking layer.
const MAX_PLACE_SEARCH_RADIUS_METERS = 50000;
const PLACE_RESULTS_LIMIT = 12;
const DEFAULT_PLACE_MARKER_COLOR = "#38bdf8";

const PLACE_LAYER_DEFINITIONS = {
  gas_station: {
    label: "Gas stations",
    markerColor: "#f59e0b",
    searches: [{ type: "gas_station" }],
  },
  ev_charging: {
    label: "EV charging",
    markerColor: "#22c55e",
    searches: [{ type: "electric_vehicle_charging_station" }],
  },
  restaurants: {
    label: "Restaurants",
    markerColor: "#ef4444",
    searches: [{ type: "restaurant" }],
  },
  nightlife: {
    label: "Nightlife",
    markerColor: "#a855f7",
    searches: [{ type: "bar" }, { type: "night_club" }],
  },
  hiking: {
    label: "Hiking trails",
    markerColor: "#10b981",
    searches: [
      { keyword: "hiking trail", type: "park" },
      { keyword: "state park", type: "park" },
      { keyword: "nature preserve" },
      { keyword: "trailhead" },
    ],
  },
};

function normalizeComparableLocation(value) {
  return value
    .toLowerCase()
    .replace(/\busa\b/g, "")
    .replace(/\bunited states\b/g, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMiles(distanceKm) {
  const miles = Number(distanceKm ?? 0) * 0.621371;
  return `${miles.toFixed(1)} mi`;
}

function formatDuration(durationMinutes) {
  const totalMinutes = Math.max(Math.round(Number(durationMinutes ?? 0)), 0);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} min`;
  }

  if (minutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${minutes} min`;
}

function locationsRoughlyMatch(left, right) {
  const normalizedLeft = normalizeComparableLocation(left ?? "");
  const normalizedRight = normalizeComparableLocation(right ?? "");
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function dedupeIds(ids) {
  return [...new Set(ids)];
}

function getSuggestedLayerIds(profile) {
  const combinedText = `${profile?.travel_style ?? ""} ${profile?.interests ?? ""}`.toLowerCase();
  const nextIds = [profile?.is_ev ? "ev_charging" : "gas_station"];

  if (/(food|restaurant|dining|eat|culinary|cuisine)/.test(combinedText)) {
    nextIds.push("restaurants");
  }

  if (/(nightlife|night life|bar|club|music|late night|party)/.test(combinedText)) {
    nextIds.push("nightlife");
  }

  if (/(hik|trail|nature|outdoor|outdoors|waterfall|mountain|park)/.test(combinedText)) {
    nextIds.push("hiking");
  }

  return dedupeIds(nextIds);
}

function getMarkerLabel(waypoint, index, waypointCount) {
  if (waypoint.kind === "start") {
    return "S";
  }

  if (waypoint.kind === "destination" || index === waypointCount - 1) {
    return "D";
  }

  return String(index);
}

function createPlaceMarkerIcon(maps, color) {
  return {
    path: maps.SymbolPath.CIRCLE,
    fillColor: color || DEFAULT_PLACE_MARKER_COLOR,
    fillOpacity: 0.95,
    strokeColor: "#0f172a",
    strokeWeight: 1.5,
    scale: 7,
  };
}

function sampleRoutePoints(route) {
  const sourcePoints =
    route?.geometry?.length > 0
      ? route.geometry.map((point) => ({
          lat: point.latitude,
          lng: point.longitude,
        }))
      : (route?.waypoints ?? []).map((waypoint) => ({
          lat: waypoint.latitude,
          lng: waypoint.longitude,
        }));

  if (sourcePoints.length <= MAX_ROUTE_SAMPLE_POINTS) {
    return sourcePoints;
  }

  const sampledPoints = [];
  const step = (sourcePoints.length - 1) / (MAX_ROUTE_SAMPLE_POINTS - 1);

  for (let index = 0; index < MAX_ROUTE_SAMPLE_POINTS; index += 1) {
    sampledPoints.push(sourcePoints[Math.round(index * step)]);
  }

  return sampledPoints.filter(
    (point, index, points) =>
      index ===
      points.findIndex(
        (candidate) =>
          candidate.lat.toFixed(4) === point.lat.toFixed(4) &&
          candidate.lng.toFixed(4) === point.lng.toFixed(4),
      ),
  );
}

function performNearbySearch(service, maps, request) {
  return new Promise((resolve, reject) => {
    service.nearbySearch(request, (results, status) => {
      if (status === maps.places.PlacesServiceStatus.OK) {
        resolve(results ?? []);
        return;
      }

      if (status === maps.places.PlacesServiceStatus.ZERO_RESULTS) {
        resolve([]);
        return;
      }

      reject(new Error(`Nearby search failed with status ${status}.`));
    });
  });
}

function requestDirections(service, request) {
  return new Promise((resolve, reject) => {
    service.route(request, (result, status) => {
      if (status === "OK" && result) {
        resolve(result);
        return;
      }

      reject(new Error(`Route recalculation failed with status ${status}.`));
    });
  });
}

function getTripLengthDays(profile) {
  const rawValue = Number(profile?.trip_length_value);
  const tripLengthValue = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 1;

  if (profile?.trip_length_unit === "weeks") {
    return tripLengthValue * 7;
  }

  if (profile?.trip_length_unit === "hours") {
    return 1;
  }

  return tripLengthValue;
}

function createSyntheticStop(location, reason, kind) {
  return {
    name: location,
    location,
    reason,
    kind,
    isSynthetic: true,
    isLocked: true,
  };
}

// Split the AI's trip stops into flexible intermediate stops (reorderable)
// and fixed anchors (start, destination, round-trip return).
function buildEditableStopGroups(profile, tripStops) {
  const startLocation = profile?.start_location ?? "";
  const destinationLocation = profile?.destination ?? "";
  const isRoundTrip = Boolean(profile?.is_round_trip);

  // Drop any stop that duplicates the start or destination anchor — those are
  // rendered as fixed cards regardless of what the model produced. This keeps
  // the destination card out of the editable list even if the LLM placed it
  // somewhere other than the end of the array.
  const intermediateStops = (tripStops ?? [])
    .filter((stop) => stop?.location?.trim())
    .filter((stop) => !locationsRoughlyMatch(stop.location, startLocation))
    .filter((stop) => !destinationLocation || !locationsRoughlyMatch(stop.location, destinationLocation))
    .map((stop) => ({
      ...stop,
      kind: "stop",
      isLocked: false,
      isSynthetic: false,
    }));

  // Try to preserve the model's destination card (with its reason/coords) if
  // it was actually returned; otherwise fall back to a synthetic one built
  // from the profile.
  const modelDestination = (tripStops ?? []).find(
    (stop) => destinationLocation && locationsRoughlyMatch(stop.location ?? "", destinationLocation),
  );

  const fixedStops = [];

  if (destinationLocation) {
    fixedStops.push(
      modelDestination
        ? {
            ...modelDestination,
            kind: "destination",
            isLocked: true,
            isSynthetic: false,
          }
        : createSyntheticStop(
            destinationLocation,
            "Destination chosen from your trip profile.",
            "destination",
          ),
    );
  }

  if (isRoundTrip && startLocation) {
    fixedStops.push(
      createSyntheticStop(
        startLocation,
        "Return to your starting location to complete the round trip.",
        "return",
      ),
    );
  }

  return {
    editableStops: intermediateStops,
    fixedStops,
  };
}

function buildOrderedTripStops(editableStops, fixedStops, profile) {
  const totalDays = getTripLengthDays(profile);

  return [...editableStops, ...fixedStops].map((stop, index) => ({
    day: Math.min(index + 1, totalDays),
    order: index + 1,
    name: stop.name,
    location: stop.location,
    reason: stop.reason,
    latitude: stop.latitude ?? null,
    longitude: stop.longitude ?? null,
    kind: stop.kind,
    isLocked: stop.isLocked,
    isSynthetic: stop.isSynthetic,
  }));
}

function stripEditableFields(tripStops) {
  return tripStops.map((stop) => ({
    day: stop.day,
    order: stop.order,
    name: stop.name,
    location: stop.location,
    reason: stop.reason,
    latitude: stop.latitude,
    longitude: stop.longitude,
  }));
}

function buildRouteDataFromDirections(directions, orderedTripStops) {
  const primaryRoute = directions.routes?.[0];
  const legs = primaryRoute?.legs ?? [];
  const orderedPoints = [
    {
      name: "Start",
      location: legs[0]?.start_address ?? "",
      kind: "start",
    },
    ...orderedTripStops.map((stop) => ({
      name: stop.name,
      location: stop.location,
      kind: stop.kind === "return" ? "destination" : stop.kind,
    })),
  ];
  const path = primaryRoute?.overview_path ?? [];

  const nextLegs = legs.map((leg, index) => {
    const fromPoint = orderedPoints[index];
    const toPoint = orderedPoints[index + 1];

    return {
      order: index + 1,
      from_name: fromPoint?.name ?? leg.start_address,
      from_location: fromPoint?.location ?? leg.start_address,
      to_name: toPoint?.name ?? leg.end_address,
      to_location: toPoint?.location ?? leg.end_address,
      distance_km: Number(((leg.distance?.value ?? 0) / 1000).toFixed(1)),
      duration_minutes: Number(((leg.duration?.value ?? 0) / 60).toFixed(1)),
    };
  });

  const waypointCoordinates = [];
  if (legs.length > 0) {
    waypointCoordinates.push(legs[0].start_location);
    legs.forEach((leg) => waypointCoordinates.push(leg.end_location));
  }

  const nextWaypoints = orderedPoints.map((point, index) => {
    const coordinate = waypointCoordinates[index];
    return {
      order: index + 1,
      name: point.name,
      location: point.location,
      kind: point.kind,
      latitude: coordinate?.lat?.() ?? 0,
      longitude: coordinate?.lng?.() ?? 0,
    };
  });

  const geometry = path.map((coordinate) => ({
    latitude: coordinate.lat(),
    longitude: coordinate.lng(),
  }));

  const totalDistanceKm = Number(
    nextLegs.reduce((sum, leg) => sum + leg.distance_km, 0).toFixed(1),
  );
  const totalDurationMinutes = Number(
    nextLegs.reduce((sum, leg) => sum + leg.duration_minutes, 0).toFixed(1),
  );

  const nextStops = orderedTripStops.map((stop, index) => {
    const coordinate = waypointCoordinates[index + 1];
    return {
      ...stop,
      latitude: coordinate?.lat?.() ?? stop.latitude ?? null,
      longitude: coordinate?.lng?.() ?? stop.longitude ?? null,
    };
  });

  return {
    route: {
      total_distance_km: totalDistanceKm,
      total_duration_minutes: totalDurationMinutes,
      legs: nextLegs,
      geometry,
      waypoints: nextWaypoints,
    },
    tripStops: stripEditableFields(nextStops),
  };
}

function buildDirectionsRequest(profile, orderedTripStops, maps) {
  if (!profile?.start_location?.trim()) {
    return null;
  }

  if (!orderedTripStops.length) {
    return null;
  }

  const destinationLocation = profile.is_round_trip
    ? profile.start_location
    : orderedTripStops[orderedTripStops.length - 1].location;
  const intermediateStops = profile.is_round_trip
    ? orderedTripStops.slice(0, -1)
    : orderedTripStops.slice(0, -1);

  return {
    origin: profile.start_location,
    destination: destinationLocation,
    waypoints: intermediateStops.map((stop) => ({
      location: stop.location,
      stopover: true,
    })),
    travelMode:
      profile.vehicle_type === "Bicycle"
        ? maps.TravelMode.BICYCLING
        : profile.vehicle_type === "Hitchhiker"
          ? maps.TravelMode.WALKING
          : maps.TravelMode.DRIVING,
    optimizeWaypoints: false,
    provideRouteAlternatives: false,
  };
}

function getSidebarLabel(stop, index, totalStops) {
  if (index === 0) {
    return "Start";
  }

  if (stop.kind === "return") {
    return "Return";
  }

  if (stop.kind === "destination" || index === totalStops - 1) {
    return "Destination";
  }

  return `Stop ${index}`;
}

function getSidebarRoleText(stop) {
  if (stop.kind === "start") {
    return "Fixed origin";
  }
  if (stop.kind === "return") {
    return "Fixed return";
  }
  if (stop.kind === "destination") {
    return "Required destination";
  }
  return "Flexible stop";
}

function buildWaypointInfoContent(waypoint, index, route, tripStops, profile) {
  const normalizedWaypointLocation = normalizeComparableLocation(waypoint.location ?? "");
  const matchedStop = (tripStops ?? []).find(
    (stop) => normalizeComparableLocation(stop.location ?? "") === normalizedWaypointLocation,
  );
  const previousLeg = index > 0 ? route?.legs?.[index - 1] : null;
  const nextLeg = route?.legs?.[index] ?? null;

  let helperLabel = "Trip stop";
  let helperValue = waypoint.location;

  if (waypoint.kind === "start") {
    helperLabel = "Starting point";
    helperValue = profile?.start_location || waypoint.location;
  } else if (waypoint.kind === "destination") {
    helperLabel = waypoint.location === profile?.start_location ? "Return stop" : "Destination";
  }

  return `
    <div style="max-width:240px; color:#0f172a; font-family:Manrope, Arial, sans-serif;">
      <div style="font-size:13px; font-weight:800; margin-bottom:4px;">${escapeHtml(waypoint.name)}</div>
      <div style="font-size:12px; color:#334155; margin-bottom:8px;">${escapeHtml(helperValue)}</div>
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#2563eb; font-weight:800; margin-bottom:4px;">
        ${escapeHtml(helperLabel)}
      </div>
      ${
        matchedStop?.day
          ? `<div style="font-size:12px; margin-bottom:4px;"><strong>Day:</strong> ${escapeHtml(matchedStop.day)}</div>`
          : ""
      }
      ${
        previousLeg
          ? `<div style="font-size:12px; margin-bottom:4px;"><strong>Arrive via:</strong> ${escapeHtml(formatMiles(previousLeg.distance_km))} · ${escapeHtml(formatDuration(previousLeg.duration_minutes))}</div>`
          : route
            ? `<div style="font-size:12px; margin-bottom:4px;"><strong>Total route:</strong> ${escapeHtml(formatMiles(route.total_distance_km))} · ${escapeHtml(formatDuration(route.total_duration_minutes))}</div>`
            : ""
      }
      ${
        nextLeg
          ? `<div style="font-size:12px; margin-bottom:6px;"><strong>Next leg:</strong> ${escapeHtml(formatMiles(nextLeg.distance_km))} · ${escapeHtml(formatDuration(nextLeg.duration_minutes))}</div>`
          : ""
      }
      ${
        matchedStop?.reason
          ? `<div style="font-size:12px; color:#475569; line-height:1.45;">${escapeHtml(matchedStop.reason)}</div>`
          : ""
      }
    </div>
  `;
}

function TripMap({
  route,
  tripStops,
  startLocation,
  onUseCurrentLocation,
  onRouteChange,
  loading,
  profile,
}) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const mapsRef = useRef(null);
  const geocoderRef = useRef(null);
  const placesServiceRef = useRef(null);
  const directionsServiceRef = useRef(null);
  const directionsRendererRef = useRef(null);
  const directionsListenerRef = useRef(null);
  const editableStopsRef = useRef([]);
  const fixedStopsRef = useRef([]);
  const profileRef = useRef(profile);
  const initialRouteRef = useRef(route);
  const initialTripStopsRef = useRef(tripStops);
  const suppressDirectionsChangeRef = useRef(false);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const currentLocationMarkerRef = useRef(null);
  const placeMarkersRef = useRef([]);
  const [mapError, setMapError] = useState("");
  const [routeEditError, setRouteEditError] = useState("");
  const [routeEditLoading, setRouteEditLoading] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [currentLocation, setCurrentLocation] = useState(null);
  const [placesError, setPlacesError] = useState("");
  const [placesLoading, setPlacesLoading] = useState(false);
  const [activeRoute, setActiveRoute] = useState(route);
  const initialStopGroups = buildEditableStopGroups(profile, tripStops);
  const [editableStops, setEditableStops] = useState(initialStopGroups.editableStops);
  const [fixedStops, setFixedStops] = useState(initialStopGroups.fixedStops);
  const availablePlaceLayerKey = getSuggestedLayerIds(profile).join("|");
  const availablePlaceLayers = (availablePlaceLayerKey
    ? availablePlaceLayerKey.split("|")
    : []
  ).map((id) => ({
    id,
    ...PLACE_LAYER_DEFINITIONS[id],
  }));
  const [placeLayerPreferences, setPlaceLayerPreferences] = useState({});

  function clearRouteOverlays() {
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }
  }

  function clearCurrentLocationMarker() {
    if (currentLocationMarkerRef.current) {
      currentLocationMarkerRef.current.setMap(null);
      currentLocationMarkerRef.current = null;
    }
  }

  function clearPlaceMarkers() {
    placeMarkersRef.current.forEach((marker) => marker.setMap(null));
    placeMarkersRef.current = [];
  }

  function handlePlaceLayerToggle(layerId) {
    setPlaceLayerPreferences((previous) => ({
      ...previous,
      [layerId]: !(previous[layerId] ?? true),
    }));
  }

  function moveStop(index, direction) {
    setEditableStops((previous) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= previous.length) {
        return previous;
      }

      const nextStops = [...previous];
      [nextStops[index], nextStops[nextIndex]] = [nextStops[nextIndex], nextStops[index]];
      return nextStops;
    });
  }

  function resetRouteEdits() {
    const { editableStops: nextEditableStops, fixedStops: nextFixedStops } =
      buildEditableStopGroups(profile, initialTripStopsRef.current);
    setEditableStops(nextEditableStops);
    setFixedStops(nextFixedStops);
    setActiveRoute(initialRouteRef.current);
    setRouteEditError("");
  }

  async function reverseGeocodeCurrentLocation(coords) {
    const maps = mapsRef.current ?? (await loadGoogleMaps());
    const geocoder = geocoderRef.current ?? new maps.Geocoder();
    geocoderRef.current = geocoder;

    return new Promise((resolve, reject) => {
      geocoder.geocode({ location: coords }, (results, status) => {
        if (status === "OK" && results?.[0]?.formatted_address) {
          resolve(results[0].formatted_address);
          return;
        }

        reject(new Error("Could not determine a readable address for your location."));
      });
    });
  }

  async function handleUseCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationError("This browser does not support location access.");
      return;
    }

    setLocationLoading(true);
    setLocationError("");

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const nextLocation = {
          lat: coords.latitude,
          lng: coords.longitude,
        };

        setCurrentLocation(nextLocation);

        try {
          const formattedAddress = await reverseGeocodeCurrentLocation(nextLocation);
          onUseCurrentLocation?.(formattedAddress);
        } catch {
          onUseCurrentLocation?.(
            `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`,
          );
        } finally {
          setLocationLoading(false);
        }
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? "Location access was denied."
            : "Unable to get your current location.";
        setLocationError(message);
        setLocationLoading(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    );
  }

  useEffect(() => {
    editableStopsRef.current = editableStops;
    fixedStopsRef.current = fixedStops;
    profileRef.current = profile;
  }, [editableStops, fixedStops, profile]);

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !mapElementRef.current) {
          return;
        }

        mapsRef.current = maps;

        if (!mapRef.current) {
          mapRef.current = new maps.Map(mapElementRef.current, {
            center: UNITED_STATES_CENTER,
            zoom: UNITED_STATES_ZOOM,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
          });
        }

        if (!geocoderRef.current) {
          geocoderRef.current = new maps.Geocoder();
        }

        if (!placesServiceRef.current) {
          placesServiceRef.current = new maps.places.PlacesService(mapRef.current);
        }

        if (!directionsServiceRef.current) {
          directionsServiceRef.current = new maps.DirectionsService();
        }

        if (!directionsRendererRef.current) {
          directionsRendererRef.current = new maps.DirectionsRenderer({
            draggable: true,
            suppressMarkers: true,
            preserveViewport: true,
            polylineOptions: {
              strokeColor: "#3b82f6",
              strokeOpacity: 0.9,
              strokeWeight: 5,
            },
          });
          directionsRendererRef.current.setMap(mapRef.current);
          directionsListenerRef.current = directionsRendererRef.current.addListener(
            "directions_changed",
            () => {
              if (suppressDirectionsChangeRef.current) {
                suppressDirectionsChangeRef.current = false;
                return;
              }

              const directions = directionsRendererRef.current?.getDirections();
              if (!directions) {
                return;
              }

              const orderedTripStops = buildOrderedTripStops(
                editableStopsRef.current,
                fixedStopsRef.current,
                profileRef.current,
              );
              const nextRouteState = buildRouteDataFromDirections(
                directions,
                orderedTripStops,
              );

              setActiveRoute(nextRouteState.route);
              onRouteChange?.(nextRouteState.route, nextRouteState.tripStops);
            },
          );
        }

        setMapError("");
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onRouteChange]);

  useEffect(() => {
    let cancelled = false;

    async function syncEditableRoute() {
      if (!route || !mapRef.current || !mapsRef.current || !directionsServiceRef.current) {
        if (directionsRendererRef.current) {
          directionsRendererRef.current.setMap(null);
        }
        setActiveRoute(route);
        setRouteEditLoading(false);
        return;
      }

      const orderedTripStops = buildOrderedTripStops(editableStops, fixedStops, profile);
      const directionsRequest = buildDirectionsRequest(profile, orderedTripStops, mapsRef.current);

      if (!directionsRequest) {
        return;
      }

      setRouteEditLoading(true);
      setRouteEditError("");

      try {
        const directions = await requestDirections(
          directionsServiceRef.current,
          directionsRequest,
        );
        if (cancelled) {
          return;
        }

        directionsRendererRef.current?.setMap(mapRef.current);
        suppressDirectionsChangeRef.current = true;
        directionsRendererRef.current?.setDirections(directions);

        const nextRouteState = buildRouteDataFromDirections(directions, orderedTripStops);
        setActiveRoute(nextRouteState.route);
        onRouteChange?.(nextRouteState.route, nextRouteState.tripStops);
      } catch (error) {
        if (!cancelled) {
          setRouteEditError(error.message);
          setActiveRoute(route);
        }
      } finally {
        if (!cancelled) {
          setRouteEditLoading(false);
        }
      }
    }

    syncEditableRoute();

    return () => {
      cancelled = true;
    };
  }, [editableStops, fixedStops, onRouteChange, profile, route]);

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !mapRef.current) {
          return;
        }

        const displayRoute = activeRoute;
        if (!displayRoute || displayRoute.waypoints.length === 0) {
          clearRouteOverlays();
          clearPlaceMarkers();
          setPlacesError("");

          if (directionsRendererRef.current) {
            directionsRendererRef.current.setMap(null);
          }

          if (currentLocation) {
            clearCurrentLocationMarker();
            currentLocationMarkerRef.current = new maps.Marker({
              map: mapRef.current,
              position: currentLocation,
              title: "Current location",
            });
            mapRef.current.setCenter(currentLocation);
            mapRef.current.setZoom(9);
            return;
          }

          clearCurrentLocationMarker();
          mapRef.current.setCenter(UNITED_STATES_CENTER);
          mapRef.current.setZoom(UNITED_STATES_ZOOM);
          return;
        }

        if (directionsRendererRef.current) {
          directionsRendererRef.current.setMap(mapRef.current);
        }

        clearRouteOverlays();
        clearCurrentLocationMarker();

        const bounds = new maps.LatLngBounds();

        displayRoute.waypoints.forEach((waypoint, index) => {
          const marker = new maps.Marker({
            map: mapRef.current,
            position: {
              lat: waypoint.latitude,
              lng: waypoint.longitude,
            },
            label: getMarkerLabel(waypoint, index, displayRoute.waypoints.length),
            title: `${waypoint.name} - ${waypoint.location}`,
          });

          const infoWindow = new maps.InfoWindow({
            content: buildWaypointInfoContent(
              waypoint,
              index,
              displayRoute,
              tripStops,
              profile,
            ),
          });

          marker.addListener("mouseover", () =>
            infoWindow.open({ anchor: marker, map: mapRef.current, shouldFocus: false }),
          );
          marker.addListener("mouseout", () => infoWindow.close());
          marker.addListener("click", () =>
            infoWindow.open({ anchor: marker, map: mapRef.current, shouldFocus: false }),
          );
          markersRef.current.push(marker);
          bounds.extend(marker.getPosition());
        });

        const hasRenderedDirections = Boolean(
          directionsRendererRef.current?.getDirections?.()?.routes?.length,
        );

        if (!hasRenderedDirections && displayRoute.geometry.length > 0) {
          polylineRef.current = new maps.Polyline({
            path: displayRoute.geometry.map((point) => ({
              lat: point.latitude,
              lng: point.longitude,
            })),
            geodesic: true,
            strokeColor: "#3b82f6",
            strokeOpacity: 0.85,
            strokeWeight: 5,
          });
          polylineRef.current.setMap(mapRef.current);
        }

        displayRoute.geometry.forEach((point) => {
          bounds.extend({ lat: point.latitude, lng: point.longitude });
        });

        mapRef.current.fitBounds(bounds, 60);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeRoute, currentLocation, profile, tripStops]);

  useEffect(() => {
    let cancelled = false;

    async function loadNearbyPlaces() {
      const displayRoute = activeRoute;
      if (
        !displayRoute ||
        !mapRef.current ||
        !mapsRef.current ||
        !placesServiceRef.current
      ) {
        clearPlaceMarkers();
        setPlacesError("");
        setPlacesLoading(false);
        return;
      }

      const activeLayers = (availablePlaceLayerKey
        ? availablePlaceLayerKey.split("|")
        : []
      )
        .map((layerId) => ({
          id: layerId,
          ...PLACE_LAYER_DEFINITIONS[layerId],
        }))
        .filter((layer) => placeLayerPreferences[layer.id] ?? true);
      if (activeLayers.length === 0) {
        clearPlaceMarkers();
        setPlacesError("");
        setPlacesLoading(false);
        return;
      }

      setPlacesLoading(true);
      setPlacesError("");

      try {
        const maps = mapsRef.current;
        const sampledPoints = sampleRoutePoints(displayRoute);
        const placeLookup = new Map();

        for (const layer of activeLayers) {
          for (const sampledPoint of sampledPoints) {
            for (const search of layer.searches) {
              const placeSearchRadius = Math.min(
                profile?.recommendation_radius_miles
                  ? Math.round(profile.recommendation_radius_miles * 1609)
                  : DEFAULT_PLACE_SEARCH_RADIUS_METERS,
                MAX_PLACE_SEARCH_RADIUS_METERS,
              );
              const results = await performNearbySearch(placesServiceRef.current, maps, {
                location: sampledPoint,
                radius: placeSearchRadius,
                ...search,
              });

              results.forEach((place) => {
                if (!place.place_id || !place.geometry?.location) {
                  return;
                }

                if (!placeLookup.has(place.place_id)) {
                  placeLookup.set(place.place_id, {
                    place,
                    layer,
                  });
                }
              });
            }
          }
        }

        if (cancelled) {
          return;
        }

        clearPlaceMarkers();

        Array.from(placeLookup.values())
          .slice(0, PLACE_RESULTS_LIMIT)
          .forEach(({ place, layer }) => {
            const marker = new maps.Marker({
              map: mapRef.current,
              position: place.geometry.location,
              title: place.name,
              icon: createPlaceMarkerIcon(maps, layer.markerColor),
            });

            const infoWindow = new maps.InfoWindow({
              content: `
                <div style="max-width:240px">
                  <strong>${place.name}</strong><br />
                  <span>${layer.label}</span><br />
                  <span>${place.vicinity || place.formatted_address || "Near your route"}</span>
                </div>
              `,
            });

            marker.addListener("click", () =>
              infoWindow.open({ anchor: marker, map: mapRef.current }),
            );
            placeMarkersRef.current.push(marker);
          });
      } catch (error) {
        if (!cancelled) {
          clearPlaceMarkers();
          setPlacesError(error.message);
        }
      } finally {
        if (!cancelled) {
          setPlacesLoading(false);
        }
      }
    }

    loadNearbyPlaces();

    return () => {
      cancelled = true;
    };
  }, [activeRoute, availablePlaceLayerKey, placeLayerPreferences, profile?.recommendation_radius_miles]);

  useEffect(
    () => () => {
      directionsListenerRef.current?.remove?.();
    },
    [],
  );

  const [hoveredStopIndex, setHoveredStopIndex] = useState(null);

  const hasRoute = Boolean(activeRoute?.waypoints?.length);
  const orderedSidebarStops = buildOrderedTripStops(editableStops, fixedStops, profile);
  const placeLayerSummary =
    availablePlaceLayers.length > 0
      ? "Show route-adjacent places based on this trip profile."
      : "Route overlays will appear after the AI generates a route.";

  return (
    <div className="card map-card">
      <div className="section-header">
        <div>
          <h2>Trip Map</h2>
          <p className="helper-text">
            {hasRoute
              ? "Drag the route line or reorder stops in the sidebar to update the trip live."
              : "Starts with a United States overview and updates in place."}
          </p>
        </div>
        {hasRoute && (
          <p>
            {formatMiles(activeRoute.total_distance_km)} • {formatDuration(activeRoute.total_duration_minutes)}
          </p>
        )}
      </div>

      <div className="map-layer-controls">
        <div>
          <h3>Show On Map</h3>
          <p className="helper-text">{placeLayerSummary}</p>
        </div>

        <div className="map-layer-list">
          {availablePlaceLayers.map((layer) => (
            <label key={layer.id} className="map-layer-option">
              <input
                type="checkbox"
                checked={placeLayerPreferences[layer.id] ?? true}
                onChange={() => handlePlaceLayerToggle(layer.id)}
                disabled={!hasRoute}
              />
              <span>{layer.label}</span>
            </label>
          ))}
        </div>
      </div>

      {mapError && <p className="status-message error-text">{mapError}</p>}

      <div className={`map-editor-layout${hasRoute ? " map-editor-layout--stacked" : " map-editor-layout--fullwidth"}`}>
        <div ref={mapElementRef} className="map-canvas" />
      </div>

      {hasRoute && (
        <aside className="route-editor-sidebar route-editor-sidebar--stacked">
          <div className="section-header">
            <div>
              <h3>Edit Route</h3>
              <p className="helper-text">
                Reorder flexible stops here. Start and final anchors stay fixed.
              </p>
            </div>
            <button
              type="button"
              className="secondary-button route-reset-button"
              onClick={resetRouteEdits}
              disabled={!hasRoute || routeEditLoading}
            >
              Reset
            </button>
          </div>

          {orderedSidebarStops.length > 0 ? (
            <div className="route-stop-list route-stop-list--stacked">
              <div
                className="route-stop-item route-stop-item--anchor"
                onMouseEnter={() => setHoveredStopIndex(-1)}
                onMouseLeave={() => setHoveredStopIndex(null)}
              >
                <div>
                  <p className="route-stop-label">Start</p>
                  <h4>{profile.start_location || "Starting point"}</h4>
                  <p className="route-stop-role">Fixed origin</p>
                </div>
                <span className="route-stop-lock">Fixed</span>
                {hoveredStopIndex === -1 && (
                  <div className="route-stop-tooltip">
                    <p className="route-stop-tooltip-label">Starting Point</p>
                    <p className="route-stop-tooltip-value">{profile.start_location || "Not set"}</p>
                    {activeRoute && (
                      <div className="route-stop-tooltip-stat">
                        <span>Total route</span>
                        <span>{formatMiles(activeRoute.total_distance_km)} · {formatDuration(activeRoute.total_duration_minutes)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {orderedSidebarStops.map((stop, index) => {
                // editableStops and fixedStops do not overlap by construction,
                // so "movable" means the stop is not locked.
                const isMovable = !stop.isLocked;
                const movableIndex = isMovable ? index : -1;
                const leg = activeRoute?.legs?.[index];

                return (
                  <div
                    key={`${stop.location}-${stop.order}-${index}`}
                    className={`route-stop-item${
                      stop.isLocked ? " route-stop-item--anchor" : ""
                    }`}
                    onMouseEnter={() => setHoveredStopIndex(index)}
                    onMouseLeave={() => setHoveredStopIndex(null)}
                  >
                    <div>
                      <p className="route-stop-label">
                        {getSidebarLabel(stop, index + 1, orderedSidebarStops.length + 1)}
                      </p>
                      <h4>{stop.name}</h4>
                      <p className="muted-text">{stop.location}</p>
                      <p className="route-stop-role">{getSidebarRoleText(stop)}</p>
                    </div>

                    {isMovable ? (
                      <div className="route-stop-actions">
                        <button
                          type="button"
                          className="route-move-button"
                          onClick={() => moveStop(movableIndex, -1)}
                          disabled={movableIndex === 0 || routeEditLoading}
                          aria-label={`Move ${stop.name} left`}
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          className="route-move-button"
                          onClick={() => moveStop(movableIndex, 1)}
                          disabled={movableIndex === editableStops.length - 1 || routeEditLoading}
                          aria-label={`Move ${stop.name} right`}
                        >
                          →
                        </button>
                      </div>
                    ) : (
                      <span className="route-stop-lock">Fixed</span>
                    )}

                    {hoveredStopIndex === index && (
                      <div className="route-stop-tooltip">
                        <p className="route-stop-tooltip-label">
                          {getSidebarLabel(stop, index + 1, orderedSidebarStops.length + 1)}
                        </p>
                        {stop.day != null && (
                          <div className="route-stop-tooltip-stat">
                            <span>Day</span>
                            <span>{stop.day}</span>
                          </div>
                        )}
                        {stop.reason && (
                          <p className="route-stop-tooltip-reason">{stop.reason}</p>
                        )}
                        {leg && (
                          <div className="route-stop-tooltip-stat">
                            <span>Leg distance</span>
                            <span>{formatMiles(leg.distance_km)}</span>
                          </div>
                        )}
                        {leg && (
                          <div className="route-stop-tooltip-stat">
                            <span>Drive time</span>
                            <span>{formatDuration(leg.duration_minutes)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="status-message">
              Generate a trip to unlock route editing controls.
            </p>
          )}

          {routeEditLoading && hasRoute && (
            <p className="status-message">Updating route path, time, and distance...</p>
          )}
          {routeEditError && <p className="status-message error-text">{routeEditError}</p>}
        </aside>
      )}

      <div className="map-toolbar">
        <p className="status-message">
          {hasRoute
            ? "Dragging the blue route or reordering stops updates the latest itinerary automatically."
            : startLocation
              ? `Starting location: ${startLocation}`
              : "Set a starting location manually or use your current location."}
        </p>

        <button
          type="button"
          className="secondary-button"
          onClick={handleUseCurrentLocation}
          disabled={locationLoading || loading}
        >
          {locationLoading ? "Finding your location..." : "Use my location"}
        </button>
      </div>

      {placesLoading && hasRoute && (
        <p className="status-message">Loading nearby places for the selected layers...</p>
      )}
      {placesError && <p className="status-message error-text">{placesError}</p>}
      {locationError && <p className="status-message error-text">{locationError}</p>}
    </div>
  );
}

export default TripMap;
