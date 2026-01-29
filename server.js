const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// GHL Configuration
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-20267a00-312f-4afb-96e1-3fa2c0ba37d8';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'JLAe4EMlLxFUSRAh1pB3';
const SITE_URL = process.env.SITE_URL || 'https://getapexautomation.com';

// GHL Custom Field IDs
const FIELD_IDS = {
  magicLinkToken: 'h9iFYRzMyzwfwzFxxQEK',
  magicLinkExpiry: '9DnrdOkpd0s1VwihA4Ef',
  sessionToken: 'aZ1HbOIStRu1HSshTdvt',
  sessionExpiry: 'YU4tul94Pjy6LNQpNUxF',
  affiliateCode: '6vixXMn6Co7zax0Z26o8',
  totalReferrals: 'gsv2PY19XMQD02YkmTbL',
  activeReferrals: '2ZCLdH0fBsHBu859Wg21',
  totalEarned: 'Em7ZiyRxaaXHxZMrmjdQ',
  pendingPayout: '77WSt5Jt6iVnpqNVfODY',
  paypalEmail: 'eEGPT1Bzyni2KnRBtMk2',
  tier: 'qVmpqD8spvnEz5HA4Xf4',
  lastPayoutDate: 'YgMuqf72R9YFYu5q8m8S',
  lastPayoutAmount: 'A7Xhmqd5fFJi1Lwa4lFU'
};

// Middleware
app.use(cors());
app.use(express.json());

// Helper: GHL API request
async function ghlRequest(endpoint, options = {}) {
  const url = `${GHL_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response.json();
}

// Helper: Get custom field value from contact
function getFieldValue(contact, fieldId) {
  const field = (contact.customFields || []).find(f => f.id === fieldId);
  return field?.value || '';
}

// Helper: Generate random token
function generateToken(length = 64) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Helper: Build affiliate data object
function buildAffiliateData(contact) {
  return {
    name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
    email: contact.email,
    affiliateCode: getFieldValue(contact, FIELD_IDS.affiliateCode),
    totalReferrals: getFieldValue(contact, FIELD_IDS.totalReferrals),
    activeReferrals: getFieldValue(contact, FIELD_IDS.activeReferrals),
    totalEarned: getFieldValue(contact, FIELD_IDS.totalEarned),
    pendingPayout: getFieldValue(contact, FIELD_IDS.pendingPayout),
    paypalEmail: getFieldValue(contact, FIELD_IDS.paypalEmail),
    tier: getFieldValue(contact, FIELD_IDS.tier),
    lastPayoutDate: getFieldValue(contact, FIELD_IDS.lastPayoutDate),
    lastPayoutAmount: getFieldValue(contact, FIELD_IDS.lastPayoutAmount)
  };
}

// ============================================
// POST /api/magic-link-request
// Sends a magic link email to the affiliate
// ============================================
app.post('/api/magic-link-request', async (req, res) => {
  try {
    const { email, portalType = 'affiliate' } = req.body;

    if (!email || !email.includes('@')) {
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Look up contact by email using search endpoint
    const searchResult = await ghlRequest(
      `/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(normalizedEmail)}`
    );

    // Find exact email match from results
    const contacts = searchResult.contacts || [];
    const contact = contacts.find(c => c.email?.toLowerCase() === normalizedEmail);
    if (!contact || !contact.id) {
      // Don't reveal if account exists
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    // Check for affiliate-active tag
    const tags = contact.tags || [];
    if (!tags.includes('affiliate-active')) {
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    // Generate token and expiry (15 minutes)
    const token = generateToken(64);
    const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store token in GHL
    await ghlRequest(`/contacts/${contact.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        customFields: [
          { id: FIELD_IDS.magicLinkToken, value: token },
          { id: FIELD_IDS.magicLinkExpiry, value: expiry }
        ]
      })
    });

    // Send magic link email via GHL
    const magicLinkUrl = `${SITE_URL}/affiliate-portal.html?token=${token}`;
    const firstName = contact.firstName || 'there';

    await ghlRequest('/conversations/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'Email',
        contactId: contact.id,
        subject: 'Your Apex Automation Login Link',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
            <h2 style="color: #14B8A6;">Hi ${firstName}!</h2>
            <p>Click the button below to log in to your affiliate portal:</p>
            <p style="text-align: center; margin: 30px 0;">
              <a href="${magicLinkUrl}" style="background: #14B8A6; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Log In to Portal
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you did not request this, you can safely ignore this email.</p>
            <p style="margin-top: 30px; color: #999; font-size: 12px;">— Apex Automation</p>
          </div>
        `
      })
    });

    res.json({ success: true, message: 'If an account exists, a login link has been sent.' });

  } catch (error) {
    console.error('Magic link request error:', error);
    res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
  }
});

// ============================================
// POST /api/magic-link-verify
// Verifies the magic link token and creates session
// ============================================
app.post('/api/magic-link-verify', async (req, res) => {
  try {
    const { token, portalType = 'affiliate' } = req.body;

    if (!token) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Search all contacts to find the one with this token
    const searchResult = await ghlRequest('/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pageLimit: 100
      })
    });

    const contacts = searchResult.contacts || [];
    let matchedContact = null;
    let tokenExpiry = null;

    for (const contact of contacts) {
      const storedToken = getFieldValue(contact, FIELD_IDS.magicLinkToken);
      if (storedToken === token) {
        matchedContact = contact;
        tokenExpiry = getFieldValue(contact, FIELD_IDS.magicLinkExpiry);
        break;
      }
    }

    if (!matchedContact) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Check if token is expired
    if (tokenExpiry && new Date(tokenExpiry) < new Date()) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Check for affiliate-active tag
    const tags = matchedContact.tags || [];
    if (!tags.includes('affiliate-active')) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Generate session token (30 day expiry)
    const sessionToken = generateToken(64);
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Store session token and clear magic link token
    await ghlRequest(`/contacts/${matchedContact.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        customFields: [
          { id: FIELD_IDS.sessionToken, value: sessionToken },
          { id: FIELD_IDS.sessionExpiry, value: sessionExpiry },
          { id: FIELD_IDS.magicLinkToken, value: '' },
          { id: FIELD_IDS.magicLinkExpiry, value: '' }
        ]
      })
    });

    res.json({
      success: true,
      sessionToken,
      email: matchedContact.email,
      user: buildAffiliateData(matchedContact)
    });

  } catch (error) {
    console.error('Magic link verify error:', error);
    res.json({ success: false, message: 'Unable to verify. Please try again.' });
  }
});

// ============================================
// POST /api/affiliate-validate
// Validates an existing session token
// ============================================
app.post('/api/affiliate-validate', async (req, res) => {
  try {
    const { token, email } = req.body;

    if (!token || !email) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Look up contact by email using search endpoint
    const normalizedEmail = email.toLowerCase().trim();
    const searchResult = await ghlRequest(
      `/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(normalizedEmail)}`
    );

    // Find exact email match from results
    const contacts = searchResult.contacts || [];
    const contact = contacts.find(c => c.email?.toLowerCase() === normalizedEmail);
    if (!contact || !contact.id) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Verify session token
    const storedToken = getFieldValue(contact, FIELD_IDS.sessionToken);
    const sessionExpiry = getFieldValue(contact, FIELD_IDS.sessionExpiry);

    if (!storedToken || storedToken !== token) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Check if session is expired
    if (sessionExpiry && new Date(sessionExpiry) < new Date()) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Check for affiliate-active tag
    const tags = contact.tags || [];
    if (!tags.includes('affiliate-active')) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    res.json({
      success: true,
      affiliate: buildAffiliateData(contact)
    });

  } catch (error) {
    console.error('Affiliate validate error:', error);
    res.json({ success: false, message: 'Unable to validate session.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Apex Affiliate API running on port ${PORT}`);
});
