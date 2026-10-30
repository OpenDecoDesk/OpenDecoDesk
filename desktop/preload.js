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
  // Global settings → Supplier connections: whether they are on, and turning them on or off (which
  // restarts the program's server and reloads the page).
  suppliersOn: () => ipcRenderer.invoke("odd:suppliers-on"),
  setSuppliersOn: (on) => ipcRenderer.invoke("odd:set-suppliers-on", !!on),
  // Global settings → Email: the mailbox's settings ({ host, port, security, user, from }, never the
  // password; null while email is off), and saving them (tried first; { ok, message }) or turning
  // email off (null). Saving restarts the program's server and reloads the page.
  emailSettings: () => ipcRenderer.invoke("odd:email-settings"),
  setEmail: (settings, password) => ipcRenderer.invoke("odd:set-email", settings, password),
  // The backup reminder: { createdAt, lastBackupAt } (ISO times or null), and File → Back up….
  backupStatus: () => ipcRenderer.invoke("odd:backup-status"),
  backUp: () => ipcRenderer.invoke("odd:back-up"),
});
