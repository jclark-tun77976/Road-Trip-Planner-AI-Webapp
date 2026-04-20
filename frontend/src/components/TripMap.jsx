import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../utils/googleMaps";

const UNITED_STATES_CENTER = { lat: 39.8283, lng: -98.5795 };
const UNITED_STATES_ZOOM = 4;
const MAX_ROUTE_SAMPLE_POINTS = 4;
const PLACE_SEARCH_RADIUS_METERS = 12000;
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
    searches: [{ keyword: "hiking trail", type: "park" }],
  },
};

function normalizeLocation(value) {
  return value.trim().toLowerCase();
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

  if (/(hiking|trail|nature|outdoor|outdoors|waterfall|mountain|park)/.test(combinedText)) {
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

function buildEditableStopGroups(profile, tripStops) {
  const sourceStops = (tripStops ?? [])
    .filter((stop) => stop?.location?.trim())
    .map((stop) => ({
      ...stop,
      kind: "stop",
      isLocked: false,
      isSynthetic: false,
    }));
  const workingStops = [...sourceStops];
  const fixedStops = [];
  const normalizedStart = normalizeLocation(profile?.start_location ?? "");
  const normalizedDestination = normalizeLocation(profile?.destination ?? "");

  if (
    profile?.is_round_trip &&
    workingStops.length > 0 &&
    normalizeLocation(workingStops[workingStops.length - 1].location) === normalizedStart
  ) {
    const returnStop = workingStops.pop();
    fixedStops.unshift({
      ...returnStop,
      kind: "return",
      isLocked: true,
    });
  }

  if (normalizedDestination) {
    if (
      workingStops.length > 0 &&
      normalizeLocation(workingStops[workingStops.length - 1].location) === normalizedDestination
    ) {
      const destinationStop = workingStops.pop();
      fixedStops.unshift({
        ...destinationStop,
        kind: "destination",
        isLocked: true,
      });
    } else {
      fixedStops.unshift(
        createSyntheticStop(
          profile.destination,
          "Destination chosen from your trip profile.",
          "destination",
        ),
      );
    }
  }

  if (
    profile?.is_round_trip &&
    normalizedStart &&
    !fixedStops.some((stop) => stop.kind === "return")
  ) {
    fixedStops.push(
      createSyntheticStop(
        profile.start_location,
        "Return to your starting location to complete the round trip.",
        "return",
      ),
    );
  }

  return {
    editableStops: workingStops,
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
            content: `
              <div style="max-width:220px">
                <strong>${waypoint.name}</strong><br />
                <span>${waypoint.location}</span>
              </div>
            `,
          });

          marker.addListener("click", () =>
            infoWindow.open({ anchor: marker, map: mapRef.current }),
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
  }, [activeRoute, currentLocation]);

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
              const results = await performNearbySearch(placesServiceRef.current, maps, {
                location: sampledPoint,
                radius: PLACE_SEARCH_RADIUS_METERS,
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
  }, [activeRoute, availablePlaceLayerKey, placeLayerPreferences]);

  useEffect(
    () => () => {
      directionsListenerRef.current?.remove?.();
    },
    [],
  );

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
            {activeRoute.total_distance_km} km • {activeRoute.total_duration_minutes} min
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

      <div className="map-editor-layout">
        <div ref={mapElementRef} className="map-canvas" />

        <aside className="route-editor-sidebar">
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
            <div className="route-stop-list">
              <div className="route-stop-item route-stop-item--anchor">
                <div>
                  <p className="route-stop-label">Start</p>
                  <h4>{profile.start_location || "Starting point"}</h4>
                  <p className="muted-text">Fixed origin</p>
                </div>
              </div>

              {orderedSidebarStops.map((stop, index) => {
                const movableIndex = editableStops.findIndex(
                  (editableStop) =>
                    editableStop.location === stop.location &&
                    editableStop.reason === stop.reason,
                );
                const isMovable = movableIndex !== -1;

                return (
                  <div
                    key={`${stop.location}-${stop.order}-${index}`}
                    className={`route-stop-item${
                      stop.isLocked ? " route-stop-item--anchor" : ""
                    }`}
                  >
                    <div>
                      <p className="route-stop-label">
                        {getSidebarLabel(stop, index + 1, orderedSidebarStops.length + 1)}
                      </p>
                      <h4>{stop.name}</h4>
                      <p className="muted-text">{stop.location}</p>
                    </div>

                    {isMovable ? (
                      <div className="route-stop-actions">
                        <button
                          type="button"
                          className="route-move-button"
                          onClick={() => moveStop(movableIndex, -1)}
                          disabled={movableIndex === 0 || routeEditLoading}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="route-move-button"
                          onClick={() => moveStop(movableIndex, 1)}
                          disabled={movableIndex === editableStops.length - 1 || routeEditLoading}
                        >
                          ↓
                        </button>
                      </div>
                    ) : (
                      <span className="route-stop-lock">Fixed</span>
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
      </div>

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
