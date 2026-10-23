// Shared by the admin upload endpoints (upload.js — public product images;
// receipt.js — private expense receipts): a size-capped body reader and a
// magic-byte check so a file's bytes must match its declared type.

// Validate that the first bytes of the body match the magic signature for
// the declared content-type — guards against a caller sending arbitrary bytes
// labeled as image/png (or similar) to store non-image content in the bucket.
export function hasValidMagicBytes(buf, contentType){
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if(contentType === "image/jpeg")
    return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  if(contentType === "image/png")
    return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  if(contentType === "image/webp")
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
           b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if(contentType === "image/gif")
    return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
           (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
  if(contentType === "application/pdf")
    return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D; // "%PDF-"
  return false;
}

// Reads the request body without ever buffering more than maxBytes. A
// Content-Length pre-check rejects an honest-but-oversized claim before
// touching the stream at all; otherwise this reads chunk-by-chunk and
// cancels the stream (signals the client/edge to stop sending) the moment
// the running total crosses the cap, rather than reading the WHOLE body
// first and checking afterward, which would let a caller stream an
// arbitrarily large body into Worker memory before the size check ever ran.
// Falls back to request.arrayBuffer() when request.body isn't a stream
// (older runtimes/test harnesses) — still cheap at this size cap either way.
export async function readBodyWithLimit(request, maxBytes){
  const contentLength = request.headers.get("Content-Length");
  if(contentLength && Number(contentLength) > maxBytes){
    return { tooLarge: true };
  }
  if(!request.body || !request.body.getReader){
    const buf = await request.arrayBuffer();
    if(buf.byteLength > maxBytes) return { tooLarge: true };
    return { bytes: buf };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    total += value.byteLength;
    if(total > maxBytes){
      try{ await reader.cancel(); }catch(e){ /* best effort */ }
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for(const chunk of chunks){ bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes: bytes.buffer };
}
