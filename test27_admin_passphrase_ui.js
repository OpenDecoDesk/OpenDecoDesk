const { JSDOM, ResourceLoader } = require("jsdom");
const fs = require("fs");
let html = fs.readFileSync(__dirname + "/public/index.html", "utf8");

// Focused on promptAdminPassphrase() itself (in admin.js, lazily
// loaded) — the masked overlay used for the admin passphrase instead
// of window.prompt(). The full admin
// auth flow through this overlay is already exercised end-to-end in
// test.js/test2.js/test4.js/test5_xss.js/test7_proxy_client.js; this file
// covers the overlay's own interaction contract in isolation: masking,
// submit, cancel button, Escape key, and a click that must NOT cancel.

// A custom ResourceLoader intercepts the <script src="admin.js"> request
// index.html's loadAdminScript() injects, and serves the real file, so it
// resolves in jsdom exactly like it would in a browser.
const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    return super.fetch(url, options);
  }
}

(async () => {
  // Doesn't matter which host — this test never triggers the real admin
  // flow, it calls promptAdminPassphrase() directly. A minimal fetch mock
  // just keeps the page's own boot-time /api/catalog call from throwing.
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/x.html", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async () => ({ ok: true, json: async () => ({status:"error", message:"n/a"}) });
    }
  });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 100));
  await window.loadAdminScript(); // promptAdminPassphrase() lives in admin.js

  console.log("=== promptAdminPassphrase(): renders a real masked input, not plaintext ===");
  {
    const p = window.promptAdminPassphrase();
    const input = window.document.getElementById("adminPassInput");
    console.log("Overlay appended synchronously (found before the promise resolves):", !!input);
    console.log("Input is type=password (masked), not text:", input.type === "password");
    console.log("autocomplete is current-password (password manager recognition):", input.getAttribute("autocomplete") === "current-password");
    input.value = "s3cr3t";
    window.document.querySelector(".admin-pass-submit").click();
    const result = await p;
    console.log("Resolves with the typed value on submit:", result === "s3cr3t");
    console.log("Overlay removed from the DOM after resolving:", !window.document.getElementById("adminPassInput"));
  }

  console.log("\n=== promptAdminPassphrase(): Cancel button resolves with empty string ===");
  {
    const p = window.promptAdminPassphrase();
    window.document.getElementById("adminPassInput").value = "typed-but-not-submitted";
    window.document.querySelector(".admin-pass-cancel").click();
    const result = await p;
    console.log("Resolves with \"\" (matches every call site's existing `|| \"\"` handling):", result === "");
    console.log("Overlay removed after cancel:", !window.document.getElementById("adminPassInput"));
  }

  console.log("\n=== promptAdminPassphrase(): Escape key cancels ===");
  {
    const p = window.promptAdminPassphrase();
    const input = window.document.getElementById("adminPassInput");
    input.value = "typed-but-escaped";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const result = await p;
    console.log("Resolves with \"\" on Escape:", result === "");
  }

  console.log("\n=== promptAdminPassphrase(): Enter key submits via form submit event ===");
  {
    const p = window.promptAdminPassphrase();
    const input = window.document.getElementById("adminPassInput");
    const form  = window.document.getElementById("adminPassForm");
    input.value = "enter-key-value";
    // Pressing Enter in a password input submits the form — simulate that.
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const result = await p;
    console.log("Resolves with the typed value on Enter (via form submit):", result === "enter-key-value");
  }

  console.log("\n=== promptAdminPassphrase(): clicking outside the box cancels ===");
  {
    const p = window.promptAdminPassphrase();
    const overlay = window.document.querySelector(".admin-pass-overlay");
    overlay.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const result = await p;
    console.log("Resolves with \"\" on click-outside:", result === "");
  }

  console.log("\n=== promptAdminPassphrase(): clicking INSIDE the box does NOT cancel ===");
  {
    const p = window.promptAdminPassphrase();
    const box = window.document.querySelector(".admin-pass-box");
    box.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    // Give any (incorrect) cancel handler a tick to fire before proving it didn't.
    await new Promise(r => setTimeout(r, 20));
    const stillOpen = !!window.document.getElementById("adminPassInput");
    console.log("Overlay is still open (click inside the box didn't bubble-cancel it):", stillOpen);
    // Clean up so this doesn't leak into a later test run.
    window.document.querySelector(".admin-pass-submit").click();
    await p;
  }
})();
