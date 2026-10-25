# Native CAD

A simple AI-assisted CAD tool. You type a request, an AI agent turns it into CAD commands, and the result is exported as STEP, STL, DXF, or PDF and shown in a 3D viewer.

This project is part of the Optiprime website: <https://optiprime.appz.se/>

## Structure

```
native-cad/
|-- backend/     FastAPI server, AI agent, MCP client, export files
`-- frontend/     Plain HTML/CSS/JS page with a Three.js 3D viewer
```

## Requirements

- Python 3.10+
- An API key for the AI model (MiniMax)
- Node.js is not required

## Setup

```bash
cd backend
pip install -r requirements.txt
```

Create `backend/.env`:

```
MINIMAX_API_KEY=your_api_key_here
MINIMAX_BASE_URL=https://api.minimax.io/v1
MINIMAX_MODEL=MiniMax-M3.1-Flash-Preview
HOST=0.0.0.0
PORT=8000
```

## Run

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open `frontend/index.html` in a browser, or serve the frontend folder with any static file server.

## Main files

| File | Purpose |
| --- | --- |
| `backend/main.py` | API routes, login, export endpoints |
| `backend/agent.py` | AI agent that builds CAD operations |
| `backend/mcp_client.py` | Client for the CAD MCP server |
| `backend/config.py` | Loads settings from `.env` |
| `backend/exports/` | Generated STEP/STL/DXF/PDF files |
| `frontend/index.html` | Web UI |
| `frontend/app.js` | Viewer and API calls |
| `frontend/libs/` | Three.js and loaders |

## Notes

- Do not commit `backend/.env`. It holds the API key.
- The `backend/tmp/` folder contains temporary reproducibility data and can be deleted.
- Exported files in `backend/exports/` are sample output, not required to run the app.
