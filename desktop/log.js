// The desktop program's log: what the program and the Worker print, in logs/opendecodesk.log in the
// data folder (Help → Open the log), so a problem on someone's computer can be looked into
// afterwards. Each line starts with the time. When the file passes 5 MB it becomes
// opendecodesk.log.1 (replacing an older one) and a new file starts, so it never grows without end.
// It holds what the code logs — errors, start-up, tracking checks — never passwords or keys.

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 5 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;   // Miniflare colours its output for a terminal

function createLog(dataDir, { maxBytes = MAX_BYTES } = {}) {
  const dir = path.join(dataDir, "logs");
  const file = path.join(dir, "opendecodesk.log");
  fs.mkdirSync(dir, { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) {}
  const rotate = () => {
    try { fs.renameSync(file, file + ".1"); } catch (e) {}
    size = 0;
  };
  // One entry: each of its lines gets the time and where it came from ("program", "worker").
  function write(text, source = "program") {
    const at = new Date().toISOString();
    const lines = String(text).replace(ANSI, "").split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return;
    const out = lines.map(l => `${at} [${source}] ${l}`).join("\n") + "\n";
    if (size + out.length > maxBytes) rotate();
    try { fs.appendFileSync(file, out); size += Buffer.byteLength(out); } catch (e) { /* a full disk mustn't stop the program */ }
  }
  return { file, dir, write };
}

module.exports = { createLog };
