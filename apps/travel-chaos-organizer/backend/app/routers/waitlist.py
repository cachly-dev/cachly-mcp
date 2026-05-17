from typing import Annotated
from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.db.database import get_db

router = APIRouter(prefix="/waitlist", tags=["waitlist"])


class WaitlistBody(BaseModel):
    email: EmailStr
    source: str = "landing"


@router.post("")
async def join_waitlist(
    body: WaitlistBody,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    try:
        await db.execute(
            text("INSERT INTO waitlist (email, source) VALUES (:email, :source)"),
            {"email": body.email.lower(), "source": body.source},
        )
        await db.commit()
        return {"joined": True}
    except Exception:
        await db.rollback()
        return {"already_joined": True}
