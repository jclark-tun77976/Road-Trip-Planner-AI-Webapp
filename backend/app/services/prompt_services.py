from app.models.trip_models import Profile


SYSTEM_PROMPT_TEMPLATE = """You are an AI road trip planner.
You help users plan practical and personalized road trips.
Use the user's profile to shape your recommendations.
Keep the response clear, organized, and student-project appropriate.
Build an ordered itinerary that can be mapped.
Each trip stop should use a real, specific location string that can be geocoded.
Include the final destination as the last trip stop.
"""


def build_system_prompt(profile: Profile) -> str:
    stops_text = ", ".join(profile.stops) if profile.stops else "No preferred stops provided"
    ev_text = "Yes" if profile.is_ev else "No"
    public_water_text = "Yes" if profile.needs_public_water else "No"
    round_trip_text = "Yes" if profile.is_round_trip else "No"

    return f"""{SYSTEM_PROMPT_TEMPLATE}

User profile:
- Name: {profile.name}
- Starting location: {profile.start_location}
- Destination: {profile.destination}
- Trip length: {profile.trip_length_value} {profile.trip_length_unit}
- Round trip: {round_trip_text}
- Vehicle type: {profile.vehicle_type}
- EV vehicle: {ev_text}
- Needs access to public water: {public_water_text}
- Budget: {profile.budget}
- Travel style: {profile.travel_style}
- Interests: {profile.interests}
- Preferred stops: {stops_text}
"""


def build_user_prompt(request: str) -> str:
    return f"""Trip planning request:
{request}

Return valid JSON with exactly these top-level keys:
- summary
- recommendations
- budget_notes
- trip_stops

Do not add markdown fences.
Do not add explanation before or after the JSON.
Use snake_case keys exactly as written.

Tool use:
- You have access to a tool named get_route_context.
- Use get_route_context when you need accurate route distance, duration, or leg order grounded in Google Maps data.
- For road trip planning requests, you should usually call it once after selecting the ordered stop locations.
- Use the tool result to improve summary, recommendation, and budget guidance with realistic travel context.

Rules:
- summary: one short paragraph string
- recommendations: array of 3 short strings
- budget_notes: one short paragraph string
- trip_stops: ordered array of stop objects
- each trip_stops item must contain:
  - day
  - order
  - name
  - location
  - reason
- location must be a real-world place string suitable for Google Maps geocoding
- order should increase from the start of the trip to the final destination
- if Round trip is Yes, include the starting location again as the final stop
- if Round trip is No, include the destination as the last stop
"""


def build_full_prompt(profile: Profile, request: str) -> str:
    system_prompt = build_system_prompt(profile)
    user_prompt = build_user_prompt(request)
    return f"""{system_prompt}

{user_prompt}"""
