#!/bin/sh
# Route47 Server — one-line VPS installer (Ubuntu/Debian).
# Intended to be hosted at https://get.route47.app so customers can run:
#
#   curl -fsSL https://get.route47.app | sh
#
# What it does:
#   1. Installs Docker (via get.docker.com) if missing.
#   2. Creates /opt/route47 with a docker-compose.yml running the OFFICIAL
#      Route47 server image + Caddy for automatic HTTPS.
#   3. Generates a random admin API key.
#   4. Sets up a nightly backup of the data volume and an update.sh helper.
#   5. Prints the server URL + admin key to paste into the Route47 Admin App.
#
# The customer owns this machine and this deployment entirely — Route47 has
# no access. Updating later: /opt/route47/update.sh (pulls the newest
# official image; data survives on the route47-data volume).
set -eu

IMAGE="ghcr.io/sreeranj065/route47-server:latest"
INSTALL_DIR="/opt/route47"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo sh install.sh)." >&2
  exit 1
fi

printf "Domain that will point at this server (e.g. route47.acme.com).\n"
printf "Leave empty to run HTTP-only on port 4700 (LAN/testing only — the\n"
printf "Route47 Driver App requires HTTPS for real fleets): "
read -r DOMAIN </dev/tty || DOMAIN=""

say "1/5 Installing Docker (if needed)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

say "2/5 Writing $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
ADMIN_KEY="r47_$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

if [ -n "$DOMAIN" ]; then
  PUBLIC_URL="https://$DOMAIN"
  cat > "$INSTALL_DIR/Caddyfile" <<EOF
$DOMAIN {
    reverse_proxy route47-server:4700
}
EOF
  cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  route47-server:
    image: $IMAGE
    restart: unless-stopped
    environment:
      DATA_DIR: /data
      ROUTE47_ADMIN_API_KEY: $ADMIN_KEY
      ROUTE47_PUBLIC_URL: $PUBLIC_URL
      ROUTE47_HOSTING_MODE: docker
      ROUTE47_SELF_UPDATE_ENABLED: "true"
      ROUTE47_COMPOSE_DIR: /host-compose
    volumes:
      - route47-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - $INSTALL_DIR:/host-compose:ro

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  route47-data:
  caddy-data:
  caddy-config:
EOF
else
  PUBLIC_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):4700"
  cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  route47-server:
    image: $IMAGE
    restart: unless-stopped
    ports:
      - "4700:4700"
    environment:
      DATA_DIR: /data
      ROUTE47_ADMIN_API_KEY: $ADMIN_KEY
      ROUTE47_HOSTING_MODE: docker
      ROUTE47_SELF_UPDATE_ENABLED: "true"
      ROUTE47_COMPOSE_DIR: /host-compose
    volumes:
      - route47-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - $INSTALL_DIR:/host-compose:ro

volumes:
  route47-data:
EOF
fi

say "3/5 Creating update + backup helpers…"
cat > "$INSTALL_DIR/update.sh" <<'EOF'
#!/bin/sh
# Pulls the latest official Route47 server image and restarts.
# Data is safe: it lives on the route47-data volume.
set -eu
cd "$(dirname "$0")"
docker compose pull
docker compose up -d
echo "Route47 server updated."
EOF
chmod +x "$INSTALL_DIR/update.sh"

cat > "$INSTALL_DIR/backup.sh" <<'EOF'
#!/bin/sh
# Nightly snapshot of the Route47 data volume (SQLite DB + proof photos).
set -eu
cd "$(dirname "$0")"
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
docker run --rm -v route47_route47-data:/data -v "$(pwd)/backups":/backups alpine \
  tar czf "/backups/route47-data-$STAMP.tar.gz" -C /data .
# Keep the 14 most recent backups.
ls -1t backups/route47-data-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
EOF
chmod +x "$INSTALL_DIR/backup.sh"

# Nightly backup at 03:17 (idempotent cron entry).
CRON_LINE="17 3 * * * $INSTALL_DIR/backup.sh >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -vF "$INSTALL_DIR/backup.sh" ; echo "$CRON_LINE" ) | crontab -

say "4/5 Starting Route47 server…"
cd "$INSTALL_DIR"
docker compose pull
docker compose up -d

say "5/5 Done!"
cat <<EOF

============================================================
 Route47 server is running.

 Server URL : $PUBLIC_URL
 Admin key  : $ADMIN_KEY

 Paste both into the Route47 Admin App
 (Server Setup → "I have my server URL").

 Update later : $INSTALL_DIR/update.sh
 Backups      : nightly to $INSTALL_DIR/backups/
 Health check : $PUBLIC_URL/healthz
============================================================
EOF
