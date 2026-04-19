import { useEffect, useState } from "react";
import ItineraryPanel from "./components/ItineraryPanel";
import LocationAutocompleteInput from "./components/LocationAutocompleteInput";
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
const TRAVEL_STYLE_OPTIONS = ["none", "hotel", "camping", "RV sleeping"];

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
  travel_style: "none",
  interests: "",
  stops: [""],
};

function getInitialProfile() {
  if (typeof window === "undefined") {
    return INITIAL_PROFILE;
  }

  const savedProfile = window.localStorage.getItem("roadTripProfile");
  if (!savedProfile) {
    return INITIAL_PROFILE;
  }

  try {
    const parsedProfile = JSON.parse(savedProfile);
    return {
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
      travel_style: TRAVEL_STYLE_OPTIONS.includes(parsedProfile.travel_style)
        ? parsedProfile.travel_style
        : "none",
      interests: parsedProfile.interests ?? "",
      stops:
        Array.isArray(parsedProfile.stops) && parsedProfile.stops.length > 0
          ? parsedProfile.stops
          : [""],
    };
  } catch {
    return INITIAL_PROFILE;
  }
}

function buildConversationHistoryPayload(entries) {
  return entries.map((entry) => ({
    version: entry.version,
    request: entry.request,
    summary: entry.response.summary,
    recommendations: entry.response.recommendations,
    budget_notes: entry.response.budget_notes,
    trip_stops: entry.response.trip_stops,
  }));
}

function App() {
  const [profile, setProfile] = useState(getInitialProfile);
  const [request, setRequest] = useState("");
  const [response, setResponse] = useState(null);
  const [responseHistory, setResponseHistory] = useState([]);
  const [refinementRequest, setRefinementRequest] = useState("");
  const [latestSubmittedRequest, setLatestSubmittedRequest] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState("");

  function persistProfile(updatedProfile) {
    setProfile(updatedProfile);
    localStorage.setItem("roadTripProfile", JSON.stringify(updatedProfile));
  }

  useEffect(() => {
    if (!loading) {
      return undefined;
    }

    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000) + 1);
    }, 1000);

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

    persistProfile(updatedProfile);
  }

  function handleStopChange(index, value) {
    const updatedStops = profile.stops.map((stop, stopIndex) =>
      stopIndex === index ? value : stop
    );

    const updatedProfile = {
      ...profile,
      stops: updatedStops,
    };

    persistProfile(updatedProfile);
  }

  function handleLocationFieldChange(fieldName, value) {
    persistProfile({
      ...profile,
      [fieldName]: value,
    });
  }

  function addStopField() {
    const updatedProfile = {
      ...profile,
      stops: [...profile.stops, ""],
    };

    persistProfile(updatedProfile);
  }

  function handleUseCurrentLocation(location) {
    persistProfile({
      ...profile,
      start_location: location,
    });
  }

  function clearProfile() {
    setProfile(INITIAL_PROFILE);
    setResponse(null);
    setResponseHistory([]);
    setRequest("");
    setRefinementRequest("");
    setLatestSubmittedRequest("");
    setError("");
    localStorage.removeItem("roadTripProfile");
  }

  async function requestTripPlan(requestText, conversationHistory) {
    if (!profile.start_location.trim()) {
      setError("Starting Location is required.");
      return null;
    }

    if (!profile.destination.trim()) {
      setError("Destination is required.");
      return null;
    }

    if (!profile.trip_length_value) {
      setError("Trip length is required.");
      return null;
    }

    if (!requestText.trim()) {
      setError("A trip request is required.");
      return null;
    }

    setLoading(true);
    setLoadingSeconds(1);
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
          request: requestText,
          conversation_history: buildConversationHistoryPayload(conversationHistory),
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
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
      setLoadingSeconds(0);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const requestText = request.trim();
    const data = await requestTripPlan(requestText, []);
    if (!data) {
      return;
    }

    const nextEntry = {
      version: 1,
      request: requestText,
      response: data,
    };

    setResponse(data);
    setResponseHistory([nextEntry]);
    setLatestSubmittedRequest(requestText);
    setRefinementRequest("");
  }

  async function handleRefinementSubmit() {
    const requestText = refinementRequest.trim();
    const data = await requestTripPlan(requestText, responseHistory);
    if (!data) {
      return;
    }

    const nextEntry = {
      version: responseHistory.length + 1,
      request: requestText,
      response: data,
    };

    setResponse(data);
    setResponseHistory((previous) => [...previous, nextEntry]);
    setLatestSubmittedRequest(requestText);
    setRefinementRequest("");
  }

  const currentRequestPreview =
    latestSubmittedRequest || request || "Your trip request will appear here.";

  return (
    <div className="page">
      <h1 className="title">Road Trip Planner AI</h1>

      <form className="planner-layout" onSubmit={handleSubmit}>
        <div className="card profile-card">
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
          <LocationAutocompleteInput
            value={profile.start_location}
            onChange={(value) => handleLocationFieldChange("start_location", value)}
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
          <LocationAutocompleteInput
            value={profile.destination}
            onChange={(value) => handleLocationFieldChange("destination", value)}
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

          <label className="label">Travel Style</label>
          <select
            className="input"
            name="travel_style"
            value={profile.travel_style}
            onChange={handleProfileChange}
          >
            {TRAVEL_STYLE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "none" ? "None" : option}
              </option>
            ))}
          </select>

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
            <LocationAutocompleteInput
              key={index}
              value={stop}
              onChange={(value) => handleStopChange(index, value)}
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

        <div className="content-column">
          <TripMap
            route={response?.route ?? null}
            startLocation={profile.start_location}
            onUseCurrentLocation={handleUseCurrentLocation}
            loading={loading}
            profile={profile}
          />

          <div className="card trip-request-card">
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

            {!responseHistory.length && error && <p className="error-text">{error}</p>}
          </div>
        </div>
      </form>

      <div className="card current-request-card">
        <h2>Current Request</h2>
        <div className="preview-box">
          <p>{currentRequestPreview}</p>
        </div>
      </div>

      {responseHistory.length > 0 && (
        <section className="results-section">
          {responseHistory.map((entry) => (
            <article key={entry.version} className="thread-card">
              <div className="thread-header">
                <div>
                  <p className="thread-label">
                    {entry.version === 1
                      ? "Initial Plan"
                      : `Refinement ${entry.version - 1}`}
                  </p>
                  <h2>Version {entry.version}</h2>
                </div>
                <p>{entry.response.trip_stops.length} stops mapped</p>
              </div>

              <div className="thread-request-box">
                <h4>{entry.version === 1 ? "Original Request" : "Follow-up Request"}</h4>
                <p>{entry.request}</p>
              </div>

              <div className="thread-response-grid">
                <div className="result-card">
                  <div className="section-header">
                    <h3>Trip Overview</h3>
                    <p>{entry.response.trip_stops.length} stops mapped</p>
                  </div>

                  <p>{entry.response.summary}</p>

                  <h4>Recommendations</h4>
                  <ul>
                    {entry.response.recommendations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>

                  <h4>Budget Notes</h4>
                  <p>{entry.response.budget_notes}</p>

                  {entry.response.tool_calling_used &&
                    entry.response.tool_calling_summary && (
                      <div className="tooling-box">
                        <h4>Tool Calling</h4>
                        <p>{entry.response.tool_calling_summary}</p>
                      </div>
                    )}

                  {entry.response.warnings?.length > 0 && (
                    <div className="warning-box">
                      <h4>Planning Notes</h4>
                      <ul>
                        {entry.response.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <ItineraryPanel response={entry.response} />
              </div>
            </article>
          ))}

          <div className="card refinement-card">
            <h2>Refine This Plan</h2>
            <p className="helper-text">
              Ask for a shorter route, a different lodging style, extra detail, or any other revision.
            </p>

            <label className="label">Follow-up request</label>
            <textarea
              className="textarea refinement-textarea"
              value={refinementRequest}
              onChange={(event) => setRefinementRequest(event.target.value)}
              placeholder="Example: Switch this to camping, shorten it to 3 days, and explain day 2 in more detail."
            />

            <p className="char-count">Character count: {refinementRequest.length}</p>

            {loading && (
              <p className="thinking-text">Refining... {loadingSeconds}s</p>
            )}

            <button
              type="button"
              className="button"
              onClick={handleRefinementSubmit}
              disabled={loading}
            >
              {loading ? `Refining... ${loadingSeconds}s` : "Submit refinement"}
            </button>

            {responseHistory.length > 0 && error && <p className="error-text">{error}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
