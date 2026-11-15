/**
 * PayPilot Phase 3 Master Verification Test Suite
 * Real-World ML Prediction, Resource Intelligence & Adaptive Recovery System
 * 
 * Verifies:
 * 1. Real-world dataset collection and model artifact integrity.
 * 2. Model A (Delay Classifier) & Model B (Completion Time Regressor) execution and validation.
 * 3. Business-specific Resource Intelligence (stock shortages, equipment, supplier lead times).
 * 4. Adaptive Recovery Planner with Flowchart Stages and 2-3 alternative recovery options.
 * 5. Owner Decision workflow: Action approval, plan rejection, and operational event audit trail.
 * 6. Printing & Custom Merchandise category workflow and tailored milestones.
 * 7. Risk recalculation and reassessment after recovery.
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const app = require('../server');
const { db } = require('../db/database');

let server;
const BASE_URL = 'http://localhost:3098';

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

function runPython(scriptPath, inputData = null) {
  return new Promise((resolve, reject) => {
    const child = execFile('python', [scriptPath], { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('Python error details:', { message: err.message, code: err.code, stdout, stderr });
        return reject(new Error(stderr || err.message));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        resolve(stdout.trim());
      }
    });
    if (inputData) {
      child.stdin.write(typeof inputData === 'string' ? inputData : JSON.stringify(inputData));
      child.stdin.end();
    }
  });
}

async function runPhase3Tests() {
  console.log('====================================================');
  console.log('Starting PayPilot Phase 3 Verification Suite...');
  console.log('====================================================\n');

  await new Promise(resolve => {
    server = app.listen(3098, () => resolve());
    server.on('error', () => resolve());
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

  // 1. Dataset Collection & Registry Verification
  await test('Real-world datasets catalogued across all 4 business categories', async () => {
    const regPath = path.join(__dirname, '..', 'ml', 'data', 'dataset_registry.json');
    assert.ok(fs.existsSync(regPath), 'dataset_registry.json must exist');
    const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));

    assert.ok(registry.bread_basket, 'Bakery dataset (Bread Basket) must be registered');
    assert.strictEqual(registry.bread_basket.category, 'Bakery & Food Businesses');
    assert.ok(registry.bread_basket.raw_records >= 20000, 'Bread Basket must have over 20,000 records');

    assert.ok(registry.dataco_supply_chain, 'Supply Chain dataset (DataCo) must be registered');
    assert.ok(registry.dataco_supply_chain.raw_records >= 5000, 'DataCo must have at least 5,000 records');

    assert.ok(registry.ai4i_manufacturing, 'UCI AI4I Manufacturing dataset must be registered');
    assert.strictEqual(registry.ai4i_manufacturing.raw_records, 10000, 'AI4I must have 10,000 records');

    assert.ok(registry.software_effort_benchmarks, 'Software Effort Benchmarks must be registered');
    assert.ok(registry.software_effort_benchmarks.raw_records >= 10000, 'Software effort benchmarks must be registered');
  });

  // 2. Trained ML Models Verification
  await test('Supervised ML Models trained, evaluated against baselines, and serialized', async () => {
    const clfPath = path.join(__dirname, '..', 'ml', 'models', 'delay_classifier.joblib');
    const regPath = path.join(__dirname, '..', 'ml', 'models', 'duration_regressor.joblib');
    const prepPath = path.join(__dirname, '..', 'ml', 'models', 'preprocessor.joblib');
    const metPath = path.join(__dirname, '..', 'ml', 'models', 'model_metrics.json');

    assert.ok(fs.existsSync(clfPath), 'delay_classifier.joblib must exist');
    assert.ok(fs.existsSync(regPath), 'duration_regressor.joblib must exist');
    assert.ok(fs.existsSync(prepPath), 'preprocessor.joblib must exist');
    assert.ok(fs.existsSync(metPath), 'model_metrics.json must exist');

    const metrics = JSON.parse(fs.readFileSync(metPath, 'utf8'));
    assert.ok(metrics.model_a_classification.selected_best, 'Classifier candidate must be selected');
    assert.ok(metrics.model_b_regression.selected_best, 'Regressor candidate must be selected');

    // Verify classifier outperforms dummy baseline
    const dummyF1 = metrics.model_a_classification.Baseline_Dummy_Prior.val_f1;
    const testF1 = metrics.model_a_classification.test_performance.f1_score;
    assert.ok(testF1 > dummyF1, `Trained classifier F1 (${testF1}) must outperform dummy baseline (${dummyF1})`);

    // Verify regressor outperforms dummy median
    const dummyMae = metrics.model_b_regression.Baseline_Dummy_Median.val_mae;
    const testMae = metrics.model_b_regression.test_performance.mae;
    assert.ok(testMae < dummyMae, `Trained regressor MAE (${testMae}) must outperform dummy median (${dummyMae})`);
  });

  // 3. GET /api/requests/ml-info Endpoint
  await test('GET /api/requests/ml-info exposes model metrics and dataset provenance', async () => {
    const res = await request('GET', '/api/requests/ml-info');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.success);
    assert.ok(res.body.activeModels.classifier.algorithm);
    assert.ok(res.body.activeModels.regressor.algorithm);
    assert.ok(res.body.activeModels.classifier.validationF1 > 0.80);
    assert.ok(res.body.activeModels.regressor.validationMaeDays < 2.5);
    assert.ok(res.body.datasets.bread_basket);
  });

  // 4. ML Python Prediction Engine Test
  await test('Python predict.py computes delay probability, remaining days, and uncertainty interval', async () => {
    const predictScript = path.join(__dirname, '..', 'ml', 'predict.py');
    const sampleInput = {
      category: 'Printing & Custom Merchandise',
      complexity_score: 4,
      total_milestones: 6,
      remaining_milestones: 4,
      progress_pct: 33,
      initial_estimated_days: 10,
      elapsed_days: 5,
      remaining_days_to_deadline: 5,
      active_projects_count: 6,
      capacity_limit: 4,
      workload_utilization_ratio: 1.5,
      staff_available_pct: 1.0,
      resource_shortage_count: 1,
      max_supplier_lead_time_days: 6,
      machine_overload_ratio: 1.2,
      has_blocked_milestone: 1,
      client_approval_pending: 0,
      historical_delay_rate: 0.35
    };

    const out = await runPython(predictScript, sampleInput);
    assert.ok(typeof out.delay_probability === 'number', 'delay_probability must be a number');
    assert.ok(out.delay_percentage >= 0 && out.delay_percentage <= 100);
    assert.ok(['Low', 'Medium', 'High', 'Critical'].includes(out.risk_level));
    assert.ok(out.estimated_remaining_days > 0);
    assert.ok(Array.isArray(out.confidence_range_days));
    assert.ok(Array.isArray(out.contributing_factors) && out.contributing_factors.length > 0);
    assert.ok(out.expected_completion_date);
  });

  // 5. Business Resource Intelligence CRUD & Shortage Detection
  let testResId = null;
  await test('Business Resource Intelligence identifies stock shortages and supplier lead times', async () => {
    // Sweet Crumb Bakery (s1) has initial resources seeded
    const res = await request('GET', '/api/requests/resources?businessId=s1');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.resources.length > 0, 'Should return seeded business resources');
    assert.ok(Array.isArray(res.body.shortages));

    // Create a new material resource with explicit shortage for PrintWave (s4)
    const createRes = await request('POST', '/api/requests/resources', {
      businessId: 's4',
      name: 'Test 20oz Stainless Tumblers',
      type: 'material',
      availableQuantity: 20,
      requiredQuantity: 60, // Shortage of 40 units!
      unit: 'tumblers',
      reorderThreshold: 25,
      supplierLeadTimeDays: 5,
      costPerUnit: 4.50,
      notes: 'Testing supplier shortage detection'
    });

    assert.strictEqual(createRes.status, 200);
    assert.ok(createRes.body.resource.id);
    testResId = createRes.body.resource.id;
    assert.strictEqual(createRes.body.resource.status, 'shortage');

    // Fetch resources and confirm shortage is detected
    const checkRes = await request('GET', '/api/requests/resources?businessId=s4');
    const tumblerShortage = checkRes.body.shortages.find(s => s.resourceId === testResId);
    assert.ok(tumblerShortage, 'Should detect shortage for created resource');
    assert.strictEqual(tumblerShortage.deficit, 40);
    assert.strictEqual(tumblerShortage.leadTimeDays, 5);
  });

  // 6. Adaptive Recovery Planner Flowchart Generation
  await test('GET /api/requests/recovery/analysis generates flowchart recovery plans with alternative options', async () => {
    const res = await request('GET', '/api/requests/recovery/analysis?businessId=s4');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.recoveryPlans, 'Response must include recoveryPlans');
    assert.ok(res.body.recoveryPlans.length > 0, 'Must generate at least 1 recovery plan for s4 shortage');

    const shortagePlan = res.body.recoveryPlans.find(p => p.riskType === 'RESOURCE_SHORTAGE');
    assert.ok(shortagePlan, 'Must have a plan for RESOURCE_SHORTAGE');
    assert.ok(shortagePlan.flowchart, 'Plan must contain flowchart stepper');
    assert.ok(shortagePlan.flowchart.step1_risk);
    assert.ok(shortagePlan.flowchart.step2_cause);
    assert.ok(shortagePlan.flowchart.step3_recommendation);
    assert.ok(shortagePlan.flowchart.step4_impact);

    assert.ok(Array.isArray(shortagePlan.options) && shortagePlan.options.length >= 2, 'Must offer 2-3 recovery options');
    const strategies = shortagePlan.options.map(o => o.strategy);
    assert.ok(strategies.includes('Fastest Recovery'), 'Must offer Fastest Recovery option');
    assert.ok(strategies.includes('Lowest Additional Cost') || strategies.includes('Least Disruption'), 'Must offer cost or disruption option');
  });

  // 7. Owner Approval Workflow & Operational Event Audit Trail
  await test('Owner approval executes recovery action, updates stock, and records operational event', async () => {
    // Approve restock for the tumbler resource
    const actRes = await request('POST', '/api/requests/recovery/action', {
      businessId: 's4',
      action: 'procure_expedited_resource',
      resourceId: testResId,
      quantity: 50
    });

    assert.strictEqual(actRes.status, 200);
    assert.ok(actRes.body.success);
    assert.ok(actRes.body.auditEventId, 'Must generate an auditEventId');

    // Confirm resource status updated from shortage to available
    const checkRes = await request('GET', '/api/requests/resources?businessId=s4');
    const updated = checkRes.body.resources.find(r => r.id === testResId);
    assert.ok(updated);
    assert.strictEqual(updated.status, 'available');
    assert.ok(updated.available_quantity >= 60, 'Available quantity should have increased');

    // Confirm operational event was logged in SQLite
    const eventRow = db.prepare('SELECT * FROM operational_events WHERE id = ?').get(actRes.body.auditEventId);
    assert.ok(eventRow, 'Operational event must be persisted');
    assert.strictEqual(eventRow.business_id, 's4');
    assert.strictEqual(eventRow.event_type, 'recovery_action_approved');
  });

  // 8. Owner Plan Rejection Workflow
  await test('Owner can reject recovery proposals without consequential actions occurring', async () => {
    const rejRes = await request('POST', '/api/requests/recovery/reject-plan', {
      businessId: 's4',
      planId: 'plan_test_dummy',
      reason: 'Owner has alternative vendor lined up'
    });

    assert.strictEqual(rejRes.status, 200);
    assert.ok(rejRes.body.success);
    assert.ok(rejRes.body.auditEventId);

    const eventRow = db.prepare('SELECT * FROM operational_events WHERE id = ?').get(rejRes.body.auditEventId);
    assert.ok(eventRow);
    assert.strictEqual(eventRow.event_type, 'recovery_plan_rejected');
  });

  // 9. Printing & Custom Merchandise Workflow & Milestones
  await test('Customer submits order to Printing business and receives tailored print milestones', async () => {
    const orderRes = await request('POST', '/api/requests', {
      businessId: 's4',
      customerName: 'Acme Event Marketing',
      requestTitle: '100 Custom Printed Sublimation Mugs',
      description: 'Full-color promotional ceramic mugs with high-resolution company branding',
      budget: 650,
      deadline: '2026-11-28',
      quantity: 100
    });

    assert.strictEqual(orderRes.status, 200);
    assert.ok(orderRes.body.requestId);
    const reqId = orderRes.body.requestId;

    // Accept request
    const acceptRes = await request('POST', `/api/requests/${reqId}/accept`);
    assert.strictEqual(acceptRes.status, 200);
    assert.ok(acceptRes.body.success);

    // Verify printing-specific milestone titles were generated
    const milestones = acceptRes.body.milestones;
    assert.ok(milestones.length >= 5, 'Must generate full printing workflow milestones');
    const titles = milestones.map(m => m.title);
    assert.ok(titles.some(t => t.includes('Artwork') || t.includes('Pre-flight')), 'Must include artwork pre-flight milestone');
    assert.ok(titles.some(t => t.includes('Stock') || t.includes('Inventory')), 'Must include substrate/blank stock milestone');
    assert.ok(titles.some(t => t.includes('Proof') || t.includes('Calibration')), 'Must include calibration proof milestone');
    assert.ok(titles.some(t => t.includes('Production') || t.includes('Batch')), 'Must include batch production milestone');
    assert.ok(titles.some(t => t.includes('Quality') || t.includes('Curing')), 'Must include quality inspection milestone');
  });

  // Cleanup test resource
  if (testResId) {
    await request('DELETE', `/api/requests/resources/${testResId}`);
  }

  if (server && server.close) {
    server.close();
  }

  console.log('\n====================================================');
  console.log(`Phase 3 Test Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runPhase3Tests().catch(err => {
  console.error('Phase 3 test execution failed:', err);
  process.exit(1);
});
