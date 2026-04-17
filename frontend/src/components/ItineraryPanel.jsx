function ItineraryPanel({ response }) {
  return (
    <div className="result-card itinerary-card">
      <div className="section-header">
        <h3>Itinerary</h3>
        <p>{response.trip_stops.length} planned stops</p>
      </div>

      {response.trip_stops.length > 0 ? (
        <div className="itinerary-list">
          {response.trip_stops.map((stop) => (
            <div key={`${stop.order}-${stop.location}`} className="itinerary-item">
              <div className="itinerary-day">Day {stop.day}</div>
              <div className="itinerary-content">
                <h4>
                  {stop.order}. {stop.name}
                </h4>
                <p className="muted-text">{stop.location}</p>
                <p>{stop.reason}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="status-message">No structured stops were returned.</p>
      )}

      <div className="section-divider" />

      <div className="section-header">
        <h3>Route Legs</h3>
        {response.route && (
          <p>
            {response.route.total_distance_km} km • {response.route.total_duration_minutes} min
          </p>
        )}
      </div>

      {response.route?.legs?.length ? (
        <div className="legs-list">
          {response.route.legs.map((leg) => (
            <div key={leg.order} className="leg-item">
              <h4>
                Leg {leg.order}: {leg.from_name} to {leg.to_name}
              </h4>
              <p className="muted-text">
                {leg.distance_km} km • {leg.duration_minutes} min
              </p>
              <p>
                {leg.from_location} → {leg.to_location}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="status-message">Route legs are not available yet.</p>
      )}
    </div>
  );
}


export default ItineraryPanel;
