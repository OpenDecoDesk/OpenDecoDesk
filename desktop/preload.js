// What the admin page may ask of the desktop program (window.oddDesktop). Only these calls — the
// page gets no Node.js and no other access to this computer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oddDesktop", {
  edition: "desktop",
  // The passphrase for the very first sign-in, while no admin has a password yet (null after
  // that), so the owner goes straight to "Finish setting up" instead of being asked for a
  // passphrase nobody was shown.
  firstRunKey: () => ipcRenderer.invoke("odd:first-run-key"),
  // Global settings → Features (the Shipping, Email and Supplier connections panels): what the program
  // keeps — whether a Shippo key is saved (never the key), whether supplier connections are on, the
  // mailbox ({ host, port, security, user, from, on }, never the password; null if none saved).
  hasShippoKey: () => ipcRenderer.invoke("odd:has-shippo-key"),
  suppliersOn: () => ipcRenderer.invoke("odd:suppliers-on"),
  emailSettings: () => ipcRenderer.invoke("odd:email-settings"),
  // Save: a mailbox tried first (signs in, saves nothing; { ok, message }), then the program's part
  // of the settings in one go — { shippoKey, email: { on, settings, password }, suppliers }, each
  // left out when unchanged — which restarts the program's server once (not the page).
  checkEmail: (settings, password) => ipcRenderer.invoke("odd:check-email", settings, password),
  applySettings: (s) => ipcRenderer.invoke("odd:apply-settings", s),
  // Orders → Save invoice PDF…: the invoice page from the server (orders.js getInvoiceDocument),
  // made into a PDF and saved where the owner chooses. { ok, path } or { ok: false, canceled | message }.
  saveInvoicePdf: (doc) => ipcRenderer.invoke("odd:save-invoice-pdf", doc),
  // The backup reminder: { createdAt, lastBackupAt } (ISO times or null), and File → Back up….
  backupStatus: () => ipcRenderer.invoke("odd:backup-status"),
  backUp: () => ipcRenderer.invoke("odd:back-up"),
});
