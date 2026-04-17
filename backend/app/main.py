from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.plan import router as plan_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"message": "FastAPI backend is running"}


app.include_router(plan_router)