// The desktop program: one window on the server in server.js, and a menu for what a cloud install
// does elsewhere (backups, restoring one, getting back in when locked out).
//
//   cd desktop && npm install && npm start
//
// The data folder is the system's per-user app data folder (on a Mac ~/Library/Application
// Support/OpenDecoDesk, on Windows %APPDATA%\OpenDecoDesk) — never next to the program, which
// can be read-only or moved. `--data-dir=<folder>` uses another one.

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, safeStorage, session, net } = require("electron");
const fs = require("fs");
const path = require("path");
const { startServer, copyState, restoreState, resetSignIn, stamp, IMAGES_HOST, desktopCsp } = require("./server.js");

const SOURCE_URL = "https://github.com/opendecodesk/opendecodesk";
const argData = process.argv.find(a => a.startsWith("--data-dir="));
const dataDir = argData ? path.resolve(argData.slice("--data-dir=".length)) : path.join(app.getPath("appData"), "OpenDecoDesk");
app.setPath("userData", path.join(dataDir, "electron"));   // the window's own storage, kept with the data

let server = null, win = null, busy = false;

// Two copies of the program on one database would each think they own it: the second one just
// brings the first one's window forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// The secrets in desktop.json are encrypted with the operating system's keychain when it has one.
const crypt = () => safeStorage.isEncryptionAvailable() ? {
  protect: (s) => safeStorage.encryptString(s).toString("base64"),
  unprotect: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
} : {};

async function start() {
  server = await startServer({ dataDir, port: 47830, ...crypt(), log: (m) => console.log(m) });
  return server;
}
async function stop() {
  if (server) { const s = server; server = null; await s.stop(); }
}
const isOurs = (u) => { try { const x = new URL(u); return x.hostname === "localhost" && server && Number(x.port) === server.port; } catch (e) { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, title: "OpenDecoDesk",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links to anywhere else open in the person's browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Printing labels and packing slips opens an empty window the page writes into; a receipt or
    // design file opens from this server.
    if (isOurs(url) || url === "" || url === "about:blank") return { action: "allow" };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isOurs(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.loadURL(server.url);
}

function setUpSession() {
  const ses = session.defaultSession;
  // Pictures are stored as https://images.desktop.invalid/<key> (server.js): answered here from
  // the IMAGES bucket. Any other https address is fetched as normal (a picture linked from a
  // supplier's site, when there is a connection).
  ses.protocol.handle("https", async (req) => {
    const u = new URL(req.url);
    if (u.hostname !== IMAGES_HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    let key = u.pathname.replace(/^\/+/, "");
    try { key = decodeURIComponent(key); } catch (e) {}
    const img = server && key && !key.includes("..") ? await server.image(key).catch(() => null) : null;
    if (!img) return new Response("Not found", { status: 404 });
    return new Response(img.body, { headers: { "Content-Type": img.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  });
  // public/_headers is written for the web: here the page's fonts are bundled, there is no
  // Cloudflare analytics or bot check, and no HTTPS to insist on.
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!isOurs(details.url)) return cb({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const l = k.toLowerCase();
      if (l === "strict-transport-security") delete headers[k];
      else if (l === "content-security-policy") headers[k] = headers[k].map(desktopCsp);
    }
    cb({ responseHeaders: headers });
  });
  // The page asks for nothing on this computer (no camera, location, …).
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
}

// Stops the server, does `work` while nothing is using the database, starts it again and reloads.
async function whileStopped(work) {
  if (busy) return;
  busy = true;
  try {
    await stop();
    try { await work(); }
    finally { await start(); if (win) win.loadURL(server.url); }
  } catch (e) {
    dialog.showErrorBox("OpenDecoDesk", String((e && e.message) || e));
  } finally { busy = false; }
}

async function backUp() {
  const r = await dialog.showOpenDialog(win, { title: "Back up to which folder?", buttonLabel: "Back up here", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  const dest = path.join(r.filePaths[0], "OpenDecoDesk backup " + stamp());
  await whileStopped(async () => { copyState(dataDir, dest); });
  if (fs.existsSync(dest)) dialog.showMessageBox(win, { message: "Backed up.", detail: "Everything — orders, books, stock, pictures and files — is in\n" + dest + "\n\nKeep a copy somewhere other than this computer." });
}

async function restore() {
  const r = await dialog.showOpenDialog(win, { title: "Restore which backup?", buttonLabel: "Restore", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  const ok = await dialog.showMessageBox(win, { type: "warning", buttons: ["Restore", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Replace everything with this backup?",
    detail: "What is here now is not deleted: it is moved to the backups folder inside the data folder first.\n\nYou sign in with the password that was in use when the backup was made." });
  if (ok.response !== 0) return;
  await whileStopped(async () => { restoreState(dataDir, r.filePaths[0]); });
}

async function resetSignInMenu() {
  const ok = await dialog.showMessageBox(win, { type: "warning", buttons: ["Reset sign-in", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Locked out?",
    detail: "This clears every password and two-step sign-in. You then set up your account again (name, email, password); other users get a new password from you under Security → Users.\n\nNo orders, books or settings are changed." });
  if (ok.response !== 0) return;
  await whileStopped(async () => {
    resetSignIn(dataDir, crypt());
    await session.defaultSession.clearStorageData({ storages: ["cookies", "localstorage"] });
  });
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Back up…", click: backUp },
      { label: "Restore a backup…", click: restore },
      { type: "separator" },
      { label: "Open the data folder", click: () => shell.openPath(dataDir) },
      { type: "separator" },
      mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Locked out? Reset sign-in…", click: resetSignInMenu },
      { type: "separator" },
      { label: "Source code and licence (AGPL-3.0)", click: () => shell.openExternal(SOURCE_URL) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("odd:first-run-key", async (e) => {
  // Only the program's own page may ask.
  if (!isOurs(e.senderFrame && e.senderFrame.url)) return null;
  return server ? server.firstRunKey() : null;
});

app.whenReady().then(async () => {
  try { await start(); }
  catch (e) {
    let started = false;
    if (e && e.code === "SECRETS_UNREADABLE") {
      const r = await dialog.showMessageBox({ type: "warning", buttons: ["Reset sign-in and open", "Quit"], defaultId: 1, cancelId: 1,
        message: "OpenDecoDesk can't read its saved sign-in secret on this computer.",
        detail: "This happens when the data folder was copied from another computer, or the system's keychain isn't available.\n\nResetting sign-in keeps every order, book and setting; you set up your account (name, email, password) again.\n\nData folder: " + dataDir });
      if (r.response === 0) {
        try { resetSignIn(dataDir, crypt()); await start(); started = true; } catch (e2) { e = e2; }
      } else { app.exit(0); return; }
    }
    if (!started) {
      dialog.showErrorBox("OpenDecoDesk couldn't start", String((e && e.message) || e) + "\n\nData folder: " + dataDir);
      app.exit(1);
      return;
    }
  }
  setUpSession();
  buildMenu();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
// The database is closed properly before the program ends.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  stop().catch(() => {}).finally(() => app.quit());
});
