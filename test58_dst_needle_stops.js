const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Upload design version: reading a .dst machine file to count its needle stops (color blocks
// with stitches) and size the thread color map to match.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const STITCH = [0x00, 0x00, 0x03], JUMP = [0x00, 0x00, 0x83], CC = [0x00, 0x00, 0xC3], END = [0x00, 0x00, 0xF3];
const dst = (...recs) => {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:TEST\r", 0, "latin1");
  return new Uint8Array(Buffer.concat([header, Buffer.from(recs.flat())])).buffer;
};
const s = (n) => Array.from({ length: n }, () => STITCH);

(async () => {
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.TextDecoder = TextDecoder;   // jsdom doesn't provide it; every real browser does
      // jsdom has no 2D canvas; stub it so the DST preview render path runs (no-op draws) and
      // doesn't spam "not implemented" warnings.
      win.HTMLCanvasElement.prototype.getContext = () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fillText(){} });
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  console.log("=== analyzeDstNeedleStops_ ===");
  let a = w.analyzeDstNeedleStops_(dst(...s(5), END));
  console.log("one color, no changes -> 1 stop:", a.needleStops === 1 && a.colorChanges === 0 && a.stitches === 5);
  a = w.analyzeDstNeedleStops_(dst(...s(3), CC, JUMP, JUMP, ...s(4), CC, ...s(2), END));
  console.log("two color changes -> 3 stops; jumps aren't stitches:", a.needleStops === 3 && a.colorChanges === 2 && a.stitches === 9);
  a = w.analyzeDstNeedleStops_(dst(CC, ...s(3), CC, CC, ...s(2), CC, END));
  console.log("leading/doubled/trailing changes with no stitches don't add stops:", a.needleStops === 2 && a.colorChanges === 4);
  a = w.analyzeDstNeedleStops_(dst(...s(2), CC, ...s(2), END, ...s(2), CC, ...s(2)));
  console.log("reading stops at the end record:", a.needleStops === 2 && a.stitches === 4);
  const raw = new Uint8Array(dst(...s(2), CC, ...s(2), END));
  a = w.analyzeDstNeedleStops_(new TextEncoder().encode(Buffer.from(raw).toString("base64")).buffer);
  console.log("base64-encoded DST (as the analyzer accepts) is decoded:", a.needleStops === 2);
  let threw = ""; try { w.analyzeDstNeedleStops_(new Uint8Array(100).buffer); } catch (e) { threw = e.message; }
  console.log("too-short file is refused:", /too short/.test(threw));
  threw = ""; try { w.analyzeDstNeedleStops_(dst(CC, JUMP, END)); } catch (e) { threw = e.message; }
  console.log("a file with no stitches is refused:", /No stitches/.test(threw));

  console.log("\n=== Upload version window ===");
  w._dsgCtx = { threads: [{ id: 1, brand: "Madeira", type: "Rayon", weight: "40", code: "1000", name: "Black" }, { id: 2, brand: "Madeira", type: "Rayon", weight: "40", code: "1001", name: "White" }] };
  w.showDesignVersionUploadModal_(1, null);
  const doc = w.document;
  const pick = async (name, buf) => {
    const input = doc.getElementById("dsgvMachineFile");
    Object.defineProperty(input, "files", { value: [{ name, arrayBuffer: async () => buf }], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await new Promise(res => setTimeout(res, 20));
  };
  const rowCount = () => doc.querySelectorAll(".dsgvThreadSelect").length;
  const stopsText = () => doc.getElementById("dsgvStops").textContent.replace(/\s+/g, " ");
  await pick("logo.DST", dst(...s(3), CC, ...s(3), CC, ...s(3), CC, ...s(3), END));
  console.log("shows the needle stops, color changes and stitches:", /4 needle stops/.test(stopsText()) && /3 color changes/.test(stopsText()) && /12 stitches/.test(stopsText()));
  console.log("thread map grows to one row per stop:", rowCount() === 4);
  console.log("says how many are picked so far:", /0 of 4 needle definitions picked/.test(stopsText()));
  const sel = doc.querySelectorAll(".dsgvThreadSelect")[0]; sel.value = "2"; sel.dispatchEvent(new w.Event("change"));
  console.log("picking a thread updates the count and keeps the summary:", /1 of 4/.test(stopsText()) && /4 needle stops/.test(stopsText()));
  await pick("smaller.dst", dst(...s(3), CC, ...s(3), END));
  console.log("a file with fewer stops drops only EMPTY extra rows:", rowCount() === 2 && doc.querySelectorAll(".dsgvThreadSelect")[0].value === "2");
  const sel2 = doc.querySelectorAll(".dsgvThreadSelect")[1]; sel2.value = "1"; sel2.dispatchEvent(new w.Event("change"));
  console.log("all picked -> ✓:", /✓ 2 of 2/.test(stopsText()));
  await pick("logo.pes", new ArrayBuffer(10));
  console.log("a non-DST machine file shows nothing (other formats aren't read):", stopsText() === "" && rowCount() === 2);
  await pick("broken.dst", new ArrayBuffer(10));
  console.log("an unreadable DST says so:", /Couldn't read the DST file/.test(stopsText()));
  console.log("the upload modal now shows a live preview canvas:", !!doc.getElementById("dsgvCanvas"));

  console.log("\n=== parseDst_ (full preview parser) ===");
  const P1 = w.parseDst_(dst([0x01,0x00,0x03],[0x01,0x00,0x03],[0x80,0x00,0x03], END)); // +1x, +1x, +1y
  console.log("decodes stitch coordinates + bbox:", P1.stitchCount === 3 && P1.bbox.minX === 1 && P1.bbox.maxX === 2 && P1.bbox.minY === 0 && P1.bbox.maxY === 1);
  const P2 = w.parseDst_(dst(...s(3), CC, ...s(2), END));
  console.log("splits into colour blocks at colour changes:", P2.needleStops === 2 && P2.stitches.filter(x => x.color === 0).length === 3 && P2.stitches.filter(x => x.color === 1).length === 2);
  const P3 = w.parseDst_(dst(...s(2), JUMP, ...s(2), END));
  console.log("jumps flagged, not counted as stitches:", P3.stitchCount === 4 && P3.stitches.filter(x => x.jump).length === 1);
  console.log("renderDstPreview_ runs against a (stubbed) 2D context without throwing:", (() => {
    try { w.renderDstPreview_(doc.createElement("canvas"), P2, (i) => i === 0 ? "#111" : "#c00"); return true; } catch (e) { return false; }
  })());

  console.log("\n=== Edit thread colors (existing version) ===");
  let saved = null;
  w.designApi_ = async (body) => { if (body.action === "updateDesignVersionColors") { saved = body; return { status: "ok" }; } return { status: "ok" }; };
  w.showToast = () => {};
  w.showEditVersionColorsModal_({ id: 7, designId: 3, machineFileExt: "dst", machineFileKey: "k", machineFileName: "logo.dst",
    threadColors: [{ needle: 1, threadId: 1 }, { needle: 2, threadId: 2 }] }, null);
  await new Promise(res => setTimeout(res, 20));
  const cSel = () => doc.querySelectorAll(".dsgcThreadSelect");
  console.log("one fixed row per saved needle, pre-filled, with NO add/remove:",
    cSel().length === 2 && cSel()[0].value === "1" && cSel()[1].value === "2" && !doc.querySelector(".dsgcThreadSelect ~ button") && doc.querySelectorAll("#dsgcThreadRows button").length === 0);
  cSel()[1].value = "1"; cSel()[1].dispatchEvent(new w.Event("change"));
  doc.getElementById("dsgcSave").click();
  await new Promise(res => setTimeout(res, 20));
  console.log("Save sends only the colors (versionId + threadColors), nothing else:",
    saved && saved.action === "updateDesignVersionColors" && saved.versionId === 7 &&
    JSON.stringify(saved.threadColors) === JSON.stringify([{ needle: 1, threadId: 1 }, { needle: 2, threadId: 1 }]) &&
    !("machineFileKey" in saved) && !("designFileKey" in saved));

  console.log("\n=== Main design page renders the current version ===");
  w._dsgCtx = { orgId: "acme", orgName: "Acme", hoops: [], designs: [{ id: 3, name: "Logo" }],
    threads: [{ id: 1, brand: "M", type: "", weight: "40", code: "1", name: "Black", colorHex: "111111" }] };
  w.designApi_ = async (body) => body.action === "getDesign"
    ? { status: "ok", design: { id: 3, name: "Logo", hoopId: null, notes: "" },
        versions: [{ id: 7, designId: 3, uploadedAt: "2026-01-01", designFileName: "a.emb", designFileKey: "dk",
          machineFileName: "a.dst", machineFileKey: "mk", machineFileExt: "dst", threadColors: [{ needle: 1, threadId: 1 }], notes: "" }] }
    : { status: "ok" };
  const detailEl = doc.createElement("div"); detailEl.id = "dsgDetail"; doc.body.appendChild(detailEl);
  await w.loadDesignDetail_(3);
  await new Promise(res => setTimeout(res, 20));
  console.log("the design detail page shows a preview canvas for the current (DST) version:", !!doc.getElementById("dsgDetailCanvas"));
  console.log("each version still offers Edit colors:", /editVersionColors_\(7\)/.test(detailEl.innerHTML));
})().catch(e => { console.log("test58 crashed:", false); console.error(e); process.exit(1); });
