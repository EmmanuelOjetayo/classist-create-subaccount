import axios from 'axios';
import { Client, Databases, ID } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  const { FLW_SECRET_KEY, APPWRITE_API_KEY, APPWRITE_FUNCTION_PROJECT_ID } = process.env;
  
  const DB_ID = 'your_database_id';
  const ALL_PROFILES_ID = 'all_user_profiles'; // Your source collection
  const ADMIN_COL_ID = 'admins'; // Your destination collection

  if (req.method !== 'POST') return res.json({ success: false, message: "POST only" }, 405);

  const client = new Client()
    .setEndpoint('https://cloud.appwrite.io/v1')
    .setProject(APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { userId, bank_code, account_number, manual_price } = body;

    // 1. Fetch existing user details from all_user_profiles
    const userProfile = await databases.getDocument(DB_ID, ALL_PROFILES_ID, userId);

    // 2. Create Flutterwave Subaccount
    const flwResponse = await axios.post(
      'https://api.flutterwave.com/v3/subaccounts',
      {
        account_bank: bank_code,
        account_number: account_number,
        business_name: `${userProfile.department} ${userProfile.level}L Admin`,
        business_email: userProfile.email,
        business_contact: userProfile.name,
        split_type: "percentage",
        split_value: 0.05 
      },
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    const subaccount_id = flwResponse.data.data.subaccount_id;

    // 3. Update the source profile & Create/Update the Admin Collection entry
    const finalData = {
      userId: userId,
      name: userProfile.name,
      email: userProfile.email,
      department: userProfile.department,
      level: userProfile.level,
      subaccount_id: subaccount_id,
      isOnboarded: true,
      bank_code: bank_code,
      account_number: account_number,
      manual_price: Number(manual_price)
    };

    // Update the original user profile
    await databases.updateDocument(DB_ID, ALL_PROFILES_ID, userId, { isOnboarded: true });

    // Create the record in the Admins collection (using userId as docId for uniqueness)
    try {
        await databases.createDocument(DB_ID, ADMIN_COL_ID, userId, finalData);
    } catch (e) {
        // If doc already exists, update it instead
        await databases.updateDocument(DB_ID, ADMIN_COL_ID, userId, finalData);
    }

    return res.json({ success: true, subaccount_id, message: "Admin Onboarded Successfully" });

  } catch (err) {
    error(err.response?.data || err.message);
    return res.json({ success: false, message: "Onboarding failed: " + (err.message || "Invalid details") }, 400);
  }
};
