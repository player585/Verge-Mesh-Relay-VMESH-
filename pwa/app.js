/**
 * VergeMesh Relay PWA — Main Application
 * v1.0 — April 2026
 *
 * Orchestrates: UI screens, Meshtastic bridge, VMESH protocol,
 * three-tier UTXO cache, QR scanner, TX broadcast + ACK.
 */

// ─── STATE ──────────────────────────────────────────────────────────────────
let currentScreen = 'screenHome';
let unsignedTxHex = '';
let signedTxHex = '';
let currentSessionId = '';
let sendCancelled = false;
let scanResolve = null;
let scanReject = null;
const activityLog = [];

// ─── UTXO CHUNK REASSEMBLY (for global listener) ──────────────────────────
const _utxoChunkBuffer = {};  // sessionId → {chunks: {}, total: null}

// ─── SETTINGS (localStorage-backed) ─────────────────────────────────────────
function getSettings() {
  return {
    address:      localStorage.getItem('vmesh_address') || '',
    apiKey:       localStorage.getItem('vmesh_apikey') || '',
    rpcUrl:       localStorage.getItem('vmesh_rpcurl') || 'https://xvg.nownodes.io',
    gatewayNode:  localStorage.getItem('vmesh_gateway_node') || '',
    autoRecovery: localStorage.getItem('vmesh_auto_recovery') !== 'false',
    cacheWarnings: localStorage.getItem('vmesh_cache_warnings') !== 'false'
  };
}

function saveSettings() {
  const s = getSettings();
  localStorage.setItem('vmesh_address', document.getElementById('settingsAddress').value.trim());
  localStorage.setItem('vmesh_apikey', document.getElementById('settingsApiKey').value.trim());
  localStorage.setItem('vmesh_rpcurl', document.getElementById('settingsRpcUrl').value.trim() || 'https://xvg.nownodes.io');
  localStorage.setItem('vmesh_gateway_node', document.getElementById('settingsGatewayNode').value.trim());
  localStorage.setItem('vmesh_auto_recovery', document.getElementById('settingsAutoRecovery').checked);
  localStorage.setItem('vmesh_cache_warnings', document.getElementById('settingsCacheWarnings').checked);

  showToast('Settings saved', 'success');
  updateDashboard();
  showScreen('screenHome');
}

// ─── SCREEN MANAGEMENT ──────────────────────────────────────────────────────
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    currentScreen = screenId;
  }

  // Populate settings fields when navigating to settings
  if (screenId === 'screenSettings') {
    const s = getSettings();
    document.getElementById('settingsAddress').value = s.address;
    document.getElementById('settingsApiKey').value = s.apiKey;
    document.getElementById('settingsRpcUrl').value = s.rpcUrl;
    document.getElementById('settingsGatewayNode').value = s.gatewayNode;
    document.getElementById('settingsAutoRecovery').checked = s.autoRecovery;
    document.getElementById('settingsCacheWarnings').checked = s.cacheWarnings;
  }
}

// ─── TOAST NOTIFICATIONS ────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ` ${type}` : '');
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ─── SPINNER ────────────────────────────────────────────────────────────────
function showSpinner(show, msg = 'Loading...') {
  const overlay = document.getElementById('spinnerOverlay');
  document.getElementById('spinnerMessage').textContent = msg;
  overlay.style.display = show ? 'flex' : 'none';
}

// ─── DASHBOARD UPDATE ───────────────────────────────────────────────────────
function updateDashboard() {
  const s = getSettings();
  const balance = UTXOCache.getBalance();
  const balEl = document.getElementById('balanceDisplay');
  const cacheEl = document.getElementById('cacheAge');
  const addrEl = document.getElementById('addressShort');

  balEl.textContent = balance > 0 ? balance.toFixed(2) : '—';
  cacheEl.textContent = UTXOCache.getCacheAgeString();

  if (s.address) {
    addrEl.textContent = s.address.slice(0, 6) + '...' + s.address.slice(-4);
    addrEl.title = s.address;
    addrEl.onclick = () => {
      navigator.clipboard.writeText(s.address);
      showToast('Address copied');
    };
  } else {
    addrEl.textContent = 'No address set';
    addrEl.onclick = () => showScreen('screenSettings');
  }

  // Update net status
  const netEl = document.getElementById('netStatus');
  if (navigator.onLine) {
    netEl.textContent = '🌐 Online';
    netEl.className = 'status-badge online';
  } else {
    netEl.textContent = '📡 Offline';
    netEl.className = 'status-badge offline';
  }

  // Update activity log
  renderActivityLog();
}

function renderActivityLog() {
  const container = document.getElementById('activityLog');
  if (activityLog.length === 0) {
    container.innerHTML = '<div class="empty-state">No transactions yet. Connect your radio to get started.</div>';
    return;
  }
  container.innerHTML = activityLog
    .slice(-10)
    .reverse()
    .map(item => `
      <div class="activity-item">
        <div>
          <span class="activity-type">${item.type}</span>
          <span style="color:var(--text-secondary);font-size:0.8rem;margin-left:8px;">${item.detail}</span>
        </div>
        <span class="activity-time">${item.time}</span>
      </div>
    `).join('');
}

function logActivity(type, detail) {
  activityLog.push({
    type,
    detail,
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  });
  renderActivityLog();
}

// ─── RADIO CONNECTION ───────────────────────────────────────────────────────
async function connectRadio() {
  const radioEl = document.getElementById('radioStatus');

  try {
    showSpinner(true, 'Connecting to radio...');
    const type = await MeshBridge.connect();

    radioEl.textContent = `🟢 ${type === 'serial' ? 'USB' : 'BLE'}`;
    radioEl.className = 'status-badge online';
    showToast(`Radio connected via ${type}`, 'success');
    logActivity('CONNECT', `Radio via ${type}`);

    // Set up VMESH packet listener
    MeshBridge.onMessage(handleIncomingPacket);

  } catch (e) {
    radioEl.textContent = '⚠ No Radio';
    radioEl.className = 'status-badge offline';
    showToast(e.message, 'error');
  } finally {
    showSpinner(false);
  }
}

function handleIncomingPacket(packet) {
  const parsed = VMESH.parsePacket(packet.text);
  if (!parsed) return;

  console.log('[VMESH] Received:', parsed.type, parsed.sessionId || '');
  logActivity('RX', `${parsed.type} ${parsed.sessionId || ''}`);

  // Handle balance response — update dashboard immediately
  if (parsed.type === 'BAL_RESP' && parsed.balance !== undefined) {
    console.log('[VMESH] Balance update:', parsed.balance, 'XVG');
    const balEl = document.getElementById('balanceDisplay');
    balEl.textContent = parsed.balance > 0 ? parsed.balance.toFixed(2) : '\u2014';
    document.getElementById('cacheAge').textContent = 'Just now (mesh)';
    showToast(`Balance: ${parsed.balance} XVG`, 'success');
  }

  // Handle UTXO chunked response — reassemble and update cache + balance
  if (parsed.type === 'UTXO_START' && parsed.sessionId) {
    _utxoChunkBuffer[parsed.sessionId] = { chunks: {}, total: parsed.count };
    console.log(`[VMESH] UTXO_START sid=${parsed.sessionId} expecting ${parsed.count} chunks`);
  }

  if (parsed.type === 'UTXO_DATA' && parsed.sessionId && _utxoChunkBuffer[parsed.sessionId]) {
    _utxoChunkBuffer[parsed.sessionId].chunks[parsed.index] = parsed.data;
    console.log(`[VMESH] UTXO_DATA sid=${parsed.sessionId} chunk ${parsed.index}`);
  }

  if (parsed.type === 'UTXO_END' && parsed.sessionId && _utxoChunkBuffer[parsed.sessionId]) {
    const buf = _utxoChunkBuffer[parsed.sessionId];
    const fullJson = Object.keys(buf.chunks)
      .sort((a, b) => a - b)
      .map(k => buf.chunks[k])
      .join('');

    delete _utxoChunkBuffer[parsed.sessionId];
    console.log(`[VMESH] UTXO reassembled (${fullJson.length} chars): ${fullJson.substring(0, 120)}...`);

    // Verify checksum then update cache
    VMESH.sha256first8(fullJson).then(hash => {
      const checksumOk = (hash === parsed.checksum);
      if (!checksumOk) {
        console.warn(`[VMESH] UTXO checksum mismatch — expected ${parsed.checksum}, got ${hash}`);
      }

      try {
        const utxos = JSON.parse(fullJson);
        // Accept data even with checksum mismatch if JSON is valid
        // (LoRa can corrupt non-critical bytes; ELLIPAL verifies the actual TX)
        UTXOCache.setCache(utxos);
        updateDashboard();
        const balance = utxos.reduce((sum, u) => sum + (u.amount || 0), 0);
        const src = checksumOk ? 'mesh' : 'mesh (checksum warning)';
        console.log(`[VMESH] UTXOs received via ${src}: ${utxos.length} UTXOs, ${balance.toFixed(2)} XVG`);
        showToast(`${utxos.length} UTXOs loaded (${balance.toFixed(2)} XVG)`, 'success');
      } catch (e) {
        console.error('[VMESH] Failed to parse UTXO JSON:', e, 'Raw:', fullJson.substring(0, 200));
        showToast('UTXO data corrupted — try again', 'error');
      }
    });
  }
}

// ─── UPDATE BALANCE (lightweight BAL_REQ over mesh) ────────────────────────
async function updateBalance() {
  const s = getSettings();
  if (!s.address) {
    showToast('Set your XVG address in Settings first', 'error');
    showScreen('screenSettings');
    return;
  }

  if (!MeshBridge.connected) {
    showToast('Connect radio first', 'error');
    return;
  }

  showSpinner(true, 'Requesting balance via mesh...');
  const sessionId = VMESH.generateSessionId();

  try {
    await MeshBridge.sendText(VMESH.buildBalReq(sessionId, s.address));
    logActivity('TX', `BAL_REQ via mesh`);
    showToast('Balance request sent — waiting for response...', 'success');
  } catch (e) {
    showToast('Failed to send balance request: ' + e.message, 'error');
  } finally {
    showSpinner(false);
  }
}

// ─── UTXO REFRESH ───────────────────────────────────────────────────────────
async function refreshUTXOs() {
  const s = getSettings();
  if (!s.address) {
    showToast('Set your XVG address in Settings first', 'error');
    showScreen('screenSettings');
    return;
  }

  showSpinner(true, 'Fetching UTXOs...');

  try {
    const utxos = await UTXOCache.fetch(
      s.address,
      s.apiKey,
      s.rpcUrl,
      MeshBridge.connected ? fetchUTXOsViaMesh : null,
      (status) => {
        document.getElementById('spinnerMessage').textContent = status;
      }
    );

    showToast(`${utxos.length} UTXOs loaded`, 'success');
    logActivity('UTXO', `${utxos.length} fetched`);
    updateDashboard();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    showSpinner(false);
  }
}

async function fetchUTXOsViaMesh(address) {
  const sessionId = VMESH.generateSessionId();
  const utxoChunks = {};
  let totalChunks = null;

  return new Promise((resolve, reject) => {
    const unsub = MeshBridge.onMessage((packet) => {
      const parsed = VMESH.parsePacket(packet.text);
      if (!parsed || parsed.sessionId !== sessionId) return;

      if (parsed.type === 'UTXO_START') {
        totalChunks = parsed.count;
      } else if (parsed.type === 'UTXO_DATA') {
        utxoChunks[parsed.index] = parsed.data;
      } else if (parsed.type === 'UTXO_END') {
        const fullJson = Object.keys(utxoChunks)
          .sort((a, b) => a - b)
          .map(k => utxoChunks[k])
          .join('');

        // Verify checksum
        VMESH.sha256first8(fullJson).then(hash => {
          if (hash === parsed.checksum) {
            unsub();
            resolve(JSON.parse(fullJson));
          } else {
            unsub();
            reject(new Error('UTXO checksum failed'));
          }
        });
      } else if (parsed.type === 'ERR') {
        unsub();
        reject(new Error(parsed.reason));
      }
    });

    MeshBridge.sendText(VMESH.buildUtxoReq(sessionId, address));

    setTimeout(() => {
      unsub();
      reject(new Error('UTXO request timed out (30s)'));
    }, VMESH.UTXO_TIMEOUT);
  });
}

// ─── SEND FLOW ──────────────────────────────────────────────────────────────
function updateSendSummary() {
  const amount = parseFloat(document.getElementById('sendAmount').value) || 0;
  const fee = VMESH.XVG_FEE;
  const total = amount + fee;
  const estHexLen = 452; // typical 1-in/2-out
  const chunks = VMESH.estimateChunks(estHexLen);

  document.getElementById('summaryAmount').textContent = `${amount.toFixed(2)} XVG`;
  document.getElementById('summaryFee').textContent = `${fee} XVG`;
  document.getElementById('summaryTotal').textContent = `${total.toFixed(2)} XVG`;
  document.getElementById('summaryChunks').textContent = `~${chunks} LoRa packets`;

  // Enable/disable build button
  const addr = document.getElementById('recipientAddr').value.trim();
  const valid = VMESH.isValidXVGAddress(addr) && amount > 0;
  document.getElementById('buildTxBtn').disabled = !valid;

  // Address validation
  const addrErr = document.getElementById('addrError');
  if (addr && !VMESH.isValidXVGAddress(addr)) {
    addrErr.textContent = 'XVG addresses start with D and are 33-35 characters';
  } else {
    addrErr.textContent = '';
  }
}

function setMaxAmount() {
  const balance = UTXOCache.getBalance();
  const max = Math.max(0, balance - VMESH.XVG_FEE);
  document.getElementById('sendAmount').value = max.toFixed(8);
  updateSendSummary();
}

async function buildTransaction() {
  const s = getSettings();
  const recipient = document.getElementById('recipientAddr').value.trim();
  const amount = parseFloat(document.getElementById('sendAmount').value);

  if (!VMESH.isValidXVGAddress(recipient)) {
    showToast('Invalid XVG address', 'error');
    return;
  }

  if (amount <= 0) {
    showToast('Enter a valid amount', 'error');
    return;
  }

  // Select UTXOs
  const selection = UTXOCache.selectUTXOs(amount, VMESH.XVG_FEE);
  if (!selection.sufficient) {
    showToast('Insufficient balance', 'error');
    return;
  }

  // Build unsigned TX preview
  // Note: The actual TX hex construction happens on the signing device (ELLIPAL Titan
  // or Verge Core CLI). The PWA shows the details and generates a QR for the signer.
  const txData = {
    inputs: selection.selected.map(u => ({ txid: u.txid, vout: u.vout })),
    outputs: {
      [recipient]: amount,
      ...(selection.change > 0.00001 ? { [s.address]: selection.change } : {})
    },
    fee: VMESH.XVG_FEE
  };

  // Store for later
  unsignedTxHex = JSON.stringify(txData);

  // Show preview
  document.getElementById('previewTo').textContent = recipient;
  document.getElementById('previewAmount').textContent = `${amount.toFixed(8)} XVG`;
  document.getElementById('previewFee').textContent = `${VMESH.XVG_FEE} XVG`;
  document.getElementById('previewChunks').textContent = `~${VMESH.estimateChunks(452)} LoRa packets`;

  showScreen('screenPreview');
  logActivity('BUILD', `${amount} XVG → ${recipient.slice(0, 8)}...`);
}

function showUnsignedQR() {
  const container = document.getElementById('unsignedQRContainer');
  QRHandler.generateQR(container, unsignedTxHex, 280);
  showScreen('screenQRShow');
}

// ─── QR SCANNING ────────────────────────────────────────────────────────────
async function scanRecipientQR() {
  try {
    const result = await openScanner();
    // Check if it's a verge: payment URI
    const parsed = VMESH.parsePaymentURI(result);
    if (parsed) {
      document.getElementById('recipientAddr').value = parsed.address;
      if (parsed.amount) document.getElementById('sendAmount').value = parsed.amount;
      if (parsed.memo) document.getElementById('sendMemo').value = parsed.memo;
      showToast('Payment details loaded from QR', 'success');
    } else if (VMESH.isValidXVGAddress(result)) {
      document.getElementById('recipientAddr').value = result;
      showToast('Address scanned', 'success');
    } else {
      document.getElementById('recipientAddr').value = result;
    }
    updateSendSummary();
  } catch (e) {
    if (e.message !== 'cancelled') showToast(e.message, 'error');
  }
}

async function scanTitanQR() {
  try {
    const result = await openScanner();
    signedTxHex = result.trim();
    showToast('Signed TX captured', 'success');
    await broadcastSignedTx();
  } catch (e) {
    if (e.message !== 'cancelled') showToast(e.message, 'error');
  }
}

function openScanner() {
  return new Promise((resolve, reject) => {
    scanResolve = resolve;
    scanReject = reject;

    const videoEl = document.getElementById('scannerVideo');
    const canvasEl = document.getElementById('scannerCanvas');

    showScreen('screenScanner');

    QRHandler.startScanner(
      videoEl,
      canvasEl,
      (result) => {
        closeScanner();
        if (scanResolve) scanResolve(result);
      },
      (status) => {
        document.getElementById('scannerStatus').textContent = status;
      }
    ).catch(e => {
      closeScanner();
      if (scanReject) scanReject(e);
    });
  });
}

function closeScanner() {
  QRHandler.stopScanner();
  showScreen(currentScreen === 'screenScanner' ? 'screenSend' : currentScreen);
  if (scanReject) {
    scanReject(new Error('cancelled'));
    scanResolve = null;
    scanReject = null;
  }
}

function useManualHex() {
  const hex = document.getElementById('manualSignedHex').value.trim();
  if (!hex) {
    showToast('Paste the signed transaction hex first', 'error');
    return;
  }
  signedTxHex = hex;
  broadcastSignedTx();
}

// ─── TX BROADCAST ───────────────────────────────────────────────────────────
async function broadcastSignedTx() {
  if (!signedTxHex) {
    showToast('No signed transaction', 'error');
    return;
  }

  // If radio is connected, broadcast over mesh
  if (MeshBridge.connected) {
    showScreen('screenSending');
    sendCancelled = false;
    await broadcastViaMesh(signedTxHex);
  } else if (navigator.onLine) {
    // Fall back to direct API broadcast
    await broadcastViaAPI(signedTxHex);
  } else {
    showToast('Connect radio or internet to broadcast', 'error');
  }
}

async function broadcastViaMesh(hex) {
  const sessionId = VMESH.generateSessionId();
  currentSessionId = sessionId;
  const chunks = VMESH.chunkHex(hex);
  const checksum = await VMESH.sha256first8(hex);
  const total = chunks.length;

  const progressCircle = document.getElementById('progressCircle');
  const statusEl = document.getElementById('sendingStatus');
  const logEl = document.getElementById('chunkLog');
  const percentEl = document.getElementById('progressPercent');
  const circumference = 314; // 2 * π * 50

  logEl.innerHTML = '';
  progressCircle.style.strokeDashoffset = circumference;

  const log = (msg, cls = '') => {
    logEl.innerHTML += `<div class="${cls}">${msg}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    // Send START
    statusEl.textContent = 'Initiating session...';
    log(`→ START sid=${sessionId} chunks=${total} checksum=${checksum}`, 'sent');
    await MeshBridge.sendText(VMESH.buildStart(sessionId, total, checksum));
    await sleep(VMESH.INTER_CHUNK_DELAY);

    if (sendCancelled) throw new Error('Cancelled');

    // Send chunks
    for (let i = 0; i < total; i++) {
      if (sendCancelled) throw new Error('Cancelled');

      const pct = Math.round(((i + 1) / (total + 1)) * 100);
      statusEl.textContent = `Sending chunk ${i + 1}/${total}...`;
      percentEl.textContent = `${pct}%`;
      progressCircle.style.strokeDashoffset = circumference - (circumference * pct / 100);

      log(`→ CHUNK ${i + 1}/${total} (${chunks[i].length} chars)`, 'sent');
      await MeshBridge.sendText(VMESH.buildChunk(sessionId, i, total, chunks[i]));
      await sleep(VMESH.INTER_CHUNK_DELAY);
    }

    // Send END
    statusEl.textContent = 'All chunks sent. Waiting for gateway ACK...';
    percentEl.textContent = '99%';
    log(`→ END sid=${sessionId}`, 'sent');
    await MeshBridge.sendText(VMESH.buildEnd(sessionId));

    // Wait for ACK or ERR
    log('⏳ Waiting for ACK from gateway...', 'waiting');
    const result = await waitForACK(sessionId);

    // Success
    percentEl.textContent = '100%';
    progressCircle.style.strokeDashoffset = 0;
    log(`✓ ACK received: ${result.txid}`, 'sent');

    showResult(true, result.txid);
    logActivity('TX', `Sent → ${result.txid.slice(0, 12)}...`);

  } catch (e) {
    log(`✗ ${e.message}`, 'error');
    if (e.message === 'Cancelled') {
      showToast('Send cancelled', 'error');
      showScreen('screenSend');
    } else {
      handleBroadcastFailure(sessionId, e.message);
    }
  }
}

async function broadcastViaAPI(hex) {
  const s = getSettings();
  showSpinner(true, 'Broadcasting via API...');

  try {
    const response = await fetch(s.rpcUrl, {
      method: 'POST',
      headers: {
        'api-key': s.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendrawtransaction',
        params: [hex]
      })
    });

    const json = await response.json();

    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    const txid = json.result;
    showResult(true, txid);
    logActivity('TX', `API → ${txid.slice(0, 12)}...`);

  } catch (e) {
    showResult(false, null, e.message);
  } finally {
    showSpinner(false);
  }
}

function waitForACK(sessionId) {
  return new Promise((resolve, reject) => {
    const unsub = MeshBridge.onMessage((packet) => {
      const parsed = VMESH.parsePacket(packet.text);
      if (!parsed || parsed.sessionId !== sessionId) return;

      if (parsed.type === 'ACK') {
        unsub();
        resolve({ txid: parsed.txid });
      } else if (parsed.type === 'ERR') {
        unsub();
        reject(new Error(VMESH.errorDescription(parsed.reason)));
      }
    });

    setTimeout(() => {
      unsub();
      reject(new Error('No ACK received — gateway may be offline'));
    }, VMESH.ACK_TIMEOUT);
  });
}

function cancelSend() {
  sendCancelled = true;
}

// ─── RESULT SCREEN ──────────────────────────────────────────────────────────
function showResult(success, txid, errorMsg) {
  const icon = document.getElementById('resultIcon');
  const title = document.getElementById('resultTitle');
  const message = document.getElementById('resultMessage');
  const txidEl = document.getElementById('resultTxid');

  if (success) {
    icon.className = 'result-icon success';
    icon.textContent = '✓';
    title.textContent = 'Broadcast Confirmed';
    message.textContent = 'Transaction accepted into mempool. Confirmation in ~30 seconds.';
    txidEl.textContent = txid;
    txidEl.style.display = 'block';
  } else {
    icon.className = 'result-icon error';
    icon.textContent = '✗';
    title.textContent = 'Broadcast Failed';
    message.textContent = errorMsg || 'Unknown error';
    txidEl.style.display = 'none';
  }

  showScreen('screenResult');
}

function sendAnother() {
  signedTxHex = '';
  unsignedTxHex = '';
  document.getElementById('recipientAddr').value = '';
  document.getElementById('sendAmount').value = '';
  document.getElementById('sendMemo').value = '';
  showScreen('screenSend');
}

function checkTxViaResult() {
  const txid = document.getElementById('resultTxid').textContent;
  if (txid) {
    document.getElementById('checkTxid').value = txid;
    showScreen('screenCheckTx');
  }
}

// ─── AUTO-RECOVERY ──────────────────────────────────────────────────────────
async function handleBroadcastFailure(sessionId, errorReason) {
  const s = getSettings();
  if (!s.autoRecovery) {
    showResult(false, null, errorReason);
    return;
  }

  // Invalidate cache
  UTXOCache.invalidate();
  showToast(`TX failed: ${errorReason}. Recovering...`, 'error');

  // Try to auto-refresh UTXOs
  try {
    showSpinner(true, 'Refreshing UTXOs for retry...');
    const utxos = await UTXOCache.fetch(
      s.address, s.apiKey, s.rpcUrl,
      MeshBridge.connected ? fetchUTXOsViaMesh : null,
      (status) => { document.getElementById('spinnerMessage').textContent = status; }
    );

    updateDashboard();
    showToast('UTXOs refreshed — you can retry the send', 'success');
    showScreen('screenSend');
  } catch (e) {
    showResult(false, null, `${errorReason}. Auto-recovery also failed: ${e.message}`);
  } finally {
    showSpinner(false);
  }
}

// ─── CHECK TX STATUS ────────────────────────────────────────────────────────
function checkTxStatus() {
  showScreen('screenCheckTx');
}

async function queryTxStatus() {
  const txid = document.getElementById('checkTxid').value.trim();
  if (!txid) {
    showToast('Enter a transaction ID', 'error');
    return;
  }

  if (MeshBridge.connected) {
    showSpinner(true, 'Querying via mesh...');
    const sessionId = VMESH.generateSessionId();

    try {
      const result = await new Promise((resolve, reject) => {
        const unsub = MeshBridge.onMessage((packet) => {
          const parsed = VMESH.parsePacket(packet.text);
          if (!parsed || parsed.sessionId !== sessionId) return;
          if (parsed.type === 'TX_RESP') {
            unsub();
            resolve(parsed);
          } else if (parsed.type === 'ERR') {
            unsub();
            reject(new Error(parsed.reason));
          }
        });

        MeshBridge.sendText(VMESH.buildTxReq(sessionId, txid));
        setTimeout(() => { unsub(); reject(new Error('Timeout')); }, 30000);
      });

      document.getElementById('txCheckStatus').textContent = result.status;
      document.getElementById('txCheckConfs').textContent = result.confirmations;
      document.getElementById('txCheckResult').style.display = 'block';

    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      showSpinner(false);
    }
  } else {
    showToast('Connect radio to query via mesh', 'error');
  }
}

// ─── RECEIVE / REQUEST PAYMENT ──────────────────────────────────────────────
function generateRequestQR() {
  const s = getSettings();
  if (!s.address) {
    showToast('Set your address in Settings first', 'error');
    return;
  }

  const amount = document.getElementById('reqAmount').value || null;
  const memo = document.getElementById('reqMemo').value || null;

  const container = document.getElementById('requestQRContainer');
  const uri = QRHandler.generatePaymentQR(container, s.address, amount, memo);

  container.style.display = 'flex';
  const uriEl = document.getElementById('requestURI');
  uriEl.textContent = uri;
  uriEl.style.display = 'block';
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SERVICE WORKER REGISTRATION ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(() => console.log('[VMESH] Service worker registered'))
    .catch(e => console.error('[VMESH] SW registration failed:', e));
}

// ─── EVENT LISTENERS ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateDashboard();

  // Bind send form inputs
  const addrInput = document.getElementById('recipientAddr');
  const amtInput = document.getElementById('sendAmount');
  if (addrInput) addrInput.addEventListener('input', updateSendSummary);
  if (amtInput) amtInput.addEventListener('input', updateSendSummary);

  // Online/offline detection
  window.addEventListener('online', updateDashboard);
  window.addEventListener('offline', updateDashboard);

  // If no address set, prompt settings
  const s = getSettings();
  if (!s.address) {
    setTimeout(() => {
      showToast('Set your XVG address in Settings to get started');
    }, 1000);
  }
});
