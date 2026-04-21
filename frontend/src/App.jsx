import { useEffect, useRef, useState } from "react";
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
  max_daily_driving_miles: "",
  recommendation_radius_miles: "",
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
      max_daily_driving_miles: parsedProfile.max_daily_driving_miles ?? "",
      recommendation_radius_miles: parsedProfile.recommendation_radius_miles ?? "",
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
    roadside_options: entry.response.roadside_options ?? [],
  }));
}

function normalizeLocation(value = "") {
  return value.trim().toLowerCase();
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

function resequenceTripStops(tripStops, profile) {
  const totalDays = getTripLengthDays(profile);

  return tripStops.map((stop, index) => ({
    ...stop,
    day: Math.min(index + 1, totalDays),
    order: index + 1,
  }));
}

function insertRoadsideStopIntoTrip(tripStops, roadsideOption, profile) {
  const normalizedRoadsideLocation = normalizeLocation(roadsideOption.location);
  if (!normalizedRoadsideLocation) {
    return tripStops;
  }

  if (
    tripStops.some(
      (stop) => normalizeLocation(stop.location) === normalizedRoadsideLocation,
    )
  ) {
    return tripStops;
  }

  const nextStop = {
    day: 1,
    order: 1,
    name: roadsideOption.name,
    location: roadsideOption.location,
    reason: roadsideOption.reason,
    latitude: null,
    longitude: null,
  };
  const normalizedDestination = normalizeLocation(profile.destination);
  let insertAt = tripStops.length;

  if (normalizedDestination) {
    const destinationIndex = tripStops.findIndex(
      (stop) => normalizeLocation(stop.location) === normalizedDestination,
    );
    if (destinationIndex !== -1) {
      insertAt = destinationIndex;
    }
  }

  const nextTripStops = [...tripStops];
  nextTripStops.splice(insertAt, 0, nextStop);
  return resequenceTripStops(nextTripStops, profile);
}

function mergeRoadsideStopIntoProfileStops(stops, roadsideOption) {
  const cleanedStops = stops.filter((stop) => stop.trim() !== "");
  if (
    cleanedStops.some(
      (stop) => normalizeLocation(stop) === normalizeLocation(roadsideOption.location),
    )
  ) {
    return stops;
  }

  return [...cleanedStops, roadsideOption.location];
}

function areTripStopsEqual(leftStops = [], rightStops = []) {
  if (leftStops.length !== rightStops.length) {
    return false;
  }

  return leftStops.every((stop, index) => {
    const otherStop = rightStops[index];
    return (
      stop.day === otherStop.day &&
      stop.order === otherStop.order &&
      stop.name === otherStop.name &&
      stop.location === otherStop.location &&
      stop.reason === otherStop.reason &&
      stop.latitude === otherStop.latitude &&
      stop.longitude === otherStop.longitude
    );
  });
}

function areRoutesEqual(leftRoute, rightRoute) {
  if (leftRoute === rightRoute) {
    return true;
  }

  if (!leftRoute || !rightRoute) {
    return false;
  }

  if (
    leftRoute.total_distance_km !== rightRoute.total_distance_km ||
    leftRoute.total_duration_minutes !== rightRoute.total_duration_minutes
  ) {
    return false;
  }

  if ((leftRoute.legs?.length ?? 0) !== (rightRoute.legs?.length ?? 0)) {
    return false;
  }

  if ((leftRoute.waypoints?.length ?? 0) !== (rightRoute.waypoints?.length ?? 0)) {
    return false;
  }

  return (
    leftRoute.legs.every((leg, index) => {
      const otherLeg = rightRoute.legs[index];
      return (
        leg.order === otherLeg.order &&
        leg.from_name === otherLeg.from_name &&
        leg.from_location === otherLeg.from_location &&
        leg.to_name === otherLeg.to_name &&
        leg.to_location === otherLeg.to_location &&
        leg.distance_km === otherLeg.distance_km &&
        leg.duration_minutes === otherLeg.duration_minutes
      );
    }) &&
    leftRoute.waypoints.every((waypoint, index) => {
      const otherWaypoint = rightRoute.waypoints[index];
      return (
        waypoint.order === otherWaypoint.order &&
        waypoint.name === otherWaypoint.name &&
        waypoint.location === otherWaypoint.location &&
        waypoint.kind === otherWaypoint.kind &&
        waypoint.latitude === otherWaypoint.latitude &&
        waypoint.longitude === otherWaypoint.longitude
      );
    })
  );
}

function App() {
  const [profile, setProfile] = useState(getInitialProfile);
  const [request, setRequest] = useState("");
  const [response, setResponse] = useState(null);
  const [responseHistory, setResponseHistory] = useState([]);
  const [expandedVersions, setExpandedVersions] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState("");
  const [tripMapRevision, setTripMapRevision] = useState(0);
  const requestTextareaRef = useRef(null);

  function persistProfile(updatedProfile) {
    setProfile(updatedProfile);
    localStorage.setItem("roadTripProfile", JSON.stringify(updatedProfile));
  }

  function resizeRequestTextarea() {
    const textarea = requestTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 52), 220);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
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

  useEffect(() => {
    const textarea = requestTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 52), 220);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
  }, [request]);

  function handleProfileChange(event) {
    const { name, type, value, checked } = event.target;
    persistProfile({
      ...profile,
      [name]: type === "checkbox" ? checked : value,
    });
  }

  function handleStopChange(index, value) {
    persistProfile({
      ...profile,
      stops: profile.stops.map((stop, stopIndex) =>
        stopIndex === index ? value : stop,
      ),
    });
  }

  function handleLocationFieldChange(fieldName, value) {
    persistProfile({
      ...profile,
      [fieldName]: value,
    });
  }

  function addStopField() {
    persistProfile({
      ...profile,
      stops: [...profile.stops, ""],
    });
  }

  function removeStopField(index) {
    const updatedStops = profile.stops.filter((_, stopIndex) => stopIndex !== index);
    persistProfile({
      ...profile,
      stops: updatedStops.length > 0 ? updatedStops : [""],
    });
  }

  function moveStopField(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= profile.stops.length) {
      return;
    }

    const updatedStops = [...profile.stops];
    [updatedStops[index], updatedStops[nextIndex]] = [
      updatedStops[nextIndex],
      updatedStops[index],
    ];
    persistProfile({
      ...profile,
      stops: updatedStops,
    });
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
    setExpandedVersions({});
    setRequest("");
    setError("");
    setTripMapRevision(0);
    localStorage.removeItem("roadTripProfile");
  }

  function startNewTrip() {
    setResponse(null);
    setResponseHistory([]);
    setExpandedVersions({});
    setRequest("");
    setError("");
    setTripMapRevision(0);
  }

  function handleAddRoadsideOption(option) {
    if (!response) {
      return;
    }

    const nextTripStops = insertRoadsideStopIntoTrip(
      response.trip_stops ?? [],
      option,
      profile,
    );

    if (areTripStopsEqual(response.trip_stops ?? [], nextTripStops)) {
      return;
    }

    setResponse((current) =>
      current
        ? {
            ...current,
            trip_stops: nextTripStops,
          }
        : current,
    );

    setResponseHistory((previous) =>
      previous.map((entry, index) =>
        index === previous.length - 1
          ? {
              ...entry,
              response: {
                ...entry.response,
                trip_stops: nextTripStops,
              },
            }
          : entry,
      ),
    );

    persistProfile({
      ...profile,
      stops: mergeRoadsideStopIntoProfileStops(profile.stops, option),
    });
    setTripMapRevision((previous) => previous + 1);
  }

  function handleInteractiveRouteChange(nextRoute, nextTripStops) {
    setResponse((current) => {
      if (!current) {
        return current;
      }

      if (
        areRoutesEqual(current.route, nextRoute) &&
        areTripStopsEqual(current.trip_stops, nextTripStops)
      ) {
        return current;
      }

      return {
        ...current,
        route: nextRoute,
        trip_stops: nextTripStops,
      };
    });

    setResponseHistory((previous) => {
      if (!previous.length) {
        return previous;
      }

      const latestEntry = previous[previous.length - 1];
      if (
        areRoutesEqual(latestEntry.response.route, nextRoute) &&
        areTripStopsEqual(latestEntry.response.trip_stops, nextTripStops)
      ) {
        return previous;
      }

      return previous.map((entry, index) =>
        index === previous.length - 1
          ? {
              ...entry,
              response: {
                ...entry.response,
                route: nextRoute,
                trip_stops: nextTripStops,
              },
            }
          : entry,
      );
    });
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
            max_daily_driving_miles: profile.max_daily_driving_miles
              ? Number(profile.max_daily_driving_miles)
              : null,
            recommendation_radius_miles: profile.recommendation_radius_miles
              ? Number(profile.recommendation_radius_miles)
              : null,
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

      return await res.json();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
      setLoadingSeconds(0);
    }
  }

  async function handleTripRequestSubmit(event) {
    event?.preventDefault();

    const requestText = request.trim();
    const conversationHistory = responseHistory.length > 0 ? responseHistory : [];
    const data = await requestTripPlan(requestText, conversationHistory);
    if (!data) {
      return;
    }

    const nextEntry = {
      version: responseHistory.length + 1,
      request: requestText,
      response: data,
    };

    setResponse(data);
    setResponseHistory((previous) =>
      previous.length > 0 ? [...previous, nextEntry] : [nextEntry],
    );
    setExpandedVersions((previous) => ({
      ...previous,
      [nextEntry.version]: false,
    }));
    setRequest("");
  }

  function handleRequestInputChange(event) {
    setRequest(event.target.value);
    resizeRequestTextarea();
  }

  function handleRequestKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleTripRequestSubmit();
    }
  }

  function toggleVersion(version) {
    setExpandedVersions((previous) => ({
      ...previous,
      [version]: !previous[version],
    }));
  }

  function getSummaryPreview(summary) {
    const trimmed = (summary ?? "").trim();
    if (trimmed.length <= 220) {
      return trimmed;
    }
    return `${trimmed.slice(0, 220).trimEnd()}...`;
  }

  const tripMapKey = responseHistory.length
    ? `trip-map-${responseHistory[responseHistory.length - 1].version}-${tripMapRevision}`
    : "trip-map-empty";
  const hasResponse = responseHistory.length > 0;
  const requestCard = (
    <div className="card trip-request-card">
      <div className="trip-request-header">
        <div className="section-heading-block">
          <p className="section-kicker">{hasResponse ? "Refine" : "Prompt"}</p>
          <h2>{hasResponse ? "Follow-up Request" : "Trip Request"}</h2>
          <p className="helper-text">
            {hasResponse
              ? "Ask for changes to the current plan. The AI will use your profile and full conversation history."
              : "Describe the trip outcome you want. The AI will use your profile and route context."}
          </p>
        </div>

        {hasResponse && (
          <div className="trip-action-row trip-action-row--compact">
            <button
              type="button"
              className="secondary-button trip-action-button trip-action-button--compact"
              onClick={startNewTrip}
              disabled={loading}
            >
              Plan next trip
            </button>
          </div>
        )}
      </div>

      <label className="label">
        {hasResponse ? "What would you like to change?" : "What do you want help with?"}
      </label>
      <div className="request-composer">
        <textarea
          ref={requestTextareaRef}
          rows={1}
          className="textarea textarea--composer"
          value={request}
          onChange={handleRequestInputChange}
          onKeyDown={handleRequestKeyDown}
          placeholder={
            hasResponse
              ? "Ask for a shorter route, more detail, different stops, or a revised style..."
              : "Plan a road trip to Hershey that arrives on day 6 with good stops on the way..."
          }
        />
        <button
          type="button"
          className="button composer-submit-button"
          disabled={loading}
          onClick={handleTripRequestSubmit}
        >
          {loading
            ? hasResponse
              ? `Refining... ${loadingSeconds}s`
              : `Thinking... ${loadingSeconds}s`
            : hasResponse
              ? "Refine"
              : "Send"}
        </button>
      </div>

      <div className="composer-meta">
        <p className="char-count">Character count: {request.length}</p>
        {loading && (
          <p className="thinking-text">
            {hasResponse ? `Refining... ${loadingSeconds}s` : `Thinking... ${loadingSeconds}s`}
          </p>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  );

  return (
    <div className="page">
      <header className="hero">
        <p className="hero-eyebrow">AI-assisted routes</p>
        <h1 className="title">Road Trip Planner</h1>
        <p className="hero-subtitle">
          Build a trip, optimize the route, drag the path on the map, and refine the plan without
          leaving the same workspace.
        </p>
        <div className="hero-chip-row">
          <span className="hero-chip">Google Maps routing</span>
          <span className="hero-chip">Navigation optimization</span>
          <span className="hero-chip">Iterative AI planning</span>
        </div>
      </header>

      <div className="planner-layout">
        <div className="card profile-card">
          <h2>User Profile</h2>

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

          <label className="label">Max Daily Driving (miles)</label>
          <input
            className="input"
            type="number"
            min="1"
            name="max_daily_driving_miles"
            value={profile.max_daily_driving_miles}
            onChange={handleProfileChange}
            placeholder="e.g. 300"
          />

          <label className="label">Recommendation Radius (miles)</label>
          <input
            className="input"
            type="number"
            min="1"
            name="recommendation_radius_miles"
            value={profile.recommendation_radius_miles}
            onChange={handleProfileChange}
            placeholder="e.g. 25"
          />

          <label className="label">Stops (Optional)</label>
          <p className="helper-text">
            Add, remove, and reorder as many intermediate stops as you want.
          </p>
          <div className="stop-list">
            {profile.stops.map((stop, index) => (
              <div key={`profile-stop-${index}`} className="stop-row">
                <div className="stop-row-input">
                  <LocationAutocompleteInput
                    value={stop}
                    onChange={(value) => handleStopChange(index, value)}
                    placeholder={`Stop ${index + 1}`}
                  />
                </div>

                <div className="stop-row-actions">
                  <button
                    type="button"
                    className="route-move-button"
                    onClick={() => moveStopField(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move stop ${index + 1} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="route-move-button"
                    onClick={() => moveStopField(index, 1)}
                    disabled={index === profile.stops.length - 1}
                    aria-label={`Move stop ${index + 1} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="stop-delete-button"
                    onClick={() => removeStopField(index)}
                    aria-label={`Remove stop ${index + 1}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={addStopField}
          >
            Add another stop
          </button>

          <button type="button" className="clear-button" onClick={clearProfile}>
            Clear profile
          </button>
        </div>

        <div className="content-column">
          <TripMap
            key={tripMapKey}
            route={response?.route ?? null}
            tripStops={response?.trip_stops ?? []}
            startLocation={profile.start_location}
            onUseCurrentLocation={handleUseCurrentLocation}
            onRouteChange={handleInteractiveRouteChange}
            loading={loading}
            profile={profile}
          />
          {!hasResponse && requestCard}
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
                <div className="thread-header-meta">
                  {entry.response.route && (
                    <div className="thread-stats-row">
                      <span className="thread-stat-pill">
                        {formatMiles(entry.response.route.total_distance_km)}
                      </span>
                      <span className="thread-stat-pill">
                        {formatDuration(entry.response.route.total_duration_minutes)}
                      </span>
                    </div>
                  )}
                  <span className="thread-stop-count-pill">
                    {entry.response.trip_stops.length} stops
                  </span>
                  <button
                    type="button"
                    className="thread-toggle-button"
                    onClick={() => toggleVersion(entry.version)}
                  >
                    {expandedVersions[entry.version] ? "Hide details" : "Show details"}
                  </button>
                </div>
              </div>

              <div className="thread-summary-strip">
                <p className="thread-request-label">
                  {entry.version === 1 ? "Original Request" : "Follow-up Request"}
                </p>
                <p className="thread-request-text">{entry.request}</p>
                <p className="thread-summary-preview">{getSummaryPreview(entry.response.summary)}</p>
              </div>

              {expandedVersions[entry.version] && (
                <div className="result-card">
                  <h3 className="result-card-title">Trip Overview</h3>

                  <p className="overview-copy">{entry.response.summary}</p>

                  <div className="overview-section">
                    <p className="overview-section-kicker">Recommendations</p>
                    <ul className="rec-list">
                      {entry.response.recommendations.map((item, index) => (
                        <li key={index} className="rec-item">
                          <span className="rec-arrow">&#8594;</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="overview-section budget-section">
                    <p className="overview-section-kicker">Budget Notes</p>
                    <p className="overview-copy">{entry.response.budget_notes}</p>
                  </div>

                  {entry.response.roadside_options?.length > 0 && (
                    <div className="overview-section">
                      <p className="overview-section-kicker">Cool Roadside Options</p>
                      <ul className="roadside-option-list">
                        {entry.response.roadside_options.map((option, index) => {
                          const isAdded = entry.response.trip_stops.some(
                            (stop) =>
                              normalizeLocation(stop.location) ===
                              normalizeLocation(option.location),
                          );
                          return (
                            <li key={`${option.name}-${index}`} className="roadside-option-item">
                              <div className="roadside-option-copy">
                                <div className="roadside-option-header">
                                  <span className="roadside-option-name">{option.name}</span>
                                  <span className="option-category-badge">{option.category}</span>
                                </div>
                                <p className="roadside-option-location">{option.location}</p>
                                <p className="roadside-option-reason">{option.reason}</p>
                              </div>
                              {entry.version === responseHistory.length && (
                                <button
                                  type="button"
                                  className={`roadside-add-button${isAdded ? " roadside-add-button--added" : ""}`}
                                  onClick={() => handleAddRoadsideOption(option)}
                                  disabled={isAdded}
                                >
                                  {isAdded ? "✓ Added" : "Add to route"}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {entry.response.tool_calling_used &&
                    entry.response.tool_calling_summary && (
                      <div className="tooling-box">
                        <p className="tooling-box-label">Route & Data Tools Used</p>
                        <p className="tooling-box-text">{entry.response.tool_calling_summary}</p>
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
              )}
            </article>
          ))}
        </section>
      )}

      {hasResponse && requestCard}
    </div>
  );
}

export default App;
