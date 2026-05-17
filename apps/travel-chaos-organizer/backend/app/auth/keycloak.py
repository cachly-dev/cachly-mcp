from typing import Annotated
import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from app.config import get_settings

settings = get_settings()
bearer_scheme = HTTPBearer()

_jwks_cache: dict | None = None


async def _get_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache:
        return _jwks_cache
    url = f"{settings.keycloak_url}/realms/{settings.keycloak_realm}/protocol/openid-connect/certs"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, timeout=10)
        resp.raise_for_status()
        _jwks_cache = resp.json()
        return _jwks_cache


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)],
) -> dict:
    token = credentials.credentials
    try:
        jwks = await _get_jwks()
        unverified_header = jwt.get_unverified_header(token)
        key = next(
            (k for k in jwks["keys"] if k["kid"] == unverified_header.get("kid")),
            None,
        )
        if key is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown signing key")

        payload = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.keycloak_client_id,
            options={"verify_exp": True},
        )
        return payload
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
        ) from exc


def user_id(user: Annotated[dict, Depends(get_current_user)]) -> str:
    return user["sub"]
