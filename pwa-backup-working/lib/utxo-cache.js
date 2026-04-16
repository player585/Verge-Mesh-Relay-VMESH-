/**
 * Three-Tier UTXO Cache System
 *
 * TIER 1 — localStorage cache (instant, zero network)
 * TIER 2 — Live NowNodes API (fast, requires internet)
 * TIER 3 — LoRa mesh UTXO_REQ to Gateway Pi (30 sec, no internet needed)
 */

const UTXOCache = {
  CACHE_KEY: 'vmesh_utxos',
  CACHE_TS_KEY: 'vmesh_utxos_ts',
  CACHE_WARN_MIN: 60,       // show warning after 60 min
  CACHE_HARD_MIN: 360,      // force refresh after 6 hours
  SPENT_KEY: 'vmesh_spent',  // locally tracked spent UTXOs

  /** Get cache age in minutes */
  getCacheAge() {
    const ts = localStorage.getItem(this.CACHE_TS_KEY);
    if (!ts) return Infinity;
    return (Date.now() - parseInt(ts)) / 1000 / 60;
  },

  /** Get human-readable cache age string */
  getCacheAgeString() {
    const age = this.getCacheAge();
    if (age === Infinity) return 'No data';
    if (age < 1) return 'Just now';
    if (age < 60) return `${Math.round(age)} min ago`;
    if (age < 1440) return `${Math.round(age / 60)} hr ago`;
    return `${Math.round(age / 1440)} days ago`;
  },

  /** Get cache safety level: 'safe', 'caution', 'risky', 'expired' */
  getCacheSafety() {
    const age = this.getCacheAge();
    if (age <= 10) return 'safe';
    if (age <= this.CACHE_WARN_MIN) return 'safe';
    if (age <= this.CACHE_HARD_MIN) return 'caution';
    return 'risky';
  },

  /** Read UTXOs from cache */
  getCached() {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  /** Write UTXOs to cache */
  setCache(utxos) {
    localStorage.setItem(this.CACHE_KEY, JSON.stringify(utxos));
    localStorage.setItem(this.CACHE_TS_KEY, Date.now().toString());
  },

  /** Invalidate cache (force refresh on next fetch) */
  invalidate() {
    localStorage.removeItem(this.CACHE_KEY);
    localStorage.removeItem(this.CACHE_TS_KEY);
  },

  /** Mark a UTXO as spent locally (before confirmation) */
  markSpent(txid, vout) {
    const utxos = this.getCached() || [];
    const updated = utxos.filter(u => !(u.txid === txid && u.vout === vout));
    this.setCache(updated);
    // Also track in spent list for double-check
    const spent = JSON.parse(localStorage.getItem(this.SPENT_KEY) || '[]');
    spent.push({ txid, vout, time: Date.now() });
    // Only keep last 50 spent entries
    if (spent.length > 50) spent.shift();
    localStorage.setItem(this.SPENT_KEY, JSON.stringify(spent));
  },

  /** Check if a UTXO was already marked as spent */
  isSpent(txid, vout) {
    const spent = JSON.parse(localStorage.getItem(this.SPENT_KEY) || '[]');
    return spent.some(s => s.txid === txid && s.vout === vout);
  },

  /** Calculate total balance from cached UTXOs */
  getBalance() {
    const utxos = this.getCached();
    if (!utxos || !utxos.length) return 0;
    return utxos.reduce((sum, u) => sum + (u.amount || 0), 0);
  },

  /**
   * Three-tier UTXO fetch
   * @param {string} address - XVG address
   * @param {string} apiKey - NowNodes API key
   * @param {string} rpcUrl - XVG RPC endpoint
   * @param {Function} meshFetch - async function to fetch via mesh (Tier 3)
   * @param {Function} onStatus - status update callback
   * @returns {Promise<Array>} UTXOs
   */
  async fetch(address, apiKey, rpcUrl, meshFetch, onStatus) {
    // TIER 1 — localStorage cache
    const cached = this.getCached();
    const age = this.getCacheAge();

    if (cached && age < this.CACHE_WARN_MIN) {
      onStatus(`Using cached UTXOs (${this.getCacheAgeString()})`);
      return cached;
    }

    // TIER 2 — Live internet fetch via Blockbook REST API
    if (navigator.onLine && apiKey) {
      onStatus('Fetching UTXOs from Blockbook...');
      try {
        const response = await window.fetch(
          `https://xvg-blockbook.nownodes.io/api/v2/utxo/${address}`,
          { headers: { 'api-key': apiKey } }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        // Blockbook returns: [{txid, vout, value (satoshis string), confirmations}]
        const utxos = result.map(u => ({
          txid: u.txid,
          vout: u.vout,
          amount: parseInt(u.value || '0') / 1e8,
          confirmations: u.confirmations || 0
        }));

        // Filter out locally-known spent UTXOs
        const filtered = utxos.filter(u => !this.isSpent(u.txid, u.vout));
        this.setCache(filtered);
        onStatus(`Fetched ${filtered.length} UTXOs from Blockbook`);
        return filtered;
      } catch (e) {
        onStatus(`Blockbook fetch failed: ${e.message}. Trying mesh...`);
      }
    }

    // TIER 3 — LoRa mesh request
    if (typeof meshFetch === 'function') {
      onStatus('No internet — requesting UTXOs via LoRa mesh (~30 sec)...');
      try {
        const utxos = await meshFetch(address);
        const filtered = utxos.filter(u => !this.isSpent(u.txid, u.vout));
        this.setCache(filtered);
        onStatus(`Fetched ${filtered.length} UTXOs via mesh`);
        return filtered;
      } catch (e) {
        throw new Error(`All UTXO sources failed. ${e.message}`);
      }
    }

    // Fall back to stale cache if available
    if (cached) {
      onStatus(`Using stale cache (${this.getCacheAgeString()}) — refresh when possible`);
      return cached;
    }

    throw new Error('No UTXOs available. Connect to internet or get closer to a gateway.');
  },

  /** Select UTXOs for a given amount (simple greedy algorithm) */
  selectUTXOs(amount, fee) {
    const utxos = this.getCached() || [];
    const target = amount + fee;
    const sorted = [...utxos].sort((a, b) => b.amount - a.amount);

    let selected = [];
    let total = 0;

    for (const utxo of sorted) {
      selected.push(utxo);
      total += utxo.amount;
      if (total >= target) break;
    }

    if (total < target) {
      return { sufficient: false, selected: [], total: 0, change: 0 };
    }

    return {
      sufficient: true,
      selected,
      total: parseFloat(total.toFixed(8)),
      change: parseFloat((total - target).toFixed(8))
    };
  }
};
