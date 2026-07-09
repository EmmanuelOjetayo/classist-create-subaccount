import { Client, Databases, Query, ID } from "node-appwrite";
import fetch from "node-fetch";

// ─────────────────────────────────────────────────────────────────────────
// Classist payment handler
// Single Appwrite Function, routed by body.action:
//   "createSubaccount"   -> resolves + creates a Flutterwave subaccount for a rep (unchanged)
//   "initializePayment"  -> starts a Flutterwave Checkout transaction, returns a payment link
//   "verifyTransaction"  -> called from the frontend redirect-back page; verifies + records the payment
// Flutterwave webhooks land on this same function (detected via the `verif-hash` header),
// and are handled independently of body.action since Flutterwave posts its own payload shape.
// ─────────────────────────────────────────────────────────────────────────

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1")
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const FLW_WEBHOOK_HASH = process.env.FLW_WEBHOOK_HASH;
  const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL;
  const DATABASE_ID = process.env.DATABASE_ID;
  const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;
  const COURSE_COLLECTION_ID = process.env.COURSE_COLLECTION_ID;
  const PAYMENT_COLLECTION_ID = process.env.PAYMENT_COLLECTION_ID;
  const PROFILES_COLLECTION_ID = process.env.PROFILES_COLLECTION_ID;

  // ── Flutterwave webhook: comes in as a raw POST with a verif-hash header,
  // not as one of our own { action: ... } calls. Handle it first and return early.
  const incomingHash = req.headers["verif-hash"] || req.headers["Verif-Hash"];
  if (incomingHash) {
    return await handleWebhook({
      req, res, log, error, incomingHash, FLW_WEBHOOK_HASH, FLW_SECRET_KEY,
      databases, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID,
    });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.json({ success: false, message: "Invalid request body" }, 400);
  }

  const { action } = body;

  try {
    if (action === "createSubaccount") {
      return await createSubaccount({ body, databases, res, log, error, FLW_SECRET_KEY, DATABASE_ID, ADMIN_COLLECTION_ID, COURSE_COLLECTION_ID });
    }
    if (action === "initializePayment") {
      return await initializePayment({
        body, databases, res, log, error, FLW_SECRET_KEY, FRONTEND_BASE_URL,
        DATABASE_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID,
      });
    }
    if (action === "verifyTransaction") {
      return await verifyTransaction({
        body, databases, res, log, error, FLW_SECRET_KEY,
        DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID,
      });
    }

    return res.json({ success: false, message: `Unknown action: ${action}` }, 400);
  } catch (err) {
    error(`CRITICAL_ERROR: ${err.message}`);
    return res.json({ success: false, message: "An internal error occurred. Please try again." }, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// 1. CREATE SUBACCOUNT (course rep onboarding) — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────
async function createSubaccount({ body, databases, res, log, error, FLW_SECRET_KEY, DATABASE_ID, ADMIN_COLLECTION_ID, COURSE_COLLECTION_ID }) {
  const {
    account_bank,
    account_number,
    business_name,
    business_email,
    business_contact,
    business_contact_mobile,
    business_mobile,
    country = "NG",
    manual_fee,
    userId,
  } = body;

  const required = {
    account_bank, account_number, business_name,
    business_email, business_contact,
    business_contact_mobile, business_mobile,
    manual_fee, userId,
  };

  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.json({ success: false, message: `Missing required field: ${key}` }, 400);
    }
  }

  if (account_number.toString().length !== 10) {
    return res.json({ success: false, message: "Account number must be 10 digits" }, 400);
  }

  if (isNaN(manual_fee) || Number(manual_fee) <= 0) {
    return res.json({ success: false, message: "Valid manual fee is required" }, 400);
  }

  log(`RESOLVING: account ${account_number} at bank ${account_bank}`);

  const resolveRaw = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
    method: "POST",
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ account_number, account_bank }),
  });

  const resolveData = await safeJson(resolveRaw, error, "RESOLVE");
  if (!resolveData) {
    return res.json({ success: false, message: "Flutterwave returned an invalid response during account verification." }, 500);
  }
  if (resolveData.status !== "success") {
    return res.json({ success: false, message: resolveData.message || "Could not verify account." }, 400);
  }

  const resolvedName = resolveData.data.account_name;
  log(`RESOLVED_NAME: ${resolvedName}`);

  const subaccountRaw = await fetch("https://api.flutterwave.com/v3/subaccounts", {
    method: "POST",
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      account_bank, account_number, business_name, business_email,
      business_contact, business_contact_mobile, business_mobile,
      country, split_type: "flat", split_value: 100,
    }),
  });

  const subaccountData = await safeJson(subaccountRaw, error, "SUBACCOUNT");
  if (!subaccountData) {
    return res.json({ success: false, message: "Flutterwave returned an invalid response during subaccount creation." }, 500);
  }
  if (subaccountData.status !== "success") {
    return res.json({ success: false, message: subaccountData.message || "Subaccount creation failed." }, 400);
  }

  const subaccount = subaccountData.data;

  const queryResult = await databases.listDocuments(DATABASE_ID, ADMIN_COLLECTION_ID, [Query.equal("studentId", userId)]);
  if (queryResult.total === 0) {
    return res.json({ success: false, message: "Admin profile not found." }, 404);
  }

  const adminDoc = queryResult.documents[0];
  const docId = adminDoc.$id;
  const classCode = adminDoc.classCode;

  await databases.updateDocument(DATABASE_ID, ADMIN_COLLECTION_ID, docId, {
    subaccount_id: subaccount.subaccount_id,
    account_number,
    bank_code: account_bank,
    account_name: resolvedName,
    business_name,
    business_email,
  });

  log(`ADMIN_UPDATED: ${docId}`);

  if (classCode) {
    const coursesRes = await databases.listDocuments(DATABASE_ID, COURSE_COLLECTION_ID, [
      Query.equal("classCode", classCode),
      Query.equal("assignedRepId", userId),
    ]);

    await Promise.all(
      coursesRes.documents.map((course) =>
        databases.updateDocument(DATABASE_ID, COURSE_COLLECTION_ID, course.$id, {
          course_manual_fee: Number(manual_fee),
        })
      )
    );
    log(`COURSES_UPDATED: course_manual_fee=${manual_fee} on ${coursesRes.total} courses`);
  }

  return res.json({
    success: true,
    subaccount_id: subaccount.subaccount_id,
    account_name: resolvedName,
    bank_name: subaccount.bank_name,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 2. INITIALIZE PAYMENT — starts a Flutterwave Checkout transaction
// ─────────────────────────────────────────────────────────────────────────
async function initializePayment({ body, databases, res, log, error, FLW_SECRET_KEY, FRONTEND_BASE_URL, DATABASE_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID }) {
  const { studentId, courseCode, classCode } = body;

  const required = { studentId, courseCode, classCode };
  for (const [key, val] of Object.entries(required)) {
    if (!val) return res.json({ success: false, message: `Missing required field: ${key}` }, 400);
  }

  const profileRes = await databases.listDocuments(DATABASE_ID, PROFILES_COLLECTION_ID, [Query.equal("user_id", studentId)]);
  if (profileRes.total === 0) return res.json({ success: false, message: "Student profile not found." }, 404);
  const profile = profileRes.documents[0];

  // Amount is always read from the course record — never trust a client-supplied amount.
  const courseRes = await databases.listDocuments(DATABASE_ID, COURSE_COLLECTION_ID, [
    Query.equal("coursecode", courseCode),
    Query.equal("classCode", classCode),
  ]);
  if (courseRes.total === 0) return res.json({ success: false, message: "Course not found." }, 404);
  const course = courseRes.documents[0];

  if (!course.course_manual_fee || course.course_manual_fee <= 0) {
    return res.json({ success: false, message: "This course has no manual fee configured." }, 400);
  }

  // tx_ref encodes studentId + courseCode + classCode so verifyTransaction can
  // rebuild the record without trusting anything the client sends back.
  const tx_ref = `CLSST-${studentId}-${courseCode}-${classCode}-${Date.now()}`;

  const initRaw = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref,
      amount: course.course_manual_fee,
      currency: "NGN",
      redirect_url: `${FRONTEND_BASE_URL}/payment-callback`,
      customer: { email: profile.email, name: profile.full_name },
      customizations: {
        title: "Classist — Course manual fee",
        description: `${courseCode} manual fee payment`,
      },
    }),
  });

  const initData = await safeJson(initRaw, error, "INIT");
  if (!initData) return res.json({ success: false, message: "Flutterwave returned an invalid response during initialization." }, 500);
  if (initData.status !== "success") return res.json({ success: false, message: initData.message || "Could not initialize payment." }, 400);

  log(`PAYMENT_INITIALIZED: tx_ref=${tx_ref}`);

  return res.json({ success: true, link: initData.data.link, tx_ref });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. VERIFY TRANSACTION — called from the frontend redirect-back page
// ─────────────────────────────────────────────────────────────────────────
async function verifyTransaction({ body, databases, res, log, error, FLW_SECRET_KEY, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID }) {
  const { transactionId } = body;
  if (!transactionId) return res.json({ success: false, message: "transactionId is required." }, 400);

  const result = await verifyAndRecord({
    transactionId, databases, log, error, FLW_SECRET_KEY,
    DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID,
  });

  if (!result.success) return res.json(result, result.status || 400);
  return res.json(result);
}

// ─────────────────────────────────────────────────────────────────────────
// 4. FLUTTERWAVE WEBHOOK — independent safety net in case the redirect-back
//    step never fires (browser closed, network drop, etc.)
// ─────────────────────────────────────────────────────────────────────────
async function handleWebhook({ req, res, log, error, incomingHash, FLW_WEBHOOK_HASH, FLW_SECRET_KEY, databases, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID }) {
  if (!FLW_WEBHOOK_HASH || incomingHash !== FLW_WEBHOOK_HASH) {
    error("WEBHOOK_REJECTED: hash mismatch");
    return res.json({ success: false, message: "Invalid webhook signature." }, 401);
  }

  let payload;
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.json({ success: false, message: "Invalid webhook payload." }, 400);
  }

  const transactionId = payload?.data?.id;
  if (!transactionId) {
    return res.json({ success: false, message: "No transaction id in webhook payload." }, 400);
  }

  log(`WEBHOOK_RECEIVED: transactionId=${transactionId}`);

  // Never trust the webhook body's amount/status directly — re-verify with Flutterwave.
  const result = await verifyAndRecord({
    transactionId, databases, log, error, FLW_SECRET_KEY,
    DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID,
  });

  // Always 200 the webhook so Flutterwave doesn't retry-storm us; log failures internally.
  if (!result.success) error(`WEBHOOK_VERIFY_FAILED: ${result.message}`);
  return res.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Shared: verify a transaction with Flutterwave, then create the paymentCol
// document if (and only if) it's genuinely successful and not a duplicate.
// Used by both verifyTransaction (frontend callback) and the webhook.
// ─────────────────────────────────────────────────────────────────────────
async function verifyAndRecord({ transactionId, databases, log, error, FLW_SECRET_KEY, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID }) {
  // Duplicate guard #1: if we've already recorded this exact transaction, return it as-is.
  const existingByTx = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [Query.equal("transactionId", String(transactionId))]);
  if (existingByTx.total > 0) {
    return { success: true, payment: existingByTx.documents[0], duplicate: true };
  }

  const verifyRaw = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
  });
  const verifyData = await safeJson(verifyRaw, error, "VERIFY");
  if (!verifyData) return { success: false, message: "Flutterwave returned an invalid response during verification.", status: 500 };
  if (verifyData.status !== "success") return { success: false, message: verifyData.message || "Verification call failed.", status: 400 };

  const txn = verifyData.data;
  const tx_ref = txn.tx_ref;

  // Duplicate guard #2: also key off tx_ref, in case verifyTransaction and the
  // webhook race each other for the same checkout attempt.
  const existingByRef = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [Query.equal("txRef", tx_ref)]);
  if (existingByRef.total > 0) {
    return { success: true, payment: existingByRef.documents[0], duplicate: true };
  }

  // tx_ref shape: CLSST-{studentId}-{courseCode}-{classCode}-{timestamp}
  const parts = tx_ref.split("-");
  if (parts[0] !== "CLSST" || parts.length < 5) {
    return { success: false, message: "Unrecognized tx_ref format; refusing to record.", status: 400 };
  }
  const studentId = parts[1];
  const courseCode = parts[2];
  const classCode = parts[3];

  const profileRes = await databases.listDocuments(DATABASE_ID, PROFILES_COLLECTION_ID, [Query.equal("user_id", studentId)]);
  const courseRes = await databases.listDocuments(DATABASE_ID, COURSE_COLLECTION_ID, [Query.equal("coursecode", courseCode), Query.equal("classCode", classCode)]);
  if (profileRes.total === 0 || courseRes.total === 0) {
    return { success: false, message: "Could not resolve student/course for this transaction.", status: 404 };
  }
  const profile = profileRes.documents[0];
  const course = courseRes.documents[0];

  const isSuccessful = txn.status === "successful" && txn.currency === "NGN" && Number(txn.amount) >= Number(course.course_manual_fee);

  let serialNumber = null;
  if (isSuccessful) {
    const existingForCourse = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [
      Query.equal("courseCode", courseCode),
      Query.equal("status", "successful"),
    ]);
    serialNumber = `${courseCode}-${String(existingForCourse.total + 1).padStart(4, "0")}`;
  }

  const payment = await databases.createDocument(DATABASE_ID, PAYMENT_COLLECTION_ID, ID.unique(), {
    studentId,
    fullName: profile.full_name,
    matricNo: profile.matricNo,
    classCode,
    courseCode,
    courseTitle: course.coursetitle,
    adminId: course.assignedRepId,
    amount: Number(txn.amount),
    txRef: tx_ref,
    transactionId: String(transactionId),
    status: isSuccessful ? "successful" : "failed",
    paymentMethod: "Flutterwave",
    paidAt: txn.created_at ? new Date(txn.created_at).toISOString() : new Date().toISOString(),
    verified: true,
    verifiedAt: new Date().toISOString(),
    // NOTE: requires a `serialNumber` (String) attribute on paymentCol — see chat notes.
    serialNumber,
  });

  log(`PAYMENT_RECORDED: ${payment.$id} status=${payment.status} serial=${serialNumber || "n/a"}`);

  return { success: true, payment };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
async function safeJson(rawRes, error, label) {
  const text = await rawRes.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    error(`${label}_PARSE_ERROR: ${text}`);
    return null;
  }
}
