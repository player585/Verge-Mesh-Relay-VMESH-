/**
 * QR Handler — Scan and generate QR codes
 *
 * Uses jsQR library for scanning (works on all browsers including iOS Safari)
 * Uses qrcode-generator for creating QR codes
 *
 * BarcodeDetector API is used as a fast path where available (Chrome/Android),
 * with jsQR as universal fallback.
 */

const QRHandler = {
  _stream: null,
  _scanning: false,
  _scanCallback: null,
  _animFrame: null,
  hasNativeScanner: typeof BarcodeDetector !== 'undefined',

  /**
   * Start the QR scanner
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} canvasEl
   * @param {Function} onResult - callback with decoded string
   * @param {Function} onStatus - status update callback
   */
  async startScanner(videoEl, canvasEl, onResult, onStatus) {
    this._scanning = true;
    this._scanCallback = onResult;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      videoEl.srcObject = this._stream;
      await videoEl.play();

      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

      // Use native BarcodeDetector if available (much faster)
      if (this.hasNativeScanner) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        this._scanWithDetector(videoEl, detector, onResult, onStatus);
      } else {
        // Fallback to jsQR
        this._scanWithJsQR(videoEl, canvasEl, ctx, onResult, onStatus);
      }
    } catch (e) {
      onStatus(`Camera error: ${e.message}`);
      throw e;
    }
  },

  _scanWithDetector(videoEl, detector, onResult, onStatus) {
    const scan = async () => {
      if (!this._scanning) return;

      try {
        const barcodes = await detector.detect(videoEl);
        if (barcodes.length > 0) {
          const value = barcodes[0].rawValue;
          if (value) {
            onResult(value);
            this.stopScanner();
            return;
          }
        }
      } catch {}

      this._animFrame = requestAnimationFrame(scan);
    };
    scan();
  },

  _scanWithJsQR(videoEl, canvasEl, ctx, onResult, onStatus) {
    const scan = () => {
      if (!this._scanning) return;

      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });

        if (code && code.data) {
          onResult(code.data);
          this.stopScanner();
          return;
        }
      }

      this._animFrame = requestAnimationFrame(scan);
    };
    scan();
  },

  /**
   * Stop the scanner and release camera
   */
  stopScanner() {
    this._scanning = false;
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  },

  /**
   * Generate a QR code and render to a container element
   * @param {HTMLElement} container
   * @param {string} data - the string to encode
   * @param {number} size - pixel size (default 280)
   * @returns {HTMLCanvasElement}
   */
  generateQR(container, data, size = 280) {
    container.innerHTML = '';

    // Determine QR version based on data length
    let typeNumber = 0; // auto
    const qr = qrcode(typeNumber, 'M');
    qr.addData(data);
    qr.make();

    // Create image
    const imgTag = qr.createImgTag(Math.floor(size / qr.getModuleCount()), 0);

    // Parse the img tag string to get the data URL
    const match = imgTag.match(/src="([^"]+)"/);
    if (match) {
      const img = document.createElement('img');
      img.src = match[1];
      img.width = size;
      img.height = size;
      img.style.imageRendering = 'pixelated';
      img.alt = 'QR Code';
      container.appendChild(img);
      return img;
    }

    // Fallback: use the HTML table method
    container.innerHTML = qr.createTableTag(Math.floor(size / qr.getModuleCount()));
    return container.firstChild;
  },

  /**
   * Generate a Verge payment URI QR code
   */
  generatePaymentQR(container, address, amount, memo) {
    const uri = VMESH.buildPaymentURI(address, amount, memo);
    this.generateQR(container, uri);
    return uri;
  }
};
