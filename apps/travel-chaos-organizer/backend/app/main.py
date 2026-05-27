from contextlib import asynccontextmanager
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.routers import trips, items, parse, inbox, mail, events as events_router, waitlist as waitlist_router
from app.routers import admin as admin_router
from app.routers import users as users_router
from app.routers import payments as payments_router
from app.routers import export as export_router
from app.routers import cache as cache_router
from app.services.cache import cachly_configured
from app.limiter import limiter
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

settings = get_settings()

APP_VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.logging_config import setup_logging
    setup_logging(debug=settings.debug)
    from app.services import sentry as sentry_svc
    sentry_svc.init(settings.sentry_dsn, settings.environment, release=APP_VERSION)
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    import sys
    if settings.admin_password == "changeme":
        print("⚠️  WARNING: ADMIN_PASSWORD is still 'changeme'. Change it before going live!", file=sys.stderr)
    yield


app = FastAPI(
    title=settings.app_name,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    openapi_url="/openapi.json" if settings.debug else None,
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
app.include_router(users_router.router, prefix="/api/v1")
app.include_router(payments_router.router, prefix="/api/v1")
app.include_router(export_router.router, prefix="/api/v1")
app.include_router(cache_router.router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "cachly_cache": "enabled" if cachly_configured() else "disabled",
    }
