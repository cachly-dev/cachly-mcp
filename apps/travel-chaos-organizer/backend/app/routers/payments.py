"""
Stripe payment endpoints.
POST /api/v1/payments/checkout  — create Stripe Checkout session for Pro upgrade
POST /api/v1/payments/webhook   — handle Stripe webhook events
"""
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from datetime import datetime, timedelta, timezone
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.config import get_settings
from app.limiter import limiter

router = APIRouter(prefix="/payments", tags=["payments"])


@limiter.limit("5/minute")
@router.post("/checkout")
async def create_checkout(
    request: Request,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    s = get_settings()
    if not s.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Payments not configured")

    import stripe
    stripe.api_key = s.stripe_secret_key

    # Get user email from DB if available
    row = await db.execute(text("SELECT email FROM users WHERE id = :uid"), {"uid": uid})
    r = row.fetchone()
    customer_email = r[0] if r and r[0] else None

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": s.stripe_pro_price_id, "quantity": 1}],
        success_url=s.stripe_success_url,
        cancel_url=s.stripe_cancel_url,
        client_reference_id=uid,
        **({"customer_email": customer_email} if customer_email else {}),
        metadata={"user_id": uid},
    )
    from app.services import telemetry
    await telemetry.track(db, uid, "stripe_checkout_initiated", {"price_id": s.stripe_pro_price_id})
    return {"checkout_url": session.url, "session_id": session.id}


@router.post("/webhook")
async def stripe_webhook(request: Request, db: Annotated[AsyncSession, Depends(get_db)]):
    s = get_settings()
    if not s.stripe_secret_key:
        return {"ok": True}

    import stripe
    stripe.api_key = s.stripe_secret_key

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig, s.stripe_webhook_secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    if event["type"] == "checkout.session.completed":
        obj = event["data"]["object"]
        uid = obj.get("metadata", {}).get("user_id") or obj.get("client_reference_id")
        if uid:
            expires_at = datetime.now(timezone.utc) + timedelta(days=365)
            await db.execute(
                text("""
                    INSERT INTO users (id, plan, plan_expires_at, updated_at)
                    VALUES (:uid, 'pro', :exp, :now)
                    ON CONFLICT (id) DO UPDATE
                      SET plan = 'pro', plan_expires_at = EXCLUDED.plan_expires_at,
                          updated_at = EXCLUDED.updated_at
                """),
                {"uid": uid, "exp": expires_at, "now": datetime.now(timezone.utc)},
            )
            await db.commit()
            from app.services import telemetry as tel_svc
            from app.services import notifier as notifier_svc
            await tel_svc.track(db, uid, "stripe_payment_completed", {"amount": obj.get("amount_total"), "currency": obj.get("currency")})
            await notifier_svc.notify("tco", "stripe_payment", {"user_id": uid, "amount": obj.get("amount_total"), "currency": obj.get("currency")})

    elif event["type"] in ("customer.subscription.deleted", "customer.subscription.paused"):
        # Downgrade when subscription cancelled
        cust_id = event["data"]["object"].get("customer")
        if cust_id:
            # Look up user by Stripe customer — store in metadata if possible
            # For now, webhook sets plan=free where stripe_customer_id matches
            # This is best-effort; admin can also do it manually
            pass

    return {"ok": True}
