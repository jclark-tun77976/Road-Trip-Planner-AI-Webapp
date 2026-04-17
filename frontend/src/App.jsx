import { useState } from "react";
import "./App.css";

function App() {
  const [profile, setProfile] = useState({
    name: "",
    preferences: "",
    goals: "",
    budget: "",
  });

  const [request, setRequest] = useState("");
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function handleProfileChange(event) {
    const { name, value } = event.target;
    setProfile({
      ...profile,
      [name]: value,
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("http://127.0.0.1:8000/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile,
          request,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to get response from backend");
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

          <label className="label">Preferences</label>
          <input
            className="input"
            type="text"
            name="preferences"
            value={profile.preferences}
            onChange={handleProfileChange}
            placeholder="Scenic, cheap, family-friendly..."
          />

          <label className="label">Goals</label>
          <input
            className="input"
            type="text"
            name="goals"
            value={profile.goals}
            onChange={handleProfileChange}
            placeholder="Relaxing trip, sightseeing, food..."
          />

          <label className="label">Budget</label>
          <input
            className="input"
            type="text"
            name="budget"
            value={profile.budget}
            onChange={handleProfileChange}
            placeholder="$1000"
          />
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
                <p>{response.result.summary}</p>
                <ul>
                  {response.result.recommendations.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

export default App;