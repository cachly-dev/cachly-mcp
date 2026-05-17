from typing import Annotated
from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.db.database import get_db
from app.services import notifier, email as email_svc

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
        # Fire-and-forget: notification + welcome email
        await notifier.notify("tco", "waitlist_signup", {"email": body.email.lower(), "source": body.source})
        await email_svc.send_waitlist_welcome(body.email.lower())
        return {"joined": True}
    except Exception:
        await db.rollback()
        return {"already_joined": True}
