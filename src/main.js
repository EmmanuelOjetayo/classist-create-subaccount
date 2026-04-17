import { Client, Databases, Users } from "node-appwrite";
import fetch from "node-fetch";

export default async ({ req, res, log, error }) => {
  try {

    // =========================
    // 🔧 APPWRITE INIT
    // =========================
    const client = new Client()
      .setEndpoint("https://fra.cloud.appwrite.io/v1")
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const users = new Users(client);

    // =========================
    // 🔐 ENV VARIABLES
    // =========================
    const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
    const DATABASE_ID = process.env.DATABASE_ID;
    const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;

    // =========================
    // 🔐 GET AUTH USER (NO FRONTEND TRUST)
    // =========================
    const userId = req.headers["x-appwrite-user-id"];

    if (!userId) {
      return res.json({
        success: false,
        message: "Unauthorized request"
      });
    }

    // (optional but stronger)
    const user = await users.get(userId);

    // =========================
    // 📥 REQUEST BODY
    // =========================
    const payload = JSON.parse(req.body);

    const {
      business_name,
      account_bank,
      account_number,
      business_email,
      business_contact,
      business_contact_mobile
    } = payload;

    // =========================
    // 🔒 VALIDATION
    // =========================
    if (!account_bank || !account_number || account_number.length !== 10) {
      return res.json({
        success: false,
        message: "Invalid bank details"
      });
    }

    // =========================
    // 🔍 STEP 1: RESOLVE ACCOUNT
    // =========================
    const resolveResponse = await fetch(
      "https://api.flutterwave.com/v3/accounts/resolve",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          account_number,
          account_bank
        })
      }
    );

    const resolveData = await resolveResponse.json();

    if (resolveData.status !== "success") {
      return res.json({
        success: false,
        message: resolveData.message || "Account verification failed"
      });
    }

    const account_name = resolveData.data.account_name;

    // =========================
    // 🏦 STEP 2: CREATE SUBACCOUNT
    // =========================
    const subResponse = await fetch(
      "https://api.flutterwave.com/v3/subaccounts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          account_bank,
          account_number,
          business_name: account_name,
          business_email: business_email || user.email,
          business_contact: business_contact || user.name,
          business_contact_mobile: business_contact_mobile || "0000000000",
          country: "NG"
        })
      }
    );

    const subData = await subResponse.json();

    if (subData.status !== "success") {
      return res.json({
        success: false,
        message: subData.message || "Subaccount creation failed"
      });
    }

    const subaccount = subData.data;

    // =========================
    // 💾 STEP 3: SAVE TO APPWRITE DB
    // =========================
    await databases.updateDocument(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      userId, // document ID must match userId in DB
      {
        subaccount_id: subaccount.subaccount_id,
        account_number,
        bank_code: account_bank,
        account_name
      }
    );

    // =========================
    // ✅ RESPONSE
    // =========================
    return res.json({
      success: true,
      subaccount_id: subaccount.subaccount_id,
      account_name,
      bank_name: subaccount.bank_name,
      account_number
    });

  } catch (err) {
    error(err.message);

    return res.json({
      success: false,
      message: "Internal server error"
    });
  }
};
