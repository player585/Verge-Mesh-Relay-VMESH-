/**
 * ELLIPAL Bridge — Generate ELLIPAL-compatible QR codes for XVG transactions
 *
 * ELLIPAL air-gapped wallet uses a proprietary URI scheme:
 *   tosign:  elp://tosign/CHAINTYPE/address/base64_tx/tokensymbol/decimal
 *   signed:  elp://signed/CHAINTYPE/address/signedHex
 *
 * For UTXO-based coins (BTC forks like XVG), the "tx" field in tosign
 * is a Bitcoin-serialized unsigned transaction, hex-encoded, then
 * base64-encoded with '/' replaced by '_' (URL-safe base64).
 *
 * Reference: https://github.com/ELLIPAL/air-gapped_qrcode_data_format
 *            https://github.com/ELLIPAL/js-ellipal
 */

const EllipalBridge = {

  CHAIN_TYPE: 'XVG',     // Verge chain identifier
  TOKEN_SYMBOL: 'XVG',   // Native coin
  DECIMALS: '8',          // 8 decimal places (satoshi precision)
  MAX_QR_BYTES: 350,      // Max base64 chars per QR page (140 in ELLIPAL's web app, but EC02 camera handles larger QRs fine)
  SATS_PER_COIN: 1e8,     // 100,000,000 satoshis per XVG

  // ─── Raw TX Builder (Bitcoin serialization) ───────────────────────────

  /**
   * Convert an integer to a little-endian hex string of given byte length
   */
  intToLE(value, bytes) {
    let hex = '';
    for (let i = 0; i < bytes; i++) {
      hex += (value & 0xff).toString(16).padStart(2, '0');
      value = Math.floor(value / 256);
    }
    return hex;
  },

  /**
   * Encode a Bitcoin varint (CompactSize)
   */
  varint(n) {
    if (n < 0xfd) return n.toString(16).padStart(2, '0');
    if (n <= 0xffff) return 'fd' + this.intToLE(n, 2);
    if (n <= 0xffffffff) return 'fe' + this.intToLE(n, 4);
    return 'ff' + this.intToLE(n, 8);
  },

  /**
   * Reverse a hex string byte-by-byte (for txid endianness)
   */
  reverseHex(hex) {
    return hex.match(/.{2}/g).reverse().join('');
  },

  /**
   * Convert an XVG amount to satoshis (integer)
   */
  toSatoshis(amount) {
    return Math.round(amount * this.SATS_PER_COIN);
  },

  /**
   * Build a P2PKH output script: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
   * XVG uses Base58Check addresses starting with 'D' (version byte 0x1e)
   */
  addressToScriptPubKey(address) {
    // Decode Base58Check to get the 20-byte pubkey hash
    const decoded = this.base58CheckDecode(address);
    if (!decoded || decoded.length !== 21) {
      throw new Error(`Invalid XVG address: ${address}`);
    }
    // decoded[0] = version byte (0x1e for XVG mainnet), decoded[1..20] = hash160
    const hash160 = decoded.slice(1).map(b => b.toString(16).padStart(2, '0')).join('');

    // P2PKH script: 76 a9 14 <20bytes> 88 ac
    return '76a914' + hash160 + '88ac';
  },

  /**
   * Base58Check decode — returns byte array
   */
  base58CheckDecode(str) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    // Decode base58 to big integer
    let num = BigInt(0);
    for (let i = 0; i < str.length; i++) {
      const idx = ALPHABET.indexOf(str[i]);
      if (idx < 0) throw new Error(`Invalid base58 char: ${str[i]}`);
      num = num * BigInt(58) + BigInt(idx);
    }

    // Convert to bytes (25 bytes for standard addresses)
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;

    // Count leading '1's (which represent leading zero bytes)
    let leadingZeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) leadingZeros++;

    const bytes = new Array(leadingZeros).fill(0);
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }

    // Pad to 25 bytes if needed (version + 20-byte hash + 4-byte checksum)
    while (bytes.length < 25) bytes.unshift(0);

    // Verify checksum (last 4 bytes)
    // For now, trust the address — checksum verification needs SHA-256 double hash
    // which we handle asynchronously separately if needed

    // Return version byte + 20-byte hash (strip checksum)
    return bytes.slice(0, 21);
  },

  /**
   * Build a raw unsigned Bitcoin-format transaction hex
   *
   * ScriptSig is empty (0x00) for each input — the ELLIPAL cold wallet
   * holds the private key and derives the signing script internally.
   * This matches what createrawtransaction produces on a Verge node.
   *
   * @param {Array} inputs  - [{txid, vout}]
   * @param {Object} outputs - {address: amount_in_xvg, ...}
   * @returns {string} hex-encoded unsigned transaction
   */
  buildUnsignedTxHex(inputs, outputs) {
    let hex = '';

    // Version (4 bytes LE) — Verge uses version 1
    hex += this.intToLE(1, 4);

    // Timestamp — Verge includes a 4-byte timestamp (like PeerCoin forks)
    // Use current UNIX timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    hex += this.intToLE(timestamp, 4);

    // Input count (varint)
    hex += this.varint(inputs.length);

    // Inputs
    for (const input of inputs) {
      // Previous tx hash (32 bytes, internal byte order = reversed)
      hex += this.reverseHex(input.txid);
      // Previous output index (4 bytes LE)
      hex += this.intToLE(input.vout, 4);
      // ScriptSig length (0 for unsigned — cold wallet fills this during signing)
      hex += '00';
      // Sequence (4 bytes, 0xffffffff = final)
      hex += 'ffffffff';
    }

    // Output count (varint)
    const outputEntries = Object.entries(outputs);
    hex += this.varint(outputEntries.length);

    // Outputs
    for (const [address, amount] of outputEntries) {
      // Value in satoshis (8 bytes LE)
      const sats = this.toSatoshis(amount);
      // Use BigInt for 8-byte encoding
      let satHex = '';
      let val = BigInt(sats);
      for (let i = 0; i < 8; i++) {
        satHex += (Number(val & BigInt(0xff))).toString(16).padStart(2, '0');
        val = val >> BigInt(8);
      }
      hex += satHex;

      // ScriptPubKey
      const script = this.addressToScriptPubKey(address);
      hex += this.varint(script.length / 2);
      hex += script;
    }

    // Locktime (4 bytes LE, 0 = no locktime)
    hex += this.intToLE(0, 4);

    return hex;
  },

  // ─── Base64 Encoding ──────────────────────────────────────────────────

  /**
   * Hex string to Uint8Array
   */
  hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  },

  /**
   * Standard Base64 encode from Uint8Array
   */
  bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  /**
   * ELLIPAL-safe Base64: standard base64 with '/' → '_' and whitespace stripped
   */
  toEllipalBase64(hexString) {
    const bytes = this.hexToBytes(hexString);
    const b64 = this.bytesToBase64(bytes);
    // ELLIPAL replaces '/' with '_' for URL safety
    return b64.replace(/\//g, '_').replace(/\s/g, '');
  },

  // ─── QR URI Generation ────────────────────────────────────────────────

  /**
   * Build the complete ELLIPAL tosign URI for XVG
   *
   * Format: elp://tosign/XVG/address/base64_tx/XVG/8
   * Multi-page: elp://PAGE:TOTAL@tosign/XVG/address/base64_tx_chunk/XVG/8
   *
   * @param {string} address - sender's XVG address
   * @param {Array} inputs - [{txid, vout}]
   * @param {Object} outputs - {address: amount_in_xvg, ...}
   * @returns {Array<string>} array of QR page URIs (usually 1, sometimes 2+)
   */
  buildTosignURIs(address, inputs, outputs, prebuiltTxHex) {
    // Use pre-built TX hex if provided, otherwise build fresh
    // IMPORTANT: the same hex must be stored for TxAssembler sighash computation
    const txHex = prebuiltTxHex || this.buildUnsignedTxHex(inputs, outputs);
    console.log('[ELLIPAL] Raw unsigned TX hex:', txHex.length, 'chars');
    console.log('[ELLIPAL] TX hex:', txHex);

    // Encode to ELLIPAL-safe base64
    const txB64 = this.toEllipalBase64(txHex);
    console.log('[ELLIPAL] Base64 TX:', txB64.length, 'chars');

    // Check if it fits in one QR page
    if (txB64.length <= this.MAX_QR_BYTES) {
      // Single page — no page indicator needed
      const uri = `elp://tosign/${this.CHAIN_TYPE}/${address}/${txB64}/${this.TOKEN_SYMBOL}/${this.DECIMALS}`;
      console.log('[ELLIPAL] Single-page URI:', uri.length, 'chars');
      return [uri];
    }

    // Multi-page: split the base64 data into chunks
    const chunks = [];
    for (let i = 0; i < txB64.length; i += this.MAX_QR_BYTES) {
      chunks.push(txB64.slice(i, i + this.MAX_QR_BYTES));
    }

    const uris = chunks.map((chunk, idx) => {
      const pageIndicator = `${idx + 1}:${chunks.length}@`;
      return `elp://${pageIndicator}tosign/${this.CHAIN_TYPE}/${address}/${chunk}/${this.TOKEN_SYMBOL}/${this.DECIMALS}`;
    });

    console.log(`[ELLIPAL] Multi-page: ${uris.length} QR pages`);
    return uris;
  },

  // ─── Parse Signed QR ──────────────────────────────────────────────────

  /**
   * Parse an ELLIPAL signed QR code
   *
   * Format: elp://signed/XVG/address/signedHex
   * Multi-page: elp://PAGE:TOTAL@signed/XVG/address/signedHexChunk
   *
   * @param {string} uri - scanned QR content
   * @returns {Object|null} {type, chainType, address, signedHex, page, total}
   */
  parseSignedQR(uri) {
    if (!uri || !uri.startsWith('elp://')) return null;

    const afterScheme = uri.slice(6); // remove 'elp://'

    let page = 1, total = 1;
    let rest = afterScheme;

    // Check for page indicator: "PAGE:TOTAL@..."
    if (rest.includes('@') && rest.indexOf('@') < rest.indexOf('/')) {
      const atIdx = rest.indexOf('@');
      const pageStr = rest.substring(0, atIdx);
      const parts = pageStr.split(':');
      if (parts.length === 2) {
        page = parseInt(parts[0]);
        total = parseInt(parts[1]);
      }
      rest = rest.substring(atIdx + 1);
    }

    // Now rest should be: "signed/CHAINTYPE/address/hexdata"
    if (!rest.startsWith('signed/')) return null;

    const items = rest.split('/');
    // items[0] = 'signed', [1] = chaintype, [2] = address, [3...] = hex data
    if (items.length < 4) return null;

    return {
      type: 'signed',
      chainType: items[1],
      address: items[2],
      signedHex: items.slice(3).join('/'), // rejoin in case hex contains slashes (unlikely)
      page,
      total
    };
  },

  /**
   * Check if a string is an ELLIPAL signed URI
   */
  isSignedURI(str) {
    return str && str.startsWith('elp://') && str.includes('signed/');
  },

  /**
   * Check if a string is an ELLIPAL tosign URI
   */
  isTosignURI(str) {
    return str && str.startsWith('elp://') && str.includes('tosign/');
  }
};
