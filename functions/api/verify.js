/**
 * Public design-verification endpoint — no admin auth required.
 * GET  /api/verify?token=TOKEN  → return verification data + org context
 * POST /api/verify              → submit customer response {token, action, note, imageUrls}
 */

import { getDesignVerification, respondToDesignVerification, getOrgById, setFulfillmentStage } from "../_lib/db.js";
import { sendDesignVerificationResponseNotification } from "../_lib/email.js";
import { jsonResponse, featureIsOff } from "../_lib/http.js";
import { verificationExpired, isOwnVerifyImage } from "../_lib/verifyLinks.js";

// Global settings → Features → Design approval switched off: links already emailed get a plain
// "not available" answer, and nothing can be approved or uploaded through them.
const VERIFY_OFF_MSG = "Design approval isn't available right now. Please contact us about your order.";

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  if (await featureIsOff(env, "designVerification")) return jsonResponse({ status: "unavailable", feature: "designVerification", message: VERIFY_OFF_MSG });

  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return jsonResponse({ status: "error", message: "Missing token" }, 400);

  const row = await getDesignVerification(env.DB, token);
  if (!row) return jsonResponse({ status: "error", message: "Not found" }, 404);
  if (row.status === "pending" && verificationExpired(row)) {
    return jsonResponse({ status: "error", message: "This link has expired — contact us for a new one." }, 410);
  }

  // Fetch org for branding — fail gracefully if missing
  let orgName = row.orgId, orgAccent = "#1d4ed8";
  try {
    const org = await getOrgById(env.DB, row.orgId);
    if (org) { orgName = org.name; orgAccent = org.accent || orgAccent; }
  } catch (_) {}

  return jsonResponse({
    status: "ok",
    token: row.token,
    orgId: row.orgId,
    orgName,
    orgAccent,
    orderId: row.orderId,
    customerName: row.customerName,
    message: row.message,
    imageUrls: tryParse_(row.imagesJson, []),
    verificationStatus: row.status,
    customerNote: row.customerNote || "",
    customerImageUrls: tryParse_(row.customerImagesJson, []),
    respondedAt: row.respondedAt || "",
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  if (await featureIsOff(env, "designVerification")) return jsonResponse({ status: "error", feature: "designVerification", message: VERIFY_OFF_MSG }, 403);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }

  const token = String(body.token || "").trim();
  if (!token) return jsonResponse({ status: "error", message: "Missing token" }, 400);

  const action = body.action === "approved" ? "approved" : "revision";
  const note = String(body.note || "").slice(0, 2000);
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter(u => isOwnVerifyImage(env, u)).slice(0, 3)
    : [];

  const row = await getDesignVerification(env.DB, token);
  if (!row) return jsonResponse({ status: "error", message: "Not found" }, 404);
  if (row.status !== "pending") {
    return jsonResponse({ status: "error", message: "Already responded" }, 409);
  }
  if (verificationExpired(row)) {
    return jsonResponse({ status: "error", message: "This link has expired — contact us for a new one." }, 410);
  }

  const respondedAt = new Date().toISOString();
  const updated = await respondToDesignVerification(env.DB, token, {
    status: action,
    customerNote: note,
    customerImagesJson: JSON.stringify(imageUrls),
    respondedAt,
  });

  if (!updated) return jsonResponse({ status: "error", message: "Could not record response" }, 500);

  // When approved: set designApproved fulfillment stage on the order — non-fatal.
  // Written straight to D1.
  if (action === "approved") {
    try {
      await setFulfillmentStage(env.DB, row.orderId, "designApproved");
    } catch (e) {
      console.error("verify: could not set designApproved for", row.orderId, e);
    }
  }

  // Notify admin — non-fatal
  try {
    await sendDesignVerificationResponseNotification(env, {
      orderId: row.orderId,
      orgId: row.orgId,
      customerName: row.customerName,
      action,
      note,
      imageUrls,
    });
  } catch (_) {}

  return jsonResponse({ status: "ok", action });
}

function tryParse_(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
