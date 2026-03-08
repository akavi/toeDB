#!/bin/bash
set -euo pipefail

DROPLET_IP=kavi.io
REMOTE_PATH=/var/www/toedb
SERVICE_NAME=toedb

# Reuse a single SSH connection for all commands
SSH_SOCK="/tmp/deploy-toedb-$$"
ssh -fNM -o ControlMaster=yes -S "$SSH_SOCK" root@"$DROPLET_IP"
cleanup() { ssh -S "$SSH_SOCK" -O exit root@"$DROPLET_IP" 2>/dev/null; }
trap cleanup EXIT

SSH="ssh -S $SSH_SOCK root@$DROPLET_IP"
RSYNC_SSH="ssh -S $SSH_SOCK"

echo "Building..."
npm run build

echo "Uploading to $DROPLET_IP..."
$SSH "mkdir -p $REMOTE_PATH"
rsync -avz --delete -e "$RSYNC_SSH" \
  dist/ \
  dist-server/ \
  server/ \
  package.json \
  package-lock.json \
  root@"$DROPLET_IP":"$REMOTE_PATH/"

echo "Installing dependencies on server..."
$SSH "cd $REMOTE_PATH && npm install --production"

echo "Setting up systemd service..."
$SSH "cat > /etc/systemd/system/$SERVICE_NAME.service" <<'UNIT'
[Unit]
Description=toeDB
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/toedb
ExecStart=/usr/bin/node dist-server/index.js
Restart=on-failure
Environment=PORT=3457
Environment=NODE_ENV=production
Environment=TOEDB_PATH=/var/www/toedb/toedb.sqlite

[Install]
WantedBy=multi-user.target
UNIT

$SSH "systemctl daemon-reload && systemctl enable $SERVICE_NAME && systemctl restart $SERVICE_NAME"

echo "Adding Caddy reverse proxy..."
$SSH 'python3 -c "
import re, sys
path = \"/etc/caddy/Caddyfile\"
with open(path) as f:
    text = f.read()

block = \"\"\"
\tredir /toedb /toedb/ 308
\thandle_path /toedb/* {
\t\treverse_proxy localhost:3457
\t}\"\"\"

# Remove existing toedb block (redir + handle_path) if present
text = re.sub(r\"\n\t*redir /toedb /toedb/[^\n]*\", \"\", text)
text = re.sub(r\"\n\t*handle_path /toedb/\* \{[^}]*\}\", \"\", text)

# Insert after \"kavi.io {\"
text = re.sub(r\"(kavi\.io \{)\", r\"\1\" + block, text)

with open(path, \"w\") as f:
    f.write(text)
print(\"Caddyfile updated\")
"'

$SSH "systemctl reload caddy"

echo "Deploy complete. Visit https://kavi.io/toedb"
