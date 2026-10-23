const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Barudan .dsb machine files (2026-10), everywhere a Tajima .dst works: accepted as a design version's machine
// file (server and upload window), read in the browser for needle stops and the thread map, previewed on the
// Designs screen / Edit colors / Run Order cards. A .dsb is the same 512-byte header as a .dst, then 3-byte
// records: control byte (0x40 = Y negative, 0x20 = X negative; LOW 5 BITS 0 stitch, 1 jump, 7 trim, 8 stop,
// 9–23 needle change = low − 8, 24 end — written 0xE7…0xF8 or, by some software, 0x87…0x98), then Y, then X.
// Checked against 14 real .dsb files in the shop's archive: those with a
// .dst twin match it in stitch count and size.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const header = () => { const h = Buffer.alloc(512, 0x20); h.write("LA:TEST\r", 0, "latin1"); return h; };
const dsb = (...recs) => new Uint8Array(Buffer.concat([header(), Buffer.from(recs.flat())])).buffer;
const ST = (x, y) => [(y < 0 ? 0x40 : 0) | (x < 0 ? 0x20 : 0), Math.abs(y), Math.abs(x)];
const JMP = (x, y) => [0x01 | (y < 0 ? 0x40 : 0) | (x < 0 ? 0x20 : 0), Math.abs(y), Math.abs(x)];
const NEEDLE = (n) => [0xE8 + n, 0, 0], TRIM = [0xE7, 0, 0], STOP = [0xE8, 0, 0], END = [0xF8, 0, 0];
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const draws = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.TextDecoder = TextDecoder;
      win.HTMLCanvasElement.prototype.getContext = () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(x, y){ draws.push([x, y]); }, stroke(){}, fillText(){}, set strokeStyle(v){ draws.push(v); } });
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  console.log("=== Reading a .dsb ===");
  // Needle 4: a small square; trim + jump; needle 1: two stitches, a stop (same needle), one more; end; junk after.
  const file = dsb(NEEDLE(4), ST(10, 0), ST(0, 10), ST(-10, 0), ST(0, -10), TRIM, JMP(30, 5), NEEDLE(1), ST(5, 5), ST(5, -5), STOP, ST(5, 0), END, ST(99, 99));
  const p = w.parseDsb_(file);
  ok("needle stops, color changes and stitches are counted (a jump isn't a stitch; a stop keeps the needle)", p.needleStops === 2 && p.colorChanges === 2 && p.stitchCount === 7);
  ok("…the needle each block runs on is read from the file", p.needles.join() === "4,1");
  ok("…moves are relative, signs from the control byte, Y up-positive like a DST", p.stitches[0].x === 10 && p.stitches[0].y === 0 && p.stitches[1].y === 10 && p.stitches[3].x === 0 && p.stitches[3].y === 0 &&
    p.stitches[4].jump === true && p.stitches[4].x === 30 && p.stitches[4].y === 5 && p.stitches[5].x === 35 && p.stitches[5].y === 10);
  ok("…block i is needle stop i (a leading needle code doesn't make an empty block)", p.stitches[0].color === 0 && p.stitches[5].color === 1);
  ok("…and the extent covers only real stitches", p.bbox.minX === 0 && p.bbox.maxX === 45 && p.bbox.minY === 0 && p.bbox.maxY === 10);
  ok("reading stops at the end code", !p.stitches.some(s => s.x > 99));
  const doubled = w.parseDsb_(dsb(NEEDLE(2), NEEDLE(3), ST(1, 1), NEEDLE(5), NEEDLE(6), ST(1, 1), NEEDLE(7), END));
  ok("needle changes with no stitches between don't add stops", doubled.needleStops === 2 && doubled.colorChanges === 5 && doubled.needles.join() === "3,6");
  // Some software writes the function codes with only the top bit (0x8A needle 2 … 0x98 end) — files in the shop's
  // own archive; the low 5 bits are what count.
  const topBit = w.parseDsb_(dsb(ST(4, 4), [0x8A, 0, 0], ST(4, 0), [0x87, 0, 0], [0x8B, 0, 0], ST(0, 4), [0x98, 0, 0], ST(50, 50)));
  ok("codes written with only the top bit (0x8A needle 2, 0x87 trim, 0x98 end) read the same", topBit.needleStops === 3 && topBit.needles.join() === ",2,3" && topBit.stitchCount === 3 && topBit.bbox.maxX === 8);
  let err = ""; try { w.parseDsb_(new Uint8Array(100).buffer); } catch (e) { err = e.message; }
  ok("a file too short is refused", /too short to be a DSB/.test(err));
  err = ""; try { w.parseDsb_(dsb(NEEDLE(1), JMP(5, 5), END)); } catch (e) { err = e.message; }
  ok("…and so is one with no stitches", /No stitches found in this DSB/.test(err));
  ok("the shared reader picks the format by extension or file name", w.parseStitchFile_(file, "logo.DSB").needleStops === 2 && w.parseStitchFile_(file, "dsb").needles.length === 2 &&
    w.eval("canPreviewStitch_('a.dsb') && canPreviewStitch_('DST') && !canPreviewStitch_('a.pes')"));
  ok("…and its needle-stop count matches", w.analyzeStitchNeedleStops_(file, "x.dsb").needleStops === 2);

  console.log("\n=== Uploads ===");
  ok("a .dsb is an accepted machine file — in the upload window and on the server", w.eval("embroideryFileProblem_('crest.dsb', 'machine')") === "" && w.eval("embroideryFileProblem_('crest.dsb', 'design')") !== "" &&
    /MACHINE_STITCH_EXTS = new Set\(\["dst", "dsb"/.test(read("functions/api/design.js")));
  w._dsgCtx = { threads: [{ id: 1, brand: "Madeira", type: "Rayon", weight: "40", code: "1000", name: "Black", colorHex: "000000" }, { id: 2, brand: "Madeira", type: "Rayon", weight: "40", code: "1001", name: "White", colorHex: "ffffff" }] };
  w.showDesignVersionUploadModal_(1, null);
  const doc = w.document;
  const input = doc.getElementById("dsgvMachineFile");
  Object.defineProperty(input, "files", { value: [{ name: "crest.DSB", arrayBuffer: async () => file }], configurable: true });
  draws.length = 0;
  input.dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 30));
  const stops = doc.getElementById("dsgvStops").textContent.replace(/\s+/g, " ");
  ok("choosing a .dsb shows its needle stops, color changes, stitches and the needles it names", /2 needle stops/.test(stops) && /2 color changes/.test(stops) && /7 stitches/.test(stops) && /needles 4, 1/.test(stops));
  ok("…sizes the thread map to its stops", doc.querySelectorAll(".dsgvThreadSelect").length === 2);
  ok("…and draws the preview", draws.filter(d => Array.isArray(d)).length >= 6);
  const sel = doc.querySelectorAll(".dsgvThreadSelect")[1];
  sel.value = "2"; draws.length = 0; sel.dispatchEvent(new w.Event("change"));
  ok("picking a thread recolors that stop in the preview", draws.includes("#ffffff"));

  console.log("\n=== Every screen that previews a DST takes a DSB ===");
  ok("the Designs screen, Edit colors and Run Order read DST and DSB through the shared reader", !/parseDst_\(await/.test(adminJs) && (adminJs.match(/parseStitchFile_\(/g) || []).length >= 5 &&
    /\/\\\.\(dst\|dsb\)\$\/i\.test\(step\.machineFileName/.test(adminJs) && !/machineFileExt \|\| ""\)\.toLowerCase\(\) [!=]== "dst"/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test131 crashed: false"); process.exit(1); });
