"""Cache stats endpoint — exposes Cachly Redis metrics to the frontend and MCP tools."""
from fastapi import APIRouter, Depends
from typing import Annotated
from app.auth.keycloak import user_id
from app.services.cache import cache_stats

router = APIRouter(prefix="/cache", tags=["cache"])


@router.get("/stats")
async def get_cache_stats(_uid: Annotated[str, Depends(user_id)]):
    """Return Cachly Redis cache statistics for the current deployment."""
    return await cache_stats()
