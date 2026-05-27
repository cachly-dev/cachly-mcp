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
        success_url=s.stripe_success_url + "?session_id={CHECKOUT_SESSION_ID}",
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
    if not sig:
        raise HTTPException(status_code=400, detail="Missing Stripe-Signature header")

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
            # Store Stripe customer ID for future subscription management
            stripe_cust = obj.get("customer")
            if stripe_cust:
                await db.execute(
                    text("UPDATE users SET stripe_customer_id = :cid WHERE id = :uid"),
                    {"cid": stripe_cust, "uid": uid},
                )
                await db.commit()
            from app.services import telemetry as tel_svc
            from app.services import notifier as notifier_svc
            await tel_svc.track(db, uid, "stripe_payment_completed", {"amount": obj.get("amount_total"), "currency": obj.get("currency")})
            await notifier_svc.notify("tco", "stripe_payment", {"user_id": uid, "amount": obj.get("amount_total"), "currency": obj.get("currency")})
            await notifier_svc.notify_user(db, uid, "🎉 *Du bist jetzt Pro!*\n\nAlle Features sind freigeschaltet. Viel Spaß beim Reisen ✈️")

    elif event["type"] in ("customer.subscription.deleted", "customer.subscription.paused"):
        cust_id = event["data"]["object"].get("customer")
        if cust_id:
            result = await db.execute(
                text("SELECT id FROM users WHERE stripe_customer_id = :cid"),
                {"cid": cust_id},
            )
            row = result.fetchone()
            if row:
                downgrade_uid = row[0]
                await db.execute(
                    text("""
                        UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = :now
                        WHERE id = :uid
                    """),
                    {"uid": downgrade_uid, "now": datetime.now(timezone.utc)},
                )
                await db.commit()
                from app.services import telemetry as tel_svc, notifier as notifier_svc
                await tel_svc.track(db, downgrade_uid, "stripe_subscription_cancelled", {"customer": cust_id})
                await notifier_svc.notify_user(db, downgrade_uid, "ℹ️ *Dein Pro-Abo wurde beendet.*\n\nDu bist jetzt wieder im Free-Plan. Deine Daten bleiben erhalten.")
                await notifier_svc.notify("tco", "stripe_payment", {"event": "cancelled", "user_id": downgrade_uid[:8]})

    elif event["type"] == "invoice.payment_succeeded":
        # Extend plan by 1 year on renewal
        sub = event["data"]["object"].get("subscription")
        cust_id = event["data"]["object"].get("customer")
        if sub and cust_id:
            result = await db.execute(
                text("SELECT id, plan_expires_at FROM users WHERE stripe_customer_id = :cid"),
                {"cid": cust_id},
            )
            row = result.fetchone()
            if row:
                renewal_uid = row[0]
                new_expiry = datetime.now(timezone.utc) + timedelta(days=366)
                await db.execute(
                    text("""
                        UPDATE users SET plan = 'pro', plan_expires_at = :exp, updated_at = :now
                        WHERE id = :uid
                    """),
                    {"uid": renewal_uid, "exp": new_expiry, "now": datetime.now(timezone.utc)},
                )
                await db.commit()

    elif event["type"] == "invoice.payment_failed":
        cust_id = event["data"]["object"].get("customer")
        attempt_count = event["data"]["object"].get("attempt_count", 1)
        if cust_id:
            result = await db.execute(
                text("SELECT id, email FROM users WHERE stripe_customer_id = :cid"),
                {"cid": cust_id},
            )
            row = result.fetchone()
            if row:
                failed_uid, user_email = row[0], row[1]
                if attempt_count >= 3:
                    # Too many failures — downgrade to free immediately
                    await db.execute(
                        text("""
                            UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = :now
                            WHERE id = :uid
                        """),
                        {"uid": failed_uid, "now": datetime.now(timezone.utc)},
                    )
                    await db.commit()
                # else: keep pro, Stripe will retry (grace period)
                from app.services import telemetry as tel_svc, notifier as notifier_svc
                await tel_svc.track(db, failed_uid, "stripe_payment_failed", {"customer": cust_id, "attempt_count": attempt_count})
                await notifier_svc.notify("tco", "stripe_payment", {"event": "payment_failed", "user_id": failed_uid[:8], "attempt": attempt_count})
                if attempt_count < 3:
                    await notifier_svc.notify_user(db, failed_uid, f"⚠️ *Zahlung fehlgeschlagen* (Versuch {attempt_count}/3)\n\nBitte aktualisiere deine Zahlungsmethode in Stripe. Dein Pro-Zugang bleibt noch aktiv.")
                else:
                    await notifier_svc.notify_user(db, failed_uid, "🔴 *Pro-Zugang deaktiviert*\n\nNach 3 fehlgeschlagenen Zahlungsversuchen wurde dein Abo beendet. Bitte erneuere dein Abo in der App.")
                if user_email and attempt_count == 1:
                    # TODO: send payment failure email via notifier_svc or a dedicated email service
                    pass

    return {"ok": True}
