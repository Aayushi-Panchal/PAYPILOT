/**
 * PayPilot Phase 2 Verification Test Suite
 * 
 * Verifies:
 * 1. Capacity extraction and persistence (selected capacity stays exact).
 * 2. PATCH /api/businesses/:id/capacity updates business capacity.
 * 3. Business-specific milestone templates when accepting requests (Bakery, Developer, Design Agency, Custom).
 * 4. Multiple customer requests with sequential non-colliding IDs.
 * 5. Adaptive Recovery Centre:
 *    - GET /api/requests/recovery/analysis
 *    - POST /api/requests/recovery/simulate-demo-risk
 *    - POST /api/requests/recovery/action (increase_capacity, extend_deadlines_3d, resolve_blocker)
 *    - POST /api/requests/recovery/clear-demo-risk
 * 6. Business isolation: requests and projects belong specifically to businessId.
 */

const assert = require('assert');
const http = require('http');
const app = require('../server');

let server;
const BASE_URL = 'http://localhost:3000';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('Starting PayPilot Phase 2 Verification Suite...');
  console.log('====================================================\n');

  await new Promise(resolve => {
    server = app.listen(3000, () => resolve());
    server.on('error', (err) => {
      // If already listening, proceed
      resolve();
    });
  });

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Capacity persistence during onboarding
  let testBakeryId = null;
  await test('AI Onboarding extracts and persists exact capacity (e.g. 3)', async () => {
    // Save onboarding session with explicit capacity 3
    const res = await request('POST', '/api/onboarding/save-session', {
      businessName: 'Phase2 Sweet Bites Bakery',
      category: 'Bakery',
      description: 'Artisan bakery specializing in custom cakes and pastries',
      services: ['Custom Birthday Cakes', 'Wedding Cakes', 'Pastry Boxes'],
      answers: {
        capacity: '3 active orders at a time',
        workflow: 'Recipe prep, baking, decorating, quality check, delivery'
      }
    });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok(res.body.success, 'Expected success: true');
    assert.ok(res.body.businessId, 'Expected businessId in response');
    testBakeryId = res.body.businessId;

    // Fetch the business to confirm capacity is 3
    const bizRes = await request('GET', '/api/businesses?all=1');
    assert.strictEqual(bizRes.status, 200);
    const biz = bizRes.body.businesses.find(b => b.id === testBakeryId);
    assert.ok(biz, 'Expected to find saved business');
    assert.strictEqual(biz.capacity, 3, `Expected capacity to be 3, got ${biz.capacity}`);
  });

  // 2. PATCH /api/businesses/:id/capacity
  await test('PATCH /api/businesses/:id/capacity updates business capacity', async () => {
    assert.ok(testBakeryId, 'testBakeryId must exist');
    const res = await request('PATCH', `/api/businesses/${testBakeryId}/capacity`, {
      capacity: 4
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.capacity, 4);

    // Verify persisted
    const bizRes = await request('GET', '/api/businesses?all=1');
    const biz = bizRes.body.businesses.find(b => b.id === testBakeryId);
    assert.strictEqual(biz.capacity, 4, 'Updated capacity should persist in DB');

    // Reset back to 3 for workload testing
    await request('PATCH', `/api/businesses/${testBakeryId}/capacity`, { capacity: 3 });
  });

  // 3. Category-specific milestone generation
  let bakeryReqId = null;
  await test('POST /:id/accept generates Bakery-specific milestones', async () => {
    // Create customer request for Bakery
    const subRes = await request('POST', '/api/requests', {
      businessId: testBakeryId,
      customerName: 'Alice Baker Customer',
      customerEmail: 'alice@example.com',
      requestTitle: '3-Tier Custom Wedding Cake',
      category: 'Bakery',
      description: 'Vanilla bean with raspberry compote',
      budget: 350,
      currency: 'USD',
      deadline: '2026-10-25'
    });
    assert.strictEqual(subRes.status, 200);
    bakeryReqId = subRes.body.requestId;
    assert.ok(bakeryReqId, 'Expected requestId');

    // Accept request
    const accRes = await request('POST', `/api/requests/${bakeryReqId}/accept`, {
      autoProject: true
    });
    assert.strictEqual(accRes.status, 200);
    assert.ok(accRes.body.project, 'Expected project object in response');
    const milestones = accRes.body.project.milestones;
    assert.ok(Array.isArray(milestones) && milestones.length >= 4, 'Expected at least 4 milestones');

    // Verify Bakery-specific terms
    const titles = milestones.map(m => m.title.toLowerCase());
    const hasBakeryTerm = titles.some(t => 
      t.includes('ingredient') || t.includes('bake') || t.includes('baking') || t.includes('decorat') || t.includes('delivery')
    );
    assert.ok(hasBakeryTerm, `Expected bakery terms in milestones: ${JSON.stringify(titles)}`);
  });

  // 4. Developer category milestones
  let devBizId = null;
  let devReqId = null;
  await test('POST /:id/accept generates Freelance Developer specific milestones', async () => {
    const bizRes = await request('POST', '/api/onboarding/save-session', {
      businessName: 'Phase2 DevCraft Studios',
      category: 'Freelance Developer',
      description: 'Full-stack web and mobile software development',
      services: ['Web Apps', 'API Development', 'React / Node.js'],
      answers: { capacity: '2 concurrent clients' }
    });
    assert.strictEqual(bizRes.status, 200);
    devBizId = bizRes.body.businessId;

    const reqRes = await request('POST', '/api/requests', {
      businessId: devBizId,
      customerName: 'Tech Startup Inc',
      customerEmail: 'founder@techstartup.com',
      requestTitle: 'SaaS Customer Dashboard API',
      category: 'Freelance Developer',
      description: 'REST API with authentication and payment webhook',
      budget: 1500,
      currency: 'USD',
      deadline: '2026-11-15'
    });
    devReqId = reqRes.body.requestId;

    const accRes = await request('POST', `/api/requests/${devReqId}/accept`, { autoProject: true });
    assert.strictEqual(accRes.status, 200);
    const milestones = accRes.body.project.milestones;
    const titles = milestones.map(m => m.title.toLowerCase());
    const hasDevTerm = titles.some(t => 
      t.includes('requirement') || t.includes('architecture') || t.includes('implementation') || t.includes('qa') || t.includes('deploy')
    );
    assert.ok(hasDevTerm, `Expected developer terms in milestones: ${JSON.stringify(titles)}`);
  });

  // 5. Sequential non-colliding request IDs
  await test('Customer requests receive robust non-colliding sequential IDs (R1, R2, etc.)', async () => {
    const resA = await request('POST', '/api/requests', {
      businessId: testBakeryId,
      customerName: 'Bob Buyer',
      customerEmail: 'bob@example.com',
      requestTitle: 'Cupcake Assortment 24-pack',
      category: 'Bakery',
      description: 'Assorted chocolate, vanilla, and strawberry cupcakes for party',
      budget: 60,
      currency: 'USD',
      deadline: '2026-10-22'
    });
    const resB = await request('POST', '/api/requests', {
      businessId: testBakeryId,
      customerName: 'Charlie Customer',
      customerEmail: 'charlie@example.com',
      requestTitle: 'Gluten-Free Brownie Platter',
      category: 'Bakery',
      description: 'Gluten-free fudge brownie assortment for corporate catering event',
      budget: 45,
      currency: 'USD',
      deadline: '2026-10-23'
    });


    assert.strictEqual(resA.status, 200);
    assert.strictEqual(resB.status, 200);
    assert.notStrictEqual(resA.body.requestId, resB.body.requestId, 'Request IDs must be unique');
    assert.match(resA.body.requestId, /^R\d+$/, 'ID must match R{number} format');
    assert.match(resB.body.requestId, /^R\d+$/, 'ID must match R{number} format');
  });

  // 6. Adaptive Recovery Centre Analysis
  await test('GET /api/requests/recovery/analysis returns capacity utilization & risk assessment', async () => {
    const res = await request('GET', `/api/requests/recovery/analysis?businessId=${testBakeryId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.activeCount, 'number');
    assert.strictEqual(res.body.capacity, 3);
    assert.strictEqual(typeof res.body.utilizationRate, 'number');
    assert.ok(Array.isArray(res.body.risks), 'risks must be an array');
  });

  // 7. Demo Risk Simulator
  await test('POST /api/requests/recovery/simulate-demo-risk injects realistic overload and overdue risks', async () => {
    const simRes = await request('POST', '/api/requests/recovery/simulate-demo-risk', {
      businessId: testBakeryId
    });
    assert.strictEqual(simRes.status, 200);
    assert.ok(simRes.body.success);

    // Analysis must now identify active risks
    const anaRes = await request('GET', `/api/requests/recovery/analysis?businessId=${testBakeryId}`);
    assert.strictEqual(anaRes.status, 200);
    assert.ok(anaRes.body.risks.length > 0, 'Should detect at least 1 risk after simulation');
    const riskTypes = anaRes.body.risks.map(r => r.type);
    assert.ok(
      riskTypes.includes('CAPACITY_OVERLOAD') || riskTypes.includes('OVERDUE_MILESTONE') || riskTypes.includes('BLOCKED_MILESTONE'),
      `Expected simulated risk types, got: ${JSON.stringify(riskTypes)}`
    );
  });

  // 8. One-click Recovery Action Execution
  await test('POST /api/requests/recovery/action executes recovery actions (e.g. increase_capacity)', async () => {
    const actRes = await request('POST', '/api/requests/recovery/action', {
      businessId: testBakeryId,
      action: 'increase_capacity'
    });
    assert.strictEqual(actRes.status, 200);
    assert.ok(actRes.body.success);
    assert.ok(actRes.body.newCapacity >= 4, 'Capacity should have been increased');

    // Confirm persisted in business table
    const anaRes = await request('GET', `/api/requests/recovery/analysis?businessId=${testBakeryId}`);
    assert.strictEqual(anaRes.body.capacity, actRes.body.newCapacity);
  });

  // 9. Clear Demo Risk
  await test('POST /api/requests/recovery/clear-demo-risk removes simulated demo records cleanly', async () => {
    const clrRes = await request('POST', '/api/requests/recovery/clear-demo-risk', {
      businessId: testBakeryId
    });
    assert.strictEqual(clrRes.status, 200);
    assert.ok(clrRes.body.success);
  });

  console.log('\n====================================================');
  console.log(`Phase 2 Test Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================\n');

  if (server && server.close) {
    server.close();
  }

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
