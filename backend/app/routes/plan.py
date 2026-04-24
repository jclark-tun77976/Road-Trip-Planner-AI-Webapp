import os

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException

from app.models.trip_models import TripRequest, TripResponse
from app.services.llm_services import generate_trip_plan

router = APIRouter()
load_dotenv()


@router.post("/plan", response_model=TripResponse)
def create_plan(data: TripRequest):
    try:
        return generate_trip_plan(data)
    except ValueError as exc:
        # Configuration / validation problems surface as readable 400s so the
        # frontend can show a specific message instead of a generic failure.
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"The trip planner hit an unexpected error: {exc}",
        )


@router.get("/debug/keys")
def debug_keys():
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    google_maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "")

    return {
        "gemini_present": bool(gemini_key),
        "gemini_suffix": gemini_key[-4:] if gemini_key else "",
        "google_maps_present": bool(google_maps_key),
        "google_maps_suffix": google_maps_key[-4:] if google_maps_key else "",
    }
