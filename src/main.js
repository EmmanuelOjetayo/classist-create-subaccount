import { Client, Databases, Query, ID } from "node-appwrite";
import fetch from "node-fetch";

// ─────────────────────────────────────────────────────────────────────────
// Classist payment handler
// Single Appwrite Function, routed by body.action:
//   "createSubaccount" -> resolves + creates a Flutterwave subaccount for a rep
//   "payNow"           -> creates a pending payment + assigns a per-course serial number
//   "verifyPayment"    -> admin approves/rejects a pending payment
// ─────────────────────────────────────────────────────────────────────────

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1")
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const DATABASE_ID = process.env.DATABASE_ID;
  const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;
  const COURSE_COLLECTION_ID = process.env.COURSE_COLLECTION_ID;
  const PAYMENT_COLLECTION_ID = process.env.PAYMENT_COLLECTION_ID;
  const PROFILES_COLLECTION_ID = process.env.PROFILES_COLLECTION_ID;

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
    if (action === "payNow") {
      return await payNow({ body, databases, res, log, error, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID });
    }
    if (action === "verifyPayment") {
      return await verifyPayment({ body, databases, res, log, error, DATABASE_ID, PAYMENT_COLLECTION_ID });
    }

    return res.json({ success: false, message: `Unknown action: ${action}` }, 400);
  } catch (err) {
    error(`CRITICAL_ERROR: ${err.message}`);
    return res.json({ success: false, message: "An internal error occurred. Please try again." }, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// 1. CREATE SUBACCOUNT (course rep onboarding)
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
// 2. PAY NOW (student submits receipt, gets a per-course serial number)
// ─────────────────────────────────────────────────────────────────────────
async function payNow({ body, databases, res, log, error, DATABASE_ID, PAYMENT_COLLECTION_ID, COURSE_COLLECTION_ID, PROFILES_COLLECTION_ID }) {
  const {
    studentId,
    courseCode,
    classCode,
    receiptUrl,
    referenceNumber,
    amount,
  } = body;

  const required = { studentId, courseCode, classCode, receiptUrl, referenceNumber, amount };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.json({ success: false, message: `Missing required field: ${key}` }, 400);
    }
  }

  // Look up student profile for denormalized name/matric on the payment record
  const profileRes = await databases.listDocuments(DATABASE_ID, PROFILES_COLLECTION_ID, [Query.equal("user_id", studentId)]);
  if (profileRes.total === 0) {
    return res.json({ success: false, message: "Student profile not found." }, 404);
  }
  const profile = profileRes.documents[0];

  // Look up course to get title + assigned rep (adminId)
  const courseRes = await databases.listDocuments(DATABASE_ID, COURSE_COLLECTION_ID, [Query.equal("coursecode", courseCode), Query.equal("classCode", classCode)]);
  if (courseRes.total === 0) {
    return res.json({ success: false, message: "Course not found." }, 404);
  }
  const course = courseRes.documents[0];

  // Prevent duplicate payments (same student, course, reference)
  const dupeCheck = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [
    Query.equal("studentId", studentId),
    Query.equal("courseCode", courseCode),
    Query.equal("referenceNumber", referenceNumber),
  ]);
  if (dupeCheck.total > 0) {
    return res.json({ success: false, message: "Payment already submitted for this reference." }, 409);
  }

  // Serial number: scoped per course, based on count of existing payments for that course
  const existingForCourse = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [Query.equal("courseCode", courseCode)]);
  const nextSerial = existingForCourse.total + 1;
  const serialNumber = `${courseCode}-${String(nextSerial).padStart(4, "0")}`;

  const payment = await databases.createDocument(DATABASE_ID, PAYMENT_COLLECTION_ID, ID.unique(), {
    studentId,
    studentName: profile.full_name,
    matricNo: profile.matricNo,
    classCode,
    courseCode,
    courseTitle: course.coursetitle,
    adminId: course.assignedRepId,
    receiptUrl,
    referenceNumber,
    amount: Number(amount),
    serialNumber,
    status: "pending",
    paymentDate: new Date().toISOString(),
    verifiedBy: null,
    verifiedAt: null,
  });

  log(`PAYMENT_CREATED: ${payment.$id} serial=${serialNumber}`);

  return res.json({ success: true, payment });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. VERIFY PAYMENT (admin approves / rejects)
// ─────────────────────────────────────────────────────────────────────────
async function verifyPayment({ body, databases, res, log, error, DATABASE_ID, PAYMENT_COLLECTION_ID }) {
  const { paymentId, verifiedBy, decision, rejectionReason } = body;

  if (!paymentId || !verifiedBy || !["approved", "rejected"].includes(decision)) {
    return res.json({ success: false, message: "paymentId, verifiedBy and a valid decision are required." }, 400);
  }

  const updated = await databases.updateDocument(DATABASE_ID, PAYMENT_COLLECTION_ID, paymentId, {
    status: decision,
    verifiedBy,
    verifiedAt: new Date().toISOString(),
    rejectionReason: decision === "rejected" ? (rejectionReason || "Not specified") : null,
  });

  log(`PAYMENT_${decision.toUpperCase()}: ${paymentId}`);

  return res.json({ success: true, payment: updated });
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
        business_contact,
        business_contact_mobile,
        business_mobile,
        country,
        split_type: "flat",
        split_value: 100,
      }),
    });

    const subaccountText = await subaccountRaw.text();
    log(`SUBACCOUNT_RAW: ${subaccountText}`);

    let subaccountData;
    try {
      subaccountData = JSON.parse(subaccountText);
    } catch (e) {
      error(`SUBACCOUNT_PARSE_ERROR: ${subaccountText}`);
      return res.json({
        success: false,
        message: "Flutterwave returned an invalid response during subaccount creation.",
      }, 500);
    }

    if (subaccountData.status !== "success") {
      return res.json({
        success: false,
        message: subaccountData.message || "Flutterwave subaccount creation failed.",
      }, 400);
    }

    const subaccount = subaccountData.data;

    // ─── 6. FIND ADMIN DOC BY studentId ─────────────────────────────────
    log(`DB_QUERY: Finding document where studentId = ${userId}`);

    const queryResult = await databases.listDocuments(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      [Query.equal("studentId", userId)]
    );

    if (queryResult.total === 0) {
      return res.json({ success: false, message: "Admin profile not found." }, 404);
    }

    const adminDoc = queryResult.documents[0];
    const docId = adminDoc.$id;
    const classCode = adminDoc.classCode;

    log(`DB_UPDATE: Updating admin document ${docId}`);

    // ─── 7. UPDATE ADMIN DOC ─────────────────────────────────────────────
    await databases.updateDocument(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      docId,
      {
        subaccount_id: subaccount.subaccount_id,
        account_number,
        bank_code: account_bank,
        account_name: resolvedName,
        business_name,
        business_email,
      }
    );

    log(`ADMIN_UPDATED: ${docId}`);

    // ─── 8. UPDATE course_manual_fee ON ASSIGNED COURSES ─────────────────
    if (classCode) {
      log(`COURSES_QUERY: classCode=${classCode} assignedRepId=${userId}`);

      const coursesRes = await databases.listDocuments(
        DATABASE_ID,
        COURSE_COLLECTION_ID,
        [
          Query.equal("classCode", classCode),
          Query.equal("assignedRepId", userId),
        ]
      );

      log(`COURSES_FOUND: ${coursesRes.total} courses to update`);

      await Promise.all(
        coursesRes.documents.map((course) =>
          databases.updateDocument(
            DATABASE_ID,
            COURSE_COLLECTION_ID,
            course.$id,
            { course_manual_fee: Number(manual_fee) }
          )
        )
      );

      log(`COURSES_UPDATED: course_manual_fee=${manual_fee} on ${coursesRes.total} courses`);
    } else {
      log(`COURSES_SKIP: No classCode found on admin doc, skipping course update`);
    }

    log("SUCCESS: All steps completed.");

    return res.json({
      success: true,
      subaccount_id: subaccount.subaccount_id,
      account_name: resolvedName,
      bank_name: subaccount.bank_name,
    });

  } catch (err) {
    error(`CRITICAL_ERROR: ${err.message}`);
    return res.json({
      success: false,
      message: "An internal error occurred. Please try again.",
    }, 500);
  }
};
