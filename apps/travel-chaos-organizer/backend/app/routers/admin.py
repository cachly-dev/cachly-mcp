"""
Admin endpoints — Basic Auth protected, no JWT required.
Mount at /admin (no /api/v1 prefix).
"""
import os
import secrets
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.db.database import get_db
from app.config import get_settings

router = APIRouter(prefix="/admin", tags=["admin"])
security = HTTPBasic()


@router.get("", response_class=HTMLResponse, include_in_schema=False)
async def admin_dashboard():
    html = """<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCO Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f0f1a; color: #ccc; }
  #login { display: flex; flex-direction: column; gap: 12px; max-width: 320px; margin: 15vh auto; padding: 32px; background: #1a1a2e; border-radius: 16px; }
  #login h1 { color: #fff; font-size: 20px; }
  input { padding: 10px 14px; border-radius: 8px; border: 1px solid #2a2a4a; background: #0f0f1a; color: #fff; font-size: 14px; }
  button { padding: 10px; background: #4f46e5; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 700; }
  button:hover { background: #4338ca; }
  #dash { display: none; padding: 24px; max-width: 1100px; margin: 0 auto; }
  h2 { color: #fff; font-size: 22px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 20px; text-align: center; }
  .card .n { font-size: 36px; font-weight: 800; color: #4f46e5; }
  .card .l { font-size: 12px; color: #6666aa; margin-top: 4px; }
  .section { background: #1a1a2e; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .section h3 { color: #fff; margin-bottom: 14px; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #6666aa; padding: 6px 8px; border-bottom: 1px solid #2a2a4a; font-weight: 600; }
  td { padding: 6px 8px; border-bottom: 1px solid #1a1a2e; color: #ccc; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
  .badge-pro { background: #4f46e522; color: #818cf8; }
  .badge-free { background: #ffffff11; color: #6666aa; }
  .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
  .top-bar h2 { margin: 0; }
  #logout { background: transparent; color: #6666aa; font-size: 13px; padding: 6px 12px; border: 1px solid #2a2a4a; }
  #err { color: #ff8888; font-size: 13px; }
  #plan-form { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  #plan-form input { flex: 1; min-width: 120px; }
  #plan-form select { padding: 10px; background: #0f0f1a; border: 1px solid #2a2a4a; color: #fff; border-radius: 8px; }
</style>
</head>
<body>
<div id="login">
  <h1>✈️ TCO Admin</h1>
  <input id="u" placeholder="Username" autocomplete="username">
  <input id="p" type="password" placeholder="Password" autocomplete="current-password">
  <button onclick="doLogin()">Login</button>
  <span id="err"></span>
</div>
<div id="dash">
  <div class="top-bar"><h2>✈️ TCO Admin</h2><button id="logout" onclick="doLogout()">Logout</button></div>
  <div class="cards" id="cards"></div>
  <div class="section">
    <h3>Plan-Upgrade</h3>
    <div id="plan-form">
      <input id="pu-uid" placeholder="User ID (Keycloak sub)">
      <select id="pu-plan"><option value="pro">pro</option><option value="free">free</option></select>
      <input id="pu-days" placeholder="Tage (leer = unbegrenzt)" type="number" style="max-width:180px">
      <button onclick="upgradePlan()">Setzen</button>
    </div>
  </div>
  <div class="section"><h3>Top Events</h3><table id="t-events"><thead><tr><th>Event</th><th>Count</th><th>Zuletzt</th></tr></thead><tbody></tbody></table></div>
  <div class="section"><h3>Benutzer</h3><table id="t-users"><thead><tr><th>ID</th><th>Plan</th><th>Events</th><th>Seit</th></tr></thead><tbody></tbody></table></div>
  <div class="section"><h3>Waitlist</h3><table id="t-wl"><thead><tr><th>Email</th><th>Source</th><th>Datum</th></tr></thead><tbody></tbody></table></div>
</div>
<script>
  let _creds = '';
  function b64(u,p){ return btoa(u+':'+p); }
  function fmt(s){ return s ? new Date(s).toLocaleString('de') : '-'; }
  async function api(path, opts={}){
    const r = await fetch(path, { headers: { Authorization: 'Basic '+_creds }, ...opts });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  async function doLogin(){
    _creds = b64(document.getElementById('u').value, document.getElementById('p').value);
    try {
      const h = await api('/admin/health');
      document.getElementById('login').style.display='none';
      document.getElementById('dash').style.display='block';
      load(h);
    } catch { document.getElementById('err').textContent='Falsche Zugangsdaten'; _creds=''; }
  }
  function doLogout(){ _creds=''; document.getElementById('dash').style.display='none'; document.getElementById('login').style.display='flex'; }
  async function load(health){
    const c = document.getElementById('cards');
    c.innerHTML = [
      [health.events_total,'Events gesamt'],
      [health.waitlist_total,'Waitlist'],
      [health.users_total,'Benutzer'],
      [health.pro_users,'Pro-User'],
    ].map(([n,l])=>`<div class="card"><div class="n">${n??0}</div><div class="l">${l}</div></div>`).join('');
    const [ev, users, wl] = await Promise.all([api('/admin/events/summary'), api('/admin/users'), api('/admin/waitlist')]);
    const tb = (id, rows) => { document.querySelector('#'+id+' tbody').innerHTML = rows; };
    tb('t-events', ev.events.map(e=>`<tr><td>${e.event_name}</td><td>${e.count}</td><td>${fmt(e.last_seen)}</td></tr>`).join(''));
    tb('t-users', users.users.map(u=>`<tr><td title="${u.id}">${u.id.slice(0,12)}…</td><td><span class="badge badge-${u.plan}">${u.plan}</span></td><td>${u.event_count}</td><td>${fmt(u.created_at)}</td></tr>`).join(''));
    tb('t-wl', wl.signups.map(s=>`<tr><td>${s.email}</td><td>${s.source||'-'}</td><td>${fmt(s.created_at)}</td></tr>`).join(''));
  }
  async function upgradePlan(){
    const uid = document.getElementById('pu-uid').value.trim();
    const plan = document.getElementById('pu-plan').value;
    const days = document.getElementById('pu-days').value;
    if (!uid) { alert('User ID fehlt'); return; }
    const q = days ? `?plan=${plan}&expires_days=${days}` : `?plan=${plan}`;
    try { await api('/admin/users/'+uid+'/plan'+q, {method:'PATCH'}); alert('Plan gesetzt'); }
    catch { alert('Fehler'); }
  }
  document.getElementById('p').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
</script>
</body>
</html>"""
    return HTMLResponse(html)


def _check_auth(credentials: Annotated[HTTPBasicCredentials, Depends(security)]) -> None:
    s = get_settings()
    ok_user = secrets.compare_digest(credentials.username.encode(), s.admin_user.encode())
    ok_pass = secrets.compare_digest(credentials.password.encode(), s.admin_password.encode())
    if not (ok_user and ok_pass):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Basic"})


@router.get("/events/summary", dependencies=[Depends(_check_auth)])
async def events_summary(db: Annotated[AsyncSession, Depends(get_db)]):
    rows = await db.execute(text("""
        SELECT event_name, COUNT(*) as count,
               MAX(created_at) as last_seen
        FROM events
        GROUP BY event_name
        ORDER BY count DESC
        LIMIT 50
    """))
    return {"events": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/events/recent", dependencies=[Depends(_check_auth)])
async def events_recent(db: Annotated[AsyncSession, Depends(get_db)], limit: int = 50):
    rows = await db.execute(text("""
        SELECT id, user_id, event_name, properties, platform, app_version, created_at
        FROM events ORDER BY created_at DESC LIMIT :limit
    """), {"limit": min(limit, 200)})
    return {"events": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/waitlist", dependencies=[Depends(_check_auth)])
async def waitlist(db: Annotated[AsyncSession, Depends(get_db)]):
    rows = await db.execute(text(
        "SELECT id, email, source, created_at FROM waitlist ORDER BY created_at DESC"
    ))
    return {"signups": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/health", dependencies=[Depends(_check_auth)])
async def admin_health(db: Annotated[AsyncSession, Depends(get_db)]):
    event_count = await db.execute(text("SELECT COUNT(*) FROM events"))
    waitlist_count = await db.execute(text("SELECT COUNT(*) FROM waitlist"))
    user_count = await db.execute(text("SELECT COUNT(*) FROM users"))
    from datetime import datetime, timezone
    pro_count = await db.execute(
        text("SELECT COUNT(*) FROM users WHERE plan != 'free' AND (plan_expires_at IS NULL OR plan_expires_at > :now)"),
        {"now": datetime.now(timezone.utc)},
    )
    return {
        "events_total": event_count.scalar(),
        "waitlist_total": waitlist_count.scalar(),
        "users_total": user_count.scalar(),
        "pro_users": pro_count.scalar(),
    }


@router.get("/users", dependencies=[Depends(_check_auth)])
async def list_users(db: Annotated[AsyncSession, Depends(get_db)], limit: int = 100):
    rows = await db.execute(text("""
        SELECT u.id, u.email, u.plan, u.plan_expires_at, u.created_at,
               COUNT(e.id) AS event_count
        FROM users u
        LEFT JOIN events e ON e.user_id = u.id
        GROUP BY u.id, u.email, u.plan, u.plan_expires_at, u.created_at
        ORDER BY u.created_at DESC
        LIMIT :limit
    """), {"limit": min(limit, 500)})
    return {"users": [dict(r._mapping) for r in rows.fetchall()]}


@router.patch("/users/{uid}/plan", dependencies=[Depends(_check_auth)])
async def set_user_plan(
    uid: str,
    plan: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    expires_days: int | None = None,
):
    if plan not in ("free", "pro"):
        raise HTTPException(status_code=400, detail="plan must be 'free' or 'pro'")
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(days=expires_days)) if expires_days else None
    await db.execute(
        text("""
            INSERT INTO users (id, plan, plan_expires_at, updated_at)
            VALUES (:uid, :plan, :expires_at, :now)
            ON CONFLICT (id) DO UPDATE
              SET plan = EXCLUDED.plan,
                  plan_expires_at = EXCLUDED.plan_expires_at,
                  updated_at = EXCLUDED.updated_at
        """),
        {"uid": uid, "plan": plan, "expires_at": expires_at, "now": now},
    )
    await db.commit()
    return {"ok": True, "uid": uid, "plan": plan}
