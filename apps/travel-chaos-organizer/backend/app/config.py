from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # App
    app_name: str = "Travel Chaos Organizer API"
    debug: bool = False
    upload_dir: str = "/data/uploads"

    # Database
    database_url: str = "postgresql+asyncpg://tco:tco@localhost:5432/tco"

    # Keycloak
    keycloak_url: str = "http://localhost:8080"
    keycloak_realm: str = "travel-chaos"
    keycloak_client_id: str = "tco-backend"

    # Ollama
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2-vision"
    ollama_timeout: int = 120

    # Cachly Redis (optional) — caches Ollama parse results by content hash.
    # Set to your Cachly Redis connection string to enable deduplication.
    # Format: redis://:<password>@<host>:<port>/0  or  rediss:// for TLS
    cachly_redis_url: str = ""

    # CORS
    cors_origins: str = "*"

    # Telegram notifier (optional)
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""       # default chat; per-app override below
    tco_telegram_chat_id: str = ""   # if set, overrides telegram_chat_id for TCO events

    # Email (Resend)
    resend_api_key: str = ""
    resend_from: str = "noreply@tco.app"

    # Admin
    admin_user: str = "admin"
    admin_password: str = "changeme"

    # Sentry (optional)
    sentry_dsn: str = ""
    environment: str = "production"

    # Upload
    max_upload_bytes: int = 20 * 1024 * 1024  # 20 MB

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
