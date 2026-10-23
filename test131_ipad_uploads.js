// Uploads on an iPad. iPadOS greys out — and won't open — any file whose type a file box's `accept` list
// doesn't name, so a tester could browse to a file and tap it with nothing happening. iPhone and iPad
// photos are HEIC (which the server doesn't take), and .tch thread charts are a type iPadOS doesn't know.
//   * every box that takes pictures also lists HEIC, and the picture is turned into a JPEG before it's
//     sent (heicToJpeg_ in index.html — Safari can draw HEIC; another browser says to save a JPG);
//   * the customer's design box also lets a PDF or SVG be picked, and says to send a PNG or JPG;
//   * no box lists a type iPadOS can't recognise (the thread chart box takes any file and checks its name).
const fs = require("fs");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const html = read("public/index.html"), adminJs = read("public/admin.js");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const boxes = [...(html + adminJs).matchAll(/<input[^>]*type="file"[^>]*>/g)].map(m => m[0]);
const accept = (b) => { const m = b.match(/accept="([^"]*)"/); return m ? m[1] : null; };
const pictureBoxes = boxes.filter(b => /image\//.test(accept(b) || ""));
ok("there are picture boxes to check", pictureBoxes.length >= 10);
const noHeic = pictureBoxes.filter(b => !/image\/heic/.test(accept(b)) && !/accept="image\/png,image\/webp"/.test(b));   // a transparent-PNG box can't be a photo
if (noHeic.length) console.log("   without HEIC:", noHeic.map(b => (b.match(/id="([^"]+)"/) || [, b.slice(0, 60)])[1]).join(", "));
ok("every box that takes pictures lists HEIC too, so an iPad lets a photo be picked", noHeic.length === 0);
const known = /^(image\/[\w.+-]+|application\/pdf|text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|\.(heic|heif|pdf|svg|csv|xlsx|png|jpe?g|webp|gif|txt))$/;
const odd = boxes.flatMap(b => (accept(b) || "").split(",").filter(Boolean).filter(t => !known.test(t.trim())));
ok("no box lists a file type an iPad doesn't recognise (it would grey those files out)", odd.length === 0 && !/accept="[^"]*\.tch/.test(adminJs));
ok("…the thread chart box takes any file, and says so when it isn't a .tch, .csv or .txt", /id="thrImportFile" style=/.test(adminJs) && /Choose a thread chart: a \.tch, \.csv or \.txt file\./.test(adminJs));

const fn = (src, name) => { const i = src.indexOf(name); return i < 0 ? "" : src.slice(i, src.indexOf("\n}", i)); };
const conv = fn(html, "async function heicToJpeg_(");
ok("a HEIC is redrawn as a JPEG (named .jpg) before it's sent, at most 4096 px on the long side", /maxSide = 4096/.test(conv) && /toBlob\(res, "image\/jpeg"/.test(conv) && /\+ "\.jpg"/.test(conv));
ok("…any other file goes as it is", /if\(!isHeicFile_\(file\)\) return file;/.test(conv));
ok("…and a browser that can't draw HEIC says to save it as a JPG", /save it as a JPG or PNG/.test(conv));
ok("admin photos and receipts are converted first", /async function uploadImage\(file, orgId\)\{\n  file = await heicToJpeg_\(file\);/.test(adminJs) && /async function uploadReceipt_\(file\)\{\n  file = await heicToJpeg_\(file\);/.test(adminJs));
ok("…and so is a mockup's base photo, and a customer's proof-reply picture", /readFileToDataUrl\(await heicToJpeg_\(f\)\)/.test(adminJs) && /file = await heicToJpeg_\(file\);\n      const res = await fetch\("\/api\/upload-verify/.test(html));

const cd = fn(html, "async function handleCustomDesignFile_(");
ok("the customer's design box lets a PDF or SVG be picked…", /accept="image\/png,image\/jpeg,image\/webp,image\/heic,image\/heif,\.heic,\.heif,application\/pdf,\.pdf,image\/svg\+xml,\.svg"/.test(html));
ok("…and says to send a PNG or JPG instead", /We need a picture of your design — a PNG or JPG/.test(cd));
ok("…turns an iPhone / iPad photo into a JPEG before checking and sending it", cd.indexOf("heicToJpeg_(file)") > 0 && cd.indexOf("heicToJpeg_(file)") < cd.indexOf("L.types.includes(file.type)"));
ok("…and says under the box that a phone photo is fine", /an iPhone or iPad photo is fine/.test(html));

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
