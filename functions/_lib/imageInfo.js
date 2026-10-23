// An image's pixel size, read from its file header without decoding it — for the customer's own
// design (functions/api/customer-design.js), which refuses images too small to reproduce and
// too large to be safe (an "image bomb": a small file that unpacks to an enormous picture).
//
//   imageSize(buf, contentType) → { width, height } or null
//
// PNG: the IHDR chunk, which the format requires to come first. JPEG: the first start-of-frame
// marker (SOF0–SOF15 other than DHT/JPG/DAC — baseline, progressive, lossless), walking the
// segments from the start; a JPEG that reaches its image data with no frame header is refused.
// WebP: the first chunk — VP8 (lossy), VP8L (lossless) or VP8X (extended: the canvas size).
// A header that doesn't match `contentType`, is cut short, or says 0 × 0 is null.

const TYPES = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

export function imageSize(buf, contentType) {
  const want = TYPES[String(contentType || "").toLowerCase()];
  if (!want || !buf) return null;
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const size = want === "png" ? pngSize_(b) : want === "jpeg" ? jpegSize_(b) : webpSize_(b);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function pngSize_(b) {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (sig.some((v, i) => b[i] !== v) || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize_(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xFF) return null;                  // segments follow each other; anything else is broken
    let m = b[i + 1];
    while (m === 0xFF && i + 2 < b.length) { i++; m = b[i + 1]; }   // fill bytes before a marker
    i += 2;
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;   // no length
    if (m === 0xD9 || m === 0xDA) return null;       // end of image / start of scan with no frame header
    if (i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC): precision(1) height(2) width(2).
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      if (i + 7 > b.length) return null;
      return { width: u16be(b, i + 5), height: u16be(b, i + 3) };
    }
    i += len;
  }
  return null;
}

function webpSize_(b) {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8L") {
    if (b[20] !== 0x2F) return null;
    return { width: 1 + (b[21] | ((b[22] & 0x3F) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0F) << 10)) };
  }
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) return null;   // key frame start code
    return { width: u16le(b, 26) & 0x3FFF, height: u16le(b, 28) & 0x3FFF };
  }
  return null;
}
