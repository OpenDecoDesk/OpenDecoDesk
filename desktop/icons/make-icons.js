// Makes the program's icons from the logo, public/images/icon.svg (the same one as the website's):
//
//   cd desktop && npx electron icons/make-icons.js
//
//   icons/icon.icns     the Mac app (the logo inside Apple's 1024 grid: an 824 px tile, centred)
//   icons/icon.ico      the Windows program, 16 to 256 px
//   icons/icon.png      the window on Linux, 512 px
//   icons/dock.png      the Mac dock when run from the source (npm start), 1024 px, as icon.icns
//   ../public/images/icon-180.png   the admin's home-screen icon on a phone (apple-touch-icon), square
//
// Electron draws the SVG on a canvas, so nothing else needs installing. Run it again after
// changing icon.svg, and commit what it writes.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const here = __dirname;
const svg = fs.readFileSync(path.join(here, "..", "..", "public", "images", "icon.svg"), "utf8");

// The logo as a PNG `size` px square, the tile `inset` px in from each edge (transparent around it,
// or `fill` behind it).
async function png(win, size, inset = 0, fill = "") {
  const url = await win.webContents.executeJavaScript(`new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = ${size};
      const g = c.getContext("2d");
      if (${JSON.stringify(fill)}) { g.fillStyle = ${JSON.stringify(fill)}; g.fillRect(0, 0, ${size}, ${size}); }
      g.drawImage(img, ${inset}, ${inset}, ${size - 2 * inset}, ${size - 2 * inset});
      ok(c.toDataURL("image/png"));
    };
    img.onerror = () => fail(new Error("the SVG did not load"));
    img.src = ${JSON.stringify("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"))};
  })`);
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

// ICNS: "icns", the file's length, then one entry per size (type, the entry's length, a PNG).
function icns(entries) {
  const parts = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

// ICO: a header, a directory entry per size, then the images as PNGs (Windows Vista and later).
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(([size, data]) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);                      // colour planes
    e.writeUInt16LE(32, 6);                     // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map(([, data]) => data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  // Apple's grid: the tile is 824/1024 of the icon, so it sits with the other apps in the dock.
  const mac = (size) => png(win, size, Math.round(size * 100 / 1024));
  fs.writeFileSync(path.join(here, "icon.icns"), icns([
    ["icp4", await mac(16)], ["icp5", await mac(32)], ["icp6", await mac(64)],
    ["ic07", await mac(128)], ["ic08", await mac(256)], ["ic09", await mac(512)],
    ["ic10", await mac(1024)], ["ic11", await mac(32)], ["ic12", await mac(64)],
    ["ic13", await mac(256)], ["ic14", await mac(512)],
  ]));
  fs.writeFileSync(path.join(here, "dock.png"), await mac(1024));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const s of sizes) images.push([s, await png(win, s)]);
  fs.writeFileSync(path.join(here, "icon.ico"), ico(images));
  fs.writeFileSync(path.join(here, "icon.png"), await png(win, 512));
  // A phone rounds the corners itself, and shows transparent ones black: square, in the logo's blue.
  fs.writeFileSync(path.join(here, "..", "..", "public", "images", "icon-180.png"), await png(win, 180, 0, "#1f5f8b"));
  console.log("Icons written to " + here + " and public/images/icon-180.png");
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
