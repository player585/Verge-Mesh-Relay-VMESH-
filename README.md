# VergeMesh Relay (VMESH)

**Offline XVG payments over Meshtastic LoRa mesh — no internet required on your device.**

Sign XVG transactions completely offline, broadcast them over a LoRa radio mesh to a gateway node, and have them confirmed on the Verge blockchain. Private keys never leave your signing device. The mesh is just a pipe.

---

## How It Works

```
[Phone — fully offline]
    ↓ USB or Bluetooth
[Any Meshtastic LoRa radio — stock firmware]
    ↓ LoRa RF 915MHz (up to 7 hops)
[Standard relay nodes — no XVG knowledge needed]
    ↓ LoRa RF 915MHz
[VergeMesh Gateway Pi — single internet-connected node]
    ↓ Internet (Wi-Fi, Ethernet, or 4G)
[XVG Network — NowNodes API or local Verge Core]
```

A typical XVG transaction takes **~3 LoRa packets** and **~6 seconds** to transmit.

---

## Components

| Component | Role | Internet |
|-----------|------|----------|
| **VergeMesh PWA** | Android Chrome app — builds TX, scans QR, sends via radio | ❌ Never |
| **Meshtastic Radio** | Heltec V4 or any stock Meshtastic device — dumb pipe | ❌ Never |
| **Relay Nodes** | Any community Meshtastic nodes — extend range for free | ❌ Never |
| **Gateway Pi** | Raspberry Pi 4 — assembles TX, broadcasts to XVG network | ✅ Yes |
| **ELLIPAL Titan** | Air-gapped hardware wallet — signs via QR code | ❌ Never |

---

## Project Structure

```
vmesh/
├── pwa/                        # Progressive Web App (Android Chrome)
│   ├── index.html              # Main PWA shell — all 8 screens
│   ├── style.css               # Dark theme, touch-optimized
│   ├── app.js                  # Main orchestrator
│   ├── manifest.json           # PWA manifest
│   ├── service-worker.js       # Offline caching
│   ├── lib/
│   │   ├── vmesh-protocol.js   # VMESH packet builder/parser
│   │   ├── utxo-cache.js       # Three-tier UTXO fetch system
│   │   ├── meshtastic-bridge.js # Web Serial/BLE radio connection
│   │   └── qr-handler.js       # QR scan (jsQR) + generate
│   └── icons/                  # PWA icons (192, 512)
├── gateway/                    # Raspberry Pi Gateway
│   ├── gateway_daemon.py       # Python daemon — mesh → blockchain bridge
│   ├── requirements.txt        # Python dependencies
│   └── scripts/
│       ├── setup-pi.sh         # Full Pi setup (deps, service, MQTT)
│       └── configure-radio.sh  # Meshtastic radio configuration
└── docs/                       # Documentation
```

---

## Quick Start

### 1. PWA (Phone Side)

The PWA is deployed to GitHub Pages. Open on Android Chrome:

**[https://player585.github.io/Verge-Mesh-Relay-VMESH-/pwa/](https://player585.github.io/Verge-Mesh-Relay-VMESH-/pwa/)**

1. Open in Chrome → tap "Add to Home Screen" for offline access
2. Go to Settings → enter your XVG address and NowNodes API key
3. Connect your Meshtastic radio via USB (Web Serial) or Bluetooth

### 2. Gateway (Pi Side)

```bash
# Clone repo on your Pi
git clone https://github.com/player585/Verge-Mesh-Relay-VMESH-.git
cd Verge-Mesh-Relay-VMESH-

# Run setup (installs deps, MQTT, systemd service)
sudo ./gateway/scripts/setup-pi.sh

# Set your NowNodes API key
sudo nano /etc/systemd/system/vergemesh.service
# Edit: Environment=NOWNODES_KEY=your_key_here

# Configure the Heltec V4 radio
./gateway/scripts/configure-radio.sh gateway

# Start the daemon
sudo systemctl start vergemesh
sudo journalctl -u vergemesh -f    # Watch logs
```

### 3. Send a Transaction

```
1. Open VergeMesh PWA
2. Tap "Send XVG" → enter recipient + amount
3. Build Transaction → Review preview
4. Show QR to ELLIPAL Titan for signing
5. Scan Titan's signed QR
6. Signed TX broadcasts over LoRa → mesh → Gateway Pi
7. Gateway broadcasts to XVG network
8. ACK returns over mesh → "Confirmed!"
```

---

## VMESH Protocol

All VMESH packets are plain Meshtastic text messages with a `VMESH:` prefix. Standard relay nodes treat them as ordinary text.

### Packet Format

```
VMESH:<COMMAND>:<SESSION_ID>:<PAYLOAD>
```

| Command | Direction | Description |
|---------|-----------|-------------|
| `VMESH:START` | Phone → GW | Begin TX session |
| `VMESH:CHUNK` | Phone → GW | Send hex chunk |
| `VMESH:END` | Phone → GW | Signal assembly complete |
| `VMESH:ACK` | GW → Phone | TX confirmed |
| `VMESH:ERR` | GW → Phone | TX rejected |
| `VMESH:UTXO_REQ` | Phone → GW | Request UTXOs |
| `VMESH:BAL_REQ` | Phone → GW | Request balance |
| `VMESH:TX_REQ` | Phone → GW | Check TX status |

---

## Three-Tier UTXO Fetch

```
TIER 1 — localStorage cache (instant, zero network)
  ↓ if stale or missing
TIER 2 — NowNodes API (fast, requires internet)
  ↓ if no internet
TIER 3 — LoRa mesh request to Gateway (30 sec, no internet)
  ↓ if all fail
ERROR — "No UTXOs available"
```

---

## Hardware

| Item | Cost | Required |
|------|------|----------|
| Heltec WiFi LoRa 32 V4 (915MHz) | ~$20 | Yes |
| Raspberry Pi 4 (4GB) | ~$85 | Yes |
| 915MHz Antenna + SMA pigtail | ~$8 | Yes |
| USB-A to USB-C cable | ~$7 | Yes |

**Total: ~$120**

⚠️ **ALWAYS** attach antenna before powering Heltec V4. No antenna = permanent RF damage.

⚠️ Buy **915MHz** version (US). 868MHz is EU and illegal in the US.

---

## Security

| Attack | Funds at Risk? | Why |
|--------|---------------|-----|
| Malicious gateway | ❌ No | Can't steal — only relay signed TX |
| Fake gateway ACK | ❌ No | Payment fails, funds stay |
| Stale UTXO double-spend | ❌ No | Network rejects, auto-recovery kicks in |
| LoRa interception | ❌ No | Signed TX is useless without private key |
| **Wrong recipient address** | ✅ **YES** | **Always verify on Titan screen** |

**The Golden Rule:** The ELLIPAL Titan screen shows the exact destination address. That is the only address that matters.

---

## Development Phases

- [x] Phase 0: Research & documentation
- [x] Phase 1: PWA build (all 8 screens, VMESH protocol, QR, UTXO cache)
- [x] Phase 2: Gateway daemon + Pi setup scripts
- [ ] Phase 3: Local bench test with hardware
- [ ] Phase 4: Field test (outdoor deployment, range testing)
- [ ] Phase 5: Community deployment & documentation

---

## Tech Stack

- **PWA:** Vanilla JS, Web Serial API, Web Bluetooth, jsQR, qrcode-generator
- **Gateway:** Python 3, meshtastic library, requests, Mosquitto MQTT
- **Blockchain:** Verge (XVG) — UTXO model, 30-second blocks, privacy-first
- **Radio:** Meshtastic LoRa — 915MHz ISM, up to 7 hops, stock firmware
- **Signing:** ELLIPAL Titan air-gapped wallet (QR-based)

---

## License

MIT

---

*VergeMesh VMESH — The Gateway Pi is the only internet-connected node. The Titan is the only key store. The PWA is the intelligence layer. The mesh is the pipe.*
