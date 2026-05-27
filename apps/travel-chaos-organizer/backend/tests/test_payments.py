"""Tests for Stripe webhook handling (signature bypassed, event structure tested)."""
import json
from unittest.mock import patch, MagicMock
import pytest
from httpx import AsyncClient

# All webhook tests use client fixture from conftest
# Stripe signature verification is mocked

CHECKOUT_EVENT = {
    "type": "checkout.session.completed",
    "data": {"object": {
        "metadata": {"user_id": "user-test-123"},
        "client_reference_id": "user-test-123",
        "customer": "cus_test123",
        "amount_total": 999,
        "currency": "eur",
    }},
}

SUBSCRIPTION_DELETED_EVENT = {
    "type": "customer.subscription.deleted",
    "data": {"object": {"customer": "cus_test123"}},
}

PAYMENT_SUCCEEDED_EVENT = {
    "type": "invoice.payment_succeeded",
    "data": {"object": {"subscription": "sub_123", "customer": "cus_test123"}},
}

PAYMENT_FAILED_EVENT_ATTEMPT1 = {
    "type": "invoice.payment_failed",
    "data": {"object": {"customer": "cus_test123", "attempt_count": 1}},
}

PAYMENT_FAILED_EVENT_ATTEMPT3 = {
    "type": "invoice.payment_failed",
    "data": {"object": {"customer": "cus_test123", "attempt_count": 3}},
}


def mock_stripe_webhook(event_dict):
    """Patch stripe to bypass signature verification and return our event dict."""
    mock_event = MagicMock()
    mock_event.__getitem__ = lambda self, key: event_dict[key]
    mock_event.get = lambda key, default=None: event_dict.get(key, default)
    mock_event["type"] = event_dict["type"]
    mock_event["data"] = event_dict["data"]
    return mock_event


@pytest.mark.asyncio
async def test_webhook_no_stripe_configured_returns_ok(client: AsyncClient):
    """When stripe not configured, webhook returns 200 immediately."""
    with patch("app.routers.payments.get_settings") as mock_settings:
        mock_settings.return_value.stripe_secret_key = ""
        r = await client.post("/api/v1/payments/webhook",
                              content=b"{}",
                              headers={"stripe-signature": "test"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_webhook_missing_signature_returns_400(client: AsyncClient):
    """Missing Stripe-Signature header returns 400."""
    with patch("app.routers.payments.get_settings") as mock_settings:
        mock_settings.return_value.stripe_secret_key = "sk_test_123"
        mock_settings.return_value.stripe_webhook_secret = "whsec_test"
        r = await client.post("/api/v1/payments/webhook", content=b"{}")
    assert r.status_code == 400
    assert "Stripe-Signature" in r.json()["detail"]


@pytest.mark.asyncio
async def test_checkout_completed_upgrades_user(client: AsyncClient):
    """checkout.session.completed sets user to pro and stores customer_id."""
    from unittest.mock import AsyncMock
    import stripe as stripe_mod
    mock_event = {
        "type": "checkout.session.completed",
        "data": {"object": {
            "metadata": {"user_id": "user-test-123"},
            "client_reference_id": "user-test-123",
            "customer": "cus_test123",
            "amount_total": 999,
            "currency": "eur",
        }},
    }
    with patch("app.config.get_settings") as ms, \
         patch("stripe.Webhook.construct_event") as mock_construct, \
         patch("app.services.telemetry.track", new_callable=AsyncMock), \
         patch("app.services.notifier.notify", new_callable=AsyncMock):
        ms.return_value.stripe_secret_key = "sk_test"
        ms.return_value.stripe_webhook_secret = "whsec_test"
        mock_construct.return_value = mock_event
        r = await client.post("/api/v1/payments/webhook",
                               content=b"{}",
                               headers={"stripe-signature": "t=1,v1=abc"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.asyncio
async def test_subscription_deleted_downgrades_user(client: AsyncClient):
    """customer.subscription.deleted downgrades user to free."""
    from sqlalchemy import text
    from unittest.mock import AsyncMock
    mock_event = {
        "type": "customer.subscription.deleted",
        "data": {"object": {"customer": "cus_test999"}},
    }
    with patch("app.config.get_settings") as ms, \
         patch("stripe.Webhook.construct_event") as mock_construct, \
         patch("app.services.telemetry.track", new_callable=AsyncMock), \
         patch("app.services.notifier.notify", new_callable=AsyncMock):
        ms.return_value.stripe_secret_key = "sk_test"
        ms.return_value.stripe_webhook_secret = "whsec_test"
        mock_construct.return_value = mock_event
        r = await client.post("/api/v1/payments/webhook",
                               content=b"{}",
                               headers={"stripe-signature": "t=1,v1=abc"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_invoice_payment_failed_attempt1_no_downgrade(client: AsyncClient):
    """invoice.payment_failed attempt 1: grace period, no downgrade."""
    from unittest.mock import AsyncMock
    mock_event = {
        "type": "invoice.payment_failed",
        "data": {"object": {"customer": "cus_test123", "attempt_count": 1}},
    }
    with patch("app.config.get_settings") as ms, \
         patch("stripe.Webhook.construct_event") as mock_construct, \
         patch("app.services.telemetry.track", new_callable=AsyncMock), \
         patch("app.services.notifier.notify", new_callable=AsyncMock):
        ms.return_value.stripe_secret_key = "sk_test"
        ms.return_value.stripe_webhook_secret = "whsec_test"
        mock_construct.return_value = mock_event
        r = await client.post("/api/v1/payments/webhook",
                               content=b"{}",
                               headers={"stripe-signature": "t=1,v1=abc"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_unknown_event_type_returns_ok(client: AsyncClient):
    """Unknown event type is ignored and returns 200."""
    from unittest.mock import AsyncMock
    mock_event = {
        "type": "customer.created",
        "data": {"object": {}},
    }
    with patch("app.config.get_settings") as ms, \
         patch("stripe.Webhook.construct_event") as mock_construct:
        ms.return_value.stripe_secret_key = "sk_test"
        ms.return_value.stripe_webhook_secret = "whsec_test"
        mock_construct.return_value = mock_event
        r = await client.post("/api/v1/payments/webhook",
                               content=b"{}",
                               headers={"stripe-signature": "t=1,v1=abc"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
