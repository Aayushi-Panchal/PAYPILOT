/**
 * PayPilot PayPal Sandbox Service
 * Handles server-side order creation, order capture, status verification,
 * and database recording according to PayPal Developer Standards.
 */

const { db } = require('../db/database');
const crypto = require('node:crypto');

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

function isConfigured() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;
  const lowerId = clientId.toLowerCase();
  const lowerSec = clientSecret.toLowerCase();
  if (lowerId.includes('your_') || lowerSec.includes('your_')) return false;
  if (lowerId.includes('placeholder') || lowerSec.includes('placeholder')) return false;
  return true;
}

/**
 * Get OAuth2 access token from PayPal Sandbox
 */
async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('PAYPAL_CREDENTIALS_MISSING');
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`PayPal OAuth authentication failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Create a PayPal Sandbox Order
 */
async function createOrder({ amount, currency = 'USD', businessId = null, projectId = null, paymentType = 'pro_subscription', idempotencyKey = null }) {
  if (!isConfigured()) {
    return {
      success: false,
      configured: false,
      error: 'PAYPAL_CREDENTIALS_MISSING',
      message: 'PayPal Sandbox credentials (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET) must be configured in your .env file.'
    };
  }

  const accessToken = await getAccessToken();
  const formattedAmount = Number(amount).toFixed(2);
  const effectiveIdempotencyKey = idempotencyKey || crypto.randomUUID();

  // Check if idempotency key already used
  const existingPayment = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(effectiveIdempotencyKey);
  if (existingPayment) {
    return {
      success: true,
      orderId: existingPayment.paypal_order_id,
      status: existingPayment.status,
      idempotentCached: true
    };
  }

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: `pp_${Date.now()}`,
        description: `PayPilot ${paymentType.replace('_', ' ').toUpperCase()} Payment`,
        custom_id: JSON.stringify({ businessId, projectId, paymentType }),
        amount: {
          currency_code: currency,
          value: formattedAmount
        }
      }
    ],
    application_context: {
      brand_name: 'PayPilot Business Operating Platform',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      return_url: 'https://example.com/paypal/return',
      cancel_url: 'https://example.com/paypal/cancel'
    }
  };

  const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'PayPal-Request-Id': effectiveIdempotencyKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create PayPal order: ${errText}`);
  }

  const orderData = await response.json();

  // Record initial order intent in database
  const insertStmt = db.prepare(`
    INSERT INTO payments (
      id, paypal_order_id, business_id, project_id, amount, currency, status,
      payment_type, idempotency_key, verified_server_side, raw_response
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const paymentId = crypto.randomUUID();
  insertStmt.run(
    paymentId,
    orderData.id,
    businessId,
    projectId,
    parseFloat(formattedAmount),
    currency,
    orderData.status,
    paymentType,
    effectiveIdempotencyKey,
    JSON.stringify(orderData)
  );

  return {
    success: true,
    configured: true,
    orderId: orderData.id,
    status: orderData.status,
    links: orderData.links
  };
}

/**
 * Capture a PayPal Sandbox Order and verify server-side
 */
async function captureOrder(orderId, expectedAmount = null) {
  if (!isConfigured()) {
    return {
      success: false,
      configured: false,
      error: 'PAYPAL_CREDENTIALS_MISSING',
      message: 'PayPal Sandbox credentials must be configured in your .env file to capture orders.'
    };
  }

  const accessToken = await getAccessToken();

  const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errData = await response.text();
    throw new Error(`PayPal Order Capture failed (${response.status}): ${errData}`);
  }

  const captureData = await response.json();
  const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];
  const capturedStatus = captureData.status; // Expected 'COMPLETED'
  const capturedAmount = captureUnit?.amount?.value;
  const captureId = captureUnit?.id;

  // Strict Server-Side Verification:
  const isStatusCompleted = capturedStatus === 'COMPLETED';
  let isAmountVerified = true;
  if (expectedAmount !== null && capturedAmount !== undefined) {
    isAmountVerified = Math.abs(parseFloat(capturedAmount) - parseFloat(expectedAmount)) < 0.01;
  }

  const verifiedServerSide = isStatusCompleted && isAmountVerified;

  // Update Database Record
  const updateStmt = db.prepare(`
    UPDATE payments
    SET paypal_capture_id = ?,
        status = ?,
        payer_id = ?,
        payer_email = ?,
        payer_name = ?,
        verified_server_side = ?,
        raw_response = ?,
        updated_at = datetime('now')
    WHERE paypal_order_id = ?
  `);

  const payer = captureData.payer || {};
  const payerName = payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : null;

  updateStmt.run(
    captureId || null,
    capturedStatus,
    payer.payer_id || null,
    payer.email_address || null,
    payerName,
    verifiedServerSide ? 1 : 0,
    JSON.stringify(captureData),
    orderId
  );

  // If verified pro subscription, activate entitlement in subscriptions table
  if (verifiedServerSide) {
    const payment = db.prepare('SELECT * FROM payments WHERE paypal_order_id = ?').get(orderId);
    if (payment && payment.business_id && payment.payment_type === 'pro_subscription') {
      const subStmt = db.prepare(`
        INSERT INTO subscriptions (id, business_id, payment_id, plan_tier, status, features_unlocked, starts_at, expires_at)
        VALUES (?, ?, ?, 'Pro', 'active', ?, datetime('now'), datetime('now', '+30 days'))
      `);
      subStmt.run(
        crypto.randomUUID(),
        payment.business_id,
        payment.id,
        JSON.stringify(['pro_badge', 'featured_listing', 'unlimited_projects', 'recovery_alerts'])
      );

      // Mark business as published / pro
      db.prepare('UPDATE businesses SET published = 1 WHERE id = ?').run(payment.business_id);
    }
  }

  return {
    success: verifiedServerSide,
    status: capturedStatus,
    orderId,
    captureId,
    amount: capturedAmount,
    currency: captureUnit?.amount?.currency_code,
    payerEmail: payer.email_address,
    verifiedServerSide,
    rawResponse: captureData
  };
}

/**
 * Get all logged payments
 */
function getPaymentHistory(businessId = null) {
  if (businessId) {
    return db.prepare('SELECT * FROM payments WHERE business_id = ? ORDER BY created_at DESC').all(businessId);
  }
  return db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 50').all();
}

module.exports = {
  isConfigured,
  createOrder,
  captureOrder,
  getPaymentHistory
};
