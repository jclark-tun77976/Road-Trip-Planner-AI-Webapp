/* global __GOOGLE_MAPS_API_KEY__ */

import { useEffect, useRef, useState } from "react";


const GOOGLE_MAPS_API_KEY = __GOOGLE_MAPS_API_KEY__;
let googleMapsPromise = null;
const GOOGLE_MAPS_CALLBACK_NAME = "__initRoadTripGoogleMaps";
const UNITED_STATES_CENTER = { lat: 39.8283, lng: -98.5795 };
const UNITED_STATES_ZOOM = 4;


function loadGoogleMaps() {
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return Promise.reject(new Error("Google Maps API key is missing in the frontend environment."));
  }

  if (!googleMapsPromise) {
    googleMapsPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector('script[data-google-maps="true"]');
      if (existingScript) {
        if (window.google?.maps) {
          resolve(window.google.maps);
          return;
        }

        window[GOOGLE_MAPS_CALLBACK_NAME] = () => {
          resolve(window.google.maps);
          delete window[GOOGLE_MAPS_CALLBACK_NAME];
        };

        existingScript.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")));
        return;
      }

      window[GOOGLE_MAPS_CALLBACK_NAME] = () => {
        resolve(window.google.maps);
        delete window[GOOGLE_MAPS_CALLBACK_NAME];
      };

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&callback=${GOOGLE_MAPS_CALLBACK_NAME}`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMaps = "true";
      script.onerror = () => {
        delete window[GOOGLE_MAPS_CALLBACK_NAME];
        reject(new Error("Failed to load Google Maps."));
      };
      document.head.appendChild(script);
    });
  }

  return googleMapsPromise;
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


function TripMap({ route, startLocation, onUseCurrentLocation, loading }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const mapsRef = useRef(null);
  const geocoderRef = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const currentLocationMarkerRef = useRef(null);
  const [mapError, setMapError] = useState("");
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [currentLocation, setCurrentLocation] = useState(null);

  function clearMapOverlays() {
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    if (currentLocationMarkerRef.current) {
      currentLocationMarkerRef.current.setMap(null);
      currentLocationMarkerRef.current = null;
    }
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

        setMapError("");

        if (!route || route.waypoints.length === 0) {
          clearMapOverlays();

          if (currentLocation) {
            currentLocationMarkerRef.current = new maps.Marker({
              map: mapRef.current,
              position: currentLocation,
              title: "Current location",
            });
            mapRef.current.setCenter(currentLocation);
            mapRef.current.setZoom(9);
            return;
          }

          mapRef.current.setCenter(UNITED_STATES_CENTER);
          mapRef.current.setZoom(UNITED_STATES_ZOOM);
          return;
        }

        clearMapOverlays();

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

      {locationError && <p className="status-message error-text">{locationError}</p>}
    </div>
  );
}


export default TripMap;
