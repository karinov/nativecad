import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from config import (
    MINIMAX_API_KEY,
    MINIMAX_BASE_URL,
    MINIMAX_MODEL,
    EXPORT_DIR,
    HOST,
    PORT,
    update_minimax_api_key
)
from mcp_client import NativeCADManager
from agent import CADAgent

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("nativecad.app")

start_time = time.time()

# --- Auth Configuration ---
JWT_SECRET = "nativecad-mcp-challenge-driven-jwt-secret-key-2026"
JWT_ALGORITHM = "HS256"
ADMIN_USER = "admin"
ADMIN_PASS = "challengedriven"

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(days=7))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("sub") != ADMIN_USER:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")
        return payload
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

async def get_current_user(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    actual_token = None
    if authorization and authorization.startswith("Bearer "):
        actual_token = authorization.split(" ")[1]
    elif token:
        actual_token = token

    if not actual_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return verify_token(actual_token)

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting NativeCAD MCP backend service...")
    mcp_manager = NativeCADManager.get_instance()
    try:
        await mcp_manager.connect()
        logger.info("NativeCAD MCP connection ready on startup.")
    except Exception as e:
        logger.error(f"Failed to connect to NativeCAD MCP during startup: {e}")
    yield
    logger.info("Shutting down NativeCAD MCP backend service...")
    try:
        await mcp_manager.disconnect()
    except Exception as e:
        logger.warning(f"Error during shutdown disconnect: {e}")

app = FastAPI(
    title="NativeCAD AI Backend",
    description="FastAPI bridge between MiniMax LLM and NativeCAD solid-modelling MCP kernel",
    version="0.19.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic Request Models ---
class LoginRequest(BaseModel):
    username: str
    password: str

class ChatRequest(BaseModel):
    message: str = Field(..., description="Prompt or CAD design instruction")
    history: Optional[List[Dict[str, Any]]] = Field(default=None, description="Previous conversation turns")
    api_key: Optional[str] = Field(default=None, description="Optional MiniMax API Key override")

class DirectToolCallRequest(BaseModel):
    tool_name: str = Field(..., description="Name of the NativeCAD tool (e.g. cad_box)")
    arguments: Dict[str, Any] = Field(default_factory=dict, description="Parameters matching tool schema")

class ApiKeyUpdateRequest(BaseModel):
    api_key: str = Field(..., min_length=1, description="MiniMax API Key")

# --- Auth Routes ---

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    if req.username == ADMIN_USER and req.password == ADMIN_PASS:
        access_token = create_access_token(data={"sub": ADMIN_USER})
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "username": ADMIN_USER,
            "message": "Login berhasil"
        }
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Username atau password salah")

@app.get("/api/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    return {"username": user.get("sub"), "status": "authenticated"}

# --- General & Status Routes ---

@app.get("/")
@app.get("/health")
@app.get("/api/health")
async def health_check():
    mcp_manager = NativeCADManager.get_instance()
    return {
        "status": "online",
        "service": "nativecad-backend",
        "mcp_connected": mcp_manager.is_connected,
        "uptime_seconds": round(time.time() - start_time, 2)
    }

@app.get("/api/status")
async def get_system_status():
    mcp_manager = NativeCADManager.get_instance()
    has_key = bool(MINIMAX_API_KEY and len(MINIMAX_API_KEY.strip()) > 5)
    masked_key = ""
    if has_key:
        k = MINIMAX_API_KEY.strip()
        masked_key = f"{k[:6]}...{k[-4:]}" if len(k) > 10 else "***"

    tools = []
    if mcp_manager.is_connected:
        try:
            tools = await mcp_manager.get_raw_tools()
        except Exception:
            pass

    return {
        "mcp": {
            "connected": mcp_manager.is_connected,
            "tool_count": len(tools),
        },
        "minimax": {
            "model": MINIMAX_MODEL,
            "base_url": MINIMAX_BASE_URL,
            "is_configured": has_key,
            "masked_key": masked_key
        },
        "exports_dir": str(EXPORT_DIR)
    }

@app.get("/api/tools")
async def list_tools():
    mcp_manager = NativeCADManager.get_instance()
    try:
        tools = await mcp_manager.get_raw_tools()
        return {
            "count": len(tools),
            "tools": tools
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch tools from NativeCAD: {str(e)}"
        )

# --- Chat & Streaming Routes (SSE) ---

@app.post("/api/chat/stream")
async def chat_stream_post(
    req: ChatRequest,
    user: dict = Depends(get_current_user)
):
    agent = CADAgent(api_key=req.api_key)

    async def event_generator():
        try:
            async for event_type, data in agent.chat_stream(req.message, req.history):
                payload = json.dumps(data)
                yield f"event: {event_type}\ndata: {payload}\n\n"
        except Exception as e:
            logger.error(f"Error in SSE stream: {e}")
            err_data = json.dumps({"error": str(e)})
            yield f"event: error\ndata: {err_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.get("/api/chat/stream")
async def chat_stream_get(
    message: str = Query(..., description="User prompt"),
    token: str = Query(..., description="Auth token"),
    api_key: Optional[str] = Query(None)
):
    verify_token(token)
    agent = CADAgent(api_key=api_key)

    async def event_generator():
        try:
            async for event_type, data in agent.chat_stream(message, None):
                payload = json.dumps(data)
                yield f"event: {event_type}\ndata: {payload}\n\n"
        except Exception as e:
            logger.error(f"Error in SSE stream: {e}")
            err_data = json.dumps({"error": str(e)})
            yield f"event: error\ndata: {err_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/chat")
async def chat_with_cad(
    req: ChatRequest,
    user: dict = Depends(get_current_user)
):
    agent = CADAgent(api_key=req.api_key)
    res = await agent.chat(
        message=req.message,
        history=req.history
    )
    if "error" in res and not res.get("response"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=res["error"])
    return res

@app.post("/api/tools/call")
async def call_tool_directly(
    req: DirectToolCallRequest,
    user: dict = Depends(get_current_user)
):
    mcp_manager = NativeCADManager.get_instance()
    try:
        result = await mcp_manager.call_tool(req.tool_name, req.arguments)
        return {
            "tool": req.tool_name,
            "arguments": req.arguments,
            "result": result
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error executing {req.tool_name}: {str(e)}"
        )

@app.post("/api/cad/reset")
async def reset_cad_session(user: dict = Depends(get_current_user)):
    mcp_manager = NativeCADManager.get_instance()
    try:
        res = await mcp_manager.call_tool("cad_session_reset", {})
        return {"status": "reset", "result": res}
    except Exception:
        await mcp_manager.restart()
        return {"status": "restarted"}

@app.post("/api/settings/api-key")
async def set_api_key(
    req: ApiKeyUpdateRequest,
    user: dict = Depends(get_current_user)
):
    update_minimax_api_key(req.api_key)
    return {
        "status": "success",
        "message": "MiniMax API Key updated and persisted successfully."
    }

# --- Exports Routes ---

@app.get("/api/exports")
async def list_exports():
    if not EXPORT_DIR.exists():
        return {"exports": []}
    files = []
    for item in EXPORT_DIR.iterdir():
        if item.is_file():
            stat = item.stat()
            files.append({
                "filename": item.name,
                "size_bytes": stat.st_size,
                "modified_at": stat.st_mtime,
                "download_url": f"/nativecad/api/exports/{item.name}"
            })
    files.sort(key=lambda x: x["modified_at"], reverse=True)
    return {"exports": files}

@app.get("/api/exports/{filename}")
async def download_export(filename: str):
    file_path = EXPORT_DIR / filename
    try:
        file_path.resolve().relative_to(EXPORT_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    # Pick media type
    ext = file_path.suffix.lower()
    media_types = {
        ".step": "application/step",
        ".stp": "application/step",
        ".stl": "model/stl",
        ".dxf": "image/vnd.dxf",
        ".pdf": "application/pdf",
        ".html": "text/html",
        ".gltf": "model/gltf+json",
        ".glb": "model/gltf-binary",
        ".3mf": "model/3mf",
    }
    media_type = media_types.get(ext, "application/octet-stream")

    return FileResponse(
        path=file_path,
        filename=filename,
        media_type=media_type
    )

@app.delete("/api/exports/{filename}")
async def delete_export(filename: str, user: dict = Depends(get_current_user)):
    file_path = EXPORT_DIR / filename
    try:
        file_path.resolve().relative_to(EXPORT_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if file_path.is_file():
        file_path.unlink()
        return {"status": "deleted", "filename": filename}
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)