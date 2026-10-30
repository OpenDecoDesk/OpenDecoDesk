// What the admin page may ask of the desktop program (window.oddDesktop). Only these calls — the
// page gets no Node.js and no other access to this computer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oddDesktop", {
  edition: "desktop",
  // The passphrase for the very first sign-in, while no admin has a password yet (null after
  // that), so the owner goes straight to "Finish setting up" instead of being asked for a
  // passphrase nobody was shown.
  firstRunKey: () => ipcRenderer.invoke("odd:first-run-key"),
  // Global settings → Carrier shipping (Shippo): whether a key is set (never the key itself), and
  // saving or removing it (null). Saving restarts the program's server and reloads the page.
  hasShippoKey: () => ipcRenderer.invoke("odd:has-shippo-key"),
  setShippoKey: (key) => ipcRenderer.invoke("odd:set-shippo-key", key),
});
