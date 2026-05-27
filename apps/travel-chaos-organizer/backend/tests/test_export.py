"""Tests for PDF export endpoint."""
import uuid
import pytest
from unittest.mock import patch, AsyncMock
from httpx import AsyncClient
from sqlalchemy import text
from tests.conftest import FAKE_USER_ID

EXPORT_TRIP_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"


@pytest.mark.asyncio
async def test_pdf_export_trip_not_found(client: AsyncClient):
    """Returns 404 for non-existent trip."""
    r = await client.get(f"/api/v1/trips/{uuid.uuid4()}/export/pdf")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_pdf_export_returns_pdf(client: AsyncClient, db_session):
    """Creates a trip and exports it as PDF — verifies content-type."""
    # Create a trip directly in DB using a valid UUID
    await db_session.execute(
        text("INSERT INTO trips (id, user_id, name, start_date, end_date) VALUES (:id, :uid, :name, :sd, :ed)"),
        {"id": EXPORT_TRIP_ID, "uid": FAKE_USER_ID, "name": "Export Test Trip",
         "sd": "2025-06-01", "ed": "2025-06-07"}
    )
    await db_session.commit()
    fake_pdf = b"%PDF-1.4 fake content for test"
    with patch("app.routers.export._build_pdf", return_value=fake_pdf), \
         patch("app.services.telemetry.track", new_callable=AsyncMock):
        r = await client.get(f"/api/v1/trips/{EXPORT_TRIP_ID}/export/pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert len(r.content) > 0


@pytest.mark.asyncio
async def test_pdf_export_other_users_trip_returns_404(client: AsyncClient, db_session):
    """Cannot export another user's trip."""
    other_trip_id = "b2c3d4e5-f6a7-8901-bcde-f12345678901"
    await db_session.execute(
        text("INSERT INTO trips (id, user_id, name) VALUES (:id, :uid, :name)"),
        {"id": other_trip_id, "uid": "other-user-999", "name": "Secret Trip"}
    )
    await db_session.commit()
    r = await client.get(f"/api/v1/trips/{other_trip_id}/export/pdf")
    assert r.status_code == 404
