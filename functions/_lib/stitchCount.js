// Stitch count of a machine file, read on the server (migrations/0071) — for design versions uploaded before the
// browser sent the count, and for order designs. The same record rules as admin.js's parseDst_ / parseDsb_:
// a 512-byte header, then 3-byte records; only real stitches count (not jumps, color changes, trims or stops).
// Other formats can't be read here: null (the count is typed in on the design instead).

export const STITCH_COUNT_EXTS = ["dst", "dsb"];

// A .dst some software writes as base64 text: the third byte of a real header is ':' ("LA:").
function dstBytes_(data) {
  if (data.length >= 3 && data[2] !== 0x3A) {
    try {
      const txt = new TextDecoder("ascii").decode(data).replace(/\s/g, "");
      if (/^[A-Za-z0-9+/=]+$/.test(txt)) return Uint8Array.from(atob(txt), c => c.charCodeAt(0));
    } catch (e) {}
  }
  return data;
}

export function countDstStitches(buffer) {
  const data = dstBytes_(new Uint8Array(buffer));
  if (data.length < 512) return null;
  let n = 0;
  for (let i = 512; i + 2 < data.length; i += 3) {
    const b2 = data[i + 2];
    if ((b2 & 0xF3) === 0xF3) break;          // end
    if ((b2 & 0xC3) === 0xC3) continue;       // color change
    if ((b2 & 0x83) === 0x83) continue;       // jump
    n++;
  }
  return n || null;
}

export function countDsbStitches(buffer) {
  const data = new Uint8Array(buffer);
  if (data.length < 512) return null;
  let n = 0;
  for (let i = 512; i + 2 < data.length; i += 3) {
    const low = data[i] & 0x1F;
    if (low === 0) { n++; continue; }         // stitch
    if (low === 1 || low === 7 || low === 8) continue;   // jump / trim / stop
    if (low >= 9 && low <= 23) continue;      // needle change
    break;                                    // end (24) or a code this reader doesn't know
  }
  return n || null;
}

// By the file's extension (or name). null = a format this can't read, or no stitches found.
export function countStitches(buffer, nameOrExt) {
  const ext = String(nameOrExt || "").toLowerCase().replace(/^.*\./, "");
  if (ext === "dst") return countDstStitches(buffer);
  if (ext === "dsb") return countDsbStitches(buffer);
  return null;
}
