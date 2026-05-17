#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 or Debian 12 server.
# Run as root or sudo: curl -sSL https://tco.app/setup | bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[TCO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[TCO]${NC} $*"; }
die()   { echo -e "${RED}[TCO ERROR]${NC} $*" >&2; exit 1; }

info "=== Travel Chaos Organizer — Server Setup ==="
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash scripts/server-setup.sh"

# 1. Update & basics
info "Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl wget git ufw unzip ca-certificates gnupg lsb-release

# 2. Docker
if ! command -v docker &>/dev/null; then
  info "Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  info "Docker installed."
else
  info "Docker already installed."
fi

# 3. Firewall
info "Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
info "Firewall configured (ssh, 80, 443)."

# 4. Create app user
if ! id tco &>/dev/null; then
  info "Creating 'tco' user..."
  useradd -m -s /bin/bash tco
  usermod -aG docker tco
fi

# 5. Clone / update repo
APP_DIR="/opt/tco"
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing repo..."
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning repo..."
  read -rp "Git repo URL (e.g. git@github.com:you/tco.git): " REPO_URL
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R tco:tco "$APP_DIR"

# 6. .env setup
cd "$APP_DIR/apps/travel-chaos-organizer"
if [[ ! -f .env ]]; then
  info "Creating .env from template..."
  cp .env.example .env
  warn "Edit /opt/tco/apps/travel-chaos-organizer/.env before running deploy!"
else
  info ".env already exists — skipping."
fi

# 7. Backup cron
info "Installing backup cron..."
CRON_LINE="0 3 * * * cd $APP_DIR/apps/travel-chaos-organizer && docker compose --profile backup run --rm backup >> /var/log/tco-backup.log 2>&1"
(crontab -u tco -l 2>/dev/null | grep -v "tco-backup"; echo "$CRON_LINE") | crontab -u tco -

info ""
info "=== Setup complete! ==="
info "Next steps:"
info "  1. Edit /opt/tco/apps/travel-chaos-organizer/.env"
info "  2. Run: sudo -u tco bash $APP_DIR/apps/travel-chaos-organizer/scripts/deploy.sh"
