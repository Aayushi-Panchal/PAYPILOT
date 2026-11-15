/**
 * PayPilot Phase 1 Automated Verification Suite
 * Verifies Database, AI Onboarding Agent, PayPal Sandbox Layer & REST APIs
 */

const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '3099';

const app = require('../server');
const { db } = require('../db/database');
const aiOnboardingService = require('../services/aiOnboardingService');
const paypalService = require('../services/paypalService');

let server;
const BASE_URL = 'http://localhost:3099';

async function post(endpoint, data) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const json = await res.json();
  return { status: res.status, ok: res.ok, data: json };
}

async function get(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  const json = await res.json();
  return { status: res.status, ok: res.ok, data: json };
}

async function runTests() {
  console.log('====================================================');
  console.log('Starting PayPilot Phase 1 Verification Suite...');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    return (async () => {
      try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
      } catch (err) {
        console.error(`[FAIL] ${name}`);
        console.error('       ', err.message);
        failed++;
      }
    })();
  }

  // Start temporary test server
  await new Promise(resolve => {
    server = app.listen(3099, resolve);
  });

  try {
    // 1. Database tests
    await test('Database tables created & seeded correctly', async () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map(t => t.name);
      
      const requiredTables = [
        'users', 'businesses', 'onboarding_sessions', 'workspace_configs',
        'customer_requests', 'projects', 'milestones', 'blockers_and_history',
        'payments', 'subscriptions', 'notifications'
      ];

      for (const req of requiredTables) {
        assert(tableNames.includes(req), `Missing expected table: ${req}`);
      }

      const bizCount = db.prepare('SELECT COUNT(*) as count FROM businesses').get();
      assert(bizCount.count >= 3, 'Sample businesses should be seeded in DB');
    });

    // 2. Health check endpoint
    await test('GET /api/health returns healthy status', async () => {
      const res = await get('/api/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'healthy');
      assert.strictEqual(res.data.product, 'PayPilot');
    });

    // 3. AI Onboarding: Category Identification
    await test('POST /api/onboarding/identify detects Bakery category', async () => {
      const res = await post('/api/onboarding/identify', {
        businessName: 'Velvet Frostings',
        description: 'Artisanal custom wedding cakes, birthday cupcakes, and organic sourdough bread.'
      });
      assert.strictEqual(res.status, 200);
      // Accepts either 'Bakery' or 'Bakery & Baked Goods' as both are valid canonical names
      assert(
        res.data.category === 'Bakery' || res.data.category === 'Bakery & Baked Goods',
        `Expected Bakery-related category, got: ${res.data.category}`
      );
      assert(res.data.confidence > 0.7, 'Confidence should be reasonable for clear description');
      assert(res.data.reasoning.length > 5, 'Reasoning should be provided');
    });

    await test('POST /api/onboarding/identify detects Freelance Developer category', async () => {
      const res = await post('/api/onboarding/identify', {
        businessName: 'CodeCraft Solutions',
        description: 'We build modern web applications using React, Node.js, and cloud APIs for small businesses.'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.category, 'Freelance developer');
    });

    await test('POST /api/onboarding/identify detects Design Agency category', async () => {
      const res = await post('/api/onboarding/identify', {
        businessName: 'Lumina Studio',
        description: 'Brand identity, Figma design systems, logo creation, and creative visual guidelines.'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.category, 'Design agency');
    });

    // 4. AI Onboarding: Adaptive Questions Generation
    await test('POST /api/onboarding/questions generates 6 to 7 adaptive MCQs with Other option', async () => {
      const res = await post('/api/onboarding/questions', {
        category: 'Bakery',
        description: 'Custom celebration cakes'
      });
      assert.strictEqual(res.status, 200);
      assert(res.data.questions.length >= 6 && res.data.questions.length <= 7, `Expected 6-7 questions, got ${res.data.questions.length}`);
      
      const firstQ = res.data.questions[0];
      assert(firstQ.options && firstQ.options.length >= 3, 'Question must have multiple choice options');
      assert(firstQ.allowsCustomInput === true, 'Question must allow custom Other input');
    });

    // 5. AI Onboarding: Tailored Workspace Generation
    await test('POST /api/onboarding/generate-workspace produces tailored milestone template', async () => {
      const res = await post('/api/onboarding/generate-workspace', {
        businessName: 'Sweet Crumb Studio',
        category: 'Bakery',
        description: 'Custom celebration cakes',
        answers: {
          q_order_type: 'Custom event & celebration cakes (tier cakes, fondant)',
          q_capacity_limit: '4 to 8 medium custom cakes / boxes'
        }
      });
      assert.strictEqual(res.status, 200);
      assert(Array.isArray(res.data.milestoneTemplate), 'Workspace must have milestoneTemplate');
      assert(res.data.milestoneTemplate.length >= 5, 'Must generate full lifecycle milestones');
      assert(res.data.recommendedModules.includes('requests'), 'Must include core modules');
      assert(res.data.recommendedModules.includes('recovery'), 'Must include recovery module');
    });

    // 6. AI Onboarding: Save Session & DB Persistence
    await test('POST /api/onboarding/save-session saves profile and workspace config to DB', async () => {
      const res = await post('/api/onboarding/save-session', {
        businessName: 'Artisan Pastry Co',
        category: 'Bakery',
        description: 'Specialty French pastries and macaron towers',
        answers: { q_lead_time: '3 to 5 business days' },
        workspaceConfig: {
          milestoneTemplate: [
            { order: 1, title: 'Confirm Flavor' },
            { order: 2, title: 'Bake & Cool' },
            { order: 3, title: 'Handover' }
          ],
          recommendedModules: ['requests', 'projects', 'recovery']
        },
        services: ['Macarons', 'Tartlets'],
        workingHours: 'Tue–Sat, 8:00–16:00',
        capacity: 8,
        teamSize: '2 people'
      });

      assert.strictEqual(res.status, 200);
      assert(res.data.businessId, 'Must return created businessId');

      // Verify row in database
      const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(res.data.businessId);
      assert(row, 'Business must be stored in database');
      assert.strictEqual(row.name, 'Artisan Pastry Co');
      assert.strictEqual(row.category, 'Bakery');

      const configRow = db.prepare('SELECT * FROM workspace_configs WHERE business_id = ?').get(res.data.businessId);
      assert(configRow, 'Workspace config must be stored in database');
    });

    // 7. PayPal Sandbox Endpoints
    await test('GET /api/paypal/status returns sandbox environment and credentials state', async () => {
      const res = await get('/api/paypal/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.mode, 'sandbox');
      assert.strictEqual(res.data.environment, 'PayPal Sandbox');
    });

    await test('POST /api/paypal/create-order returns clear credentials configuration response when unconfigured', async () => {
      // In default sandbox template without real keys, returns 503 PAYPAL_CREDENTIALS_MISSING
      const res = await post('/api/paypal/create-order', {
        amount: 29.00,
        currency: 'USD',
        paymentType: 'pro_subscription'
      });
      
      // If credentials are not set, it should not fake success; it should return 503 with error explanation
      if (!paypalService.isConfigured()) {
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.data.error, 'PAYPAL_CREDENTIALS_MISSING');
      } else {
        assert(res.data.orderId, 'Should create real PayPal order when credentials configured');
      }
    });

    await test('POST /api/paypal/create-order rejects invalid amount', async () => {
      const res = await post('/api/paypal/create-order', {
        amount: -5.00
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error, 'VALIDATION_ERROR');
    });

    // 8. Business Listing Endpoint & Marketplace Visibility
    await test('GET /api/businesses returns only published businesses with parsed services', async () => {
      const res = await get('/api/businesses');
      assert.strictEqual(res.status, 200);
      assert(Array.isArray(res.data.businesses));
      assert(res.data.businesses.length >= 1, 'Must return published businesses');
      // All returned businesses must have published === true
      for (const b of res.data.businesses) {
        assert.strictEqual(b.published, true, `Business ${b.id} in marketplace must be published`);
        assert(Array.isArray(b.services), 'Services must be parsed array');
      }
    });

    await test('GET /api/businesses?all=1 returns all businesses including unpublished', async () => {
      const pubRes = await get('/api/businesses');
      const allRes = await get('/api/businesses?all=1');
      assert.strictEqual(allRes.status, 200);
      assert(allRes.data.businesses.length >= pubRes.data.businesses.length, 'All businesses list must be >= published list');
    });

    await test('POST /api/businesses/:id/publish toggles and sets publication status', async () => {
      const allRes = await get('/api/businesses?all=1');
      const target = allRes.data.businesses[0];
      assert(target, 'Target business must exist');

      // Explicitly unpublish
      const unpubRes = await post(`/api/businesses/${target.id}/publish`, { published: false });
      assert.strictEqual(unpubRes.status, 200);
      assert.strictEqual(unpubRes.data.published, false);

      // Verify it is not in customer marketplace
      const mktRes1 = await get('/api/businesses');
      assert(!mktRes1.data.businesses.some(b => b.id === target.id), 'Unpublished business must NOT appear in marketplace');

      // Explicitly publish
      const pubRes = await post(`/api/businesses/${target.id}/publish`, { published: true });
      assert.strictEqual(pubRes.status, 200);
      assert.strictEqual(pubRes.data.published, true);

      // Verify it is now in customer marketplace
      const mktRes2 = await get('/api/businesses');
      assert(mktRes2.data.businesses.some(b => b.id === target.id), 'Published business MUST appear in marketplace');
    });

    // 9. Customer Request Flow: Submit → Accept → Milestone Toggle
    await test('Full customer request lifecycle: submit, accept, milestone toggle', async () => {
      // Get a real business id from seed data
      const bizRes = await get('/api/businesses');
      const biz = bizRes.data.businesses.find(b => b.id === 's1') || bizRes.data.businesses[0];
      assert(biz, 'Must have at least one business');

      // Submit request
      const submitRes = await post('/api/requests', {
        businessId: biz.id,
        requestTitle: 'Test Phase 1 Order',
        description: 'Automated test request to validate the full customer order lifecycle end-to-end',
        budget: 100,
        deadline: '2026-12-31',
        quantity: 1
      });
      assert.strictEqual(submitRes.status, 200);
      assert(submitRes.data.requestId, 'Must return requestId');

      const rId = submitRes.data.requestId;

      // Accept request (owner action)
      const acceptRes = await post(`/api/requests/${rId}/accept`, {});
      assert.strictEqual(acceptRes.status, 200);
      assert.strictEqual(acceptRes.data.status, 'Accepted');
      assert(acceptRes.data.project.milestones.length >= 4, 'Must generate business-specific milestones');

      // Toggle first milestone
      const m1Id = acceptRes.data.project.milestones[0].id;
      const toggleRes = await post(`/api/requests/milestones/${m1Id}/toggle`, {});
      assert.strictEqual(toggleRes.status, 200);
      assert.strictEqual(toggleRes.data.status, 'Completed');
      assert(toggleRes.data.progressPercentage > 0, 'Progress must increase after milestone completion');
    });

    // 10. AI Onboarding: Next adaptive question generation
    await test('POST /api/onboarding/next-question generates a single contextual adaptive question', async () => {
      const res = await post('/api/onboarding/next-question', {
        businessName: 'Luxe Locks',
        description: 'Organic hair growth oils and botanical scalp serums',
        category: 'Beauty & Personal Care',
        questionIndex: 0,
        history: []
      });
      assert.strictEqual(res.status, 200);
      assert(res.data.question && res.data.question.length > 10, 'Must return a question');
      assert(Array.isArray(res.data.options) && res.data.options.length >= 3, 'Must return options');
      assert(res.data.allowsCustomInput === true, 'Must allow custom Other input');
    });

    // 11. AI Provider Status & Security (No Leaked Secrets)
    await test('GET /api/onboarding/ai-status returns active provider info and never exposes secrets', async () => {
      const res = await get('/api/onboarding/ai-status');
      assert.strictEqual(res.status, 200);
      assert(res.data.ai, 'Must return ai status');
      assert(res.data.ai.provider, 'Must have provider name');
      assert(res.data.ai.model, 'Must have model name');
      // Critical security check: full API key must NEVER be exposed
      const bodyStr = JSON.stringify(res.data);
      if (process.env.OPENROUTER_API_KEY) {
        assert(!bodyStr.includes(process.env.OPENROUTER_API_KEY), 'Must never leak raw OpenRouter API key');
      }
      if (process.env.GEMINI_API_KEY) {
        assert(!bodyStr.includes(process.env.GEMINI_API_KEY), 'Must never leak raw Gemini API key');
      }
    });

    // 12. Manage Data & Test Cleanup API
    await test('GET /api/cleanup/summary detects test records vs genuine safe businesses', async () => {
      const res = await get('/api/cleanup/summary');
      assert.strictEqual(res.status, 200);
      assert(res.data.summary, 'Must return summary');
      assert(Array.isArray(res.data.summary.testRequests), 'Must return test requests list');
      assert(Array.isArray(res.data.summary.safeBusinesses), 'Must return safe businesses list');
      // DevlOOPs and seed businesses must be in safe list, not test businesses list
      const safeNames = res.data.summary.safeBusinesses.map(b => b.name);
      assert(safeNames.includes('Sweet Crumb Bakery') || safeNames.includes('Northwind Dev'), 'Seed demo businesses must be marked safe');
    });

    await test('POST /api/cleanup/purge-test-data rejects invalid confirmation and accepts DELETE TEST DATA', async () => {
      // 1. Should reject with wrong confirmation
      const rejectRes = await post('/api/cleanup/purge-test-data', { confirmation: 'WRONG' });
      assert.strictEqual(rejectRes.status, 400);

      // 2. Should accept with exact confirmation
      const purgeRes = await post('/api/cleanup/purge-test-data', { confirmation: 'DELETE TEST DATA' });
      assert.strictEqual(purgeRes.status, 200);
      assert.strictEqual(purgeRes.data.success, true);
    });

  } finally {
    if (server) server.close();
    // Teardown: Clean up test fixtures created during the test run so the live UI database is clean
    try {
      db.prepare("DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE title LIKE '%Test Phase 1 Order%')").run();
      db.prepare("DELETE FROM projects WHERE title LIKE '%Test Phase 1 Order%'").run();
      db.prepare("DELETE FROM customer_requests WHERE request_title LIKE '%Test Phase 1 Order%'").run();
      db.prepare("DELETE FROM workspace_configs WHERE business_id IN (SELECT id FROM businesses WHERE name = 'Artisan Pastry Co' AND description LIKE '%French pastries%')").run();
      db.prepare("DELETE FROM onboarding_sessions WHERE business_id IN (SELECT id FROM businesses WHERE name = 'Artisan Pastry Co' AND description LIKE '%French pastries%')").run();
      db.prepare("DELETE FROM businesses WHERE name = 'Artisan Pastry Co' AND description LIKE '%French pastries%'").run();
    } catch (e) {
      // ignore teardown errors
    }
  }

  console.log('\n====================================================');
  console.log(`Phase 1 Test Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
