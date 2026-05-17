from contextlib import asynccontextmanager
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.routers import trips, items, parse, inbox, mail, events as events_router, waitlist as waitlist_router
from app.routers import admin as admin_router
from app.services.cache import cachly_configured
from app.limiter import limiter
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(",") if settings.cors_origins != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trips.router, prefix="/api/v1")
app.include_router(items.router, prefix="/api/v1")
app.include_router(parse.router, prefix="/api/v1")
app.include_router(inbox.router, prefix="/api/v1")
app.include_router(mail.router, prefix="/api/v1")
app.include_router(events_router.router, prefix="/api/v1")
app.include_router(waitlist_router.router, prefix="/api/v1")
app.include_router(admin_router.router)   # no /api/v1 prefix — admin is at /admin


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "0.1.0",
        "cachly_cache": "enabled" if cachly_configured() else "disabled",
    }
