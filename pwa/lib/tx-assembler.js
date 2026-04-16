/**
 * TX Assembler — Build a complete signed Verge (XVG) transaction from:
 *   1. The unsigned TX hex (built by EllipalBridge)
 *   2. The raw ECDSA signature (r || s) returned by ELLIPAL
 *
 * ELLIPAL returns raw signature components, NOT a complete signed transaction.
 * We must:
 *   a) Compute the sighash (double SHA-256 of unsigned TX with scriptPubKey per input)
 *   b) Recover the public key from (r, s, sighash) — try both recovery IDs
 *   c) Verify the recovered pubkey matches the sender's address (hash160 check)
 *   d) DER-encode the signature
 *   e) Build the scriptSig: <len> <DER_sig> <SIGHASH_ALL> <pubkey_len> <compressed_pubkey>
 *   f) Insert scriptSig into the unsigned TX to produce the final signed TX
 *
 * Dependencies:
 *   - noble-secp256k1.js (UMD, exposes window.nobleSecp256k1)
 *   - Web Crypto API (for SHA-256)
 *
 * Verge-specific notes:
 *   - TX version 1, with 4-byte nTime after version
 *   - P2PKH only (addresses starting with 'D', version byte 0x1e)
 *   - SIGHASH_ALL = 0x01
 */

const TxAssembler = {

  SIGHASH_ALL: 0x01,
  XVG_ADDR_VERSION: 0x1e,

  // ─── Hex / Byte Utilities ─────────────────────────────────────────

  hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  },

  bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  intToLE(value, bytes) {
    let hex = '';
    for (let i = 0; i < bytes; i++) {
      hex += (value & 0xff).toString(16).padStart(2, '0');
      value = Math.floor(value / 256);
    }
    return hex;
  },

  readLE(hex, offset, bytes) {
    let val = 0;
    for (let i = 0; i < bytes; i++) {
      val += parseInt(hex.substr(offset + i * 2, 2), 16) * Math.pow(256, i);
    }
    return val;
  },

  readVarint(hex, offset) {
    const first = parseInt(hex.substr(offset, 2), 16);
    if (first < 0xfd) return { value: first, size: 1 };
    if (first === 0xfd) return { value: this.readLE(hex, offset + 2, 2), size: 3 };
    if (first === 0xfe) return { value: this.readLE(hex, offset + 2, 4), size: 5 };
    return { value: this.readLE(hex, offset + 2, 8), size: 9 };
  },

  varint(n) {
    if (n < 0xfd) return n.toString(16).padStart(2, '0');
    if (n <= 0xffff) return 'fd' + this.intToLE(n, 2);
    if (n <= 0xffffffff) return 'fe' + this.intToLE(n, 4);
    return 'ff' + this.intToLE(n, 8);
  },

  // ─── SHA-256 (via Web Crypto API) ─────────────────────────────────

  async sha256(data) {
    const buffer = (data instanceof Uint8Array) ? data : this.hexToBytes(data);
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hash);
  },

  async doubleSha256(data) {
    const first = await this.sha256(data);
    return await this.sha256(first);
  },

  // ─── RIPEMD-160 (compact implementation for hash160) ──────────────
  // hash160 = RIPEMD160(SHA256(data))

  ripemd160(bytes) {
    // RIPEMD-160 implementation (public domain, adapted for Uint8Array)
    const K  = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
    const KK = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];
    const R  = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    const RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    const S  = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    const SS = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];

    function f(j, x, y, z) {
      if (j <= 15) return x ^ y ^ z;
      if (j <= 31) return (x & y) | (~x & z);
      if (j <= 47) return (x | ~y) ^ z;
      if (j <= 63) return (x & z) | (y & ~z);
      return x ^ (y | ~z);
    }

    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
    function add32(...args) { return args.reduce((a, b) => (a + b) >>> 0, 0); }

    // Pad message
    const msgLen = bytes.length;
    const bitLen = msgLen * 8;
    const padLen = (msgLen % 64 < 56) ? 56 - msgLen % 64 : 120 - msgLen % 64;
    const padded = new Uint8Array(msgLen + padLen + 8);
    padded.set(bytes);
    padded[msgLen] = 0x80;
    // Little-endian 64-bit length
    for (let i = 0; i < 4; i++) padded[msgLen + padLen + i] = (bitLen >>> (8 * i)) & 0xff;

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

    for (let off = 0; off < padded.length; off += 64) {
      const X = new Array(16);
      for (let i = 0; i < 16; i++) {
        X[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) | (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24);
        X[i] = X[i] >>> 0;
      }

      let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
      let ar = h0, br = h1, cr = h2, dr = h3, er = h4;

      for (let j = 0; j < 80; j++) {
        const rnd = j >> 4;
        let tl = add32(al, f(j, bl, cl, dl), X[R[j]], K[rnd]);
        tl = add32(rotl(tl, S[j]), el);
        al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = tl;

        let tr = add32(ar, f(79 - j, br, cr, dr), X[RR[j]], KK[rnd]);
        tr = add32(rotl(tr, SS[j]), er);
        ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = tr;
      }

      const t = add32(h1, cl, dr);
      h1 = add32(h2, dl, er);
      h2 = add32(h3, el, ar);
      h3 = add32(h4, al, br);
      h4 = add32(h0, bl, cr);
      h0 = t;
    }

    const out = new Uint8Array(20);
    for (let i = 0; i < 4; i++) {
      out[i]      = (h0 >>> (8 * i)) & 0xff;
      out[i + 4]  = (h1 >>> (8 * i)) & 0xff;
      out[i + 8]  = (h2 >>> (8 * i)) & 0xff;
      out[i + 12] = (h3 >>> (8 * i)) & 0xff;
      out[i + 16] = (h4 >>> (8 * i)) & 0xff;
    }
    return out;
  },

  async hash160(bytes) {
    const sha = await this.sha256(bytes);
    return this.ripemd160(sha);
  },

  // ─── Parse Unsigned TX ────────────────────────────────────────────
  // Parses a Verge unsigned TX hex into its components
  // Verge format: version(4) + nTime(4) + vinCount + vins + voutCount + vouts + locktime(4)

  parseUnsignedTx(hex) {
    let pos = 0;

    const version = hex.substr(pos, 8); pos += 8;
    const nTime = hex.substr(pos, 8); pos += 8;

    const vinCount = this.readVarint(hex, pos);
    pos += vinCount.size * 2;

    const inputs = [];
    for (let i = 0; i < vinCount.value; i++) {
      const prevHash = hex.substr(pos, 64); pos += 64;  // 32 bytes
      const prevIndex = hex.substr(pos, 8); pos += 8;    // 4 bytes LE

      const scriptLen = this.readVarint(hex, pos);
      pos += scriptLen.size * 2;
      const script = hex.substr(pos, scriptLen.value * 2);
      pos += scriptLen.value * 2;

      const sequence = hex.substr(pos, 8); pos += 8;

      inputs.push({ prevHash, prevIndex, scriptLen: scriptLen.value, script, sequence });
    }

    const voutCount = this.readVarint(hex, pos);
    pos += voutCount.size * 2;

    const outputs = [];
    for (let i = 0; i < voutCount.value; i++) {
      const value = hex.substr(pos, 16); pos += 16;  // 8 bytes LE (satoshis)

      const scriptLen = this.readVarint(hex, pos);
      pos += scriptLen.size * 2;
      const script = hex.substr(pos, scriptLen.value * 2);
      pos += scriptLen.value * 2;

      outputs.push({ value, scriptLen: scriptLen.value, script });
    }

    const locktime = hex.substr(pos, 8);

    return { version, nTime, inputs, outputs, locktime };
  },

  // ─── Compute Sighash ─────────────────────────────────────────────
  // For P2PKH, the sighash for input N is computed by:
  //   1. Replace the scriptSig of input N with the scriptPubKey of the UTXO being spent
  //   2. Set all other inputs' scriptSig to empty
  //   3. Append SIGHASH_ALL as 4 bytes LE
  //   4. Double SHA-256 the result

  async computeSighash(unsignedTxHex, inputIndex, scriptPubKey) {
    const parsed = this.parseUnsignedTx(unsignedTxHex);

    // Rebuild the TX with the signing script in the correct input
    let hex = '';
    hex += parsed.version;
    hex += parsed.nTime;
    hex += this.varint(parsed.inputs.length);

    for (let i = 0; i < parsed.inputs.length; i++) {
      hex += parsed.inputs[i].prevHash;
      hex += parsed.inputs[i].prevIndex;

      if (i === inputIndex) {
        // Replace with scriptPubKey of the UTXO being spent
        hex += this.varint(scriptPubKey.length / 2);
        hex += scriptPubKey;
      } else {
        // Empty script for other inputs
        hex += '00';
      }

      hex += parsed.inputs[i].sequence;
    }

    hex += this.varint(parsed.outputs.length);
    for (const out of parsed.outputs) {
      hex += out.value;
      hex += this.varint(out.scriptLen);
      hex += out.script;
    }

    hex += parsed.locktime;

    // Append SIGHASH_ALL as 4 bytes LE
    hex += this.intToLE(this.SIGHASH_ALL, 4);

    // Double SHA-256
    return await this.doubleSha256(hex);
  },

  // ─── Recover Public Key ───────────────────────────────────────────
  // Try both recovery IDs (0 and 1) and verify against the sender address

  async recoverPubkey(sighash, rHex, sHex, senderAddress) {
    const secp = window.nobleSecp256k1;
    if (!secp) throw new Error('noble-secp256k1 not loaded');

    // Build compact signature (r || s, 64 bytes = 128 hex chars)
    const compactSig = rHex + sHex;

    // Decode sender address to get the expected hash160
    const decoded = EllipalBridge.base58CheckDecode(senderAddress);
    const expectedHash = this.bytesToHex(decoded.slice(1)); // 20-byte hash160

    console.log('[TxAssembler] Expected hash160:', expectedHash);
    console.log('[TxAssembler] Sighash:', this.bytesToHex(sighash));
    console.log('[TxAssembler] Compact sig:', compactSig);

    // Try recovery ID 0 and 1
    for (let recovery = 0; recovery < 2; recovery++) {
      try {
        const pubkeyBytes = secp.recoverPublicKey(
          this.bytesToHex(sighash),
          compactSig,
          recovery,
          true  // compressed (33 bytes)
        );

        if (!pubkeyBytes) continue;

        // Compute hash160 of recovered pubkey
        const pubkeyHash = await this.hash160(pubkeyBytes);
        const pubkeyHashHex = this.bytesToHex(pubkeyHash);

        console.log(`[TxAssembler] Recovery ${recovery}: pubkey=${this.bytesToHex(pubkeyBytes).substring(0, 20)}... hash160=${pubkeyHashHex}`);

        if (pubkeyHashHex === expectedHash) {
          console.log(`[TxAssembler] ✓ Pubkey recovered with recovery=${recovery}`);
          return pubkeyBytes;
        }
      } catch (e) {
        console.log(`[TxAssembler] Recovery ${recovery} failed:`, e.message);
      }
    }

    throw new Error('Could not recover public key matching sender address');
  },

  // ─── Build Complete Signed TX ─────────────────────────────────────
  // Main entry point: takes unsigned TX hex + raw ELLIPAL signature + address info
  // Returns the complete signed TX hex ready for broadcast

  async buildSignedTx(unsignedTxHex, rawSignatureHex, senderAddress) {
    console.log('[TxAssembler] Building signed TX...');
    console.log('[TxAssembler] Unsigned TX:', unsignedTxHex.length, 'hex chars');
    console.log('[TxAssembler] Raw signature:', rawSignatureHex.length, 'hex chars');
    console.log('[TxAssembler] Sender:', senderAddress);

    const secp = window.nobleSecp256k1;
    if (!secp) throw new Error('noble-secp256k1 not loaded');

    // Validate signature length (should be 128 hex chars = 64 bytes = r + s)
    if (rawSignatureHex.length !== 128) {
      throw new Error(`Expected 128 hex char signature (r||s), got ${rawSignatureHex.length}`);
    }

    // Split into r and s
    const rHex = rawSignatureHex.substring(0, 64);
    const sHex = rawSignatureHex.substring(64, 128);
    console.log('[TxAssembler] r:', rHex);
    console.log('[TxAssembler] s:', sHex);

    // Enforce low-S (BIP-62) — if s > n/2, replace with n - s
    const sig = secp.Signature.fromCompact(rawSignatureHex);
    let finalSig = sig;
    if (sig.hasHighS()) {
      console.log('[TxAssembler] High-S detected, normalizing to low-S');
      finalSig = new secp.Signature(sig.r, secp.CURVE.n - sig.s);
    }

    // Get the scriptPubKey for the sender address (P2PKH)
    const scriptPubKey = EllipalBridge.addressToScriptPubKey(senderAddress);
    console.log('[TxAssembler] ScriptPubKey:', scriptPubKey);

    // Parse the unsigned TX to understand its structure
    const parsed = this.parseUnsignedTx(unsignedTxHex);
    console.log('[TxAssembler] TX has', parsed.inputs.length, 'inputs,', parsed.outputs.length, 'outputs');

    // For each input, compute sighash and recover pubkey
    // (For now we assume all inputs are from the same address — typical for ELLIPAL)
    const scriptSigs = [];
    let recoveredPubkey = null;

    for (let i = 0; i < parsed.inputs.length; i++) {
      console.log(`[TxAssembler] Processing input ${i}...`);

      // Compute sighash for this input
      const sighash = await this.computeSighash(unsignedTxHex, i, scriptPubKey);

      // Recover public key (only need to do this once if all inputs use same address)
      if (!recoveredPubkey) {
        recoveredPubkey = await this.recoverPubkey(sighash, rHex, sHex, senderAddress);
      }

      // DER-encode the (possibly low-S normalized) signature
      const derSig = finalSig.toDERRawBytes();
      const derHex = this.bytesToHex(derSig);

      // Build scriptSig: <len(DER+0x01)> <DER_sig> <0x01 SIGHASH_ALL> <0x21 pubkey_len> <compressed_pubkey>
      const pubkeyHex = this.bytesToHex(recoveredPubkey);
      const sigWithHashType = derHex + '01'; // DER sig + SIGHASH_ALL byte

      const scriptSig = this.varint(sigWithHashType.length / 2) +
                         sigWithHashType +
                         this.varint(pubkeyHex.length / 2) +
                         pubkeyHex;

      scriptSigs.push(scriptSig);
      console.log(`[TxAssembler] Input ${i} scriptSig: ${scriptSig.length} hex chars`);
    }

    // Reconstruct the TX with scriptSigs inserted
    let signedHex = '';
    signedHex += parsed.version;
    signedHex += parsed.nTime;
    signedHex += this.varint(parsed.inputs.length);

    for (let i = 0; i < parsed.inputs.length; i++) {
      signedHex += parsed.inputs[i].prevHash;
      signedHex += parsed.inputs[i].prevIndex;
      signedHex += this.varint(scriptSigs[i].length / 2);
      signedHex += scriptSigs[i];
      signedHex += parsed.inputs[i].sequence;
    }

    signedHex += this.varint(parsed.outputs.length);
    for (const out of parsed.outputs) {
      signedHex += out.value;
      signedHex += this.varint(out.scriptLen);
      signedHex += out.script;
    }

    signedHex += parsed.locktime;

    console.log('[TxAssembler] ✓ Signed TX built:', signedHex.length, 'hex chars');
    console.log('[TxAssembler] Signed TX hex:', signedHex);

    return signedHex;
  }
};
