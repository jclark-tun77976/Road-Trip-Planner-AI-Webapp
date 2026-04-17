import { useEffect, useRef, useState } from "react";


const GOOGLE_MAPS_API_KEY = __GOOGLE_MAPS_API_KEY__;
let googleMapsPromise = null;
const GOOGLE_MAPS_CALLBACK_NAME = "__initRoadTripGoogleMaps";


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


function TripMap({ route }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const [mapError, setMapError] = useState("");

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !mapElementRef.current) {
          return;
        }

        if (!mapRef.current) {
          mapRef.current = new maps.Map(mapElementRef.current, {
            center: { lat: 39.8283, lng: -98.5795 },
            zoom: 4,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
          });
        }

        setMapError("");

        markersRef.current.forEach((marker) => marker.setMap(null));
        markersRef.current = [];

        if (polylineRef.current) {
          polylineRef.current.setMap(null);
          polylineRef.current = null;
        }

        if (!route || route.waypoints.length === 0) {
          return;
        }

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
  }, [route]);

  return (
    <div className="result-card map-card">
      <div className="section-header">
        <h3>Trip Map</h3>
        {route && (
          <p>
            {route.total_distance_km} km • {route.total_duration_minutes} min
          </p>
        )}
      </div>

      {mapError ? (
        <p className="status-message error-text">{mapError}</p>
      ) : route ? (
        <div ref={mapElementRef} className="map-canvas" />
      ) : (
        <p className="status-message">Route data is not available for this itinerary yet.</p>
      )}
    </div>
  );
}


export default TripMap;
