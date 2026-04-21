import { Client, Databases, Users } from "node-appwrite";
import fetch from "node-fetch";

export default async ({ req, res, log, error }) => {
  // ─── 1. INIT ──────────────────────────────────────────────────────────
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
      split_type: "flat",
      split_value: 100, 
      userId,
    } = body;

    // ─── 3. VALIDATE REQUIRED FIELDS ────────────────────────────────────
    const required = {
      account_bank, account_number, business_name,
      business_email, business_contact,
      business_contact_mobile, business_mobile,
      split_type, split_value, userId
    };

    for (const [key, val] of Object.entries(required)) {
      if (val === undefined || val === null || val === "") {
        return res.json({ success: false, message: `Missing required field: ${key}` }, 400);
      }
    }

    if (account_number.toString().length !== 10) {
      return res.json({ success: false, message: "Account number must be 10 digits" }, 400);
    }

    // ─── 4. VERIFY ACCOUNT WITH FLUTTERWAVE ─────────────────────────────
    log(`RESOLVING: account ${account_number} at bank ${account_bank}`);

    const resolveRes = await fetch(
      `https://api.flutterwave.com/v3/accounts/resolve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ account_number, account_bank }),
      }
    );

    const resolveData = await resolveRes.json();
    log(`RESOLVE_RESPONSE: ${JSON.stringify(resolveData)}`);

    if (resolveData.status !== "success") {
      return res.json({
        success: false,
        message: "Could not verify account. Please check the account number and bank.",
      }, 400);
    }

    const resolvedName = resolveData.data.account_name;
    log(`RESOLVED_NAME: ${resolvedName}`);

    // ─── 5. CREATE SUBACCOUNT ON FLUTTERWAVE ────────────────────────────
    log(`CREATING subaccount for ${business_name}`);

    const subaccountRes = await fetch("https://api.flutterwave.com/v3/subaccounts", {
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

    const subaccountData = await subaccountRes.json();
    log(`SUBACCOUNT_RESPONSE: ${JSON.stringify(subaccountData)}`);

    if (subaccountData.status !== "success") {
      return res.json({
        success: false,
        message: subaccountData.message || "Flutterwave subaccount creation failed",
      }, 400);
    }

    const subaccount = subaccountData.data;

    // ─── 6. SAVE TO APPWRITE DB ─────────────────────────────────────────
    log(`DB_UPDATE: Saving subaccount for user ${userId}`);

    await databases.updateDocument(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      userId,
      {
        subaccount_id: subaccount.subaccount_id,
        account_number,
        bank_code: account_bank,
        account_name: resolvedName,
        business_name,
        business_email,
      }
    );

    log("SUCCESS: Subaccount created and saved.");

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
