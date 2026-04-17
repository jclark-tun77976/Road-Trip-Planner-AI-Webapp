import { useEffect, useState } from "react";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

const INITIAL_PROFILE = {
  name: "",
  start_location: "",
  destination: "",
  trip_length_days: "",
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
        trip_length_days: parsedProfile.trip_length_days ?? "",
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

  function handleProfileChange(event) {
    const { name, value } = event.target;
    const updatedProfile = {
      ...profile,
      [name]: value,
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
            trip_length_days: Number(profile.trip_length_days),
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

          <label className="label">Trip Length (Days)</label>
          <input
            className="input"
            type="number"
            name="trip_length_days"
            value={profile.trip_length_days}
            onChange={handleProfileChange}
            placeholder="4"
          />

          <label className="label">Destination</label>
          <input
            className="input"
            type="text"
            name="destination"
            value={profile.destination}
            onChange={handleProfileChange}
            placeholder="Pittsburgh"
          />

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

          <button type="submit" className="button" disabled={loading}>
            {loading ? "Loading..." : "Submit"}
          </button>

          <div className="preview-box">
            <h3>Current Request</h3>
            <p>{request || "Your trip request will appear here."}</p>

            {error && <p>{error}</p>}

            {response && (
              <div>
                <h3>AI Response</h3>
                <p>{response.summary}</p>

                <h4>Recommendations</h4>
                <ul>
                  {response.recommendations.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>

                <h4>Budget Notes</h4>
                <p>{response.budget_notes}</p>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

export default App;
