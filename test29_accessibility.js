const { JSDOM, ResourceLoader } = require("jsdom");
const fs = require("fs");
let html = fs.readFileSync(__dirname + "/public/index.html", "utf8");

// Accessibility: showToast()/announceStatus() (in place of alert()), the
// cart aria-live announcements, and the labels on two form controls
// (personalization name field, image upload file input).
//
// imageUploadControl() lives in admin.js (lazily loaded);
// a custom ResourceLoader serves it so
// window.loadAdminScript() resolves in jsdom like it would in a browser.
const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    return super.fetch(url, options);
  }
}

(async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/x.html", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url) => {
        if(String(url).startsWith("/api/catalog")){
          return { ok: true, json: async () => ({
            status: "ok", orgId: "league-101",
            catalog: {
              name: "Example League 101", eyebrow: "Members shop",
              accent: "#1E7A4C", ready: true, desc: "Test catalog.", designImages:{shirt:"",cap:"",detail:""},
              cardPaymentEnabled: true,
              products: [
                { id:"A", type:"shirt", name:"Option A — Budget Performance", sub:"Style 100", images:[], features:[], personalizationPrice:2, sizePricing:{XS:23,S:23,M:23,L:23,XL:23,"2XL":24,"3XL":26,"4XL":27} }
              ]
            }
          })};
        }
        return { ok: true, json: async () => ({status:"error", message:"n/a"}) };
      };
    }
  });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 100));

  console.log("=== showToast(): creates an aria-live region and a visible, dismissible toast ===");
  {
    window.showToast("Test error message", true);
    const region = window.document.getElementById("toastRegion");
    console.log("Toast region created:", !!region);
    console.log("Region has role=status:", region.getAttribute("role") === "status");
    console.log("Region has aria-live=assertive:", region.getAttribute("aria-live") === "assertive");
    const toast = region.querySelector(".toast");
    console.log("Toast rendered with the message text:", toast.textContent === "Test error message");
    console.log("Error toast gets the toast-error class:", toast.classList.contains("toast-error"));

    window.showToast("Test success message", false);
    const toasts = region.querySelectorAll(".toast");
    console.log("A second toast stacks rather than replacing the first:", toasts.length === 2);
    console.log("Success toast does NOT get toast-error:", !toasts[1].classList.contains("toast-error"));

    toasts[0].click();
    console.log("Clicking a toast dismisses it:", region.querySelectorAll(".toast").length === 1);
  }

  console.log("\n=== announceStatus(): updates a persistent, screen-reader-only aria-live region ===");
  {
    window.announceStatus("First status message");
    const region = window.document.getElementById("statusRegion");
    console.log("Status region created:", !!region);
    console.log("Region has role=status:", region.getAttribute("role") === "status");
    console.log("Region has aria-live=polite (routine, not urgent):", region.getAttribute("aria-live") === "polite");
    console.log("Visually hidden via sr-only class, not display:none (still announced by AT):", region.className === "sr-only");
    console.log("Contains the message:", region.textContent === "First status message");

    window.announceStatus("Second status message");
    console.log("Updates in place rather than stacking (unlike toasts):", region.textContent === "Second status message");
  }

  console.log("\n=== Cart changes announce a summary via announceStatus() ===");
  {
    window.document.getElementById("size-A").value = "M";
    window.document.getElementById("qty-A").value = "2";
    window.addToCart("A");
    const afterAdd = window.document.getElementById("statusRegion").textContent;
    console.log("Announces the item name:", afterAdd.includes("Option A"));
    console.log("Announces the running total:", /total \$\d+\.\d{2}/.test(afterAdd));

    window.removeFromCart(0, "league-101");
    const afterRemove = window.document.getElementById("statusRegion").textContent;
    console.log("Announces the removal:", afterRemove.startsWith("Removed item from cart."));
    console.log("Empty cart announces clearly:", afterRemove.includes("Cart is empty"));
  }

  console.log("\n=== Personalization name field has an accessible name beyond just a placeholder ===");
  {
    const persNameInput = window.document.getElementById("pers-name-A");
    console.log("Has an aria-label naming the product:", persNameInput.getAttribute("aria-label") === "Name to embroider on Option A — Budget Performance");
  }

  console.log("\n=== Admin image-upload file input has an aria-label ===");
  {
    await window.loadAdminScript(); // imageUploadControl() lives in admin.js
    const html = window.imageUploadControl("orgFormImgShirt", "league-101");
    console.log("Output includes aria-label for the file input:", /aria-label="Upload image file"/.test(html));
  }

  console.log("\n=== No alert() or window.prompt() calls remain for anything except the test-transaction dollar amount ===");
  {
    let alertCalled = false;
    window.alert = () => { alertCalled = true; };
    window.document.getElementById("custName").value = ""; // trigger the "add your name" validation path
    await window.placeOrder("league-101");
    console.log("Validation error didn't use alert():", alertCalled === false);
    // Shown next to the order form (a persistent, role=alert box), not a pop-up or a vanishing toast.
    const msg = window.document.getElementById("checkoutMsg");
    console.log("Message shown in the order form instead:", !!msg && !msg.hidden && msg.textContent.includes("add your name") && msg.getAttribute("role") === "alert");
  }
})();
