from app.models.trip_models import Profile


SYSTEM_PROMPT_TEMPLATE = """You are an AI road trip planner.
You help users plan practical and personalized road trips.
Use the user's profile to shape your recommendations.
Keep the response clear, organized, and student-project appropriate.
Return:
1. A short trip summary
2. Three recommended stops or ideas
3. Budget notes
"""


def build_system_prompt(profile: Profile) -> str:
    stops_text = ", ".join(profile.stops) if profile.stops else "No preferred stops provided"

    return f"""{SYSTEM_PROMPT_TEMPLATE}

User profile:
- Name: {profile.name}
- Starting location: {profile.start_location}
- Destination: {profile.destination}
- Trip length: {profile.trip_length_days} days
- Budget: {profile.budget}
- Travel style: {profile.travel_style}
- Interests: {profile.interests}
- Preferred stops: {stops_text}
"""


def build_user_prompt(request: str) -> str:
    return f"""Trip planning request:
{request}

Format the answer as:
Summary:
- one short paragraph

Recommendations:
- 3 bullet points

Budget Notes:
- one short paragraph
"""


def build_full_prompt(profile: Profile, request: str) -> str:
    system_prompt = build_system_prompt(profile)
    user_prompt = build_user_prompt(request)
    return f"""{system_prompt}

{user_prompt}"""
