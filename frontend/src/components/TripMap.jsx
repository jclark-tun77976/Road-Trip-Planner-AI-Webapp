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
function TripMap({ route, startLocation, onUseCurrentLocation, loading, profile }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const mapsRef = useRef(null);
  const geocoderRef = useRef(null);
  const placesServiceRef = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const currentLocationMarkerRef = useRef(null);
  const placeMarkersRef = useRef([]);
  const [mapError, setMapError] = useState("");
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [currentLocation, setCurrentLocation] = useState(null);
  const [placesError, setPlacesError] = useState("");
  const [placesLoading, setPlacesLoading] = useState(false);
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

        setMapError("");

        if (!route || route.waypoints.length === 0) {
          clearRouteOverlays();
          clearPlaceMarkers();
          setPlacesError("");

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

        clearRouteOverlays();
        clearCurrentLocationMarker();

        const bounds = new maps.LatLngBounds();

        route.waypoints.forEach((waypoint, index) => {
          const marker = new maps.Marker({
            map: mapRef.current,
            position: {
              lat: waypoint.latitude,
              lng: waypoint.longitude,
            },
            label: getMarkerLabel(waypoint, index, route.waypoints.length),
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

          marker.addListener("click", () => infoWindow.open({ anchor: marker, map: mapRef.current }));
          markersRef.current.push(marker);
          bounds.extend(marker.getPosition());
        });

        if (route.geometry.length > 0) {
          polylineRef.current = new maps.Polyline({
            path: route.geometry.map((point) => ({
              lat: point.latitude,
              lng: point.longitude,
            })),
            geodesic: true,
            strokeColor: "#3b82f6",
            strokeOpacity: 0.85,
            strokeWeight: 5,
          });
          polylineRef.current.setMap(mapRef.current);

          route.geometry.forEach((point) => {
            bounds.extend({ lat: point.latitude, lng: point.longitude });
          });
        }

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
  }, [currentLocation, route]);

  useEffect(() => {
    let cancelled = false;

    async function loadNearbyPlaces() {
      if (!route || !mapRef.current || !mapsRef.current || !placesServiceRef.current) {
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
        const sampledPoints = sampleRoutePoints(route);
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
  }, [availablePlaceLayerKey, placeLayerPreferences, route]);

  const hasRoute = Boolean(route?.waypoints?.length);
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
            {route
              ? "The latest AI route is drawn on this map."
              : "Starts with a United States overview and updates in place."}
          </p>
        </div>
        {route && (
          <p>
            {route.total_distance_km} km • {route.total_duration_minutes} min
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
      <div ref={mapElementRef} className="map-canvas" />

      <div className="map-toolbar">
        <p className="status-message">
          {route
            ? "Submitting a new trip keeps this map in place and redraws the route."
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
