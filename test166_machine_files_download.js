const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Machine Files → Download (2026-10): copy files off an embroidery machine through the send agent's /read (or the
// relay's read job, from a phone). One file saves as <base>.DSB, several as one .zip; a file that can't be read is
// named; an agent from before /read says to update it. The real admin page in jsdom; the admin API, the loopback
// agent and the relay are stubbed.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

const FILES = { "Logo.001": "LA:logo-bytes", "Logo.017": "LA:logo-again", "Cap Front.004": "LA:cap", "马头机~1.008": "LA:x" };
const LISTING = Object.keys(FILES).map((name, i) => ({ name, size: 1000 + i, modified: "2026-10-01 10:00:00" }))
  .concat([{ name: "Broken.009", size: 5, modified: "2026-10-01" }]);
const b64 = (s) => Buffer.from(s).toString("base64");

(async () => {
  const adminJs = read("public/admin.js");
  let agentMode = "local";            // "local" | "old" (an agent from before /read) | "relay"
  const reads = [], relayJobs = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const answerRead = (name) => {
    if (agentMode === "old") return json(404, { status: "error", message: "Not found" });
    if (!(name in FILES)) return json(502, { status: "error", message: `The machine refused to send ${name}.` });
    return json(200, { status: "ok", fileName: name, bytes: Buffer.byteLength(FILES[name]), blocks: 1, ext: "DSB", dataBase64: b64(FILES[name]) });
  };

  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#orders", pretendToBeVisual: true,
    beforeParse(win){
      autoConfirm(win, () => true);
      win.TextEncoder = TextEncoder; // jsdom lacks it; makeZip_ uses it for file names
      win.fetch = async (url, init) => {
        url = String(url);
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (url.includes("/api/orders")) {
          if (body.action === "listMachines") return json(200, { status: "ok", machines: [{ id: 1, name: "Machine 1", ipAddress: "192.168.1.50", verifiedAt: new Date().toISOString(), embDir: "/EMB" }] });
          if (body.action === "listOrgsAdmin") return json(200, { status: "ok", orgs: [{ orgId: "acme", name: "Acme" }] });
          if (body.action === "getMachineSettings") return json(200, { status: "ok", machineSettings: { showDeleteButton: false } });
          return json(200, { status: "ok" });
        }
        if (url.startsWith("http://127.0.0.1:8787")) {
          if (agentMode === "relay") throw new TypeError("Failed to fetch");
          if (url.endsWith("/ping")) return json(200, { ok: true });
          if (url.endsWith("/list")) return json(200, { status: "ok", files: LISTING });
          if (url.endsWith("/read")) { reads.push(body.fileName); return answerRead(body.fileName); }
        }
        if (url.includes("/api/agent?op=")) {
          const op = url.split("op=")[1];
          if (op === "status") return json(200, { status: "ok", online: true });
          if (op === "submit") { relayJobs.push(body); return json(200, { status: "ok", id: String(relayJobs.length).padStart(24, "0") }); }
          if (op === "result") {
            const job = relayJobs[Number(body.id) - 1];
            const r = job.type === "list" ? json(200, { status: "ok", files: LISTING }) : answerRead(job.fileName);
            return json(200, { status: "ok", done: true, result: { httpStatus: r.status, body: await r.json() } });
          }
        }
        return json(404, { status: "error" });
      };
    } });
  const w = dom.window, d = w.document;
  // Every save goes through an <a download> click on a blob: URL — record them.
  const saves = [];
  const blobs = new Map(); let n = 0;
  w.URL.createObjectURL = (blob) => { const u = "blob:test/" + (++n); blobs.set(u, blob); return u; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function(){ saves.push({ name: this.download, blob: blobs.get(this.href) }); };
  const blobBytes = (blob) => new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(Buffer.from(fr.result)); fr.readAsArrayBuffer(blob); });

  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const app = d.getElementById("app");

  console.log("=== The file list has a tick box and a Download button per file ===");
  await w.renderMachineFiles(app);
  await wait(() => d.getElementById("mfMachineSelect") && d.getElementById("mfMachineSelect").options.length > 1);
  const mSel = d.getElementById("mfMachineSelect");
  mSel.value = "1"; mSel.dispatchEvent(new w.Event("change"));
  await wait(() => d.querySelectorAll(".mfDownloadBtn").length === LISTING.length);
  ok("every file has a Download button and a tick box", d.querySelectorAll(".mfDownloadBtn").length === 5 && d.querySelectorAll(".mfPick").length === 5);
  ok("'Download all (5)' is offered; 'Download selected' is off until something is ticked",
    /Download all \(5\)/.test(d.getElementById("mfDownloadAll").textContent) && d.getElementById("mfDownloadSel").disabled);
  ok("the page says files come as .DSB, several as a .zip", /\.DSB/.test(d.getElementById("mfFileList").textContent) && /\.zip/.test(d.getElementById("mfFileList").textContent));
  ok("each tick box is named so a refresh can put it back", d.querySelector(".mfPick").getAttribute("data-keep-check") === "mf:1|Logo.001");

  console.log("\n=== One file: saved as <base>.DSB with the machine's bytes ===");
  const btn = [...d.querySelectorAll(".mfDownloadBtn")].find(b => b.dataset.name === "Cap Front.004");
  btn.click();
  await wait(() => saves.length === 1);
  ok("the agent was asked for the file by its listed name", reads.join() === "Cap Front.004");
  ok("saved as 'Cap Front.DSB'", saves[0] && saves[0].name === "Cap Front.DSB");
  ok("…holding exactly the bytes the machine sent", saves[0] && (await blobBytes(saves[0].blob)).toString() === "LA:cap");
  await wait(() => /Downloaded 1 file/.test(d.getElementById("mfDownloadStatus").textContent));
  ok("the status says what happened", /Downloaded 1 file\./.test(d.getElementById("mfDownloadStatus").textContent));

  console.log("\n=== Selected files: one .zip, two of the same name numbered ===");
  const pick = (name) => { const cb = [...d.querySelectorAll(".mfPick")].find(c => c.dataset.name === name); cb.checked = true; cb.dispatchEvent(new w.Event("change")); };
  pick("Logo.001"); pick("Logo.017"); pick("马头机~1.008");
  ok("ticking shows the count", d.getElementById("mfDownloadSel").textContent === "Download selected (3)" && !d.getElementById("mfDownloadSel").disabled);
  reads.length = 0; saves.length = 0;
  d.getElementById("mfDownloadSel").click();
  await wait(() => saves.length === 1);
  ok("each ticked file was read, in order", reads.join("|") === "Logo.001|Logo.017|马头机~1.008");
  ok("they come as one .zip named after the machine", saves[0] && /^Machine 1 files \d{4}-\d{2}-\d{2}\.zip$/.test(saves[0].name));
  const zip = saves[0] ? await blobBytes(saves[0].blob) : Buffer.alloc(0);
  const zipText = zip.toString("utf8");
  ok("the .zip holds Logo.DSB, 'Logo (2).DSB' and the non-ASCII name, with their bytes",
    zip.slice(0, 2).toString() === "PK" && zipText.includes("Logo.DSB") && zipText.includes("Logo (2).DSB") && zipText.includes("马头机~1.DSB") &&
    zipText.includes("LA:logo-bytes") && zipText.includes("LA:logo-again"));

  console.log("\n=== A file that can't be read is named; the rest still come ===");
  [...d.querySelectorAll(".mfPick")].forEach(cb => { cb.checked = false; });
  const pickAll = d.getElementById("mfPickAll");
  pickAll.checked = true; pickAll.dispatchEvent(new w.Event("change"));
  ok("'select all' ticks every file", [...d.querySelectorAll(".mfPick")].every(cb => cb.checked) && /\(5\)/.test(d.getElementById("mfDownloadSel").textContent));
  reads.length = 0; saves.length = 0;
  d.getElementById("mfDownloadAll").click();
  await wait(() => saves.length === 1);
  await wait(() => /Couldn't copy/.test(d.getElementById("mfDownloadStatus").textContent));
  const st = d.getElementById("mfDownloadStatus").textContent;
  ok("all five were tried; four saved in a .zip", reads.length === 5 && /Downloaded 4 files \(one \.zip\)/.test(st));
  ok("…and the one the machine refused is named with the machine's message", /Couldn't copy Broken\.009: The machine refused to send Broken\.009/.test(st));
  ok("the buttons are back on afterwards", !d.getElementById("mfDownloadAll").disabled && !d.querySelector(".mfDownloadBtn").disabled);

  console.log("\n=== An agent from before /read says to update it ===");
  agentMode = "old"; saves.length = 0;
  d.querySelector(".mfDownloadBtn").click();
  await wait(() => /older version/.test(d.getElementById("mfDownloadStatus").textContent));
  ok("nothing saved, and the message says to update the send agent", !saves.length && /older version — update it/.test(d.getElementById("mfDownloadStatus").textContent));

  console.log("\n=== From a phone: the relay carries a read job ===");
  agentMode = "relay"; reads.length = 0;
  w.eval("_agentLocal = { at: 0, up: false };");
  const r = await w.readMachineFile_({ id: 1, name: "Machine 1", ipAddress: "192.168.1.50", verifiedAt: new Date().toISOString() }, "Logo.001");
  const job = relayJobs[relayJobs.length - 1];
  ok("a 'read' job went to the relay with the machine and the listed name", job && job.type === "read" && job.machineIp === "192.168.1.50" && job.fileName === "Logo.001");
  ok("…and its answer is decoded to the file", r.name === "Logo.DSB" && Buffer.from(r.bytes).toString() === "LA:logo-bytes");
  agentMode = "old";
  relayJobs.length = 0;
  // A relay agent from before read jobs answers "Unknown job type."
  w.fetch = ((orig) => async (url, init) => String(url).includes("op=result")
    ? json(200, { status: "ok", done: true, result: { httpStatus: 400, body: { status: "error", message: "Unknown job type." } } })
    : orig(url, init))(w.fetch);
  let msg = "";
  try { await w.readMachineFile_({ id: 1, name: "Machine 1", ipAddress: "192.168.1.50", verifiedAt: new Date().toISOString() }, "Logo.001"); }
  catch (e) { msg = e.message; }
  ok("a relay agent from before read jobs gets the same 'update it' message", /older version/.test(msg));

  console.log("\n=== Names ===");
  ok("<base>.<NNN> → <base>.DSB; odd characters made safe", w.machineDownloadName_("Logo.012") === "Logo.DSB" &&
    w.machineDownloadName_("A/B: C.003") === "A_B_ C.DSB" && w.machineDownloadName_("NoExt") === "NoExt.DSB");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
