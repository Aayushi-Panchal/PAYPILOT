const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

/**
 * Execute callback inside a SQLite transaction (node:sqlite compatible)
 */
function runInTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Helper to identify if a business is an automated test fixture
 */
function isTestBusiness(b) {
  if (!b) return false;
  // Seed presentation businesses are protected
  if (['s1', 's2', 's3'].includes(b.id)) return false;
  // Explicit test names or automated test suite artifacts
  if (/^test\b/i.test(b.name) || /\[test/i.test(b.name)) return true;
  // The automated phase1 test suite generates 'Artisan Pastry Co' with this exact description
  if (b.name === 'Artisan Pastry Co' && (b.description || '').includes('Specialty French pastries')) {
    return true;
  }
  return false;
}

/**
 * Helper to identify if a request is test data
 */
function isTestRequest(r) {
  if (!r) return false;
  const title = (r.request_title || '').toLowerCase();
  const desc = (r.description || '').toLowerCase();
  const customer = (r.customer_name || '').toLowerCase();
  return title.includes('test') || desc.includes('automated test') || customer.includes('test');
}

/**
 * Helper to identify if a project is test data
 */
function isTestProject(p) {
  if (!p) return false;
  const title = (p.title || '').toLowerCase();
  return title.includes('test');
}

/**
 * GET /api/cleanup/summary
 * Scan and return identified test/demo records vs genuine business records
 */
router.get('/summary', (req, res) => {
  try {
    const allBusinesses = db.prepare('SELECT id, name, category, description, published, created_at FROM businesses').all();
    const allRequests = db.prepare('SELECT id, business_id, request_title, customer_name, description, status, created_at FROM customer_requests').all();
    const allProjects = db.prepare('SELECT id, business_id, request_id, title, status, progress_percentage, created_at FROM projects').all();

    const testBusinesses = allBusinesses.filter(isTestBusiness).map(b => ({
      id: b.id,
      name: b.name,
      category: b.category,
      createdAt: b.created_at,
      reason: 'Automated test suite workspace artifact'
    }));

    const safeBusinesses = allBusinesses.filter(b => !isTestBusiness(b)).map(b => ({
      id: b.id,
      name: b.name,
      category: b.category,
      isSeedDemo: ['s1', 's2', 's3'].includes(b.id)
    }));

    const testRequests = allRequests.filter(isTestRequest).map(r => ({
      id: r.id,
      businessId: r.business_id,
      requestTitle: r.request_title,
      customerName: r.customer_name,
      status: r.status,
      createdAt: r.created_at,
      reason: 'Test request title or automated test description'
    }));

    const testProjects = allProjects.filter(p => isTestProject(p) || testRequests.some(tr => tr.id === p.request_id)).map(p => ({
      id: p.id,
      businessId: p.business_id,
      title: p.title,
      status: p.status,
      createdAt: p.created_at,
      reason: 'Linked to test order or test project title'
    }));

    const testMilestoneCount = testProjects.length > 0
      ? db.prepare(`SELECT COUNT(*) as count FROM milestones WHERE project_id IN (${testProjects.map(() => '?').join(',')})`).get(...testProjects.map(p => p.id)).count
      : 0;

    res.json({
      success: true,
      summary: {
        testBusinesses,
        testRequests,
        testProjects,
        testMilestoneCount,
        safeBusinesses,
        totalTestRecords: testBusinesses.length + testRequests.length + testProjects.length
      }
    });
  } catch (err) {
    console.error('Error fetching cleanup summary:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/cleanup/business/:id
 * Delete a selected workspace and all its cascaded records
 */
router.delete('/business/:id', (req, res) => {
  const { id } = req.params;
  try {
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
    if (!biz) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business workspace not found' });
    }

    // Protection check for primary seed demo businesses unless explicitly confirmed
    if (['s1', 's2', 's3'].includes(id) && req.query.force !== 'true') {
      return res.status(400).json({
        error: 'PROTECTED_RECORD',
        message: 'This is a protected presentation seed business. Pass ?force=true to delete.'
      });
    }

    runInTransaction(() => {
      // 1. Get all customer requests for this business
      const reqs = db.prepare('SELECT id FROM customer_requests WHERE business_id = ?').all(id);
      for (const r of reqs) {
        const proj = db.prepare('SELECT id FROM projects WHERE request_id = ?').get(r.id);
        if (proj) {
          db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(proj.id);
          db.prepare('DELETE FROM milestones WHERE project_id = ?').run(proj.id);
          db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
        }
      }

      // 2. Direct projects
      const directProjs = db.prepare('SELECT id FROM projects WHERE business_id = ?').all(id);
      for (const p of directProjs) {
        db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(p.id);
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(p.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
      }

      db.prepare('DELETE FROM customer_requests WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM workspace_configs WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM onboarding_sessions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM notifications WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM subscriptions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
    });

    res.json({
      success: true,
      message: `Business "${biz.name}" and associated workspace records deleted successfully.`,
      deletedBusinessId: id
    });
  } catch (err) {
    console.error('Error deleting business:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/cleanup/request/:id
 * Delete a selected customer request and its linked project & milestones
 */
router.delete('/request/:id', (req, res) => {
  const { id } = req.params;
  try {
    const r = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(id);
    if (!r) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Customer request not found' });
    }

    runInTransaction(() => {
      const proj = db.prepare('SELECT id FROM projects WHERE request_id = ?').get(id);
      if (proj) {
        db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
      }
      db.prepare('DELETE FROM customer_requests WHERE id = ?').run(id);
    });

    res.json({
      success: true,
      message: `Request "${r.request_title}" and linked project records deleted successfully.`,
      deletedRequestId: id
    });
  } catch (err) {
    console.error('Error deleting request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/cleanup/project/:id
 * Delete a selected project and its milestones, leaving customer request in 'New' status
 */
router.delete('/project/:id', (req, res) => {
  const { id } = req.params;
  try {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!proj) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Project not found' });
    }

    runInTransaction(() => {
      db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM milestones WHERE project_id = ?').run(id);
      if (proj.request_id) {
        db.prepare("UPDATE customer_requests SET status = 'New' WHERE id = ?").run(proj.request_id);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });

    res.json({
      success: true,
      message: `Project "${proj.title}" and its milestones deleted successfully.`,
      deletedProjectId: id
    });
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/cleanup/purge-test-data
 * Clear all identified test/demo records in one bulk action
 * Requires confirmation text: 'DELETE TEST DATA'
 */
router.post('/purge-test-data', (req, res) => {
  try {
    const { confirmation } = req.body;
    if (confirmation !== 'DELETE TEST DATA') {
      return res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Bulk deletion requires exact confirmation string: "DELETE TEST DATA".'
      });
    }

    const result = runInTransaction(() => {
      // 1. Identify test requests
      const testRequests = db.prepare(`
        SELECT id FROM customer_requests 
        WHERE request_title LIKE '%Test%' 
           OR description LIKE '%Automated test%' 
           OR customer_name LIKE '%Test%'
      `).all();

      for (const r of testRequests) {
        const proj = db.prepare('SELECT id FROM projects WHERE request_id = ?').get(r.id);
        if (proj) {
          db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(proj.id);
          db.prepare('DELETE FROM milestones WHERE project_id = ?').run(proj.id);
          db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
        }
        db.prepare('DELETE FROM customer_requests WHERE id = ?').run(r.id);
      }

      // 2. Orphan test projects
      const testProjects = db.prepare("SELECT id FROM projects WHERE title LIKE '%Test%'").all();
      for (const p of testProjects) {
        db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(p.id);
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(p.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
      }

      // 3. Test businesses (never delete s1, s2, s3, DevlOOPs, Hair Bloom)
      const allBiz = db.prepare('SELECT id, name, description FROM businesses').all();
      const testBiz = allBiz.filter(isTestBusiness);

      for (const b of testBiz) {
        db.prepare('DELETE FROM workspace_configs WHERE business_id = ?').run(b.id);
        db.prepare('DELETE FROM onboarding_sessions WHERE business_id = ?').run(b.id);
        db.prepare('DELETE FROM notifications WHERE business_id = ?').run(b.id);
        db.prepare('DELETE FROM businesses WHERE id = ?').run(b.id);
      }

      return {
        deletedRequests: testRequests.length,
        deletedProjects: testProjects.length,
        deletedBusinesses: testBiz.length
      };
    });

    res.json({
      success: true,
      message: `Successfully purged ${result.deletedRequests} test requests, ${result.deletedProjects} test projects, and ${result.deletedBusinesses} test businesses. Genuine business workspaces were fully preserved.`,
      result
    });
  } catch (err) {
    console.error('Error purging test data:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/cleanup/reset-all
 * Reset the entire database to a clean empty state for a live presentation.
 * Clears all businesses, orders, projects, milestones, resources, and recovery plans.
 * Does NOT touch trained ML model artifacts or dataset files.
 */
router.post('/reset-all', (req, res) => {
  try {
    runInTransaction(() => {
      db.prepare('DELETE FROM blockers_and_history').run();
      db.prepare('DELETE FROM milestones').run();
      db.prepare('DELETE FROM recovery_plans').run();
      db.prepare('DELETE FROM operational_events').run();
      db.prepare('DELETE FROM projects').run();
      db.prepare('DELETE FROM customer_requests').run();
      db.prepare('DELETE FROM resources').run();
      db.prepare('DELETE FROM workspace_configs').run();
      db.prepare('DELETE FROM onboarding_sessions').run();
      db.prepare('DELETE FROM notifications').run();
      db.prepare('DELETE FROM subscriptions').run();
      db.prepare('DELETE FROM payments').run();
      db.prepare('DELETE FROM businesses').run();
    });

    res.json({
      success: true,
      message: 'All application business data reset. Workspace is clean and ready for registration.'
    });
  } catch (err) {
    console.error('Error resetting database:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

module.exports = router;
