import { useEffect, useState } from "react";
import ItineraryPanel from "./components/ItineraryPanel";
import TripMap from "./components/TripMap";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

const VEHICLE_TYPE_OPTIONS = [
  "Hitchhiker",
  "Bicycle",
  "Motorcycle",
  "Compact car",
  "Sedan",
  "SUV",
  "Minivan",
  "Pickup truck",
  "Camper van",
  "RV",
  "Truck driver",
];

const TRIP_LENGTH_UNITS = ["hours", "days", "weeks"];

const INITIAL_PROFILE = {
  name: "",
  start_location: "",
  destination: "",
  trip_length_value: "",
  trip_length_unit: "days",
  is_round_trip: false,
  vehicle_type: "Sedan",
  is_ev: false,
  needs_public_water: false,
  budget: "",
  travel_style: "",
  interests: "",
  stops: [""],
};

function App() {
  const [profile, setProfile] = useState(INITIAL_PROFILE);

  const [request, setRequest] = useState("");
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const savedProfile = localStorage.getItem("roadTripProfile");
    if (savedProfile) {
      const parsedProfile = JSON.parse(savedProfile);
      setProfile({
        ...INITIAL_PROFILE,
        name: parsedProfile.name ?? "",
        start_location: parsedProfile.start_location ?? "",
        destination: parsedProfile.destination ?? "",
        trip_length_value:
          parsedProfile.trip_length_value ?? parsedProfile.trip_length_days ?? "",
        trip_length_unit: parsedProfile.trip_length_unit ?? "days",
        is_round_trip: parsedProfile.is_round_trip ?? false,
        vehicle_type: parsedProfile.vehicle_type ?? "Sedan",
        is_ev: parsedProfile.is_ev ?? false,
        needs_public_water: parsedProfile.needs_public_water ?? false,
        budget: parsedProfile.budget ?? "",
        travel_style: parsedProfile.travel_style ?? "",
        interests: parsedProfile.interests ?? "",
        stops:
          Array.isArray(parsedProfile.stops) && parsedProfile.stops.length > 0
            ? parsedProfile.stops
            : [""],
      });
    }
  }, []);

  useEffect(() => {
    if (!loading) {
      setLoadingSeconds(0);
      return undefined;
    }

    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000) + 1);
    }, 1000);

    setLoadingSeconds(1);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loading]);

  function handleProfileChange(event) {
    const { name, type, value, checked } = event.target;
    const updatedProfile = {
      ...profile,
      [name]: type === "checkbox" ? checked : value,
    };

    setProfile(updatedProfile);
    localStorage.setItem("roadTripProfile", JSON.stringify(updatedProfile));
  }

  function handleStopChange(index, value) {
    const updatedStops = profile.stops.map((stop, stopIndex) =>
      stopIndex === index ? value : stop
    );

    const updatedProfile = {
      ...profile,
      stops: updatedStops,
    };

    setProfile(updatedProfile);
    localStorage.setItem("roadTripProfile", JSON.stringify(updatedProfile));
  }

  function addStopField() {
    const updatedProfile = {
      ...profile,
      stops: [...profile.stops, ""],
    };

    setProfile(updatedProfile);
    localStorage.setItem("roadTripProfile", JSON.stringify(updatedProfile));
  }

  function clearProfile() {
    setProfile(INITIAL_PROFILE);
    localStorage.removeItem("roadTripProfile");
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!profile.start_location.trim()) {
      setError("Starting Location is required.");
      return;
    }

    if (!profile.destination.trim()) {
      setError("Destination is required.");
      return;
    }

    if (!profile.trip_length_value) {
      setError("Trip length is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${API_BASE_URL}/api/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: {
            ...profile,
            trip_length_value: Number(profile.trip_length_value),
            stops: profile.stops.filter((stop) => stop.trim() !== ""),
          },
          request,
        }),
      });

      if (!res.ok) {
        let errorMessage = `Backend request failed (${res.status})`;

        try {
          const errorData = await res.json();
          if (typeof errorData?.detail === "string" && errorData.detail) {
            errorMessage = errorData.detail;
          }
        } catch {
          // Keep the status-based fallback if the backend response is not JSON.
        }

        throw new Error(errorMessage);
      }

      const data = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <h1 className="title">Road Trip Planner AI</h1>

      <form className="container" onSubmit={handleSubmit}>
        <div className="card">
          <h2>User Profile</h2>

          <label className="label">Name</label>
          <input
            className="input"
            type="text"
            name="name"
            value={profile.name}
            onChange={handleProfileChange}
            placeholder="Enter your name"
          />
          
          <label className="label">Starting Location</label>
          <input
            className="input"
            type="text"
            name="start_location"
            value={profile.start_location}
            onChange={handleProfileChange}
            placeholder="Philadelphia"
          />

          <label className="label">Trip Length</label>
          <div className="trip-length-group">
            <input
              className="input trip-length-input"
              type="number"
              min="1"
              name="trip_length_value"
              value={profile.trip_length_value}
              onChange={handleProfileChange}
              placeholder="4"
            />

            <div className="segment-switch" role="group" aria-label="Trip length unit">
              {TRIP_LENGTH_UNITS.map((unit) => (
                <button
                  key={unit}
                  type="button"
                  className={`segment-option${
                    profile.trip_length_unit === unit ? " active" : ""
                  }`}
                  onClick={() =>
                    handleProfileChange({
                      target: { name: "trip_length_unit", type: "text", value: unit },
                    })
                  }
                >
                  {unit}
                </button>
              ))}
            </div>
          </div>

          <label className="label">Destination</label>
          <input
            className="input"
            type="text"
            name="destination"
            value={profile.destination}
            onChange={handleProfileChange}
            placeholder="Pittsburgh"
          />

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="is_round_trip"
              checked={profile.is_round_trip}
              onChange={handleProfileChange}
            />
            <span>Round trip</span>
          </label>

          {profile.is_round_trip && (
            <p className="helper-text">
              This trip will return to your starting location at the end.
            </p>
          )}

          <label className="label">Vehicle Type</label>
          <select
            className="input"
            name="vehicle_type"
            value={profile.vehicle_type}
            onChange={handleProfileChange}
          >
            {VEHICLE_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="is_ev"
              checked={profile.is_ev}
              onChange={handleProfileChange}
            />
            <span>EV vehicle</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="needs_public_water"
              checked={profile.needs_public_water}
              onChange={handleProfileChange}
            />
            <span>Need access to public water</span>
          </label>

          <label className="label">Budget</label>
          <input
            className="input"
            type="text"
            name="budget"
            value={profile.budget}
            onChange={handleProfileChange}
            placeholder="low, medium, or high"
          />

          <label className="label">Travel Style</label>
          <input
            className="input"
            type="text"
            name="travel_style"
            value={profile.travel_style}
            onChange={handleProfileChange}
            placeholder="scenic, relaxed, adventurous"
          />

          <label className="label">Interests</label>
          <input
            className="input"
            type="text"
            name="interests"
            value={profile.interests}
            onChange={handleProfileChange}
            placeholder="nature, food, small towns"
          />

          <label className="label">Stops (Optional)</label>
          {profile.stops.map((stop, index) => (
            <input
              key={index}
              className="input"
              type="text"
              value={stop}
              onChange={(event) => handleStopChange(index, event.target.value)}
              placeholder={`Stop ${index + 1}`}
            />
          ))}

          {profile.stops[profile.stops.length - 1]?.trim() && (
            <button
              type="button"
              className="secondary-button"
              onClick={addStopField}
            >
              Add another stop
            </button>
          )}

          <button type="button" className="clear-button" onClick={clearProfile}>
            Clear profile
          </button>
        </div>

        <div className="card">
          <h2>Trip Request</h2>

          <label className="label">What do you want help with?</label>
          <textarea
            className="textarea"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder="Example: Plan me a 5-day scenic road trip with cheap hotels and good food stops."
          />

          <p className="char-count">Character count: {request.length}</p>

          {loading && (
            <p className="thinking-text">Thinking... {loadingSeconds}s</p>
          )}

          <button type="submit" className="button" disabled={loading}>
            {loading ? `Thinking... ${loadingSeconds}s` : "Submit"}
          </button>

          <div className="preview-box">
            <h3>Current Request</h3>
            <p>{request || "Your trip request will appear here."}</p>

            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
      </form>

      {response && (
        <section className="results-section">
          <div className="result-card">
            <div className="section-header">
              <h3>Trip Overview</h3>
              <p>{response.trip_stops.length} stops mapped</p>
            </div>

            <p>{response.summary}</p>

            <h4>Recommendations</h4>
            <ul>
              {response.recommendations.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>

            <h4>Budget Notes</h4>
            <p>{response.budget_notes}</p>

            {response.warnings?.length > 0 && (
              <div className="warning-box">
                <h4>Planning Notes</h4>
                <ul>
                  {response.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <TripMap route={response.route} />
          <ItineraryPanel response={response} />
        </section>
      )}
    </div>
  );
}

export default App;
