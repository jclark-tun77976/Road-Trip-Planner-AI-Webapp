from app.models.trip_models import ConversationTurn, Profile


SYSTEM_PROMPT_TEMPLATE = """You are an AI road trip planner.
You help users plan practical and personalized road trips.
Use the user's profile to shape your recommendations.
Keep the response clear, organized, and student-project appropriate.
Build an ordered itinerary that can be mapped.
Each trip stop should use a real, specific location string that can be geocoded.
Include the final destination as the last trip stop.
When a user asks for a refinement, update the previous plan coherently instead of ignoring prior context.
"""


def build_system_prompt(profile: Profile) -> str:
    stops_text = ", ".join(profile.stops) if profile.stops else "No preferred stops provided"
    ev_text = "Yes" if profile.is_ev else "No"
    public_water_text = "Yes" if profile.needs_public_water else "No"
    round_trip_text = "Yes" if profile.is_round_trip else "No"
    travel_style_text = profile.travel_style.strip()

    profile_lines = [
        f"- Name: {profile.name}",
        f"- Starting location: {profile.start_location}",
        f"- Destination: {profile.destination}",
        f"- Trip length: {profile.trip_length_value} {profile.trip_length_unit}",
        f"- Round trip: {round_trip_text}",
        f"- Vehicle type: {profile.vehicle_type}",
        f"- EV vehicle: {ev_text}",
        f"- Needs access to public water: {public_water_text}",
    ]

    if travel_style_text and travel_style_text.lower() != "none":
        profile_lines.append(f"- Travel style: {travel_style_text}")

    profile_lines.extend(
        [
            f"- Interests: {profile.interests}",
            f"- Preferred stops: {stops_text}",
        ]
    )

    if profile.max_daily_driving_miles:
        profile_lines.append(
            f"- Max daily driving: {profile.max_daily_driving_miles} miles per day — do not plan more than this per day"
        )

    if profile.recommendation_radius_miles:
        profile_lines.append(
            f"- Recommendation radius: only suggest roadside options within {profile.recommendation_radius_miles} miles of the planned route"
        )

    return f"""{SYSTEM_PROMPT_TEMPLATE}

User profile:
{chr(10).join(profile_lines)}
"""


def _format_conversation_history(conversation_history: list[ConversationTurn]) -> str:
    if not conversation_history:
        return "No prior conversation history."

    turns: list[str] = []

    for turn in conversation_history:
        recommendations = (
            "\n".join(f"  - {item}" for item in turn.recommendations)
            if turn.recommendations
            else "  - None recorded"
        )
        trip_stops = (
            "\n".join(
                f"  - Day {stop.day}, stop {stop.order}: {stop.name} ({stop.location}) - {stop.reason}"
                for stop in turn.trip_stops
            )
            if turn.trip_stops
            else "  - No structured stops returned"
        )
        roadside_options = (
            "\n".join(
                f"  - {option.name} ({option.location}) [{option.category}] - {option.reason}"
                for option in turn.roadside_options
            )
            if turn.roadside_options
            else "  - No roadside options returned"
        )

        turns.append(
            f"""Version {turn.version}
User request:
{turn.request}

AI response summary:
{turn.summary}

AI recommendations:
{recommendations}

AI budget notes:
{turn.budget_notes}

AI trip stops:
{trip_stops}

AI roadside options:
{roadside_options}"""
        )

    return "\n\n".join(turns)


def _build_constraint_block(profile: Profile) -> str:
    constraints: list[str] = []
    if profile.max_daily_driving_miles:
        constraints.append(
            f"- Never plan more than {profile.max_daily_driving_miles} miles of driving per day."
        )
    if profile.recommendation_radius_miles:
        constraints.append(
            f"- Only suggest roadside_options within {profile.recommendation_radius_miles} miles of the planned route."
        )
    if not constraints:
        return ""
    return "\nHard constraints from user profile:\n" + "\n".join(constraints) + "\n"


def build_user_prompt(request: str, conversation_history: list[ConversationTurn] | None = None, profile: Profile | None = None) -> str:
    history_text = _format_conversation_history(conversation_history or [])
    constraint_block = _build_constraint_block(profile) if profile else ""

    return f"""Previous conversation history:
{history_text}

Latest user request:
{request}

{constraint_block}
If previous conversation history exists, treat the latest user request as a refinement of the existing trip unless the user explicitly asks to start over.
Keep useful prior decisions that still fit the user's newest direction.
Revise summary, recommendations, budget notes, and trip stops so they reflect the latest request.
If useful, include optional roadside attraction ideas that fit the route.

Return valid JSON with exactly these top-level keys:
- summary
- recommendations
- budget_notes
- trip_stops
- roadside_options

Do not add markdown fences.
Do not add explanation before or after the JSON.
Use snake_case keys exactly as written.

Tool use:
- You have access to a tool named get_route_context.
- You have access to a tool named get_roadside_options.
- Use get_route_context when you need accurate route distance, duration, or leg order grounded in Google Maps data.
- The route tool can also return a Google-optimized stop order when multiple stops are present.
- For road trip planning requests, you should usually call it once after selecting the ordered stop locations.
- Use get_roadside_options when you want interesting optional attractions or oddities near the route.
- For road trip planning requests, you should usually call get_roadside_options once after the ordered stop locations are selected.
- Use the tool result to improve summary, recommendation, and budget guidance with realistic travel context.

Rules:
- summary: one short paragraph string
- recommendations: array of 3 short strings
- budget_notes: one short paragraph string
- trip_stops: ordered array of stop objects
- roadside_options: array of 0 to 5 optional attraction objects
- each trip_stops item must contain:
  - day
  - order
  - name
  - location
  - reason
- each roadside_options item must contain:
  - name
  - location
  - category
  - reason
- location must be a real-world place string suitable for Google Maps geocoding
- order should increase from the start of the trip to the final destination
- always include the profile destination somewhere in the ordered trip_stops
- if Round trip is Yes, include the destination before returning to the starting location, and include the starting location again as the final stop
- if Round trip is No, include the destination as the last stop
"""


def build_full_prompt(
    profile: Profile,
    request: str,
    conversation_history: list[ConversationTurn] | None = None,
) -> str:
    system_prompt = build_system_prompt(profile)
    user_prompt = build_user_prompt(request, conversation_history, profile)
    return f"""{system_prompt}

{user_prompt}"""
