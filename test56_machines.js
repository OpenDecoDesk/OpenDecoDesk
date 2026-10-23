const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Production run management: machines (migrations/0025) — real SQL (sql.js), real
// db.js + orders.js admin API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listMachines, getMachine, saveMachine, deleteMachine, setMachineHoop, setMachineNeedle, setMachineNeedles,
  recordMachineDiscovery, normalizeMac_, createHoop, deleteHoop, createThread, deleteThread };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  const roundHoopId = await lib.createHoop(d1, { name: "4in Round", widthMm: 100, heightMm: 100, isCapFrame: false });
  const capHoopId = await lib.createHoop(d1, { name: "Cap Frame", widthMm: 130, heightMm: 60, isCapFrame: true });
  const threadRed = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1147", name: "Red", colorHex: "cc2222" });
  const threadBlue = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1201", name: "Blue", colorHex: "2222cc" });

  console.log("=== db.js: create/update/list/get/delete ===");
  const id1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, ipAddress: "192.168.1.50", embDir: "/EMB", notes: "front-left", hoopIds: [roundHoopId, capHoopId] });
  let m = await lib.getMachine(d1, id1);
  console.log("created with hoops set:", m.name === "Machine 1" && m.needleCount === 12 && m.hoopIds.sort().join(",") === [roundHoopId, capHoopId].sort().join(","));
  await lib.saveMachine(d1, { id: id1, name: "Machine 1 (renamed)", needleCount: 15, ipAddress: "192.168.1.50", embDir: "/EMB", notes: "", hoopIds: [roundHoopId] });
  m = await lib.getMachine(d1, id1);
  console.log("updated, hoop set replaced (cap hoop removed):", m.name === "Machine 1 (renamed)" && m.needleCount === 15 && m.hoopIds.length === 1 && m.hoopIds[0] === roundHoopId);

  const id2 = await lib.saveMachine(d1, { name: "Machine 2", needleCount: 9, hoopIds: [] });
  let all = await lib.listMachines(d1);
  console.log("listMachines sorted by name:", all.length === 2 && all[0].name === "Machine 1 (renamed)" && all[1].name === "Machine 2");
  await lib.deleteMachine(d1, id2);
  console.log("deleted:", (await lib.listMachines(d1)).length === 1);

  console.log("\n=== db.js: current hoop + needle state ===");
  await lib.setMachineHoop(d1, id1, roundHoopId);
  m = await lib.getMachine(d1, id1);
  console.log("current hoop set:", m.currentHoopId === roundHoopId);
  await lib.setMachineHoop(d1, id1, null);
  m = await lib.getMachine(d1, id1);
  console.log("current hoop cleared:", m.currentHoopId === null);

  await lib.setMachineNeedles(d1, id1, [{ needle: 1, threadId: threadRed }, { needle: 2, threadId: threadBlue }]);
  m = await lib.getMachine(d1, id1);
  console.log("bulk needle set:", m.needles[1] === threadRed && m.needles[2] === threadBlue);
  await lib.setMachineNeedle(d1, id1, 1, threadBlue);
  m = await lib.getMachine(d1, id1);
  console.log("single needle corrected by hand, needle 2 untouched:", m.needles[1] === threadBlue && m.needles[2] === threadBlue);
  await lib.setMachineNeedle(d1, id1, 1, null);
  m = await lib.getMachine(d1, id1);
  console.log("needle cleared back to empty:", m.needles[1] === null);

  console.log("\n=== db.js: deleteHoop/deleteThread refuse while a machine references them ===");
  // A third hoop, mounted as id1's current hoop but NOT in its supported-hoop set, isolates the
  // currentHoopId check from the machine_hoops check.
  const ovalHoopId = await lib.createHoop(d1, { name: "6in Oval", widthMm: 150, heightMm: 90, isCapFrame: false });
  await lib.setMachineHoop(d1, id1, ovalHoopId);
  let threw = false;
  try { await lib.deleteHoop(d1, ovalHoopId); } catch (e) { threw = /mounted/.test(e.message); }
  console.log("refused: hoop is a machine's CURRENT hoop:", threw);
  await lib.setMachineHoop(d1, id1, null);
  await lib.deleteHoop(d1, ovalHoopId);
  console.log("succeeds once unmounted:", true);
  threw = false;
  try { await lib.deleteHoop(d1, roundHoopId); } catch (e) { threw = /machine/.test(e.message); }
  console.log("refused: hoop is in a machine's supported set:", threw);

  await lib.setMachineNeedle(d1, id1, 2, threadBlue);
  threw = false;
  try { await lib.deleteThread(d1, threadBlue); } catch (e) { threw = /loaded on a machine/.test(e.message); }
  console.log("refused: thread is loaded on a machine needle:", threw);
  await lib.setMachineNeedle(d1, id1, 2, null);
  await lib.deleteThread(d1, threadBlue);
  console.log("succeeds once cleared:", true);

  console.log("\n=== db.js: MAC identity + scanner-populated IP + verifiedAt (migrations/0027) ===");
  console.log("normalizeMac_ ignores case/separators:", lib.normalizeMac_("AA:BB:CC:00:11:22") === "aabbcc001122" && lib.normalizeMac_("aa-bb-cc-00-11-22") === "aabbcc001122");
  const macId = await lib.saveMachine(d1, { name: "MAC Machine", needleCount: 10, macAddress: "AA:BB:CC:00:11:22", ipAddress: "192.168.1.77", hoopIds: [] });
  m = await lib.getMachine(d1, macId);
  console.log("macAddress persisted, verifiedAt starts empty:", m.macAddress === "AA:BB:CC:00:11:22" && !m.verifiedAt);
  // A discovery sweep reporting that MAC at a NEW ip refreshes the ip + stamps verifiedAt.
  let disc = await lib.recordMachineDiscovery(d1, [{ mac: "aabbcc001122", ip: "192.168.1.99" }, { mac: "ff:ff:ff:ff:ff:ff", ip: "10.0.0.1" }]);
  console.log("only the matching MAC updated:", disc.updated.length === 1 && disc.updated[0] === macId);
  m = await lib.getMachine(d1, macId);
  console.log("scanner updated the IP and stamped verifiedAt:", m.ipAddress === "192.168.1.99" && !!m.verifiedAt);
  // A machine with no MAC on file is never touched by discovery.
  const noMacId = await lib.saveMachine(d1, { name: "No MAC", needleCount: 6, ipAddress: "192.168.1.5", hoopIds: [] });
  disc = await lib.recordMachineDiscovery(d1, [{ mac: "12:34:56:78:9a:bc", ip: "192.168.1.200" }]);
  m = await lib.getMachine(d1, noMacId);
  console.log("no-MAC machine untouched by an unmatched sweep:", disc.updated.length === 0 && m.ipAddress === "192.168.1.5" && !m.verifiedAt);
  await lib.deleteMachine(d1, macId);
  await lib.deleteMachine(d1, noMacId);

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "listMachines" });
  console.log("listMachines action:", r.status === 200 && r.body.machines.length === 1);
  r = await call({ action: "saveMachine", machine: { name: "", needleCount: 10 } });
  console.log("name required:", r.status === 400 && /required/.test(r.body.message));
  r = await call({ action: "saveMachine", machine: { name: "Machine X", needleCount: 0 } });
  console.log("needleCount must be positive:", r.status === 400 && /Needle count/.test(r.body.message));
  r = await call({ action: "saveMachine", machine: { name: "Machine X", needleCount: 6, hoopIds: [roundHoopId] } });
  console.log("valid machine created via the API:", r.status === 200 && !!r.body.id);
  const machineXId = r.body.id;
  r = await call({ action: "getMachine", id: machineXId });
  console.log("getMachine action returns full state:", r.status === 200 && r.body.machine.hoopIds.includes(roundHoopId));
  r = await call({ action: "setMachineHoop", machineId: machineXId, hoopId: roundHoopId });
  console.log("setMachineHoop action:", r.status === 200);
  r = await call({ action: "setMachineNeedle", machineId: machineXId, needle: 1, threadId: threadRed });
  console.log("setMachineNeedle action:", r.status === 200);
  r = await call({ action: "getMachine", id: machineXId });
  console.log("needle reflected:", r.body.machine.currentHoopId === roundHoopId && r.body.machine.needles[1] === threadRed);
  r = await call({ action: "deleteMachine", id: machineXId });
  console.log("deleteMachine action:", r.status === 200);
  r = await call({ action: "listMachines" });
  console.log("...and it's gone:", !r.body.machines.some(x => x.id === machineXId));

  // recordMachineDiscovery action: saves a MAC, then a discovery sweep refreshes the IP.
  r = await call({ action: "saveMachine", machine: { name: "Scanned", needleCount: 8, macAddress: "de:ad:be:ef:00:01", ipAddress: "192.168.1.10", hoopIds: [] } });
  const scannedId = r.body.id;
  r = await call({ action: "recordMachineDiscovery", discovered: [{ mac: "DEADBEEF0001", ip: "192.168.1.222" }] });
  const scanned = (r.body.machines || []).find(x => x.id === scannedId);
  console.log("recordMachineDiscovery action refreshes IP + verifiedAt and returns machines:", r.status === 200 && scanned && scanned.ipAddress === "192.168.1.222" && !!scanned.verifiedAt);
  await call({ action: "deleteMachine", id: scannedId });

  console.log("\n=== Screen wiring ===");
  const adminJs = read("public/admin.js");
  console.log("Machines is in the persistent admin header and routed:", /\["machines", "Machines"\]/.test(adminJs) && /renderMachines\(app\)/.test(adminJs));
  console.log("New-machine button + save/hoop/needle actions exist:", /id="mchNewBtn"/.test(adminJs) && /action: "saveMachine"/.test(adminJs) && /action: "setMachineHoop"/.test(adminJs) && /action: "setMachineNeedle"/.test(adminJs));
  console.log("MAC field + scanner-populated IP + verified label in the form/card:", /id="mchfMac"/.test(adminJs) && /machineVerifiedLabel_/.test(adminJs) && /readonly/.test(adminJs));
  console.log("auto-rediscovery before list/upload wired:", /function ensureMachineFresh_/.test(adminJs) && /action: "recordMachineDiscovery"/.test(adminJs) && /ensureMachineFresh_\(machine\)/.test(adminJs));
  console.log("lists have scroll containers:", /id="mchBody"[^>]*overflow-y:auto/.test(adminJs) && /id="mfFileList"/.test(adminJs) && /max-height:55vh;overflow-y:auto/.test(adminJs));
})();
