/**
 * VMESH Protocol v1 — Packet builder/parser for VergeMesh Relay
 *
 * All VMESH packets are plain Meshtastic text messages with a VMESH: prefix.
 * Standard relay nodes treat them as ordinary text and forward unchanged.
 *
 * Packet format: VMESH:<COMMAND>:<SESSION_ID>:<PAYLOAD>
 */

const VMESH = {
  CHUNK_SIZE: 180,          // max hex chars per LoRa chunk (leaves room within 228-byte MTU)
  SESSION_ID_LEN: 8,        // 8-char hex session ID (4-billion collision space)
  INTER_CHUNK_DELAY: 2000,  // ms between chunks (respects LoRa duty cycle)
  ACK_TIMEOUT: 90000,       // ms to wait for gateway ACK
  UTXO_TIMEOUT: 30000,      // ms to wait for UTXO response
  XVG_FEE: 0.1,             // standard XVG network fee

  /** Generate a random session ID */
  generateSessionId() {
    const arr = new Uint8Array(4);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /** SHA-256 first 8 hex chars */
  async sha256first8(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8);
  },

  /** Split signed hex into chunks */
  chunkHex(signedHex) {
    const chunks = [];
    for (let i = 0; i < signedHex.length; i += this.CHUNK_SIZE) {
      chunks.push(signedHex.slice(i, i + this.CHUNK_SIZE));
    }
    return chunks;
  },

  /** Build VMESH:START packet */
  buildStart(sessionId, totalChunks, checksum) {
    return `VMESH:START:${sessionId}:${totalChunks}/${checksum}`;
  },

  /** Build VMESH:CHUNK packet */
  buildChunk(sessionId, index, total, data) {
    return `VMESH:CHUNK:${sessionId}:${index}/${total}:${data}`;
  },

  /** Build VMESH:END packet */
  buildEnd(sessionId) {
    return `VMESH:END:${sessionId}`;
  },

  /** Build VMESH:UTXO_REQ packet */
  buildUtxoReq(sessionId, address) {
    return `VMESH:UTXO_REQ:${sessionId}:${address}`;
  },

  /** Build VMESH:BAL_REQ packet */
  buildBalReq(sessionId, address) {
    return `VMESH:BAL_REQ:${sessionId}:${address}`;
  },

  /** Build VMESH:TX_REQ packet */
  buildTxReq(sessionId, txid) {
    return `VMESH:TX_REQ:${sessionId}:${txid}`;
  },

  /** Build VMESH:LASTTX_REQ packet */
  buildLastTxReq(sessionId, address) {
    return `VMESH:LASTTX_REQ:${sessionId}:${address}`;
  },

  /** Parse an incoming VMESH packet */
  parsePacket(text) {
    if (!text || !text.startsWith('VMESH:')) return null;
    const parts = text.split(':');
    const command = parts[1];

    switch (command) {
      case 'ACK':
        return { type: 'ACK', sessionId: parts[2], txid: parts[3] };

      case 'ERR':
        return { type: 'ERR', sessionId: parts[2], reason: parts[3] };

      case 'UTXO_START':
        return { type: 'UTXO_START', sessionId: parts[2], count: parseInt(parts[3]) };

      case 'UTXO_DATA':
        return { type: 'UTXO_DATA', sessionId: parts[2], index: parseInt(parts[3]), data: parts.slice(4).join(':') };

      case 'UTXO_END':
        return { type: 'UTXO_END', sessionId: parts[2], checksum: parts[3] };

      case 'BAL_RESP':
        return { type: 'BAL_RESP', sessionId: parts[2], balance: parseFloat(parts[3]) };

      case 'TX_RESP':
        return { type: 'TX_RESP', sessionId: parts[2], confirmations: parseInt(parts[3]), status: parts[4] };

      case 'LASTTX_START':
        return { type: 'LASTTX_START', sessionId: parts[2], count: parseInt(parts[3]) };

      case 'LASTTX_DATA':
        return { type: 'LASTTX_DATA', sessionId: parts[2], index: parseInt(parts[3]), data: parts.slice(4).join(':') };

      case 'LASTTX_END':
        return { type: 'LASTTX_END', sessionId: parts[2], checksum: parts[3] };

      case 'LASTTX_RESP':
        return { type: 'LASTTX_RESP', sessionId: parts[2], data: parts[3] };

      default:
        return { type: 'UNKNOWN', raw: text };
    }
  },

  /** Estimate chunk count for a given hex string */
  estimateChunks(hexLength) {
    return Math.ceil(hexLength / this.CHUNK_SIZE);
  },

  /** Validate XVG address format */
  isValidXVGAddress(addr) {
    return typeof addr === 'string' && addr.startsWith('D') && addr.length >= 33 && addr.length <= 35;
  },

  /** Build verge: payment URI */
  buildPaymentURI(address, amount, memo) {
    let uri = `verge:${address}`;
    const params = [];
    if (amount) params.push(`amount=${amount}`);
    if (memo) params.push(`memo=${encodeURIComponent(memo)}`);
    if (params.length) uri += '?' + params.join('&');
    return uri;
  },

  /** Parse verge: payment URI */
  parsePaymentURI(uri) {
    if (!uri.startsWith('verge:')) return null;
    const [addressPart, queryPart] = uri.replace('verge:', '').split('?');
    const params = new URLSearchParams(queryPart || '');
    return {
      address: addressPart,
      amount: params.get('amount') ? parseFloat(params.get('amount')) : null,
      memo: params.get('memo') || null
    };
  },

  /** Error code descriptions */
  errorDescription(code) {
    const descriptions = {
      'checksum_fail':     'Data corrupted during transmission — retransmit',
      'utxo_spent':        'Input already consumed — fetching fresh UTXOs',
      'mempool_conflict':  'Transaction conflicts in mempool — fetching fresh UTXOs',
      'insufficient_fee':  'Fee too low — recalculate',
      'invalid_tx':        'Malformed transaction hex — check signing',
      'api_unavailable':   'Gateway cannot reach XVG network — wait and retry',
      'rejected':          'Network rejected transaction — check manually',
      'session_not_found': 'Session expired at gateway — resend'
    };
    return descriptions[code] || `Unknown error: ${code}`;
  }
};
