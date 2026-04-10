#!/bin/bash
# ═══════════════════════════════════════════════════════════
# VergeMesh Gateway — Raspberry Pi Setup Script
# Run on a fresh Raspberry Pi OS Lite (64-bit)
#
# Usage:
#   chmod +x setup-pi.sh
#   sudo ./setup-pi.sh
# ═══════════════════════════════════════════════════════════

set -e

echo "╔═══════════════════════════════════════════════╗"
echo "║   VergeMesh Gateway Pi Setup v1.0             ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ── System Update ────────────────────────────────────────
echo "[1/6] Updating system packages..."
apt update && apt upgrade -y

# ── Install Dependencies ─────────────────────────────────
echo "[2/6] Installing dependencies..."
apt install -y python3-pip python3-venv git mosquitto mosquitto-clients

# ── Create Python Virtual Environment ────────────────────
echo "[3/6] Setting up Python virtual environment..."
VMESH_DIR="/home/pi/vergemesh"
mkdir -p "$VMESH_DIR"

python3 -m venv "$VMESH_DIR/venv"
source "$VMESH_DIR/venv/bin/activate"
pip install meshtastic requests pyserial pypubsub

# ── Copy Gateway Daemon ──────────────────────────────────
echo "[4/6] Installing gateway daemon..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp "$SCRIPT_DIR/gateway_daemon.py" "$VMESH_DIR/"
cp "$SCRIPT_DIR/requirements.txt" "$VMESH_DIR/"

# ── Configure Mosquitto (Private MQTT Broker) ────────────
echo "[5/6] Configuring Mosquitto MQTT broker..."
cat > /etc/mosquitto/conf.d/vergemesh.conf << 'MQTTCONF'
# VergeMesh private MQTT broker
listener 1883
allow_anonymous true
max_connections 50
MQTTCONF

systemctl enable mosquitto
systemctl restart mosquitto

# ── Install Systemd Service ──────────────────────────────
echo "[6/6] Installing systemd service..."
cat > /etc/systemd/system/vergemesh.service << 'SVCEOF'
[Unit]
Description=VergeMesh Gateway Daemon
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/vergemesh
ExecStart=/home/pi/vergemesh/venv/bin/python3 /home/pi/vergemesh/gateway_daemon.py
Restart=always
RestartSec=10
Environment=NOWNODES_KEY=
Environment=XVG_RPC_URL=https://xvg.nownodes.io
Environment=LOG_LEVEL=INFO
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable vergemesh

# ── Set Ownership ────────────────────────────────────────
chown -R pi:pi "$VMESH_DIR"

echo ""
echo "═══════════════════════════════════════════════════"
echo " ✓ VergeMesh Gateway installed!"
echo ""
echo " NEXT STEPS:"
echo "  1. Set your NowNodes API key:"
echo "     sudo nano /etc/systemd/system/vergemesh.service"
echo "     → Edit NOWNODES_KEY= line"
echo ""
echo "  2. Connect Heltec V4 via USB"
echo ""
echo "  3. Flash Meshtastic firmware (see configure-radio.sh)"
echo ""
echo "  4. Start the daemon:"
echo "     sudo systemctl start vergemesh"
echo ""
echo "  5. Check logs:"
echo "     journalctl -u vergemesh -f"
echo "═══════════════════════════════════════════════════"
