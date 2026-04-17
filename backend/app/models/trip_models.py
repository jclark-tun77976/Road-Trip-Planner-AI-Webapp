from pydantic import BaseModel


class Profile(BaseModel):
    name: str
    preferences: str
    goals: str
    budget: str


class TripRequest(BaseModel):
    profile: Profile
    request: str
