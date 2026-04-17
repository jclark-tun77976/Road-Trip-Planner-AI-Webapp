from fastapi import APIRouter, HTTPException

from app.models.trip_models import TripRequest, TripResponse
from app.services.llm_services import generate_trip_plan

router = APIRouter()


@router.post("/plan", response_model=TripResponse)
def create_plan(data: TripRequest):
    try:
        return generate_trip_plan(data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))