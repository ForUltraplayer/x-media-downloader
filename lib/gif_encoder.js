(() => {
  'use strict';

  class ByteBuffer {
    constructor(initialCapacity = 65536) {
      this.buf = new Uint8Array(initialCapacity);
      this.pos = 0;
    }

    ensure(extra) {
      if (this.pos + extra <= this.buf.length) return;
      let nextLen = this.buf.length * 2;
      while (nextLen < this.pos + extra) nextLen *= 2;
      const next = new Uint8Array(nextLen);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }

    writeByte(b) {
      this.ensure(1);
      this.buf[this.pos++] = b & 0xff;
    }

    writeShortLE(v) {
      this.ensure(2);
      this.buf[this.pos++] = v & 0xff;
      this.buf[this.pos++] = (v >> 8) & 0xff;
    }

    writeBytes(arr) {
      this.ensure(arr.length);
      this.buf.set(arr, this.pos);
      this.pos += arr.length;
    }

    writeAscii(str) {
      this.ensure(str.length);
      for (let i = 0; i < str.length; i++) {
        this.buf[this.pos++] = str.charCodeAt(i) & 0xff;
      }
    }

    toUint8Array() {
      return this.buf.subarray(0, this.pos);
    }
  }

  function buildPaletteMedianCut(rgba, maxColors = 256) {
    // 5-bit per channel histogram (32 * 32 * 32 = 32768 buckets)
    const hist = new Uint32Array(32768);
    const totalPixels = rgba.length >> 2;
    const step = totalPixels > 80000 ? 2 : 1;

    for (let i = 0; i < rgba.length; i += 4 * step) {
      const r = rgba[i] >> 3;
      const g = rgba[i + 1] >> 3;
      const b = rgba[i + 2] >> 3;
      hist[(r << 10) | (g << 5) | b] += 1;
    }

    const colors = [];
    for (let idx = 0; idx < 32768; idx++) {
      if (hist[idx] > 0) {
        colors.push({
          r: (idx >> 10) & 31,
          g: (idx >> 5) & 31,
          b: idx & 31,
          count: hist[idx],
          idx
        });
      }
    }

    if (colors.length === 0) {
      colors.push({ r: 0, g: 0, b: 0, count: 1, idx: 0 });
    }

    function createBox(items) {
      let rMin = 31, rMax = 0;
      let gMin = 31, gMax = 0;
      let bMin = 31, bMax = 0;
      let total = 0;
      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        if (c.r < rMin) rMin = c.r;
        if (c.r > rMax) rMax = c.r;
        if (c.g < gMin) gMin = c.g;
        if (c.g > gMax) gMax = c.g;
        if (c.b < bMin) bMin = c.b;
        if (c.b > bMax) bMax = c.b;
        total += c.count;
      }
      const spanR = rMax - rMin;
      const spanG = gMax - gMin;
      const spanB = bMax - bMin;
      return {
        items,
        total,
        maxSpan: Math.max(spanR, spanG, spanB),
        axis: spanG >= spanR && spanG >= spanB ? 'g' : spanR >= spanB ? 'r' : 'b'
      };
    }

    const boxes = [createBox(colors)];
    while (boxes.length < maxColors) {
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.items.length > 1 && box.maxSpan > 0) {
          const score = box.maxSpan * Math.sqrt(box.total);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
      }
      if (bestIdx === -1) break;

      const box = boxes.splice(bestIdx, 1)[0];
      const axis = box.axis;
      box.items.sort((a, b) => a[axis] - b[axis]);

      const half = box.total / 2;
      let acc = 0;
      let split = 1;
      for (let i = 0; i < box.items.length - 1; i++) {
        acc += box.items[i].count;
        if (acc >= half) {
          split = i + 1;
          break;
        }
      }

      boxes.push(createBox(box.items.slice(0, split)));
      boxes.push(createBox(box.items.slice(split)));
    }

    const palette = new Uint8Array(256 * 3);
    const palCount = Math.min(256, boxes.length);
    for (let i = 0; i < palCount; i++) {
      const items = boxes[i].items;
      let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
      for (let j = 0; j < items.length; j++) {
        const c = items[j];
        rSum += ((c.r << 3) | (c.r >> 2)) * c.count;
        gSum += ((c.g << 3) | (c.g >> 2)) * c.count;
        bSum += ((c.b << 3) | (c.b >> 2)) * c.count;
        cnt += c.count;
      }
      palette[i * 3] = Math.round(rSum / cnt);
      palette[i * 3 + 1] = Math.round(gSum / cnt);
      palette[i * 3 + 2] = Math.round(bSum / cnt);
    }

    // Build 15-bit lookup table for O(1) pixel quantization
    const lut = new Uint8Array(32768);
    lut.fill(255);
    for (let i = 0; i < palCount; i++) {
      const items = boxes[i].items;
      for (let j = 0; j < items.length; j++) {
        lut[items[j].idx] = i;
      }
    }

    const indexed = new Uint8Array(totalPixels);
    for (let p = 0, o = 0; p < totalPixels; p++, o += 4) {
      const r5 = rgba[o] >> 3;
      const g5 = rgba[o + 1] >> 3;
      const b5 = rgba[o + 2] >> 3;
      const key = (r5 << 10) | (g5 << 5) | b5;
      let palIdx = lut[key];
      if (palIdx === 255) {
        // Nearest color fallback for any unbucketed color (if subsampled)
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        let bestDist = Infinity;
        let best = 0;
        for (let i = 0; i < palCount; i++) {
          const dr = r - palette[i * 3];
          const dg = g - palette[i * 3 + 1];
          const db = b - palette[i * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        palIdx = best;
        lut[key] = best;
      }
      indexed[p] = palIdx;
    }

    return { palette, indexed };
  }

  function writeLzwData(out, indexedPixels, minCodeSize = 8) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    out.writeByte(minCodeSize);

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const dict = new Int32Array(4096 * 256);

    function resetDict() {
      dict.fill(-1);
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }

    const subBlock = new Uint8Array(256);
    let subLen = 0;

    function flushSubBlock() {
      if (subLen > 0) {
        out.writeByte(subLen);
        out.writeBytes(subBlock.subarray(0, subLen));
        subLen = 0;
      }
    }

    let bitBuf = 0;
    let bitCount = 0;

    function emitCode(code) {
      bitBuf |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        subBlock[subLen++] = bitBuf & 0xff;
        if (subLen === 255) flushSubBlock();
        bitBuf >>= 8;
        bitCount -= 8;
      }
    }

    resetDict();
    emitCode(clearCode);

    let prefix = indexedPixels[0];
    for (let i = 1; i < indexedPixels.length; i++) {
      const k = indexedPixels[i];
      const entryIdx = (prefix << 8) | k;
      const found = dict[entryIdx];
      if (found !== -1) {
        prefix = found;
      } else {
        emitCode(prefix);
        if (nextCode < 4096) {
          dict[entryIdx] = nextCode++;
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          emitCode(clearCode);
          resetDict();
        }
        prefix = k;
      }
    }

    emitCode(prefix);
    emitCode(eoiCode);

    if (bitCount > 0) {
      subBlock[subLen++] = bitBuf & 0xff;
    }
    flushSubBlock();
    out.writeByte(0); // Block terminator
  }

  class GifEncoder {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.out = new ByteBuffer(256 * 1024);
      this.started = false;
    }

    writeHeader() {
      if (this.started) return;
      this.started = true;

      // GIF89a Header
      this.out.writeAscii('GIF89a');
      // Logical Screen Descriptor (no global color table; each frame uses local 256-color table)
      this.out.writeShortLE(this.width);
      this.out.writeShortLE(this.height);
      this.out.writeByte(0x70); // Global Color Table = 0, Color Res = 7 (8-bit)
      this.out.writeByte(0);    // Background Color Index
      this.out.writeByte(0);    // Pixel Aspect Ratio

      // Netscape 2.0 Application Extension (infinite loop)
      this.out.writeByte(0x21);
      this.out.writeByte(0xff);
      this.out.writeByte(11);
      this.out.writeAscii('NETSCAPE2.0');
      this.out.writeByte(3);
      this.out.writeByte(1);
      this.out.writeShortLE(0); // 0 = loop forever
      this.out.writeByte(0);
    }

    addFrame(rgba, delayCs = 7) {
      this.writeHeader();
      const { palette, indexed } = buildPaletteMedianCut(rgba, 256);

      // Graphic Control Extension
      this.out.writeByte(0x21);
      this.out.writeByte(0xf9);
      this.out.writeByte(4);
      this.out.writeByte(0x04); // Disposal = 1 (do not dispose)
      this.out.writeShortLE(Math.max(2, Math.round(delayCs)));
      this.out.writeByte(0);
      this.out.writeByte(0);

      // Image Descriptor with Local Color Table (256 colors -> size = 7)
      this.out.writeByte(0x2c);
      this.out.writeShortLE(0);
      this.out.writeShortLE(0);
      this.out.writeShortLE(this.width);
      this.out.writeShortLE(this.height);
      this.out.writeByte(0x87); // Local Color Table flag=1, size=7 (2^(7+1)=256)

      this.out.writeBytes(palette);
      writeLzwData(this.out, indexed, 8);
    }

    finish() {
      this.writeHeader();
      this.out.writeByte(0x3b); // GIF Trailer
      return this.out.toUint8Array();
    }
  }

  if (typeof window !== 'undefined') {
    window.GifEncoder = GifEncoder;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GifEncoder;
  }
})();
