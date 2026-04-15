/**
 * Meshtastic Bridge — Web Bluetooth connection to Meshtastic radio
 *
 * Implements the Meshtastic BLE protocol using protobuf encoding.
 * Connects via Web Bluetooth to a Meshtastic device, performs the
 * config handshake, and sends/receives text messages over the mesh.
 *
 * Protocol reference: https://meshtastic.org/docs/development/device/client-api/
 *
 * BLE Characteristics:
 *   ToRadio:   f75c76d2-129e-4dad-a1dd-7866124401e7 (write)
 *   FromRadio: 2c55e69e-4993-11ed-b878-0242ac120002 (read)
 *   FromNum:   ed9da18c-a800-4f66-a670-aa7547e34453 (read,notify,write)
 */

const MeshBridge = {
  // Connection state
  connected: false,
  connectionType: null,
  listeners: [],
  _server: null,
  _service: null,
  _toRadio: null,
  _fromRadio: null,
  _fromNum: null,
  _configComplete: false,
  _myNodeNum: 0,
  _configId: 0,
  _packetId: 1000,

  // BLE UUIDs
  SERVICE_UUID:   '6ba1b218-15a8-461f-9fa8-5dcae273eafd',
  TORADIO_UUID:   'f75c76d2-129e-4dad-a1dd-7866124401e7',
  FROMRADIO_UUID: '2c55e69e-4993-11ed-b878-0242ac120002',
  FROMNUM_UUID:   'ed9da18c-a800-4f66-a670-aa7547e34453',

  // ── Protobuf Helpers ──────────────────────────────────────────────
  // Minimal protobuf encoder/decoder for Meshtastic ToRadio/FromRadio
  // Field types: 0=varint, 1=64bit, 2=length-delimited, 5=32bit

  _encodeVarint(value) {
    const bytes = [];
    value = value >>> 0; // ensure unsigned
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return bytes;
  },

  _decodeVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
      const byte = buf[pos];
      result |= (byte & 0x7f) << shift;
      pos++;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) break; // safety
    }
    return { value: result >>> 0, nextOffset: pos };
  },

  _encodeTag(fieldNumber, wireType) {
    return this._encodeVarint((fieldNumber << 3) | wireType);
  },

  _encodeBytes(fieldNumber, data) {
    const tag = this._encodeTag(fieldNumber, 2);
    const len = this._encodeVarint(data.length);
    return [...tag, ...len, ...data];
  },

  _encodeString(fieldNumber, str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    return this._encodeBytes(fieldNumber, Array.from(data));
  },

  _encodeUint32(fieldNumber, value) {
    return [...this._encodeTag(fieldNumber, 0), ...this._encodeVarint(value)];
  },

  _encodeFixed32(fieldNumber, value) {
    const tag = this._encodeTag(fieldNumber, 5);
    const bytes = [
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff
    ];
    return [...tag, ...bytes];
  },

  _encodeBool(fieldNumber, value) {
    return this._encodeUint32(fieldNumber, value ? 1 : 0);
  },

  /**
   * Decode a protobuf message into fields
   * Returns array of { fieldNumber, wireType, value }
   */
  _decodeMessage(buf) {
    const fields = [];
    let offset = 0;
    while (offset < buf.length) {
      const tagResult = this._decodeVarint(buf, offset);
      offset = tagResult.nextOffset;
      const fieldNumber = tagResult.value >> 3;
      const wireType = tagResult.value & 0x7;

      let value;
      switch (wireType) {
        case 0: { // varint
          const r = this._decodeVarint(buf, offset);
          value = r.value;
          offset = r.nextOffset;
          break;
        }
        case 1: { // 64-bit
          value = buf.slice(offset, offset + 8);
          offset += 8;
          break;
        }
        case 2: { // length-delimited
          const lenR = this._decodeVarint(buf, offset);
          offset = lenR.nextOffset;
          value = buf.slice(offset, offset + lenR.value);
          offset += lenR.value;
          break;
        }
        case 5: { // 32-bit fixed
          value = buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24);
          value = value >>> 0;
          offset += 4;
          break;
        }
        default:
          console.warn('[MeshBridge] Unknown wire type', wireType, 'at offset', offset);
          return fields; // can't continue
      }
      fields.push({ fieldNumber, wireType, value });
    }
    return fields;
  },

  // ── Meshtastic Protobuf Builders ──────────────────────────────────

  /**
   * Build ToRadio protobuf with want_config_id
   * ToRadio { field 3: uint32 want_config_id }
   */
  _buildWantConfig(configId) {
    return new Uint8Array(this._encodeUint32(3, configId));
  },

  /**
   * Build a MeshPacket containing a text message
   * MeshPacket:
   *   field 1: fixed32 from (our node)
   *   field 2: fixed32 to (destination, 0xFFFFFFFF = broadcast)
   *   field 3: Data (decoded) {
   *     field 1: PortNum (varint, TEXT_MESSAGE_APP = 1)
   *     field 2: bytes payload (the text)
   *     field 6: bool want_response = false
   *   }
   *   field 6: uint32 id (packet id)
   *   field 7: bool want_ack = true
   *   field 9: uint32 channel = 0
   */
  _buildTextMeshPacket(text, destination = 0xFFFFFFFF, channel = 0) {
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);

    // Build Data submessage (field numbers per mesh.proto Data message)
    const dataFields = [
      ...this._encodeUint32(1, 1), // portnum = TEXT_MESSAGE_APP (1)
      ...this._encodeBytes(2, Array.from(textBytes)), // payload
    ];

    const packetId = this._packetId++;

    // Build MeshPacket (field numbers per mesh.proto MeshPacket message)
    // field 1: fixed32 from (omitted — radio fills in our node num)
    // field 2: fixed32 to
    // field 3: uint32 channel
    // field 4: Data decoded (oneof payload_variant)
    // field 6: fixed32 id
    // field 9: uint32 hop_limit
    // field 10: bool want_ack
    const meshPacket = [
      ...this._encodeFixed32(2, destination),  // to (field 2, fixed32)
      ...this._encodeUint32(3, channel),       // channel (field 3, uint32)
      ...this._encodeBytes(4, dataFields),     // decoded (field 4, Data submessage)
      ...this._encodeFixed32(6, packetId),     // id (field 6, fixed32)
      ...this._encodeUint32(9, 3),             // hop_limit (field 9, uint32)
      ...this._encodeBool(10, true),           // want_ack (field 10, bool)
    ];

    return { bytes: new Uint8Array(meshPacket), packetId };
  },

  /**
   * Build ToRadio protobuf wrapping a MeshPacket
   * ToRadio { field 1: MeshPacket packet }
   */
  _buildToRadioPacket(text, destination, channel) {
    const { bytes: meshPacketBytes, packetId } = this._buildTextMeshPacket(text, destination, channel);
    const toRadio = this._encodeBytes(1, Array.from(meshPacketBytes));
    return { bytes: new Uint8Array(toRadio), packetId };
  },

  // ── FromRadio Decoder ─────────────────────────────────────────────

  /**
   * Parse a FromRadio protobuf and extract text messages
   * FromRadio {
   *   field 1: uint32 id
   *   field 2: MeshPacket packet
   *   field 5: MyNodeInfo my_info
   *   field 6: NodeInfo node_info
   *   field 8: Config config
   *   field 9: LogRecord log_record
   *   field 10: uint32 config_complete_id
   *   field 11: bool rebooted
   *   field 12: ModuleConfig moduleConfig
   *   field 13: Channel channel
   * }
   */
  _parseFromRadio(buf) {
    const uint8 = new Uint8Array(buf);
    const fields = this._decodeMessage(uint8);
    const result = { type: 'unknown' };

    for (const field of fields) {
      switch (field.fieldNumber) {
        case 1: // id
          result.id = field.value;
          break;
        case 2: // MeshPacket
          result.type = 'packet';
          result.meshPacket = this._parseMeshPacket(field.value);
          break;
        case 5: // MyNodeInfo
          result.type = 'my_info';
          result.myInfo = this._parseMyNodeInfo(field.value);
          break;
        case 10: // config_complete_id
          result.type = 'config_complete';
          result.configCompleteId = field.value;
          break;
        case 11: // rebooted
          result.type = 'rebooted';
          break;
      }
    }
    return result;
  },

  _parseMyNodeInfo(buf) {
    const fields = this._decodeMessage(buf);
    const info = {};
    for (const f of fields) {
      if (f.fieldNumber === 1) info.myNodeNum = f.value;
    }
    return info;
  },

  _parseMeshPacket(buf) {
    const fields = this._decodeMessage(buf);
    const pkt = { from: 0, to: 0, decoded: null, id: 0, channel: 0 };

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1: pkt.from = f.value; break;    // from (fixed32)
        case 2: pkt.to = f.value; break;      // to (fixed32)
        case 3: pkt.channel = f.value; break; // channel (uint32)
        case 4: pkt.decoded = this._parseData(f.value); break; // decoded (Data)
        case 6: pkt.id = f.value; break;      // id (fixed32)
      }
    }
    return pkt;
  },

  _parseData(buf) {
    const fields = this._decodeMessage(buf);
    const data = { portnum: 0, payload: null, text: null };

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1: data.portnum = f.value; break;  // portnum
        case 2: // payload (bytes)
          data.payload = f.value;
          data.text = new TextDecoder().decode(new Uint8Array(f.value));
          break;
      }
    }
    return data;
  },

  // ── BLE Connection ────────────────────────────────────────────────

  async connectBLE() {
    if (!('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth not supported. Use Chrome on Android or desktop.');
    }

    try {
      console.log('[MeshBridge] Requesting Bluetooth device...');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.SERVICE_UUID] }],
        optionalServices: [this.SERVICE_UUID]
      });

      console.log('[MeshBridge] Connecting to GATT server...');
      this._server = await device.gatt.connect();

      console.log('[MeshBridge] Getting Meshtastic service...');
      this._service = await this._server.getPrimaryService(this.SERVICE_UUID);

      // Get characteristics
      this._toRadio = await this._service.getCharacteristic(this.TORADIO_UUID);
      this._fromRadio = await this._service.getCharacteristic(this.FROMRADIO_UUID);
      this._fromNum = await this._service.getCharacteristic(this.FROMNUM_UUID);

      this.connected = true;
      this.connectionType = 'ble';

      // Handle disconnection
      device.addEventListener('gattserverdisconnected', () => {
        console.log('[MeshBridge] BLE disconnected');
        this.connected = false;
        this._configComplete = false;
        this._dispatchPacket({ text: '__DISCONNECTED__', from: 'system', to: 'local' });
      });

      // Perform config handshake
      await this._performConfigHandshake();

      // Start listening for notifications
      await this._fromNum.startNotifications();
      this._fromNum.addEventListener('characteristicvaluechanged', () => {
        this._drainFromRadio();
      });

      // Also start a polling loop as backup — some Android BLE stacks
      // don't reliably fire fromNum notifications for incoming mesh packets
      this._startBLEPolling();

      console.log('[MeshBridge] BLE connection complete, listening for packets');
      return true;

    } catch (e) {
      this.connected = false;
      throw new Error(`Bluetooth connection failed: ${e.message}`);
    }
  },

  /**
   * Perform the Meshtastic config handshake
   * Send want_config_id, then drain FromRadio until config_complete
   */
  async _performConfigHandshake() {
    this._configId = Math.floor(Math.random() * 0xFFFFFFFF);
    console.log('[MeshBridge] Sending want_config_id:', this._configId);

    const wantConfig = this._buildWantConfig(this._configId);
    await this._toRadio.writeValue(wantConfig);

    // Drain all config packets
    let emptyCount = 0;
    const maxReads = 200;
    for (let i = 0; i < maxReads; i++) {
      try {
        const value = await this._fromRadio.readValue();
        const buf = new Uint8Array(value.buffer);

        if (buf.length === 0) {
          emptyCount++;
          if (emptyCount > 3) break;
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        emptyCount = 0;

        const parsed = this._parseFromRadio(buf);
        console.log('[MeshBridge] Config packet:', parsed.type);

        if (parsed.type === 'my_info' && parsed.myInfo) {
          this._myNodeNum = parsed.myInfo.myNodeNum;
          console.log('[MeshBridge] My node num:', this._myNodeNum);
        }

        if (parsed.type === 'config_complete') {
          this._configComplete = true;
          console.log('[MeshBridge] Config complete');
          break;
        }

        // Also check for incoming text messages during config
        if (parsed.type === 'packet' && parsed.meshPacket?.decoded?.portnum === 1) {
          const text = parsed.meshPacket.decoded.text;
          if (text && text.startsWith('VMESH:')) {
            this._dispatchPacket({
              text,
              from: parsed.meshPacket.from.toString(),
              to: parsed.meshPacket.to.toString()
            });
          }
        }

      } catch (e) {
        console.warn('[MeshBridge] Config read error:', e);
        await new Promise(r => setTimeout(r, 100));
      }
    }
  },

  /**
   * Read all available FromRadio packets
   */
  async _drainFromRadio() {
    let emptyCount = 0;
    for (let i = 0; i < 50; i++) {
      try {
        const value = await this._fromRadio.readValue();
        const buf = new Uint8Array(value.buffer);

        if (buf.length === 0) {
          emptyCount++;
          if (emptyCount > 2) break;
          continue;
        }
        emptyCount = 0;

        const parsed = this._parseFromRadio(buf);

        if (parsed.type === 'packet' && parsed.meshPacket?.decoded) {
          const data = parsed.meshPacket.decoded;
          // TEXT_MESSAGE_APP = portnum 1
          if (data.portnum === 1 && data.text) {
            console.log('[MeshBridge] Received text:', data.text.substring(0, 80));
            if (data.text.startsWith('VMESH:')) {
              this._dispatchPacket({
                text: data.text,
                from: parsed.meshPacket.from.toString(),
                to: parsed.meshPacket.to.toString()
              });
            }
          }
        }
      } catch (e) {
        console.warn('[MeshBridge] Read error:', e);
        break;
      }
    }
  },

  // ── Serial Connection (USB) ───────────────────────────────────────

  port: null,
  reader: null,
  writer: null,
  _readLoopActive: false,
  _serialBuffer: new Uint8Array(0),

  async connectSerial() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial not supported. Use Chrome on Android or desktop.');
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.connected = true;
      this.connectionType = 'serial';

      // Start reading raw bytes
      this._startSerialReadLoop();

      // Perform config handshake over serial
      await this._performSerialConfigHandshake();

      return true;
    } catch (e) {
      this.connected = false;
      throw new Error(`Serial connection failed: ${e.message}`);
    }
  },

  // Serial protocol framing: 0x94 0xC3 [MSB len] [LSB len] [protobuf data]
  START1: 0x94,
  START2: 0xC3,

  _frameSerialPacket(protobufBytes) {
    const len = protobufBytes.length;
    const frame = new Uint8Array(4 + len);
    frame[0] = this.START1;
    frame[1] = this.START2;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(protobufBytes, 4);
    return frame;
  },

  _startSerialReadLoop() {
    if (this._readLoopActive) return;
    this._readLoopActive = true;

    const readLoop = async () => {
      const reader = this.port.readable.getReader();
      try {
        while (this._readLoopActive) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this._processSerialBytes(value);
        }
      } catch (e) {
        if (this._readLoopActive) {
          console.error('[MeshBridge] Serial read error:', e);
        }
      } finally {
        reader.releaseLock();
      }
    };
    readLoop();
  },

  _processSerialBytes(newBytes) {
    // Append to buffer
    const combined = new Uint8Array(this._serialBuffer.length + newBytes.length);
    combined.set(this._serialBuffer);
    combined.set(newBytes, this._serialBuffer.length);
    this._serialBuffer = combined;

    // Look for framed packets
    while (this._serialBuffer.length >= 4) {
      // Find START1 START2
      let startIdx = -1;
      for (let i = 0; i < this._serialBuffer.length - 1; i++) {
        if (this._serialBuffer[i] === this.START1 && this._serialBuffer[i+1] === this.START2) {
          startIdx = i;
          break;
        }
      }

      if (startIdx === -1) {
        // No valid frame start found, keep last byte in case it's START1
        this._serialBuffer = this._serialBuffer.slice(Math.max(0, this._serialBuffer.length - 1));
        break;
      }

      // Discard bytes before frame start
      if (startIdx > 0) {
        this._serialBuffer = this._serialBuffer.slice(startIdx);
      }

      if (this._serialBuffer.length < 4) break;

      const len = (this._serialBuffer[2] << 8) | this._serialBuffer[3];
      if (len > 512) {
        // Invalid, skip this START marker
        this._serialBuffer = this._serialBuffer.slice(2);
        continue;
      }

      if (this._serialBuffer.length < 4 + len) break; // need more data

      const protobufData = this._serialBuffer.slice(4, 4 + len);
      this._serialBuffer = this._serialBuffer.slice(4 + len);

      // Parse FromRadio
      try {
        const parsed = this._parseFromRadio(protobufData);
        this._handleParsedFromRadio(parsed);
      } catch (e) {
        console.warn('[MeshBridge] Serial parse error:', e);
      }
    }
  },

  _handleParsedFromRadio(parsed) {
    if (parsed.type === 'my_info' && parsed.myInfo) {
      this._myNodeNum = parsed.myInfo.myNodeNum;
      console.log('[MeshBridge] My node num:', this._myNodeNum);
    }
    if (parsed.type === 'config_complete') {
      this._configComplete = true;
      console.log('[MeshBridge] Config complete');
    }
    if (parsed.type === 'packet' && parsed.meshPacket?.decoded) {
      const data = parsed.meshPacket.decoded;
      if (data.portnum === 1 && data.text) {
        console.log('[MeshBridge] Received text:', data.text.substring(0, 80));
        if (data.text.startsWith('VMESH:')) {
          this._dispatchPacket({
            text: data.text,
            from: parsed.meshPacket.from.toString(),
            to: parsed.meshPacket.to.toString()
          });
        }
      }
    }
  },

  async _performSerialConfigHandshake() {
    this._configId = Math.floor(Math.random() * 0xFFFFFFFF);
    const wantConfig = this._buildWantConfig(this._configId);
    const framed = this._frameSerialPacket(wantConfig);

    // Write to serial
    const writer = this.port.writable.getWriter();
    await writer.write(framed);
    writer.releaseLock();

    // Wait for config complete
    const start = Date.now();
    while (!this._configComplete && Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this._configComplete) {
      console.warn('[MeshBridge] Config handshake timed out, continuing anyway');
    }
  },

  // ── Public API ────────────────────────────────────────────────────

  async connect() {
    // Try BLE up to 3 times before giving up (GATT errors are often transient)
    let lastBleErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[MeshBridge] BLE connection attempt ${attempt}/3`);
        await this.connectBLE();
        return 'ble';
      } catch (bleErr) {
        lastBleErr = bleErr;
        console.warn(`[MeshBridge] BLE attempt ${attempt} failed:`, bleErr.message);
        if (bleErr.message.includes('User cancelled')) {
          throw bleErr; // User hit cancel — don't retry
        }
        if (attempt < 3) {
          console.log('[MeshBridge] Retrying BLE in 2 seconds...');
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    // All BLE attempts failed — don't fall back to serial (confusing UX)
    throw new Error(`Bluetooth connection failed after 3 attempts: ${lastBleErr.message}. Make sure Meshtastic app is closed and try again.`);
  },

  /**
   * Send a text message over the mesh
   */
  async sendText(text) {
    if (!this.connected) throw new Error('Radio not connected');

    if (this.connectionType === 'ble') {
      const { bytes } = this._buildToRadioPacket(text, 0xFFFFFFFF, 0);
      await this._toRadio.writeValue(bytes);
      console.log('[MeshBridge] Sent via BLE:', text.substring(0, 60));
    } else if (this.connectionType === 'serial') {
      const { bytes } = this._buildToRadioPacket(text, 0xFFFFFFFF, 0);
      const framed = this._frameSerialPacket(bytes);
      const writer = this.port.writable.getWriter();
      await writer.write(framed);
      writer.releaseLock();
      console.log('[MeshBridge] Sent via serial:', text.substring(0, 60));
    }
  },

  /**
   * Register a listener for incoming VMESH packets
   */
  onMessage(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  },

  _blePollingInterval: null,

  _startBLEPolling() {
    if (this._blePollingInterval) clearInterval(this._blePollingInterval);
    this._blePollingInterval = setInterval(() => {
      if (this.connected && this.connectionType === 'ble' && this._fromRadio) {
        this._drainFromRadio();
      } else {
        clearInterval(this._blePollingInterval);
        this._blePollingInterval = null;
      }
    }, 3000); // Poll every 3 seconds
  },

  async disconnect() {
    this._readLoopActive = false;
    this._configComplete = false;
    if (this._blePollingInterval) {
      clearInterval(this._blePollingInterval);
      this._blePollingInterval = null;
    }
    if (this._server) {
      try { this._server.disconnect(); } catch {}
    }
    if (this.port) {
      try { await this.port.close(); } catch {}
    }
    this.connected = false;
    this.connectionType = null;
    this._server = null;
    this._service = null;
    this._toRadio = null;
    this._fromRadio = null;
    this._fromNum = null;
    this.port = null;
  },

  _dispatchPacket(packet) {
    for (const listener of this.listeners) {
      try { listener(packet); } catch (e) {
        console.error('[MeshBridge] Listener error:', e);
      }
    }
  },

  /**
   * Simulate a received packet (for testing without hardware)
   */
  _simulateReceive(text) {
    this._dispatchPacket({ text, from: 'simulator', to: 'local' });
  }
};
