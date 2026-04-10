#!/usr/bin/env python3
"""
VergeMesh Gateway Daemon v1.0
─────────────────────────────
Bridges Meshtastic LoRa mesh to XVG blockchain.

Runs on Raspberry Pi 4 connected to a Heltec V4 via USB.
Listens for VMESH protocol packets, reassembles chunked transactions,
broadcasts to XVG network via NowNodes API or local Verge Core node,
and sends ACK/ERR back over the mesh.

Usage:
    python3 gateway_daemon.py

Environment:
    NOWNODES_KEY    — NowNodes XVG API key
    XVG_RPC_URL     — XVG RPC endpoint (default: https://xvg.nownodes.io)
    LOG_LEVEL       — Logging level (default: INFO)
"""

import meshtastic
import meshtastic.serial_interface
from pubsub import pub
import requests
import json
import hashlib
import time
import os
import sys
import threading
import logging
from collections import defaultdict
from datetime import datetime

# ─── CONFIG ──────────────────────────────────────────────────────────────────
NOWNODES_KEY       = os.environ.get("NOWNODES_KEY", "")
XVG_RPC_URL        = os.environ.get("XVG_RPC_URL", "https://xvg.nownodes.io")
RATE_LIMIT_SECONDS = 5       # Min seconds between requests from same node
MAX_SESSIONS       = 50      # Max concurrent sessions before cleanup
SESSION_TIMEOUT    = 300     # Seconds before stale sessions are purged
LOG_LEVEL          = os.environ.get("LOG_LEVEL", "INFO")
SERIAL_PORT        = os.environ.get("SERIAL_PORT", None)  # Auto-detect if None

# ─── LOGGING ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [VMESH] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("vmesh")

# ─── STATE ───────────────────────────────────────────────────────────────────
tx_buffers      = {}   # session_id → dict of {chunk_index: hex_data}
tx_checksums    = {}   # session_id → expected checksum
tx_chunk_counts = {}   # session_id → expected chunk count
tx_timestamps   = {}   # session_id → creation timestamp
last_request    = defaultdict(float)  # node_id → last request timestamp
stats           = {"tx_relayed": 0, "tx_failed": 0, "utxo_served": 0, "uptime_start": time.time()}


def rpc_call(method, params):
    """Call NowNodes XVG JSON-RPC API or local Verge Core node."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    headers = {"Content-Type": "application/json"}

    if NOWNODES_KEY:
        headers["api-key"] = NOWNODES_KEY

    try:
        r = requests.post(XVG_RPC_URL, headers=headers, json=payload, timeout=15)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        log.error(f"RPC call failed ({method}): {e}")
        return {"error": {"message": str(e)}}


def verify_checksum(data: str, expected: str) -> bool:
    """Verify SHA-256 first 8 chars checksum."""
    computed = hashlib.sha256(data.encode()).hexdigest()[:8]
    return computed == expected


def categorize_error(error_str: str) -> str:
    """Map network error to VMESH error code."""
    e = error_str.lower()
    if "missing" in e or "spent" in e:
        return "utxo_spent"
    elif "mempool" in e:
        return "mempool_conflict"
    elif "fee" in e:
        return "insufficient_fee"
    elif "invalid" in e or "parse" in e:
        return "invalid_tx"
    elif "timeout" in e or "connection" in e:
        return "api_unavailable"
    else:
        return "rejected"


def send_chunked(prefix: str, session_id: str, data: str, interface):
    """Send a large string back to the phone in 180-char chunks."""
    chunks = [data[i:i+180] for i in range(0, len(data), 180)]
    checksum = hashlib.sha256(data.encode()).hexdigest()[:8]

    interface.sendText(f"{prefix}_START:{session_id}:{len(chunks)}")
    time.sleep(2)

    for idx, chunk in enumerate(chunks):
        interface.sendText(f"{prefix}_DATA:{session_id}:{idx}:{chunk}")
        time.sleep(2)

    interface.sendText(f"{prefix}_END:{session_id}:{checksum}")


def rate_check(node_id: str) -> bool:
    """Returns True if request is allowed (not rate-limited)."""
    now = time.time()
    if now - last_request[node_id] < RATE_LIMIT_SECONDS:
        return False
    last_request[node_id] = now
    return True


def cleanup_session(session_id: str):
    """Remove session data to free memory."""
    tx_buffers.pop(session_id, None)
    tx_checksums.pop(session_id, None)
    tx_chunk_counts.pop(session_id, None)
    tx_timestamps.pop(session_id, None)


def cleanup_stale_sessions():
    """Purge sessions older than SESSION_TIMEOUT."""
    now = time.time()
    stale = [sid for sid, ts in tx_timestamps.items() if now - ts > SESSION_TIMEOUT]
    for sid in stale:
        log.info(f"Purging stale session: {sid}")
        cleanup_session(sid)


# ─── HANDLERS ────────────────────────────────────────────────────────────────

def handle_start(session_id: str, total: str, checksum: str):
    """Initialize TX assembly session."""
    # Deduplicate: ignore if already processing this session
    if session_id in tx_buffers:
        log.warning(f"Duplicate START for session {session_id} — ignoring")
        return

    # Enforce session limit
    if len(tx_buffers) >= MAX_SESSIONS:
        cleanup_stale_sessions()
        if len(tx_buffers) >= MAX_SESSIONS:
            log.warning("Max sessions reached — dropping new session")
            return

    tx_buffers[session_id] = {}
    tx_checksums[session_id] = checksum
    tx_chunk_counts[session_id] = int(total)
    tx_timestamps[session_id] = time.time()
    log.info(f"Session {session_id}: START — expecting {total} chunks, checksum {checksum}")


def handle_chunk(session_id: str, n: str, data: str):
    """Store an incoming TX chunk."""
    if session_id in tx_buffers:
        tx_buffers[session_id][int(n)] = data
        log.debug(f"Session {session_id}: CHUNK {n} received ({len(data)} chars)")


def handle_end(session_id: str, interface):
    """Assemble chunks, verify, and broadcast to XVG network."""
    if session_id not in tx_buffers:
        interface.sendText(f"VMESH:ERR:{session_id}:session_not_found")
        return

    expected = tx_chunk_counts.get(session_id, 0)
    received = len(tx_buffers[session_id])

    log.info(f"Session {session_id}: END — received {received}/{expected} chunks")

    # Check all chunks arrived
    if received < expected:
        log.warning(f"Session {session_id}: Missing {expected - received} chunks")
        interface.sendText(f"VMESH:ERR:{session_id}:missing_chunks")
        cleanup_session(session_id)
        return

    # Reassemble in order
    full_hex = "".join(
        tx_buffers[session_id].get(i, "")
        for i in range(expected)
    )

    # Verify checksum
    if not verify_checksum(full_hex, tx_checksums[session_id]):
        log.error(f"Session {session_id}: Checksum FAILED")
        interface.sendText(f"VMESH:ERR:{session_id}:checksum_fail")
        stats["tx_failed"] += 1
        cleanup_session(session_id)
        return

    log.info(f"Session {session_id}: Checksum OK — broadcasting {len(full_hex)} chars")

    # Broadcast to XVG network
    try:
        result = rpc_call("sendrawtransaction", [full_hex])

        if "error" in result and result["error"]:
            reason = categorize_error(str(result["error"]))
            log.error(f"Session {session_id}: Broadcast FAILED — {reason}: {result['error']}")
            interface.sendText(f"VMESH:ERR:{session_id}:{reason}")
            stats["tx_failed"] += 1
        else:
            txid = result.get("result", "unknown")
            log.info(f"Session {session_id}: ✓ Broadcast SUCCESS — TXID {txid}")
            interface.sendText(f"VMESH:ACK:{session_id}:{txid[:16]}")
            stats["tx_relayed"] += 1

    except Exception as e:
        reason = categorize_error(str(e))
        log.error(f"Session {session_id}: Exception — {reason}: {e}")
        interface.sendText(f"VMESH:ERR:{session_id}:{reason}")
        stats["tx_failed"] += 1

    cleanup_session(session_id)


def handle_utxo_req(session_id: str, address: str, interface):
    """Fetch UTXOs for address and return over mesh."""
    log.info(f"UTXO request for {address[:12]}...")

    try:
        result = rpc_call("listunspent", [1, 9999, [address]])
        utxos = result.get("result", [])

        # Minify — only send what PWA needs
        minimal = [
            {"txid": u["txid"], "vout": u["vout"],
             "amount": u["amount"], "confirmations": u["confirmations"]}
            for u in utxos
        ]
        data = json.dumps(minimal, separators=(',', ':'))
        send_chunked("VMESH:UTXO", session_id, data, interface)
        stats["utxo_served"] += 1
        log.info(f"Sent {len(utxos)} UTXOs for {address[:12]}...")

    except Exception as e:
        log.error(f"UTXO fetch failed: {e}")
        interface.sendText(f"VMESH:ERR:{session_id}:api_unavailable")


def handle_bal_req(session_id: str, address: str, interface):
    """Return XVG balance for address."""
    try:
        result = rpc_call("listunspent", [1, 9999, [address]])
        utxos = result.get("result", [])
        balance = round(sum(u["amount"] for u in utxos), 8)
        interface.sendText(f"VMESH:BAL_RESP:{session_id}:{balance}")
        log.info(f"Balance for {address[:12]}...: {balance} XVG")

    except Exception as e:
        interface.sendText(f"VMESH:ERR:{session_id}:api_unavailable")


def handle_tx_req(session_id: str, txid: str, interface):
    """Return confirmation count and status for a TXID."""
    try:
        result = rpc_call("getrawtransaction", [txid, 1])
        tx = result.get("result", {})
        confs = tx.get("confirmations", 0)
        status = "confirmed" if confs > 0 else "mempool"
        interface.sendText(f"VMESH:TX_RESP:{session_id}:{confs}:{status}")
        log.info(f"TX status for {txid[:12]}...: {confs} confs ({status})")

    except Exception as e:
        interface.sendText(f"VMESH:TX_RESP:{session_id}:-1:not_found")


def handle_lasttx_req(session_id: str, address: str, interface):
    """Return the most recent TX for an address."""
    try:
        result = rpc_call("listtransactions", ["*", 10, 0, True])
        txs = result.get("result", [])
        relevant = [t for t in txs if t.get("address") == address]

        if relevant:
            t = relevant[0]
            data = json.dumps({
                "txid":          t["txid"][:16],
                "amount":        abs(t["amount"]),
                "direction":     t["category"],
                "confirmations": t.get("confirmations", 0),
                "time":          t.get("time", 0)
            }, separators=(',', ':'))
            send_chunked("VMESH:LASTTX", session_id, data, interface)
        else:
            interface.sendText(f"VMESH:LASTTX_RESP:{session_id}:none")

    except Exception as e:
        interface.sendText(f"VMESH:ERR:{session_id}:api_unavailable")


# ─── MAIN LISTENER ───────────────────────────────────────────────────────────

def on_receive(packet, interface):
    """Main packet dispatcher — runs on every incoming Meshtastic message."""
    try:
        decoded = packet.get("decoded", {})
        if decoded.get("portnum") != "TEXT_MESSAGE_APP":
            return

        text = decoded.get("text", "")
        node_id = str(packet.get("from", "unknown"))

        if not text.startswith("VMESH:"):
            return  # Not a VMESH packet — ignore

        # Rate limiting
        if not rate_check(node_id):
            log.debug(f"Rate-limited node {node_id}")
            return

        parts = text.split(":")
        log.debug(f"Received from {node_id}: {text[:80]}...")

        # ── TX Broadcast ──
        if text.startswith("VMESH:START:"):
            sid = parts[2]
            tc = parts[3].split("/")
            handle_start(sid, tc[0], tc[1])

        elif text.startswith("VMESH:CHUNK:"):
            sid = parts[2]
            n = parts[3].split("/")[0]
            data = ":".join(parts[4:]) if len(parts) > 4 else ""
            handle_chunk(sid, n, data)

        elif text.startswith("VMESH:END:"):
            sid = parts[2]
            threading.Thread(
                target=handle_end, args=(sid, interface), daemon=True
            ).start()

        # ── Data Requests ──
        elif text.startswith("VMESH:UTXO_REQ:"):
            sid, address = parts[2], parts[3]
            threading.Thread(
                target=handle_utxo_req,
                args=(sid, address, interface), daemon=True
            ).start()

        elif text.startswith("VMESH:BAL_REQ:"):
            sid, address = parts[2], parts[3]
            threading.Thread(
                target=handle_bal_req,
                args=(sid, address, interface), daemon=True
            ).start()

        elif text.startswith("VMESH:TX_REQ:"):
            sid, txid = parts[2], parts[3]
            threading.Thread(
                target=handle_tx_req,
                args=(sid, txid, interface), daemon=True
            ).start()

        elif text.startswith("VMESH:LASTTX_REQ:"):
            sid, address = parts[2], parts[3]
            threading.Thread(
                target=handle_lasttx_req,
                args=(sid, address, interface), daemon=True
            ).start()

    except Exception as e:
        log.error(f"Dispatch error: {e}", exc_info=True)


def print_banner():
    """Print startup banner."""
    print("""
╔═══════════════════════════════════════════════╗
║       VergeMesh Gateway Daemon v1.0           ║
║  Bridging LoRa Mesh → XVG Blockchain          ║
╚═══════════════════════════════════════════════╝
    """)
    log.info(f"RPC endpoint: {XVG_RPC_URL}")
    log.info(f"NowNodes key: {'configured' if NOWNODES_KEY else 'NOT SET'}")
    log.info(f"Rate limit: {RATE_LIMIT_SECONDS}s per node")
    log.info(f"Max sessions: {MAX_SESSIONS}")
    log.info(f"Session timeout: {SESSION_TIMEOUT}s")


def stats_reporter():
    """Periodically log stats."""
    while True:
        time.sleep(3600)  # Every hour
        uptime = int(time.time() - stats["uptime_start"])
        log.info(
            f"STATS — Uptime: {uptime//3600}h{(uptime%3600)//60}m | "
            f"TX relayed: {stats['tx_relayed']} | "
            f"TX failed: {stats['tx_failed']} | "
            f"UTXO served: {stats['utxo_served']} | "
            f"Active sessions: {len(tx_buffers)}"
        )
        cleanup_stale_sessions()


def main():
    print_banner()

    if not NOWNODES_KEY and "localhost" not in XVG_RPC_URL:
        log.warning("No NOWNODES_KEY set and not using local node — API calls will fail!")
        log.warning("Set: export NOWNODES_KEY=your_key_here")

    # Start stats reporter
    threading.Thread(target=stats_reporter, daemon=True).start()

    # Connect to Meshtastic radio
    log.info("Connecting to Meshtastic radio...")
    try:
        if SERIAL_PORT:
            iface = meshtastic.serial_interface.SerialInterface(devPath=SERIAL_PORT)
        else:
            iface = meshtastic.serial_interface.SerialInterface()

        log.info("Radio connected successfully")
    except Exception as e:
        log.critical(f"Failed to connect to radio: {e}")
        log.critical("Ensure Heltec V4 is connected via USB and has Meshtastic firmware")
        sys.exit(1)

    # Register packet handler
    pub.subscribe(on_receive, "meshtastic.receive")
    log.info("Listening for VMESH packets...")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Shutting down...")
        iface.close()
        print("\n[VMESH] Gateway stopped.")


if __name__ == "__main__":
    main()
