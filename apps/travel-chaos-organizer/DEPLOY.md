# Travel Chaos Organizer — Deployment & Test Checklist

> Hand this file to any agent or developer to get the app running end-to-end.
> Everything below assumes a fresh Ubuntu 22.04 VPS and an Android phone for testing.

---

## Prerequisites

| What | Where to get |
|------|-------------|
| VPS (min. 2 GB RAM) | Hetzner / DigitalOcean / any Ubuntu 22.04 |
| Domain pointing to VPS | Your DNS provider → A record → VPS IP |
| Stripe account | stripe.com — get secret key + webhook secret + price ID |
| Resend account | resend.com — get API key, verify sender domain |
| Telegram bot (optional) | @BotFather → create bot → get token + chat ID |
| Expo account | expo.dev — needed for EAS builds |
| Android phone | Expo Go from Play Store for quick testing |

---

## Step 1 — Server Setup (run once)

```bash
# On the VPS as root:
curl -o server-setup.sh https://raw.githubusercontent.com/cachly-dev/cachly-mcp/claude/plan-mvp-project-1ORlN/apps/travel-chaos-organizer/scripts/server-setup.sh
chmod +x server-setup.sh
bash server-setup.sh
# → installs Docker, UFW, creates tco user, sets up backup cron
```

---

## Step 2 — Configure Environment

```bash
# As the tco user on the VPS:
git clone https://github.com/cachly-dev/cachly-mcp.git /home/tco/app
cd /home/tco/app/apps/travel-chaos-organizer
bash scripts/configure-env.sh
```

**The script asks for these values — have them ready:**

### Backend `.env` (created at `apps/travel-chaos-organizer/.env`)

| Variable | Value / Where to find |
|----------|-----------------------|
| `DATABASE_URL` | `postgresql+asyncpg://tco:YOURPASSWORD@postgres:5432/tco` |
| `KEYCLOAK_URL` | `https://auth.YOURDOMAIN.com` |
| `KEYCLOAK_REALM` | `tco` |
| `KEYCLOAK_CLIENT_ID` | `tco-app` |
| `OLLAMA_URL` | `http://ollama:11434` |
| `OLLAMA_MODEL` | `llama3.2-vision` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → signing secret |
| `STRIPE_PRO_PRICE_ID` | Stripe Dashboard → Products → your Pro price ID |
| `RESEND_API_KEY` | Resend Dashboard → API Keys |
| `RESEND_FROM` | `TCO <noreply@YOURDOMAIN.com>` |
| `ADMIN_USER` | choose a username (not "admin") |
| `ADMIN_PASSWORD` | strong password (min 20 chars) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → your bot token (optional) |
| `TCO_TELEGRAM_CHAT_ID` | your personal/group chat ID (optional) |
| `SENTRY_DSN` | sentry.io → project → DSN (optional) |
| `CORS_ORIGINS` | `https://YOURDOMAIN.com` (lock down in production) |
| `SECRET_KEY` | run: `openssl rand -hex 32` |
| `APP_URL` | `https://YOURDOMAIN.com` |

### Frontend `.env.production` (created at `apps/travel-chaos-organizer/frontend/.env.production`)

| Variable | Value |
|----------|-------|
| `EXPO_PUBLIC_API_URL` | `https://YOURDOMAIN.com` |
| `EXPO_PUBLIC_KEYCLOAK_URL` | `https://auth.YOURDOMAIN.com` |
| `EXPO_PUBLIC_KEYCLOAK_REALM` | `tco` |
| `EXPO_PUBLIC_KEYCLOAK_CLIENT_ID` | `tco-app` |
| `EXPO_PUBLIC_UPGRADE_URL` | `https://YOURDOMAIN.com/upgrade` (or Stripe payment link) |
| `EXPO_PUBLIC_PRIVACY_URL` | `https://YOURDOMAIN.com/privacy` |
| `EXPO_PUBLIC_TERMS_URL` | `https://YOURDOMAIN.com/terms` |
| `EXPO_PUBLIC_SUPPORT_EMAIL` | `support@YOURDOMAIN.com` |
| `EXPO_PUBLIC_SENTRY_DSN` | same Sentry DSN as backend (optional) |

---

## Step 3 — Deploy Backend

```bash
cd /home/tco/app/apps/travel-chaos-organizer
bash scripts/deploy.sh
# → pulls images, builds, starts containers, runs Alembic migrations
```

**Verify it's running:**
```bash
bash scripts/health-check.sh
# Should print: ✓ API healthy, ✓ Keycloak reachable
```

---

## Step 4 — Pull Ollama Model

```bash
# On the VPS (this downloads ~2GB, takes a few minutes):
docker exec tco-ollama ollama pull llama3.2-vision

# Verify:
docker exec tco-ollama ollama list
# Should show: llama3.2-vision
```

---

## Step 5 — Configure Keycloak

```bash
# Open in browser:
https://auth.YOURDOMAIN.com/admin

# Login with: admin / (password set during server-setup.sh)
```

1. **Import realm**: Realm Settings → Import → upload `keycloak/realm-export.json`
2. **Set SMTP** (for password reset emails):
   - Realm Settings → Email → configure with your SMTP provider
3. **Create first user** (optional — users can self-register):
   - Users → Add user → set email + temp password
4. **Verify redirect URIs**: Clients → tco-app → Settings → Valid redirect URIs should include:
   - `tco://*`
   - `exp://*`
   - `https://auth.expo.io/@YOUR_EXPO_USERNAME/tco`

---

## Step 6 — Configure Stripe Webhook

1. Go to Stripe Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. Endpoint URL: `https://YOURDOMAIN.com/api/v1/payments/webhook`
4. Events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Copy the signing secret → put in `STRIPE_WEBHOOK_SECRET` env var
6. Re-run `bash scripts/deploy.sh` to apply the new env var

---

## Step 7 — Generate App Icons (local, on your machine)

```bash
# On your local machine in the repo:
cd apps/travel-chaos-organizer/frontend
npm install -g sharp-cli
node ../../scripts/generate-icons.js
# → creates icon.png, adaptive-icon.png, splash.png, favicon.png in assets/
```

> If sharp-cli fails: open `assets/icon.svg` in a browser, screenshot at 1024×1024, save as `assets/icon.png`. Repeat for splash at 1284×2778.

---

## Step 8 — Test on Android with Expo Go (quickest)

```bash
# On your local machine:
cd apps/travel-chaos-organizer/frontend
cp .env.production .env.local   # use production config
npx expo start --tunnel         # --tunnel makes it reachable over internet
```

1. Install **Expo Go** from Play Store on your Android phone
2. Scan the QR code shown in the terminal
3. App opens on your phone with live reload

**Test these flows in order:**
- [ ] Onboarding slides swipe correctly, "Start" navigates to login
- [ ] Login via Keycloak opens browser, redirects back to app
- [ ] `/api/v1/users/me` returns plan (check Network tab or backend logs)
- [ ] Create a trip → check it appears in list
- [ ] Upload a PDF/screenshot → Ollama parses it → item appears in timeline
- [ ] Parse success triggers confetti ✨
- [ ] Trip countdown shows correct days
- [ ] Score ring updates after adding flight/hotel items
- [ ] Tap "↗" share button → share sheet opens with formatted text
- [ ] Inbox shows parsed items without trip_id
- [ ] Assign inbox item to trip
- [ ] Go offline (airplane mode) → create trip → back online → syncs
- [ ] Settings → Plan shows Free/Pro correctly

---

## Step 9 — Build Production APK with EAS

```bash
# On your local machine (one-time setup):
npm install -g eas-cli
eas login   # with your Expo account

cd apps/travel-chaos-organizer/frontend

# Preview build (sideloadable APK, no Play Store needed):
eas build --profile preview --platform android
# → ~10-15 min build time on EAS servers
# → get download link by email + in Expo dashboard
```

**Install on phone:**
1. Open the download link on your Android phone
2. Tap Install (allow "Install unknown apps" for your browser)
3. Done — this is the real app, no Expo Go needed

---

## Step 10 — Smoke Test Production

```bash
bash scripts/smoke-test.sh
# Tests: health, waitlist signup, event tracking, admin auth
```

```bash
bash scripts/verify-tracking.sh
# Checks: Sentry DSN, Telegram bot, Resend API, Stripe, Ollama, Cachly Redis
```

---

## Admin Dashboard

```
https://YOURDOMAIN.com/admin
Username: (ADMIN_USER from .env)
Password: (ADMIN_PASSWORD from .env)
```

Features:
- See all users + their plan status
- Manually upgrade/downgrade a user's plan
- View telemetry events
- View waitlist signups
- Trigger drip email sequence (dry run first!)

---

## Drip Emails

```bash
# Dry run first — see what would be sent:
make drip-dry
# or: curl -X POST https://YOURDOMAIN.com/admin/drip/run?dry_run=true -u admin:password

# Actually send:
make drip-run
```

Set up a cron job on the VPS to run daily:
```bash
# As tco user — add to crontab:
0 9 * * * curl -s -X POST https://YOURDOMAIN.com/admin/drip/run -u ADMIN_USER:ADMIN_PASSWORD
```

---

## Backups

```bash
# Manual backup:
bash scripts/backup.sh
# → creates timestamped pg_dump in backups/

# Docker backup profile (scheduled):
docker compose --profile backup run backup
```

Backups are kept for 30 days, stored in `backups/` on the VPS.

---

## Monitoring

| What | Where |
|------|-------|
| App errors (mobile) | Sentry → your project |
| Backend errors | `docker compose logs backend -f` |
| Stripe payments | Stripe Dashboard → Events |
| New users / signups | Telegram bot notifications |
| Admin overview | `https://YOURDOMAIN.com/admin` |

---

## Common Issues

**Parse fails / Ollama error**
```bash
docker exec tco-ollama ollama list          # is model downloaded?
docker logs tco-ollama --tail 50            # any errors?
curl http://localhost:11434/api/tags        # is Ollama responding?
```

**Login fails / Keycloak error**
```bash
docker logs tco-keycloak --tail 50
# Check redirect URIs in Keycloak client config
# Check EXPO_PUBLIC_KEYCLOAK_URL matches exactly (no trailing slash)
```

**Stripe webhook returns 400**
```bash
docker logs tco-backend --tail 50
# Check STRIPE_WEBHOOK_SECRET is the signing secret (not the API key)
# In Stripe Dashboard: Webhooks → your endpoint → "Signing secret" (not "Secret key")
```

**Push notifications not arriving**
- Expo Go: notifications don't work in Expo Go — use EAS Preview build
- Check device has notifications enabled for the app
- event_at must be in the future for reminders to schedule

---

## Branch

All code is on: `claude/plan-mvp-project-1ORlN`

Merge to `main` when ready to ship.
