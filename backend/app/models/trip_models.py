from pydantic import BaseModel, Field


class Profile(BaseModel):
    name: str
    start_location: str
    destination: str
    trip_length_days: int
    budget: str
    travel_style: str
    interests: str
    stops: list[str] = Field(default_factory=list)


class TripRequest(BaseModel):
    profile: Profile
    request: str


class TripResponse(BaseModel):
    summary: str
    recommendations: list[str]
    budget_notes: str
    prompt_used: str
