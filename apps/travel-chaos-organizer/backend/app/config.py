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

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
