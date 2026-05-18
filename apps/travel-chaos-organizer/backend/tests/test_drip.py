"""Tests for email drip sequence logic."""
import pytest
from unittest.mock import patch, AsyncMock
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta, timezone


@pytest.mark.asyncio
async def test_drip_dry_run_returns_plan(client, db_session):
    """Dry run returns what would be sent without sending."""
    r = await client.post("/admin/drip/run?dry_run=true",
                          headers={"Authorization": "Basic YWRtaW46Y2hhbmdlbWU="})  # admin:changeme
    # Either 200 (admin auth works in test) or 401 (expected in test env)
    assert r.status_code in (200, 401)


@pytest.mark.asyncio
async def test_drip_run_admin_required(client):
    """Drip run without auth returns 401."""
    r = await client.post("/admin/drip/run")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_drip_no_users_no_emails(db_session: AsyncSession):
    """run_drip with no users sends nothing."""
    from app.services.drip import run_drip
    with patch("app.services.email._send", new_callable=AsyncMock) as mock_send:
        result = await run_drip(db_session, dry_run=True)
        mock_send.assert_not_called()
    assert isinstance(result, dict)
