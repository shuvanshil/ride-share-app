"""
FastAPI application entrypoint.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from .core.errors import ApiError
from .routers import account, admin, auth, google, notify, otp, rides

app = FastAPI(title="LiphtUp API", docs_url=None, redoc_url=None, openapi_url=None)

# --- Aggressive CORS Middleware ---
class ForceCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Handle OPTIONS preflight manually
        if request.method == "OPTIONS":
            response = JSONResponse(content={"ok": True}, status_code=200)
        else:
            try:
                response = await call_next(request)
            except Exception as e:
                # Ensure even unhandled exceptions return CORS headers
                response = JSONResponse(
                    status_code=500,
                    content={"error": "Internal server error"}
                )

        # Inject CORS headers into EVERY response
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept, X-Requested-With"
        response.headers["Access-Control-Max-Age"] = "86400"
        response.headers["Access-Control-Expose-Headers"] = "*"
        return response

app.add_middleware(ForceCORSMiddleware)

# Redundant standard middleware as fallback
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    headers = {"Access-Control-Allow-Origin": "*"}
    retry_after = exc.extra.get("retryAfter")
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return JSONResponse(status_code=exc.status_code, content=exc.to_payload(), headers=headers)

@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    message = f"Invalid request: {field} - {first.get('msg')}" if field else "Invalid request."
    return JSONResponse(status_code=400, content={"error": message}, headers={"Access-Control-Allow-Origin": "*"})

@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
    headers = {"Access-Control-Allow-Origin": "*"}
    if exc.headers:
        headers.update(exc.headers)
    return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=headers)

@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error"},
        headers={"Access-Control-Allow-Origin": "*"}
    )

app.include_router(google.router, prefix="/api")
app.include_router(otp.router, prefix="/api")
app.include_router(account.router, prefix="/api")
app.include_router(notify.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(rides.router, prefix="/api")
app.include_router(admin.router, prefix="/api")

# Continuous background thread for scheduled ride activation & matching sweep
import threading
import time

def _bg_scheduled_ride_sweeper():
    while True:
        try:
            from .core.firebase import get_admin_app
            import firebase_admin.firestore as fb_firestore
            from .routers.rides import activate_due_scheduled_requests
            db = fb_firestore.client(get_admin_app())
            activate_due_scheduled_requests(db)
        except Exception:
            pass
        time.sleep(10)

_sweeper_thread = threading.Thread(target=_bg_scheduled_ride_sweeper, daemon=True)
_sweeper_thread.start()

@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}
