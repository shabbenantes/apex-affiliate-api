const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// GHL Configuration (still used for contact lookup and email sending)
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-20267a00-312f-4afb-96e1-3fa2c0ba37d8';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'JLAe4EMlLxFUSRAh1pB3';
const SITE_URL = process.env.SITE_URL || 'https://getapexautomation.com';

// Database path - use persistent directory on Render if available
const DATA_DIR = process.env.DATA_DIR || '/opt/render/project/data';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'auth.db');

// GHL Custom Field IDs (for affiliate data, not tokens)
const FIELD_IDS = {
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

// ============================================
// DATABASE INITIALIZATION
// ============================================
let db;

function initDatabase() {
  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Create tokens table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('magic_link', 'session')),
      contact_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
    CREATE INDEX IF NOT EXISTS idx_tokens_email_type ON tokens(email, type);
    CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON tokens(expires_at);
  `);

  console.log(`Database initialized at ${DB_PATH}`);
}

// Clean up expired tokens periodically
function cleanupExpiredTokens() {
  const now = new Date().toISOString();
  const result = db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} expired tokens`);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Clean up expired tokens on each request (lightweight operation)
app.use((req, res, next) => {
  cleanupExpiredTokens();
  next();
});

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

// Helper: Look up contact by email in GHL
async function findContactByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const searchResult = await ghlRequest(
    `/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(normalizedEmail)}`
  );
  const contacts = searchResult.contacts || [];
  return contacts.find(c => c.email?.toLowerCase() === normalizedEmail);
}

// ============================================
// POST /api/magic-link-request
// Sends a magic link email to the affiliate
// ============================================
app.post('/api/magic-link-request', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Look up contact in GHL
    const contact = await findContactByEmail(normalizedEmail);
    if (!contact || !contact.id) {
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    // Check for affiliate-active tag
    const tags = contact.tags || [];
    if (!tags.includes('affiliate-active')) {
      return res.json({ success: true, message: 'If an account exists, a login link has been sent.' });
    }

    // Generate token and expiry (15 minutes)
    const token = generateToken(64);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Delete any existing magic link tokens for this email
    db.prepare('DELETE FROM tokens WHERE email = ? AND type = ?').run(normalizedEmail, 'magic_link');

    // Store token in SQLite
    db.prepare(`
      INSERT INTO tokens (email, token, type, contact_id, expires_at)
      VALUES (?, ?, 'magic_link', ?, ?)
    `).run(normalizedEmail, token, contact.id, expiresAt);

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

    console.log(`Magic link sent to ${normalizedEmail}`);
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
    const { token } = req.body;

    if (!token) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Look up token in SQLite
    const tokenRow = db.prepare(`
      SELECT * FROM tokens WHERE token = ? AND type = 'magic_link'
    `).get(token);

    if (!tokenRow) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Check if token is expired
    if (new Date(tokenRow.expires_at) < new Date()) {
      // Delete expired token
      db.prepare('DELETE FROM tokens WHERE id = ?').run(tokenRow.id);
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Look up contact in GHL to get affiliate data
    const contact = await findContactByEmail(tokenRow.email);
    if (!contact) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Check for affiliate-active tag
    const tags = contact.tags || [];
    if (!tags.includes('affiliate-active')) {
      return res.json({ success: false, message: 'This link has expired or is invalid. Please request a new one.' });
    }

    // Generate session token (30 day expiry)
    const sessionToken = generateToken(64);
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Delete any existing session tokens for this email
    db.prepare('DELETE FROM tokens WHERE email = ? AND type = ?').run(tokenRow.email, 'session');

    // Store session token in SQLite
    db.prepare(`
      INSERT INTO tokens (email, token, type, contact_id, expires_at)
      VALUES (?, ?, 'session', ?, ?)
    `).run(tokenRow.email, sessionToken, contact.id, sessionExpiry);

    // Delete the used magic link token
    db.prepare('DELETE FROM tokens WHERE id = ?').run(tokenRow.id);

    console.log(`Session created for ${tokenRow.email}`);

    res.json({
      success: true,
      sessionToken,
      email: contact.email,
      user: buildAffiliateData(contact)
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

    const normalizedEmail = email.toLowerCase().trim();

    // Look up session token in SQLite
    const sessionRow = db.prepare(`
      SELECT * FROM tokens WHERE token = ? AND email = ? AND type = 'session'
    `).get(token, normalizedEmail);

    if (!sessionRow) {
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Check if session is expired
    if (new Date(sessionRow.expires_at) < new Date()) {
      // Delete expired session
      db.prepare('DELETE FROM tokens WHERE id = ?').run(sessionRow.id);
      return res.json({ success: false, message: 'Session expired. Please log in again.' });
    }

    // Look up contact in GHL to get latest affiliate data
    const contact = await findContactByEmail(normalizedEmail);
    if (!contact) {
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
  const tokenCount = db.prepare('SELECT COUNT(*) as count FROM tokens').get();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: DB_PATH,
    activeTokens: tokenCount.count
  });
});

// Debug endpoint (remove in production)
app.get('/api/debug/tokens', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  const tokens = db.prepare('SELECT id, email, type, expires_at, created_at FROM tokens').all();
  res.json({ tokens });
});

// Initialize database and start server
initDatabase();
app.listen(PORT, () => {
  console.log(`Apex Affiliate API running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
