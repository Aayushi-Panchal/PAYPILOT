const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

/**
 * GET /api/businesses
 * Customer-facing marketplace: only published businesses.
 * Owner portal can pass ?all=1 to see their own (unpublished) businesses too.
 */
router.get('/', (req, res) => {
  try {
    let query;
    let params = [];

    if (req.query.all === '1') {
      // Owner view: return all businesses (including unpublished)
      query = 'SELECT * FROM businesses ORDER BY created_at DESC';
    } else {
      // Customer marketplace: published only
      query = 'SELECT * FROM businesses WHERE published = 1 ORDER BY created_at DESC';
    }

    const businesses = db.prepare(query).all(...params);
    const formatted = businesses.map(b => ({
      ...b,
      services: (() => {
        try { return JSON.parse(b.services || '[]'); } catch { return []; }
      })(),
      published: Boolean(b.published)
    }));
    res.json({ businesses: formatted });
  } catch (err) {
    console.error('Error fetching businesses:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * GET /api/businesses/:id
 * Single business profile + workspace config (always accessible by ID)
 */
router.get('/:id', (req, res) => {
  try {
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    const config = db.prepare('SELECT * FROM workspace_configs WHERE business_id = ?').get(req.params.id);

    res.json({
      business: {
        ...business,
        services: (() => {
          try { return JSON.parse(business.services || '[]'); } catch { return []; }
        })(),
        published: Boolean(business.published)
      },
      workspaceConfig: config ? {
        ...config,
        modules: (() => { try { return JSON.parse(config.modules || '[]'); } catch { return []; } })(),
        milestoneTemplates: (() => { try { return JSON.parse(config.milestone_templates || '[]'); } catch { return []; } })(),
        workflowRules: (() => { try { return JSON.parse(config.workflow_rules || '{}'); } catch { return {}; } })()
      } : null
    });
  } catch (err) {
    console.error('Error fetching business:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/businesses/:id/publish
 * Toggle published/unlisted status.
 * published=1 → visible in customer marketplace.
 * published=0 → hidden (draft / unlisted).
 */
router.post('/:id/publish', (req, res) => {
  try {
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    // Allow explicit set via body, or toggle current
    let newStatus;
    if (typeof req.body.published === 'boolean') {
      newStatus = req.body.published ? 1 : 0;
    } else {
      newStatus = business.published ? 0 : 1;
    }

    db.prepare("UPDATE businesses SET published = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newStatus, req.params.id);

    res.json({ success: true, published: Boolean(newStatus), businessId: req.params.id });
  } catch (err) {
    console.error('Error toggling publish:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * PATCH /api/businesses/:id/capacity
 * Update business maximum concurrent project capacity
 */
router.patch('/:id/capacity', (req, res) => {
  try {
    const { capacity } = req.body;
    const parsed = parseInt(capacity, 10);
    if (!parsed || isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Valid capacity >= 1 is required' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    db.prepare("UPDATE businesses SET capacity = ?, updated_at = datetime('now') WHERE id = ?")
      .run(parsed, req.params.id);

    res.json({ success: true, businessId: req.params.id, capacity: parsed });
  } catch (err) {
    console.error('Error updating capacity:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/businesses/:id
 * Delete a specific business and all its cascaded records
 * Does not affect any other business
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
    if (!biz) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Delete linked projects, milestones, blockers
      const projects = db.prepare('SELECT id FROM projects WHERE business_id = ?').all(id);
      for (const p of projects) {
        db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(p.id);
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(p.id);
      }
      db.prepare('DELETE FROM projects WHERE business_id = ?').run(id);

      // 2. Delete customer requests
      db.prepare('DELETE FROM customer_requests WHERE business_id = ?').run(id);

      // 3. Delete resources
      db.prepare('DELETE FROM resources WHERE business_id = ?').run(id);

      // 4. Delete recovery plans & operational events
      db.prepare('DELETE FROM recovery_plans WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM operational_events WHERE business_id = ?').run(id);

      // 5. Delete workspace config, onboarding, notifications, subscriptions, payments
      db.prepare('DELETE FROM workspace_configs WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM onboarding_sessions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM notifications WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM subscriptions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM payments WHERE business_id = ?').run(id);

      // 6. Delete the business itself
      db.prepare('DELETE FROM businesses WHERE id = ?').run(id);

      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }

    res.json({
      success: true,
      message: `Business "${biz.name}" deleted successfully.`,
      deletedBusinessId: id
    });
  } catch (err) {
    console.error('Error deleting business:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

module.exports = router;
