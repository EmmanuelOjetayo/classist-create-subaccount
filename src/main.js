import { Client, Databases } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
  // Initialize Appwrite SDK
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  // Configuration from Environment Variables
  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const DATABASE_ID = process.env.DATABASE_ID;
  const ADMIN_COLLECTION_ID = process.env.ADMIN_COLLECTION_ID;

  // Safely parse request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.json({ success: false, message: "Invalid JSON input" }, 400);
  }

  const { userId, bank_code, account_number, manual_price } = body;

  try {
    log(`Starting onboarding for User: ${userId} with Bank Code: ${bank_code}`);

    // 1. Create Subaccount on Flutterwave
    const flwResponse = await axios.post(
      "https://api.flutterwave.com/v3/subaccounts",
      {
        account_bank: bank_code, 
        account_number: account_number,
        business_name: `Classist-Admin-${userId}`,
        business_email: `admin-${userId}@classist.app`,
        business_contact: "Classist Admin",
        business_contact_mobile: "0123456789", // You can pass real phone if available
        business_mobile: "0123456789",
        country: "NG",
        split_type: "percentage",
        split_value: 0.05, // Classist takes 5% (0.05), Admin gets 95%
      },
      {
        headers: { 
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
      }
    );

    const subaccount_id = flwResponse.data.data.subaccount_id;
    log(`Flutterwave Subaccount Created: ${subaccount_id}`);

    // 2. Update Admin Document in Appwrite
    await databases.updateDocument(
      DATABASE_ID,
      ADMIN_COLLECTION_ID,
      userId,
      {
        subaccount_id: subaccount_id,
        bank_code: bank_code,
        account_number: account_number,
        manual_price: Number(manual_price),
        isOnboarded: true,
      }
    );

    return res.json({
      success: true,
      message: "Onboarding completed successfully",
      subaccount_id: subaccount_id
    });

  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    error("Onboarding Error: " + errorMsg);
    
    return res.json({
      success: false,
      message: errorMsg
    }, 400);
  }
};
