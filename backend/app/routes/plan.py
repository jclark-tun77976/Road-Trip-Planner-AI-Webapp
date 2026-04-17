from fastapi import APIRouter

from app.models.trip_models import TripRequest

router = APIRouter()


@router.post("/plan")
def create_plan(data: TripRequest):
    return {
        "message": "Dummy response from FastAPI",
        "profile": data.profile.model_dump(),
        "request": data.request,
        "result": {
            "summary": f"{data.profile.name} wants a road trip plan with a budget of {data.profile.budget}.",
            "recommendations": [
                "Choose scenic stops based on your preferences.",
                "Set a daily spending limit for food and hotels.",
                "Plan around your main trip goals.",
            ],
        },
    }