const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Mockup (overlay) editor: near-full-screen window, typed Width/X/Y boxes kept in step with the slider and
// dragging, Copy from another mockup, "apply to all" flag in the save result, and the headless composite.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
(async () => {
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  const doc = w.document;
  w.HTMLCanvasElement.prototype.getContext = () => null;   // jsdom has no canvas; the editor skips drawing without one

  const others = [
    { key: "1|2|Navy", label: "Left chest · Crest · Navy", placement: { xPct: 0.3, yPct: 0.25, wPct: 0.18 } },
    { key: "1|2|Red",  label: "Left chest · Crest · Red",  placement: { xPct: 0.31, yPct: 0.26, wPct: 0.2 } },
  ];
  const saved = [];
  await w.showOverlayEditorModal_({ title: "Crest · Black", orgId: "acme", baseCandidates: [], graphicUrl: "", placement: { xPct: 0.5, yPct: 0.5, wPct: 0.4 }, hasExisting: false, others, onSave: (r) => saved.push(r) });
  const q = (s) => doc.querySelector(s);
  let top = q("#ovCanvas"); while (top.parentElement !== doc.body) top = top.parentElement;
  const box = top.firstElementChild;
  console.log("window is nearly the whole screen:", box.style.width === "97vw" && box.style.maxHeight === "96vh");
  console.log("canvas is large and sized from the screen height:", q("#ovCanvas").width >= 1000 && /94vh/.test(q("#ovCanvas").getAttribute("style")));
  console.log("Width / X / Y boxes show the current placement:", q("#ovW").value === "40" && q("#ovX").value === "50" && q("#ovY").value === "50");

  const type = (id, v) => { const e = q(id); e.value = v; e.dispatchEvent(new w.Event("input", { bubbles: true })); e.dispatchEvent(new w.Event("change", { bubbles: true })); };
  type("#ovW", "25"); type("#ovX", "30.5"); type("#ovY", "70");
  console.log("typing in the boxes moves the slider too:", Number(q("#ovSize").value) === 25);
  q("#ovSize").value = "33"; q("#ovSize").dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("the slider updates the Width box:", q("#ovW").value === "33" && q("#ovX").value === "30.5" && q("#ovY").value === "70");
  type("#ovW", "500");
  console.log("width is clamped to 100% on the slider:", Number(q("#ovSize").value) <= 100);

  // Copy from: size only, then position only.
  q("#ovFrom").value = "0"; q("#ovCopyPos").checked = false;
  q("#ovCopy").click();
  console.log("Copy from (size only) takes the width and leaves the position:", q("#ovW").value === "18" && q("#ovX").value === "30.5" && q("#ovY").value === "70");
  q("#ovCopyPos").checked = true; q("#ovCopySize").checked = false; q("#ovFrom").value = "1";
  q("#ovCopy").click();
  console.log("Copy from (position only) takes X/Y and leaves the width:", q("#ovW").value === "18" && q("#ovX").value === "31" && q("#ovY").value === "26");
  q("#ovCopySize").checked = false; q("#ovCopyPos").checked = false; q("#ovCopy").click();
  console.log("Copy with nothing ticked says so:", /Tick Size and\/or Position/.test(q("#ovErr").textContent));
  console.log("an 'apply to all N other mockups' option is offered:", /all 2 other mockups/.test(q("#ovApplyAll").parentElement.textContent));

  // A window with no other mockups doesn't offer Copy/Apply.
  q("#ovCancel").click();
  await w.showOverlayEditorModal_({ title: "t", orgId: "acme", baseCandidates: [], graphicUrl: "", others: [], onSave(){} });
  console.log("with no other mockups there's no Copy/Apply (just a hint):", !q("#ovCopy") && !q("#ovApplyAll") && /No other mockups yet/.test(doc.body.textContent));
  q("#ovCancel").click();

  // Source-level: the apply-to-all path re-makes each other mockup and the helper is shared with Save.
  console.log("Save and apply-to-all share one headless composite:", /async function overlayComposite_\(/.test(adminJs) && (adminJs.match(/overlayComposite_\(/g) || []).length >= 3);
  console.log("apply-to-all re-makes the OTHER mockups from their remembered photo + graphic:", /async function applyPlacementToOthers_\(/.test(adminJs) && /what\.size/.test(adminJs) && /what\.pos/.test(adminJs));
  console.log("the save result carries applyAll only when ticked:", /applyAll: \(applyAll && \(applyAll\.size \|\| applyAll\.pos\)\) \? applyAll : null/.test(adminJs));
})().catch(e => { console.log("test91 crashed:", false); console.error(e); process.exit(1); });
