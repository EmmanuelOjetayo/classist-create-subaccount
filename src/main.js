import { Client, Databases, Users } from "node-appwrite";
import fetch from "node-fetch";

export default async ({ req, res, log, error }) => {
  // 🔧 1. APPWRITE INIT
  const client = new Client()
    .setEndpoint("https://fra.cloud.appwrite.io/v1")
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const DATABASE_ID = process.env.DATABASE_ID;
  const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;

  try {
    // 📥 2. SAFE BODY PARSING (Matches your working module)
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const userId = req.headers["x-appwrite-user-id"];

    log(`START: Processing subaccount for UserID: ${userId}`);

    if (!userId) {
      error("AUTH_ERROR: No UserID found in headers.");
      return res.json({ success: false, message: "Unauthorized request" }, 401);
    }

    // 🔐 3. GET AUTH USER (Requires 'users.read' scope in settings)
    let user;
    try {
      user = await users.get(userId);
      log(`USER_FETCH: Found user ${user.email}`);
    } catch (e) {
      error(`SCOPE_ERROR: Failed to fetch user. Ensure 'users.read' scope is enabled. ${e.message}`);
      return res.json({ success: false, message: "Server permission error (users.read)" }, 500);
    }

    const { account_bank, account_number, business_email, business_contact } = payload;

    // 🔍 4. RESOLVE ACCOUNT
    log(`FLW_RESOLVE: Verifying ${account_number} with bank ${account_bank}`);
    const resolveResponse = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ account_number, account_bank })
    });

    const resolveData = await resolveResponse.json();
    if (resolveData.status !== "success") {
      error(`FLW_RESOLVE_FAIL: ${resolveData.message}`);
      return res.json({ success: false, message: resolveData.message || "Bank verification failed" });
    }

    const resolvedName = resolveData.data.account_name;
    log(`FLW_RESOLVE_SUCCESS: ${resolvedName}`);

    // 🏦 5. CREATE SUBACCOUNT
    log(`FLW_SUBACCOUNT: Creating subaccount for ${resolvedName}`);
    const subResponse = await fetch("https://api.flutterwave.com/v3/subaccounts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        account_bank,
        account_number,
        business_name: resolvedName,
        business_email: business_email || user.email,
        business_contact: business_contact || user.name,
        country: "NG"
      })
    });

    const subData = await subResponse.json();
    if (subData.status !== "success") {
      error(`FLW_SUB_FAIL: ${subData.message}`);
      return res.json({ success: false, message: subData.message || "Subaccount creation failed" });
    }

    const subaccount = subData.data;
    log(`FLW_SUB_SUCCESS: ID ${subaccount.subaccount_id}`);

    // 💾 6. SAVE TO APPWRITE DB
    log(`DB_UPDATE: Updating document ${userId} in collection ${ADMIN_COLLECTION_ID}`);
    await databases.updateDocument(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      userId,
      {
        subaccount_id: subaccount.subaccount_id,
        account_number,
        bank_code: account_bank,
        account_name: resolvedName
      }
    );

    log("SUCCESS: All steps completed.");
    return res.json({
      success: true,
      subaccount_id: subaccount.subaccount_id,
      account_name: resolvedName
    });

  } catch (err) {
    error(`CRITICAL_ERROR: ${err.message}`);
    return res.json({
      success: false,
      message: "Internal server error",
      details: err.message
    }, 500);
  }
};
