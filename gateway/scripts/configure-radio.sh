#!/bin/bash
# ═══════════════════════════════════════════════════════════
# VergeMesh — Meshtastic Radio Configuration
# Run after flashing Meshtastic firmware to Heltec V4
#
# Prerequisites:
#   - Heltec V4 connected via USB
#   - Meshtastic firmware flashed (use https://flasher.meshtastic.org)
#     → Select "Heltec WiFi LoRa 32 V3" target
#   - meshtastic Python package installed
#
# ⚠️  ALWAYS attach antenna before powering the Heltec V4!
#     Running without antenna damages the SX1262 RF chip permanently.
#
# Usage:
#   pip install meshtastic
#   chmod +x configure-radio.sh
#   ./configure-radio.sh [gateway|relay]
# ═══════════════════════════════════════════════════════════

set -e

MODE="${1:-gateway}"

echo "╔═══════════════════════════════════════════════╗"
echo "║   VergeMesh Radio Configuration               ║"
echo "║   Mode: $MODE"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ── Basic Settings ───────────────────────────────────────
echo "[1/4] Setting LoRa region to US (915 MHz)..."
meshtastic --set lora.region US

echo "[2/4] Setting device name..."
if [ "$MODE" = "gateway" ]; then
    meshtastic --set device.name "VergeMesh-Gateway"
else
    meshtastic --set device.name "VergeMesh-Relay"
fi

# ── MQTT Configuration ───────────────────────────────────
echo "[3/4] Configuring MQTT..."
meshtastic --set mqtt.enabled true
meshtastic --set mqtt.encryption_enabled true

if [ "$MODE" = "gateway" ]; then
    # Gateway uses local Mosquitto broker on Pi
    echo "  → Configuring for local MQTT broker"
    echo "  → After setup, update MQTT address to your Pi's IP:"
    echo "    meshtastic --set mqtt.address 192.168.1.X"

    # Default to public Meshtastic MQTT for initial testing
    meshtastic --set mqtt.address mqtt.meshtastic.org
    meshtastic --set mqtt.username meshdev
    meshtastic --set mqtt.password large4cats
else
    # Relay nodes use public MQTT
    meshtastic --set mqtt.address mqtt.meshtastic.org
    meshtastic --set mqtt.username meshdev
    meshtastic --set mqtt.password large4cats
fi

# ── Channel Configuration ────────────────────────────────
echo "[4/4] Configuring channels..."

# Enable uplink/downlink on primary channel for MQTT bridge
meshtastic --ch-set uplink_enabled true --ch-index 0
meshtastic --ch-set downlink_enabled true --ch-index 0

# Optional: Set up a dedicated VergeMesh channel with PSK
# Uncomment to create a private channel (all nodes must share the same PSK)
# meshtastic --ch-set name vergemesh --ch-set psk random --ch-index 1
# meshtastic --ch-set uplink_enabled true --ch-index 1
# meshtastic --ch-set downlink_enabled true --ch-index 1

echo ""
echo "═══════════════════════════════════════════════════"
echo " ✓ Radio configured as $MODE!"
echo ""
echo " Verify with:"
echo "   meshtastic --info"
echo "   meshtastic --nodes"
echo ""
if [ "$MODE" = "gateway" ]; then
    echo " For private MQTT (recommended):"
    echo "   meshtastic --set mqtt.address <PI_IP_ADDRESS>"
fi
echo ""
echo " ⚠️  REMEMBER: Antenna MUST be attached before powering on!"
echo "═══════════════════════════════════════════════════"
