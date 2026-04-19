/* global __GOOGLE_MAPS_API_KEY__ */

const GOOGLE_MAPS_API_KEY = __GOOGLE_MAPS_API_KEY__;
let googleMapsPromise = null;
const GOOGLE_MAPS_CALLBACK_NAME = "__initRoadTripGoogleMaps";

export function loadGoogleMaps() {
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
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=${GOOGLE_MAPS_CALLBACK_NAME}`;
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
