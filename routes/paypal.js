const express = require('express');
const router = express.Router();
const paypalService = require('../services/paypalService');

/**
 * Check if PayPal Sandbox is configured
 */
router.get('/status', (req, res) => {
  const configured = paypalService.isConfigured();
  res.json({
    configured,
    mode: process.env.PAYPAL_MODE || 'sandbox',
    clientIdConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && !process.env.PAYPAL_CLIENT_ID.includes('your_')),
    clientSecretConfigured: Boolean(process.env.PAYPAL_CLIENT_SECRET && !process.env.PAYPAL_CLIENT_SECRET.includes('your_')),
    environment: 'PayPal Sandbox'
  });
});

/**
 * Create a PayPal Sandbox Order
 */
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'USD', businessId, projectId, paymentType = 'pro_subscription', idempotencyKey } = req.body;

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'A valid numeric payment amount greater than zero is required.'
      });
    }

    const result = await paypalService.createOrder({
      amount,
      currency,
      businessId,
      projectId,
      paymentType,
      idempotencyKey
    });

    if (!result.success && result.error === 'PAYPAL_CREDENTIALS_MISSING') {
      return res.status(503).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error('Error in /api/paypal/create-order:', error);
    return res.status(500).json({
      error: 'PAYPAL_ORDER_CREATION_FAILED',
      message: error.message
    });
  }
});

/**
 * Capture PayPal Order & Server-Side Verification
 */
router.post('/capture-order', async (req, res) => {
  try {
    const { orderId, expectedAmount } = req.body;

    if (!orderId) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'PayPal orderId is required for capture.'
      });
    }

    const result = await paypalService.captureOrder(orderId, expectedAmount);

    if (!result.success && result.error === 'PAYPAL_CREDENTIALS_MISSING') {
      return res.status(503).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error('Error in /api/paypal/capture-order:', error);
    return res.status(500).json({
      error: 'PAYPAL_CAPTURE_FAILED',
      message: error.message
    });
  }
});

/**
 * Get payment transactions history from verified DB
 */
router.get('/transactions', (req, res) => {
  try {
    const { businessId } = req.query;
    const history = paypalService.getPaymentHistory(businessId);
    res.json({ transactions: history });
  } catch (error) {
    console.error('Error in /api/paypal/transactions:', error);
    res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
  }
});

module.exports = router;
