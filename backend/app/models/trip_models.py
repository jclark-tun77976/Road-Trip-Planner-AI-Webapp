from pydantic import BaseModel, Field


class Profile(BaseModel):
    name: str
    start_location: str
    destination: str
    trip_length_value: int
    trip_length_unit: str = "days"
    is_round_trip: bool = False
    vehicle_type: str
    is_ev: bool = False
    needs_public_water: bool = False
    budget: str
    travel_style: str
    interests: str
    stops: list[str] = Field(default_factory=list)


class TripRequest(BaseModel):
    profile: Profile
    request: str


class Coordinate(BaseModel):
    latitude: float
    longitude: float


class TripStop(BaseModel):
    day: int = Field(ge=1)
    order: int = Field(ge=1)
    name: str
    location: str
    reason: str
    latitude: float | None = None
    longitude: float | None = None


class RouteWaypoint(BaseModel):
    order: int = Field(ge=1)
    name: str
    location: str
    kind: str
    latitude: float
    longitude: float


class RouteLeg(BaseModel):
    order: int = Field(ge=1)
    from_name: str
    from_location: str
    to_name: str
    to_location: str
    distance_km: float
    duration_minutes: float


class RouteData(BaseModel):
    total_distance_km: float
    total_duration_minutes: float
    legs: list[RouteLeg] = Field(default_factory=list)
    geometry: list[Coordinate] = Field(default_factory=list)
    waypoints: list[RouteWaypoint] = Field(default_factory=list)


class GeneratedTripPlan(BaseModel):
    summary: str
    recommendations: list[str] = Field(default_factory=list)
    budget_notes: str
    trip_stops: list[TripStop] = Field(default_factory=list)


class TripResponse(GeneratedTripPlan):
    route: RouteData | None = None
    warnings: list[str] = Field(default_factory=list)
    tool_calling_used: bool = False
    tool_calling_summary: str = ""
    prompt_used: str
