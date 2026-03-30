import axios from 'axios';

export default async ({ req, res, log, error }) => {
  // Pull Secret Key from Appwrite Function Environment Variables
  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.json({ success: false, message: "Method not allowed" }, 405);
  }

  try {
    // Parse incoming data from the Admin Hub frontend
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { bank_code, account_number, business_name, email, name, phone } = body;

    // 1. Create the Subaccount on Flutterwave
    const response = await axios.post(
      'https://api.flutterwave.com/v3/subaccounts',
      {
        account_bank: bank_code,
        account_number: account_number,
        business_name: business_name,
        business_email: email,
        business_contact: name,
        business_contact_mobile: phone,
        split_type: "percentage",
        split_value: 0.05 // You (Classist) take 5% commission
      },
      {
        headers: { 
            Authorization: `Bearer ${FLW_SECRET_KEY}`,
            'Content-Type': 'application/json'
        }
      }
    );

    log(`Subaccount created for ${business_name}: ${response.data.data.subaccount_id}`);

    return res.json({
      success: true,
      subaccount_id: response.data.data.subaccount_id,
      bank_name: response.data.data.bank_name
    });

  } catch (err) {
    // Catch-all for API errors (wrong bank code, invalid account, etc.)
    error("Flutterwave API Error: " + JSON.stringify(err.response?.data || err.message));
    
    return res.json({
      success: false,
      message: err.response?.data?.message || "Failed to link bank account"
    }, 400);
  }
};
