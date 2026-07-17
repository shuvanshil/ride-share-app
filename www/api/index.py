"""
FastAPI application entrypoint.

Vercel's Python runtime auto-detects FastAPI: it looks for a variable named
`app` in one of app.py / index.py / server.py / main.py / wsgi.py / asgi.py
and deploys the WHOLE app as a single Vercel Function (zero extra config
needed -- no vercel.json rewrites required). See:
https://vercel.com/docs/frameworks/backend/fastapi

Every route below matches the exact path + method + request/response shape
of the Node.js functions it replaces, so the existing frontend
(js/app.js, js/login.js, js/map.js, js/profile.js) needs NO changes -- it
keeps calling the same `/api/...` URLs.

Local development:
    cd www
    pip install -r requirements.txt
    uvicorn api.index:app --reload --port 3000
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core.errors import ApiError
from .routers import account, auth, google, notify, otp, rides

app = FastAPI(title="LiphtUp API", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_payload())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Body/query failed pydantic validation (e.g. wrong types). Keep the same
    # {"error": ...} shape the frontend already knows how to read.
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    message = f"Invalid request: {field} - {first.get('msg')}" if field else "Invalid request."
    return JSONResponse(status_code=400, content={"error": message})


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    # Normalizes Starlette's default 404 / 405 {"detail": ...} responses to
    # the {"error": ...} shape used everywhere else (matches methodNotAllowed()
    # from the original _otp.js).
    detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
    return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Last-resort safety net so the frontend always gets the {"error": ...}
    # shape it expects, instead of a raw 500 HTML page. Do not expose the
    # exception text: it may contain provider, credential, or infrastructure
    # details that belong only in server logs.
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


# All routers are mounted under /api to match the original Vercel function
# paths (www/api/<name>.js -> POST/GET /api/<name>).
app.include_router(google.router, prefix="/api")
app.include_router(otp.router, prefix="/api")
app.include_router(account.router, prefix="/api")
app.include_router(notify.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(rides.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}
