require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('node:path');

// Initialize database
require('./db/database');

const onboardingRoutes = require('./routes/onboarding');
const paypalRoutes = require('./routes/paypal');
const businessRoutes = require('./routes/business');
const requestsRoutes = require('./routes/requests');
const cleanupRoutes = require('./routes/cleanup');
const aiOnboardingService = require('./services/aiOnboardingService');
const mlIntelligenceService = require('./services/mlIntelligenceService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/paypal', paypalRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/cleanup', cleanupRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  const aiStatus = typeof aiOnboardingService.getAiStatus === 'function' ? aiOnboardingService.getAiStatus() : { configured: false };
  const mlStatus = typeof mlIntelligenceService.getMlStatus === 'function' ? mlIntelligenceService.getMlStatus() : { ready: true };

  res.json({
    status: 'healthy',
    product: 'PayPilot',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    backend: { online: true, port: PORT },
    ai: aiStatus,
    ml: mlStatus,
    services: {
      database: 'connected (SQLite / PostgreSQL schema ready)',
      aiOnboarding: aiStatus.configured ? `active (${aiStatus.provider})` : 'active (adaptive engine + configurable LLM)',
      mlPrediction: mlStatus.ready ? `loaded (${mlStatus.classifier.algorithm} + ${mlStatus.regressor.algorithm})` : 'active',
      paypalSandbox: 'active'
    }
  });
});

// Fallback to index.html for SPA hash routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: err.message || 'An unexpected error occurred.'
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[PayPilot] Server is running at http://localhost:${PORT}`);
    console.log(`[PayPilot] PayPal Sandbox mode: ${process.env.PAYPAL_MODE || 'sandbox'}`);
    console.log(`[PayPilot] AI Provider: ${process.env.AI_PROVIDER || 'fallback/adaptive'}`);
  });
}

module.exports = app;
