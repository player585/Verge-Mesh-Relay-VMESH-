# VMESH Demo Guide — Turn-Key Setup

## Step 1: Update the Pi Gateway

SSH into the Pi and run these commands:

```bash
ssh pi@10.0.0.200
cd ~/vmesh && git pull
sudo systemctl restart vergemesh
sudo journalctl -u vergemesh -f
```

**You should see:**
```
[VMESH] INFO RPC endpoint (broadcast only): https://xvg.nownodes.io
[VMESH] INFO Blockbook endpoint: https://xvg-blockbook.nownodes.io
[VMESH] INFO NowNodes key: configured
[VMESH] INFO Radio connected successfully
[VMESH] INFO Listening for VMESH packets...
```

If it says "Failed to connect to radio" — unplug the Heltec V4 USB, wait 5 seconds, plug back in, then restart the service.

**Leave this terminal open** to watch for incoming UTXO requests during the demo.

---

## Step 2: Load the PWA on Your Phone

1. **Close any old VMESH tabs** in Chrome
2. Open Chrome on your Android device
3. Go to: **https://player585.github.io/Verge-Mesh-Relay-VMESH-/pwa/**
4. **Important: Force refresh** — tap the three-dot menu → Settings → Site settings → find the VMESH site → Clear & reset. Then reload the page.
5. Alternatively: Chrome DevTools → Application → Storage → "Clear site data"

**You should see:** VMESH app with "⚠ No Radio" and "🌐 Online" badges.

---

## Step 3: Connect the T-Echo via BLE

1. **Disconnect the Meshtastic app** if open (only one BLE connection allowed at a time)
2. In the PWA, tap **📡 Connect Radio** at the bottom
3. Select "Five Eight Five (585)" (the T-Echo) from the Bluetooth picker
4. Wait for the config handshake to complete

**You should see:** Status badge changes to "🟢 BLE"

---

## Step 4: Set Your XVG Address

1. Tap **⚙ Settings**
2. Paste your XVG address from Ellipal (starts with D)
3. Enter your NowNodes API key: `5d5c5070-b024-4db3-ba55-2076e748c50f`
4. Tap **Save Settings**

---

## Step 5: Demo — Fetch Balance & UTXOs

Tap **Fetch UTXOs** on the home screen.

**What happens behind the scenes:**
1. PWA tries Blockbook directly (internet is on) → should succeed instantly
2. If that fails, sends `VMESH:UTXO_REQ` via BLE → T-Echo → LoRa → Heltec → Pi → Blockbook API → response back over mesh

**Pi logs should show:** `UTXO request for D9Bxp3...` → `Sent 1 UTXOs for D9Bxp3...`

**PWA should show:** Balance of ~3,056 XVG

---

## Step 6: Demo — Show the Mesh Path (for audience)

To demonstrate the full mesh relay visually:

1. On the T-Echo, you'll see raw VMESH protocol messages scrolling on the e-ink display
2. On the Pi terminal, you'll see gateway logs processing the requests
3. On the PWA, the balance updates

**Demo talking points:**
- "The phone has no direct connection to the blockchain"
- "It sends a request over Bluetooth to this LoRa radio" (hold up T-Echo)
- "Which transmits over 915MHz radio to the gateway radio" (point to Heltec)
- "Connected to a Raspberry Pi that queries the Verge blockchain"
- "And sends the result back the same way — all without cell service"

---

## Hardware Involved

| Device | Role | Connection |
|--------|------|------------|
| Android Phone | PWA wallet interface | Bluetooth LE to T-Echo |
| LILYGO T-Echo | Mobile LoRa relay | BLE ↔ LoRa |
| Heltec WiFi LoRa V4 | Gateway radio | LoRa ↔ USB Serial |
| Raspberry Pi 4 | Blockchain bridge | USB Serial ↔ Internet |
| Ellipal EC02 | Cold wallet signer | Air-gapped (QR only) |

---

## Troubleshooting

### "No Radio" after connecting
- Close the Meshtastic app on your phone first (only one BLE connection at a time)
- Toggle Bluetooth off/on and try again

### PWA shows old code / stale behavior
- Clear site data: Chrome → Settings → Site settings → VMESH → Clear & reset
- Or open DevTools → Application → "Clear site data"

### Pi says "Failed to connect to radio"
- Unplug Heltec V4 USB, wait 5 seconds, plug back in
- `sudo systemctl restart vergemesh`

### UTXO request timeout (30s)
- Check Pi logs — if no "UTXO request" line appears, the LoRa link is down
- Restart both the Meshtastic service and the gateway: `sudo systemctl restart vergemesh`
- Make sure T-Echo and Heltec are on the same channel (Channel 0, LONG_FAST, US region)

### Balance shows "No data"
- Make sure your XVG address is set in Settings
- Make sure NowNodes API key is entered
- Tap "Fetch UTXOs" — the balance comes from the UTXO data

---

## Step 7: Demo — Send Transaction with ELLIPAL Signing

1. Tap **Send** on the home screen
2. Enter recipient address: `DLv25ww5CipJngsKMYemBTBWH14CUpucxX`
3. Enter amount: `1.585` XVG
4. Tap **Build Transaction**
5. Review the preview — shows recipient, amount, fee, and QR page count
6. Tap **Show QR for ELLIPAL** — this generates the ELLIPAL-compatible QR code(s)

### On the ELLIPAL EC02:
7. Open the Verge (XVG) wallet on your ELLIPAL
8. Choose **Scan to Sign**
9. Scan the QR code(s) displayed on your phone
10. Review the transaction details on the ELLIPAL screen
11. Confirm the signing on the ELLIPAL
12. The ELLIPAL displays a **Signed QR code**

### Back on the Phone:
13. Tap **Scan Signed QR** in the PWA
14. Scan the signed QR from the ELLIPAL screen
15. The PWA broadcasts the signed transaction over mesh:
    - Phone → BLE → T-Echo → LoRa → Heltec → Pi → Verge Network
16. Wait for the ACK from the gateway confirming broadcast

**ELLIPAL QR Format (v3.1):**
- Uses `elp://tosign/XVG/address/base64_tx/XVG/8` URI scheme
- TX version 1 (standard Verge format)
- Includes nTime timestamp field (Verge-specific, PeerCoin heritage)
- ScriptSig contains sender's P2PKH scriptPubKey (signing preparation)
- Base64 uses modified encoding: `/` replaced with `_`
- Multi-page QRs split at 140-character boundaries

### ELLIPAL "signature data parsing failed"
- **Fixed in v3.1** — this was caused by TX version 2 (should be 1) and empty scriptSig
- Clear site data on phone to get the v3.1 update
- If still failing, check that the ELLIPAL firmware supports XVG (v2.3.0+ confirmed)

---

## Version History

| Version | Changes |
|---------|--------|
| v2.6 | Compact UTXO_RESP, checksum tolerance |
| v3.0 | ELLIPAL bridge: QR generation + signed QR parsing |
| v3.1 | Fix ELLIPAL parsing: TX version 1, P2PKH scriptSig in inputs |
