/**
 * Meshtastic Bridge — Web Serial / Web Bluetooth connection to radio
 *
 * Uses the Meshtastic.js library for Web Serial (USB) or Web Bluetooth (BLE)
 * to communicate with stock Meshtastic firmware radios.
 *
 * Since @meshtastic/js doesn't ship a UMD build suitable for direct <script> use,
 * we implement a lightweight serial/BLE bridge using the Web Serial API and
 * Meshtastic Protobuf encoding directly.
 *
 * For the PWA MVP, we use a simplified approach:
 * - Web Serial API for USB connection
 * - Send/receive plain text messages via Meshtastic text channel
 * - VMESH protocol packets are just text messages with VMESH: prefix
 */

const MeshBridge = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  connectionType: null, // 'serial' or 'ble'
  listeners: [],        // packet listeners
  _readLoopActive: false,
  _incomingBuffer: '',

  /**
   * Connect to Meshtastic radio via Web Serial (USB)
   */
  async connectSerial() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial not supported. Use Chrome on Android or desktop.');
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.connected = true;
      this.connectionType = 'serial';

      // Set up writer
      const encoder = new TextEncoderStream();
      encoder.readable.pipeTo(this.port.writable);
      this.writer = encoder.writable.getWriter();

      // Start reading
      this._startReadLoop();

      return true;
    } catch (e) {
      this.connected = false;
      throw new Error(`Serial connection failed: ${e.message}`);
    }
  },

  /**
   * Connect to Meshtastic radio via Web Bluetooth
   */
  async connectBLE() {
    if (!('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth not supported on this browser.');
    }

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd'] }],
        optionalServices: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd']
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('6ba1b218-15a8-461f-9fa8-5dcae273eafd');

      // Meshtastic BLE characteristics
      const toRadio = await service.getCharacteristic('f75c76d2-129e-4dad-a1dd-7866124401e7');
      const fromRadio = await service.getCharacteristic('2c55e69e-4993-11ed-b878-0242ac120002');
      const fromNum = await service.getCharacteristic('ed9da18c-a800-4f66-a670-aa7547e34453');

      this._bleToRadio = toRadio;
      this._bleFromRadio = fromRadio;
      this.connected = true;
      this.connectionType = 'ble';

      // Start BLE notification listener
      await fromNum.startNotifications();
      fromNum.addEventListener('characteristicvaluechanged', () => {
        this._readBLEPacket();
      });

      return true;
    } catch (e) {
      this.connected = false;
      throw new Error(`Bluetooth connection failed: ${e.message}`);
    }
  },

  /**
   * Auto-connect: try serial first, then BLE
   */
  async connect() {
    try {
      await this.connectSerial();
      return 'serial';
    } catch (serialErr) {
      try {
        await this.connectBLE();
        return 'ble';
      } catch (bleErr) {
        throw new Error(`No radio found. Serial: ${serialErr.message}. BLE: ${bleErr.message}`);
      }
    }
  },

  /**
   * Send a text message over the mesh
   * For the serial protocol, we encode as a Meshtastic text message
   */
  async sendText(text) {
    if (!this.connected) throw new Error('Radio not connected');

    if (this.connectionType === 'serial' && this.writer) {
      // Meshtastic serial protocol: send as text command
      // Using the Meshtastic serial API format
      const packet = this._buildSerialTextPacket(text);
      await this.writer.write(packet);
    } else if (this.connectionType === 'ble' && this._bleToRadio) {
      const packet = this._buildBLETextPacket(text);
      await this._bleToRadio.writeValue(packet);
    }
  },

  /**
   * Register a listener for incoming packets
   * @param {Function} callback - receives { text, from, to }
   * @returns {Function} unsubscribe function
   */
  onMessage(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  },

  /**
   * Disconnect from radio
   */
  async disconnect() {
    if (this.port) {
      try { await this.port.close(); } catch {}
    }
    this.connected = false;
    this.connectionType = null;
    this.port = null;
    this.reader = null;
    this.writer = null;
  },

  // ── Internal methods ──────────────────────────────────────────────────

  _startReadLoop() {
    if (this._readLoopActive) return;
    this._readLoopActive = true;

    const decoder = new TextDecoderStream();
    this.port.readable.pipeTo(decoder.writable);
    this.reader = decoder.readable.getReader();

    const readLoop = async () => {
      try {
        while (this._readLoopActive) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._processSerialData(value);
        }
      } catch (e) {
        if (this._readLoopActive) {
          console.error('[MeshBridge] Read error:', e);
        }
      }
    };

    readLoop();
  },

  _processSerialData(data) {
    this._incomingBuffer += data;

    // Look for complete lines (Meshtastic serial outputs newline-delimited)
    let lines = this._incomingBuffer.split('\n');
    this._incomingBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('VMESH:')) {
        this._dispatchPacket({ text: trimmed, from: 'mesh', to: 'local' });
      }
    }
  },

  async _readBLEPacket() {
    if (!this._bleFromRadio) return;
    try {
      const value = await this._bleFromRadio.readValue();
      const text = new TextDecoder().decode(value);
      if (text.startsWith('VMESH:')) {
        this._dispatchPacket({ text, from: 'mesh', to: 'local' });
      }
    } catch {}
  },

  _dispatchPacket(packet) {
    for (const listener of this.listeners) {
      try { listener(packet); } catch (e) {
        console.error('[MeshBridge] Listener error:', e);
      }
    }
  },

  /**
   * Build a Meshtastic serial text message packet
   * Simplified: sends text as a raw serial command
   * In production, this would use proper protobuf encoding
   */
  _buildSerialTextPacket(text) {
    // Meshtastic serial interface expects protobuf-encoded ToRadio packets.
    // For this MVP, we use the meshtastic CLI-compatible text format.
    // The actual production version should use @meshtastic/js protobuf encoding.
    return text + '\n';
  },

  _buildBLETextPacket(text) {
    return new TextEncoder().encode(text);
  },

  /**
   * Simulate a received packet (for testing without hardware)
   */
  _simulateReceive(text) {
    this._dispatchPacket({ text, from: 'simulator', to: 'local' });
  }
};
