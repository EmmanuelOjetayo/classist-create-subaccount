import { Client, Databases, Users, Query } from "node-appwrite";
import fetch from "node-fetch";

export default async ({ req, res, log, error }) => {
  // ─── 1. INIT ──────────────────────────────────────────────────────────
  const client = new Client()
    .setEndpoint("https://fra.cloud.appwrite.io/v1")
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const DATABASE_ID = process.env.DATABASE_ID;
  const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;
  const COURSE_COLLECTION_ID = process.env.COURSE_COLLECTION_ID;

  try {
    // ─── 2. PARSE BODY ──────────────────────────────────────────────────
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return res.json({ success: false, message: "Invalid request body" }, 400);
    }

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

    // ─── 3. VALIDATE REQUIRED FIELDS ────────────────────────────────────
    const required = {
      account_bank, account_number, business_name,
      business_email, business_contact,
      business_contact_mobile, business_mobile,
      manual_fee, userId
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

    // ─── 4. VERIFY ACCOUNT WITH FLUTTERWAVE ─────────────────────────────
    log(`RESOLVING: account ${account_number} at bank ${account_bank}`);

    const resolveRaw = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account_number, account_bank }),
    });

    const resolveText = await resolveRaw.text();
    log(`RESOLVE_RAW: ${resolveText}`);

    let resolveData;
    try {
      resolveData = JSON.parse(resolveText);
    } catch (e) {
      error(`RESOLVE_PARSE_ERROR: ${resolveText}`);
      return res.json({
        success: false,
        message: "Flutterwave returned an invalid response during account verification. Check your FLW_SECRET_KEY.",
      }, 500);
    }

    if (resolveData.status !== "success") {
      return res.json({
        success: false,
        message: resolveData.message || "Could not verify account. Please check the account number and bank.",
      }, 400);
    }

    const resolvedName = resolveData.data.account_name;
    log(`RESOLVED_NAME: ${resolvedName}`);

    // ─── 5. CREATE SUBACCOUNT ON FLUTTERWAVE ────────────────────────────
    log(`CREATING subaccount for ${business_name}`);

    const subaccountRaw = await fetch("https://api.flutterwave.com/v3/subaccounts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_bank,
        account_number,
        business_name,
        business_email,
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
