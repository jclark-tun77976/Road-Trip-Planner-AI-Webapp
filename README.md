# AI Road Trip Planner

A personalized, mapped, multi-day road trip planner that turns a structured user
profile and a free-text request into a real, geocoded itinerary you can open in
Google Maps and refine iteratively.

## Team members

- Justin Clark

## Chosen domain

**Travel planning / road trip itinerary generation.** The user persona is a
road tripper who knows their start and destination but does not want to manually
stitch together stops, drive times, and interest-matched detours from a dozen
browser tabs. The app combines an LLM's reasoning with real Google Maps route
data to produce a plan that is both opinionated and grounded.

---

## Architecture overview

Three layers, two external services, one LLM.

```
┌────────────────────────┐        POST /api/plan         ┌────────────────────────────┐
│  Frontend (React/Vite) │ ────────────────────────────▶ │  Backend (FastAPI)         │
│  port 5173             │                               │  port 8000                 │
│                        │ ◀──── TripResponse JSON ───── │  app/routes/plan.py        │
└────────────────────────┘                               └─────────────┬──────────────┘
        ▲                                                              │
        │ Google Maps JS SDK                                           │
        │ (autocomplete, map render)                                   ▼
        │                                                ┌────────────────────────────┐
        │                                                │  Prompt builder            │
        │                                                │  (system + profile +       │
        │                                                │   conversation history)    │
        │                                                └─────────────┬──────────────┘
        │                                                              │
        │                                                              ▼
        │                                                ┌────────────────────────────┐
        │                                                │  Gemini 2.5 Flash          │
        │                                                │  Pass 1: tool-calling      │
        │                                                │   ├─ get_route_context     │ ──▶ Google Maps Routes API
        │                                                │   └─ get_roadside_options  │ ──▶ Google Places API
        │                                                │  Pass 2: structured JSON   │
        │                                                │   (response_schema)        │
        │                                                └─────────────┬──────────────┘
        │                                                              │
        │                                                              ▼
        │                                                ┌────────────────────────────┐
        │                                                │  Post-processing           │
        │                                                │  - geocode every stop      │
        │                                                │  - build real route        │
        │                                                │  - promote interest- and   │
        │                                                │    "stops on the way"-     │
        │                                                │    aligned detours         │
        └────────────────────────────────────────────────┴────────────────────────────┘
```

### Data flow, end to end

1. **Profile + request submitted.** The React frontend
   ([`frontend/src/App.jsx`](frontend/src/App.jsx)) collects start, destination,
   trip length, vehicle, EV flag, travel style, interests, daily mileage cap,
   and recommendation radius, plus a free-text request. It POSTs the payload
   (including any prior turns as `conversation_history`) to `/api/plan`.
2. **Prompt assembled.**
   [`backend/app/services/prompt_services.py`](backend/app/services/prompt_services.py)
   builds a system prompt (role + interest-personalization rules), injects the
   profile as bullet points, formats prior conversation turns, and appends a
   strict JSON output contract.
3. **Tool-calling pass.**
   [`backend/app/services/llm_services.py`](backend/app/services/llm_services.py)
   registers two Python tools (`get_route_context`, `get_roadside_options`) and
   lets Gemini decide whether to call them. The tools wrap the Google Maps
   Routes and Places APIs in
   [`backend/app/services/mapping_services.py`](backend/app/services/mapping_services.py).
4. **Structured-output pass.** Tool results are injected back into the prompt,
   and Gemini is called again with `response_mime_type="application/json"` and
   a `response_schema` that pins the output shape.
5. **Post-processing.** Every stop is geocoded, a real Google Maps route is
   built, and the backend promotes interest-aligned or "stops on the way"
   detours when the model missed them.
6. **Response rendered.** The frontend renders a summary card, an
   [`ItineraryPanel`](frontend/src/components/ItineraryPanel.jsx) (day-by-day
   stops + route legs), an interactive
   [`TripMap`](frontend/src/components/TripMap.jsx), and an
   _"Open in Google Maps"_ button so the user can save the route to their
   Google account.
7. **Iterative refinement.** Subsequent requests are sent with the prior turns
   as `conversation_history`. The system prompt instructs the model to treat
   them as refinements of the existing plan rather than from-scratch rewrites.

---

## Setup instructions

### Prerequisites

- **Node.js** 18+ and **npm**
- **Python** 3.11+
- A **Google Gemini API key** (`GEMINI_API_KEY`)
- A **Google Maps Platform API key** (`GOOGLE_MAPS_API_KEY`) with the following
  APIs enabled:
  - Maps JavaScript API
  - Routes API
  - Places API
  - Geocoding API

### 1. Clone and install root tooling

```bash
git clone <your-repo-url>
cd AI_roadtripApp
npm install
```

### 2. Backend setup (FastAPI)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env` with your keys (see the **Environment variables** section
below). **Never commit this file** — it is already listed in
[`.gitignore`](.gitignore).

### 3. Frontend setup (React + Vite)

```bash
cd ../frontend
npm install
```

Create `frontend/.env` with your public Google Maps key (also covered below).

### 4. Run locally

You have two options.

**Option A — one command from the project root** (uses
[`concurrently`](https://www.npmjs.com/package/concurrently) to start both
servers):

```bash
npm run dev
```

**Option B — two terminals:**

```bash
# Terminal 1: backend on http://127.0.0.1:8000
cd backend
source venv/bin/activate
uvicorn app.main:app --reload
```

```bash
# Terminal 2: frontend on http://localhost:5173
cd frontend
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

You can verify the backend sees your keys by visiting
[http://127.0.0.1:8000/api/debug/keys](http://127.0.0.1:8000/api/debug/keys) —
it returns presence flags and the last four characters only, never the full
key.

---

## Environment variables

**API keys must live in `.env` files and must never be committed.** The repo's
[`.gitignore`](.gitignore) already excludes `backend/.env`, `frontend/.env`,
and the common `.env.local` variants. Confirm with `git status` before any
commit that mentions these files.

### `backend/.env`

```
GEMINI_API_KEY=your_google_gemini_api_key_here
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

| Variable              | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `GEMINI_API_KEY`      | Authenticates calls to the Gemini 2.5 Flash model via `google-genai`.   |
| `GOOGLE_MAPS_API_KEY` | Server-side key used for the Routes, Places, and Geocoding API calls.  |

> `GOOGLE_API_KEY` is accepted as a fallback alias for `GEMINI_API_KEY`; see
> [`backend/app/services/model_registry.py`](backend/app/services/model_registry.py).

### `frontend/.env`

```
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

| Variable                   | Purpose                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `VITE_GOOGLE_MAPS_API_KEY` | Loaded by the Maps JavaScript API for in-browser autocomplete and map rendering. **Restrict by HTTP referrer in the Google Cloud console.** |
| `VITE_API_BASE_URL`        | Optional. Overrides the backend URL (default `http://127.0.0.1:8000`).                                 |

### Key-handling rules

- **Never paste keys into source files, commits, screenshots, or chat logs.**
- The frontend key is shipped to the browser by design — protect it with an
  HTTP-referrer restriction and an API-surface restriction in the Google Cloud
  console.
- The backend key is server-only — restrict it by IP where practical.
- Rotate any key that has ever been committed, even briefly.

---

## Project layout

```
AI_roadtripApp/
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI entry point + CORS
│   │   ├── routes/plan.py          # POST /api/plan
│   │   ├── models/trip_models.py   # Pydantic request/response models
│   │   └── services/
│   │       ├── llm_services.py     # Gemini orchestration + tool calling
│   │       ├── prompt_services.py  # System + user prompt construction
│   │       ├── mapping_services.py # Google Maps Routes/Places/Geocoding
│   │       ├── model_registry.py   # Active LLM config
│   │       └── trip_parser.py      # JSON validation + fallback plan
│   ├── requirements.txt
│   └── .env                        # gitignored
├── frontend/
│   ├── src/
│   │   ├── App.jsx                 # Profile form + request flow
│   │   └── components/
│   │       ├── ItineraryPanel.jsx
│   │       ├── TripMap.jsx
│   │       └── LocationAutocompleteInput.jsx
│   ├── package.json
│   └── .env                        # gitignored
├── package.json                    # root: concurrent dev script
└── README.md
```

---

## Tech stack

- **Frontend:** React 19, Vite, Google Maps JavaScript API
- **Backend:** FastAPI, Pydantic v2, `google-genai` SDK, `python-dotenv`
- **LLM:** Google Gemini 2.5 Flash (tool calling + structured output)
- **External APIs:** Google Maps Routes, Places, and Geocoding
