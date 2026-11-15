const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db/database');
const mlIntelligenceService = require('../services/mlIntelligenceService');
const catalogService = require('../services/catalogService');

/**
 * GET /api/requests/catalog
 * Single source of truth for realistic $90-$95 product catalog
 */
router.get('/catalog', (req, res) => {
  try {
    const { category } = req.query;
    if (category) {
      return res.json({
        category,
        products: catalogService.getProductsForCategory(category)
      });
    }
    return res.json({
      catalog: catalogService.getCatalog()
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/requests
 * List requests. Optional query: businessId
 */
router.get('/', (req, res) => {
  try {
    const { businessId } = req.query;
    let query = 'SELECT r.*, b.name as business_name, b.category as business_category FROM customer_requests r LEFT JOIN businesses b ON r.business_id = b.id';
    let params = [];

    if (businessId) {
      query += ' WHERE r.business_id = ?';
      params.push(businessId);
    }
    query += ' ORDER BY r.created_at DESC';

    const requests = db.prepare(query).all(...params);

    // Attach linked project and milestones if any
    const enriched = requests.map(r => {
      const project = db.prepare('SELECT * FROM projects WHERE request_id = ?').get(r.id);
      let milestones = [];
      if (project) {
        milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(project.id);
      }
      return {
        id: r.id,
        businessId: r.business_id,
        businessName: r.business_name || 'Business',
        businessCategory: r.business_category || 'General',
        requestTitle: r.request_title,
        description: r.description,
        budget: r.budget,
        currency: r.currency || 'USD',
        deadline: r.deadline,
        quantity: r.quantity || 1,
        referenceImageUrl: r.reference_image_url || '',
        status: r.status,
        createdAt: r.created_at,
        project: project ? {
          id: project.id,
          title: project.title,
          status: project.status,
          progressPercentage: project.progress_percentage,
          deadline: project.deadline,
          milestones: milestones.map(m => ({
            id: m.id,
            sequenceOrder: m.sequence_order,
            title: m.title,
            description: m.description,
            status: m.status,
            done: m.status === 'Completed'
          }))
        } : null
      };
    });

    res.json({ requests: enriched });
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * GET /api/requests/recovery/analysis
 * Adaptive Recovery Centre risk assessment for a business (Phase 3 ML + Resource Intelligence)
 */
router.get('/recovery/analysis', async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId query parameter is required' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    const config = db.prepare('SELECT * FROM workspace_configs WHERE business_id = ?').get(businessId);
    const capacity = business.capacity || (config ? config.capacity_threshold : null) || 5;

    const activeProjects = db.prepare(`
      SELECT p.*, r.request_title, r.customer_name, r.deadline as req_deadline
      FROM projects p
      JOIN customer_requests r ON p.request_id = r.id
      WHERE p.business_id = ? AND p.status != 'Completed' AND (p.progress_percentage IS NULL OR p.progress_percentage < 100)
      ORDER BY p.deadline ASC
    `).all(businessId);

    const activeCount = activeProjects.length;
    const isOverCapacity = activeCount > capacity;
    const utilizationRate = Math.round((activeCount / capacity) * 100);

    const risks = [];
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // 1. Resource Intelligence: Check physical materials, equipment, supplier lead times
    const resourceIntel = mlIntelligenceService.evaluateBusinessResources(businessId);
    if (resourceIntel.shortages.length > 0) {
      resourceIntel.shortages.forEach(sh => {
        risks.push({
          id: `risk_shortage_${sh.resourceId}`,
          type: 'RESOURCE_SHORTAGE',
          resourceId: sh.resourceId,
          severity: sh.leadTimeDays >= 3 ? 'Critical' : 'High',
          title: `Resource Shortage: Missing ${sh.deficit} ${sh.unit} of ${sh.name}`,
          description: `Current available inventory is ${sh.available} ${sh.unit}, but active commitments require ${sh.required} ${sh.unit}. Reorder lead time is ~${sh.leadTimeDays} business days.`,
          impact: `Production may stall by up to ${sh.leadTimeDays} days unless replacement stock is expedited or buffer stock is reallocated.`,
          affectedCount: 1,
          suggestedActions: [
            {
              action: 'procure_expedited_resource',
              resourceId: sh.resourceId,
              label: `Restock Missing ${sh.deficit} ${sh.unit} (Expedited)`,
              detail: `Place rush restock order with supplier to clear shortage in ${Math.max(1, Math.round(sh.leadTimeDays / 2))} days`
            },
            {
              action: 'reallocate_internal_stock',
              resourceId: sh.resourceId,
              label: 'Reallocate Workshop Buffer Stock',
              detail: `Draw ${sh.deficit} ${sh.unit} from emergency workshop reserve to clear immediate bottleneck`
            }
          ]
        });
      });
    }

    // 2. Capacity Overload Risk
    if (isOverCapacity) {
      risks.push({
        id: 'risk_capacity_overload',
        type: 'CAPACITY_OVERLOAD',
        severity: activeCount >= capacity + 2 ? 'Critical' : 'High',
        title: `Workload Overload (${activeCount}/${capacity} Projects)`,
        description: `Active projects (${activeCount}) exceed your configured maximum threshold (${capacity}). Working above 100% capacity risks delivery delays, quality issues, and burnout.`,
        impact: 'High risk of delivery delays and quality degradation across all active work.',
        affectedCount: activeCount,
        suggestedActions: [
          {
            action: 'increase_capacity',
            label: `Raise Capacity Limit to ${activeCount}`,
            detail: `Update workspace threshold to ${activeCount} concurrent projects`
          },
          {
            action: 'extend_deadlines_3d',
            label: 'Apply +3 Days Buffer to All Active Projects',
            detail: 'Decompress workload by proposing a 3-day extension to current deadlines'
          }
        ]
      });
    }

    // 3. Overdue Deadline & Blocked Dependency Risks
    activeProjects.forEach(proj => {
      const pDeadline = proj.deadline || proj.req_deadline;
      const isOverdue = pDeadline && pDeadline < todayStr && proj.progress_percentage < 100;

      if (isOverdue) {
        risks.push({
          id: `risk_due_${proj.id}`,
          type: 'OVERDUE_DEADLINE',
          projectId: proj.id,
          projectTitle: proj.title || proj.request_title,
          severity: 'Critical',
          title: `Overdue Project: "${proj.title || proj.request_title}"`,
          description: `Target deadline was ${pDeadline}, but progress is currently at ${proj.progress_percentage}%.`,
          impact: 'Client expectation mismatch and potential dispute risk.',
          suggestedActions: [
            {
              action: 'extend_project_deadline_5d',
              projectId: proj.id,
              label: 'Propose 5-Day Delivery Extension',
              detail: 'Safely adjust project deadline by +5 business days'
            }
          ]
        });
      }

      const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(proj.id);
      const blocked = milestones.find(m => m.status === 'Blocked');
      if (blocked) {
        risks.push({
          id: `risk_block_${blocked.id}`,
          type: 'BLOCKED_DEPENDENCY',
          projectId: proj.id,
          milestoneId: blocked.id,
          projectTitle: proj.title || proj.request_title,
          milestoneTitle: blocked.title,
          severity: 'Medium',
          title: `Blocked Milestone: "${blocked.title}"`,
          description: blocked.description || 'Milestone is blocked awaiting client input or external dependency.',
          impact: 'Downstream milestones cannot proceed until this blocker is cleared.',
          suggestedActions: [
            {
              action: 'clear_blocker',
              milestoneId: blocked.id,
              label: 'Mark Dependency Resolved',
              detail: 'Restore milestone status to Pending and unblock workflow'
            }
          ]
        });
      }
    });

    // 4. ML Model Predictions (Model A: Delay Classifier, Model B: Duration Regressor)
    const mlPredictions = await Promise.all(
      activeProjects.map(proj => {
        const pMilestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(proj.id);
        return mlIntelligenceService.predictProject(business, proj, pMilestones, activeCount, resourceIntel.shortages);
      })
    );

    // 5. Generate Adaptive Flowchart Recovery Plans
    const recoveryPlans = mlIntelligenceService.buildRecoveryPlans(business, activeProjects, resourceIntel, mlPredictions);

    res.json({
      businessId,
      businessName: business.name,
      capacity,
      activeCount,
      isOverCapacity,
      utilizationRate,
      riskCount: risks.length,
      risks,
      activeProjects: activeProjects.map(p => {
        const pred = mlPredictions.find(pr => pr.projectId === p.id);
        return {
          id: p.id,
          title: p.title || p.request_title,
          deadline: p.deadline || p.req_deadline,
          progress: p.progress_percentage,
          status: p.status,
          mlDelayProbability: pred ? pred.delayProbability : 0,
          mlDelayPercentage: pred ? pred.delayPercentage : 0,
          mlRiskLevel: pred ? pred.riskLevel : 'Low',
          mlEstimatedRemainingDays: pred ? pred.estimatedRemainingDays : 5,
          mlExpectedCompletionDate: pred ? pred.expectedCompletionDate : p.deadline,
          mlExpectedDelayDays: pred ? pred.expectedDelayDays : 0,
          mlContributingFactors: pred ? pred.contributingFactors : [],
          mlModelUsed: pred ? pred.modelUsed : 'Default'
        };
      }),
      resourceIntelligence: resourceIntel,
      mlPredictions,
      recoveryPlans
    });
  } catch (err) {
    console.error('Error in recovery analysis:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/recovery/action
 * Apply owner-approved recovery action with audit trail & reassessment
 */
router.post('/recovery/action', async (req, res) => {
  try {
    const { businessId, action, projectId, milestoneId, resourceId, planId, selectedOptionId } = req.body;
    if (!businessId || !action) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId and action are required' });
    }

    // Execute through mlIntelligenceService for complete audit trail & event logging
    const execResult = await mlIntelligenceService.executeApprovedRecoveryAction(businessId, action, req.body);

    if (action === 'increase_capacity') {
      const activeCount = db.prepare("SELECT COUNT(*) as count FROM projects WHERE business_id = ? AND status != 'Completed'").get(businessId).count;
      const newCap = Math.max(activeCount, 4);
      return res.json({ success: true, message: `Capacity limit raised to ${newCap} active projects.`, newCapacity: newCap, auditEventId: execResult.eventId });
    }

    if (action === 'extend_deadlines_3d') {
      return res.json({ success: true, message: execResult.summary, auditEventId: execResult.eventId });
    }

    if (action === 'extend_project_deadline_5d' || action === 'extend_project_deadline') {
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      return res.json({ success: true, message: execResult.summary, newDeadline: p ? p.deadline : null, auditEventId: execResult.eventId });
    }

    if (action === 'clear_blocker') {
      return res.json({ success: true, message: 'Dependency resolved. Milestone status set to Pending.', auditEventId: execResult.eventId });
    }

    if (action === 'procure_expedited_resource' || action === 'reallocate_internal_stock') {
      return res.json({ success: true, message: execResult.summary, auditEventId: execResult.eventId });
    }

    if (action === 'mark_milestone_blocked') {
      if (!milestoneId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'milestoneId required' });
      db.prepare("UPDATE milestones SET status = 'Blocked', description = 'Blocked: Awaiting client assets & approval', updated_at = datetime('now') WHERE id = ?").run(milestoneId);
      return res.json({ success: true, message: 'Milestone marked as Blocked.' });
    }

    return res.json({ success: true, message: execResult.summary || `Recovery action "${action}" approved and executed.`, auditEventId: execResult.eventId });
  } catch (err) {
    console.error('Error in recovery action:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/recovery/batch-action
 * Execute multiple approved recovery actions in a single batch with consolidated ML reassessment
 */
router.post('/recovery/batch-action', async (req, res) => {
  try {
    const { businessId, actions } = req.body;
    if (!businessId || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId and non-empty actions array are required' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    const results = [];
    for (const act of actions) {
      try {
        const r = await mlIntelligenceService.executeApprovedRecoveryAction(businessId, act.action, act);
        results.push({ action: act.action, success: true, summary: r.summary, auditEventId: r.eventId });
      } catch (actErr) {
        results.push({ action: act.action, success: false, error: actErr.message });
      }
    }

    // Single consolidated reassessment after all batch actions execute
    const resourceIntel = mlIntelligenceService.evaluateBusinessResources(businessId);
    const activeProjects = db.prepare(`
      SELECT p.*, r.request_title, r.customer_name, r.deadline as req_deadline
      FROM projects p
      JOIN customer_requests r ON p.request_id = r.id
      WHERE p.business_id = ? AND p.status != 'Completed' AND (p.progress_percentage IS NULL OR p.progress_percentage < 100)
      ORDER BY p.deadline ASC
    `).all(businessId);

    const mlPredictions = await Promise.all(
      activeProjects.map(proj => {
        const pMilestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(proj.id);
        return mlIntelligenceService.predictProject(business, proj, pMilestones, activeProjects.length, resourceIntel.shortages);
      })
    );

    const recoveryPlans = mlIntelligenceService.buildRecoveryPlans(business, activeProjects, resourceIntel, mlPredictions);

    return res.json({
      success: true,
      executedCount: results.filter(r => r.success).length,
      totalCount: actions.length,
      results,
      remainingRiskCount: recoveryPlans.length,
      recoveryPlans,
      activeProjectsCount: activeProjects.length
    });
  } catch (err) {
    console.error('Error in batch recovery action:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/recovery/reject-plan
 * Business owner rejects a recommended recovery plan
 */
router.post('/recovery/reject-plan', (req, res) => {
  try {
    const { businessId, planId, reason } = req.body;
    if (!businessId || !planId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId and planId are required' });
    }

    const eventId = `evt_${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(`
      INSERT INTO operational_events (id, business_id, event_type, event_data)
      VALUES (?, ?, 'recovery_plan_rejected', ?)
    `).run(
      eventId,
      businessId,
      JSON.stringify({
        planId,
        reason: reason || 'Owner chose to proceed without suggested modification',
        rejectedAt: new Date().toISOString()
      })
    );

    res.json({
      success: true,
      message: 'Recovery plan rejected and logged to operational audit trail.',
      planId,
      auditEventId: eventId
    });
  } catch (err) {
    console.error('Error rejecting recovery plan:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

function seedResourcesForBusiness(businessId) {
  const existing = db.prepare('SELECT COUNT(*) as count FROM resources WHERE business_id = ?').get(businessId);
  if (existing && existing.count > 0) return;

  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const cat = (biz?.category || '').toLowerCase();

  const insert = db.prepare(`
    INSERT INTO resources (id, business_id, name, type, available_quantity, allocated_quantity, required_quantity, unit, reorder_threshold, supplier_lead_time_days, status, cost_per_unit, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (cat.includes('baker') || cat.includes('food')) {
    insert.run(`r_${businessId}_flour`, businessId, 'Organic Cake Flour', 'material', 25, 10, 15, 'kg', 20, 2, 'available', 2.50, 'Valley Mills');
    insert.run(`r_${businessId}_sugar`, businessId, 'Granulated Sugar', 'material', 30, 8, 12, 'kg', 15, 1, 'available', 1.80, 'Standard supplier');
    insert.run(`r_${businessId}_butter`, businessId, 'Unsalted Butter', 'material', 18, 5, 8, 'kg', 10, 2, 'available', 6.00, 'Dairy direct');
    insert.run(`r_${businessId}_eggs`, businessId, 'Farm Fresh Eggs', 'material', 12, 4, 6, 'trays', 8, 1, 'available', 8.50, 'Local farm');
    insert.run(`r_${businessId}_cream`, businessId, 'Heavy Whipping Cream', 'material', 8, 3, 5, 'litres', 6, 2, 'available', 4.20, 'Daily delivery');
    insert.run(`r_${businessId}_choc`, businessId, 'Belgian Dark Chocolate', 'material', 10, 3, 4, 'kg', 5, 3, 'available', 14.00, 'Specialty import');
    insert.run(`r_${businessId}_ing`, businessId, 'Baking Ingredients & Vanilla', 'material', 6, 2, 3, 'kits', 4, 2, 'available', 25.00, 'Flavorings and leavening');
    insert.run(`r_${businessId}_boxes`, businessId, 'Cake & Pastry Boxes', 'material', 40, 15, 20, 'boxes', 15, 2, 'available', 1.50, 'Protective food packaging');
    insert.run(`r_${businessId}_pack`, businessId, 'Packaging Bags & Ribbons', 'material', 60, 20, 25, 'packs', 30, 1, 'available', 0.80, 'Finishing wrap');
    insert.run(`r_${businessId}_oven`, businessId, 'Deck Ovens', 'equipment', 2, 1, 2, 'ovens', 1, 0, 'available', 0, 'Max 4 baking decks');
    insert.run(`r_${businessId}_mix`, businessId, 'Commercial Mixers', 'equipment', 2, 1, 1, 'machines', 1, 0, 'available', 0, 'Spiral dough mixers');
    insert.run(`r_${businessId}_staff`, businessId, 'Pastry Chef & Baker Hours', 'staff', 40, 25, 30, 'hours', 20, 0, 'available', 30.00, 'Production team');
  } else if (cat.includes('dev') || cat.includes('software')) {
    insert.run(`r_${businessId}_lap`, businessId, 'Developer Laptops', 'equipment', 5, 3, 4, 'units', 3, 3, 'available', 1200.00, 'M-series workstations');
    insert.run(`r_${businessId}_mon`, businessId, '4K External Monitors', 'equipment', 6, 4, 4, 'screens', 3, 2, 'available', 250.00, 'Dual screen setups');
    insert.run(`r_${businessId}_kb`, businessId, 'Ergonomic Keyboards', 'equipment', 5, 3, 3, 'units', 2, 2, 'available', 80.00, 'Hardware peripherals');
    insert.run(`r_${businessId}_cloud`, businessId, 'Cloud Servers & Staging', 'service', 4, 2, 3, 'instances', 2, 0, 'available', 45.00, 'AWS & GCP clusters');
    insert.run(`r_${businessId}_lic`, businessId, 'Software Licences (IDE/Tools)', 'service', 8, 4, 5, 'seats', 3, 0, 'available', 35.00, 'JetBrains, GitHub Copilot');
    insert.run(`r_${businessId}_tools`, businessId, 'Development & CI/CD Tools', 'service', 5, 2, 3, 'licenses', 2, 0, 'available', 20.00, 'Docker, Datadog');
    insert.run(`r_${businessId}_net`, businessId, 'Dedicated Fiber Internet', 'service', 2, 1, 1, 'lines', 1, 0, 'available', 90.00, 'High-bandwidth fiber');
    insert.run(`r_${businessId}_dev`, businessId, 'Developer Staff Hours', 'staff', 50, 32, 40, 'hours', 30, 0, 'available', 75.00, 'Full-stack engineering hours');
  } else if (cat.includes('design') || cat.includes('creative')) {
    insert.run(`r_${businessId}_lap`, businessId, 'Designer Workstation Laptops', 'equipment', 4, 2, 3, 'units', 2, 3, 'available', 1500.00, 'MacBook Pro workstations');
    insert.run(`r_${businessId}_dtab`, businessId, 'Wacom Drawing Tablets', 'equipment', 3, 1, 2, 'tablets', 2, 2, 'available', 450.00, 'Pen display tablets');
    insert.run(`r_${businessId}_gtab`, businessId, 'Graphic Tablets', 'equipment', 2, 1, 1, 'tablets', 1, 2, 'available', 300.00, 'Secondary tablet units');
    insert.run(`r_${businessId}_cam`, businessId, 'Studio Camera & Lighting', 'equipment', 1, 1, 1, 'cameras', 1, 4, 'available', 900.00, 'Product photography rig');
    insert.run(`r_${businessId}_soft`, businessId, 'Design Software Licences', 'service', 6, 3, 4, 'seats', 2, 0, 'available', 55.00, 'Adobe Creative Cloud, Figma');
    insert.run(`r_${businessId}_font`, businessId, 'Commercial Font Packages', 'service', 15, 6, 8, 'packages', 5, 0, 'available', 40.00, 'Type Network & Typekit');
    insert.run(`r_${businessId}_stock`, businessId, 'Stock Images & Asset Credits', 'service', 25, 10, 15, 'credits', 10, 0, 'available', 20.00, 'Shutterstock & Envato');
    insert.run(`r_${businessId}_stor`, businessId, 'High-Speed Cloud Storage', 'service', 5, 2, 3, 'TB', 2, 0, 'available', 15.00, 'Cloud drive archive');
    insert.run(`r_${businessId}_sup`, businessId, 'Printing & Packaging Supplies', 'material', 10, 4, 6, 'kits', 5, 3, 'available', 30.00, 'Proofing paper and mounts');
    insert.run(`r_${businessId}_staff`, businessId, 'Senior Designer Hours', 'staff', 45, 28, 35, 'hours', 25, 0, 'available', 65.00, 'UI/UX and brand design team');
  } else {
    // Printing & Custom Merchandise
    insert.run(`r_${businessId}_shirts`, businessId, 'Blank T-shirts (Cotton)', 'material', 50, 20, 35, 'shirts', 25, 3, 'available', 4.50, 'Apparel Blank Co.');
    insert.run(`r_${businessId}_mugs`, businessId, 'Ceramic Blank Mugs 11oz', 'material', 30, 15, 35, 'mugs', 20, 4, 'shortage', 1.85, 'Sublimation blanks (low stock)');
    insert.run(`r_${businessId}_card`, businessId, 'Business Card Paper 350gsm', 'material', 25, 8, 12, 'packs', 10, 2, 'available', 12.00, 'Heavy matte card stock');
    insert.run(`r_${businessId}_broch`, businessId, 'Brochure Paper Gloss 150gsm', 'material', 15, 4, 8, 'reams', 5, 2, 'available', 18.50, 'A4 glossy brochures');
    insert.run(`r_${businessId}_vinyl`, businessId, 'Vinyl Sticker Sheets', 'material', 20, 6, 10, 'rolls', 8, 3, 'available', 35.00, 'Waterproof printable vinyl');
    insert.run(`r_${businessId}_ban`, businessId, 'Heavy Banner Material', 'material', 12, 3, 5, 'rolls', 6, 4, 'available', 48.00, 'Reinforced outdoor vinyl');
    insert.run(`r_${businessId}_ink`, businessId, 'Digital Printing Ink', 'material', 8, 3, 5, 'cartridges', 4, 2, 'available', 65.00, 'High-density pigment ink');
    insert.run(`r_${businessId}_subink`, businessId, 'Sublimation Ink Set', 'material', 5, 2, 3, 'sets', 3, 3, 'available', 85.00, 'CYMK Sublimation ink bottles');
    insert.run(`r_${businessId}_pack`, businessId, 'Packaging & Shipping Boxes', 'material', 80, 30, 45, 'boxes', 50, 1, 'available', 0.75, 'Cardboard parcel boxes');
    insert.run(`r_${businessId}_mach`, businessId, 'Wide-Format Printing Machines', 'equipment', 2, 1, 1, 'machines', 1, 0, 'available', 0, '64-inch eco-solvent printer');
    insert.run(`r_${businessId}_press`, businessId, 'Heat Press Machines', 'equipment', 2, 1, 2, 'machines', 1, 0, 'available', 0, 'Pneumatic dual heat press');
    insert.run(`r_${businessId}_staff`, businessId, 'Print Technician Staff Hours', 'staff', 40, 24, 30, 'hours', 15, 0, 'available', 25.00, 'Machine operation & QC');
  }
}

/**
 * GET /api/requests/resources
 * List resources for a specific business workspace
 */
router.get('/resources', (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId query param required' });
    }

    let resources = db.prepare('SELECT * FROM resources WHERE business_id = ? ORDER BY type, name').all(businessId);
    if (resources.length === 0) {
      seedResourcesForBusiness(businessId);
      resources = db.prepare('SELECT * FROM resources WHERE business_id = ? ORDER BY type, name').all(businessId);
    }
    const intel = mlIntelligenceService.evaluateBusinessResources(businessId);

    res.json({
      businessId,
      totalCount: resources.length,
      resources,
      shortages: intel.shortages,
      warnings: intel.warnings
    });
  } catch (err) {
    console.error('Error fetching resources:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/resources/:id/reorder
 * Place a supplier reorder for a missing resource with cost and estimated delivery
 */
router.post('/resources/:id/reorder', (req, res) => {
  try {
    const resourceId = req.params.id;
    const { quantity } = req.body;
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    if (!resource) return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid quantity' });

    const totalCost = (qty * (resource.cost_per_unit || 10)).toFixed(2);
    const orderId = `po_${crypto.randomUUID().slice(0, 8)}`;
    const leadDays = resource.supplier_lead_time_days || 3;
    const deliveryDate = new Date(Date.now() + leadDays * 86400000).toISOString().split('T')[0];

    const eventId = `evt_${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(`
      INSERT INTO operational_events (id, business_id, event_type, event_data)
      VALUES (?, ?, 'resource_reorder', ?)
    `).run(eventId, resource.business_id, JSON.stringify({
      orderId,
      resourceId,
      resourceName: resource.name,
      quantity: qty,
      unit: resource.unit,
      totalCost,
      status: 'Ordered — Awaiting Delivery',
      expectedDelivery: deliveryDate,
      orderedAt: new Date().toISOString()
    }));

    res.json({
      success: true,
      orderId,
      resourceName: resource.name,
      quantity: qty,
      unit: resource.unit,
      totalCost,
      expectedDelivery: deliveryDate,
      status: 'Ordered — Awaiting Delivery'
    });
  } catch (err) {
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/resources/:id/confirm-delivery
 * Confirm receipt of reordered items and increment available inventory
 */
router.post('/resources/:id/confirm-delivery', (req, res) => {
  try {
    const resourceId = req.params.id;
    const { quantity } = req.body;
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    if (!resource) return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    const qty = parseFloat(quantity) || 0;
    const newAvail = resource.available_quantity + qty;
    let newStatus = 'available';
    if (newAvail < resource.required_quantity) newStatus = 'shortage';
    else if (newAvail <= resource.reorder_threshold) newStatus = 'low';

    db.prepare("UPDATE resources SET available_quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newAvail, newStatus, resourceId);

    res.json({
      success: true,
      message: `Stock updated. ${qty} ${resource.unit} of ${resource.name} added.`,
      availableQuantity: newAvail
    });
  } catch (err) {
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/resources
 * Add a new operational resource (material, staff, equipment, supplier, service)
 */
router.post('/resources', (req, res) => {
  try {
    const { businessId, name, type, availableQuantity, requiredQuantity, unit, reorderThreshold, supplierLeadTimeDays, costPerUnit, notes } = req.body;

    if (!businessId || !name || !type) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId, name, and type are required' });
    }

    const id = `res_${crypto.randomUUID().slice(0, 8)}`;
    const avail = parseFloat(availableQuantity) || 0;
    const reqQty = parseFloat(requiredQuantity) || 0;
    const thresh = parseFloat(reorderThreshold) || 0;
    const lead = parseInt(supplierLeadTimeDays, 10) || 0;
    const cost = parseFloat(costPerUnit) || 0.0;

    let status = 'available';
    if (reqQty > avail) status = 'shortage';
    else if (avail <= thresh) status = 'low';

    db.prepare(`
      INSERT INTO resources (id, business_id, name, type, available_quantity, required_quantity, unit, reorder_threshold, supplier_lead_time_days, status, cost_per_unit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, businessId, name.trim(), type, avail, reqQty, unit || 'units', thresh, lead, status, cost, notes || '');

    res.json({
      success: true,
      message: `Resource "${name}" created.`,
      resource: { id, businessId, name, type, availableQuantity: avail, requiredQuantity: reqQty, unit, status }
    });
  } catch (err) {
    console.error('Error creating resource:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * PATCH /api/requests/resources/:id
 * Update an existing resource
 */
router.patch('/resources/:id', (req, res) => {
  try {
    const resourceId = req.params.id;
    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    if (!row) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    const { availableQuantity, requiredQuantity, unit, reorderThreshold, supplierLeadTimeDays, notes, costPerUnit } = req.body;

    const avail = availableQuantity !== undefined ? parseFloat(availableQuantity) : row.available_quantity;
    const reqQty = requiredQuantity !== undefined ? parseFloat(requiredQuantity) : row.required_quantity;
    const thresh = reorderThreshold !== undefined ? parseFloat(reorderThreshold) : row.reorder_threshold;
    const lead = supplierLeadTimeDays !== undefined ? parseInt(supplierLeadTimeDays, 10) : row.supplier_lead_time_days;
    const cost = costPerUnit !== undefined ? parseFloat(costPerUnit) : row.cost_per_unit;
    const u = unit !== undefined ? unit : row.unit;
    const n = notes !== undefined ? notes : row.notes;

    let status = 'available';
    if (reqQty > avail) status = 'shortage';
    else if (avail <= thresh) status = 'low';

    db.prepare(`
      UPDATE resources
      SET available_quantity = ?, required_quantity = ?, unit = ?, reorder_threshold = ?, supplier_lead_time_days = ?, cost_per_unit = ?, notes = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(avail, reqQty, u, thresh, lead, cost, n, status, resourceId);

    res.json({
      success: true,
      message: `Resource updated.`,
      resource: { id: resourceId, availableQuantity: avail, requiredQuantity: reqQty, status }
    });
  } catch (err) {
    console.error('Error updating resource:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/requests/resources/:id
 */
router.delete('/resources/:id', (req, res) => {
  try {
    const resourceId = req.params.id;
    db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
    res.json({ success: true, message: 'Resource deleted.' });
  } catch (err) {
    console.error('Error deleting resource:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * GET /api/requests/ml-info
 * Returns trained ML model architectures, validation metrics, and dataset provenance
 */
router.get('/ml-info', (req, res) => {
  try {
    const metricsPath = path.join(__dirname, '..', 'ml', 'models', 'model_metrics.json');
    const registryPath = path.join(__dirname, '..', 'ml', 'data', 'dataset_registry.json');

    let metrics = {};
    let registry = {};

    if (fs.existsSync(metricsPath)) {
      metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    }
    if (fs.existsSync(registryPath)) {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }

    res.json({
      success: true,
      version: 'PayPilot-ML-Phase3-3.0',
      activeModels: {
        classifier: {
          algorithm: metrics?.model_a_classification?.selected_best || 'RandomForestClassifier',
          task: 'Project Delay & Risk Probability',
          validationF1: metrics?.model_a_classification?.test_performance?.f1_score || 0.8677,
          validationRocAuc: metrics?.model_a_classification?.test_performance?.roc_auc || 0.9070,
          topFeatures: metrics?.model_a_classification?.top_features || []
        },
        regressor: {
          algorithm: metrics?.model_b_regression?.selected_best || 'HistGradientBoostingRegressor / LightGBM',
          task: 'Remaining Completion Days & Uncertainty Range',
          validationMaeDays: metrics?.model_b_regression?.test_performance?.mae || 1.32,
          validationR2: metrics?.model_b_regression?.test_performance?.r2 || 0.965,
          residualStd: metrics?.model_b_regression?.residual_std || 2.96
        }
      },
      datasets: registry,
      metrics
    });
  } catch (err) {
    console.error('Error fetching ML info:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/recovery/simulate-demo-risk
 * Creates realistic demo workload risks (overload, overdue deadline, blocked dependency)
 */
router.post('/recovery/simulate-demo-risk', (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId required' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Business not found' });
    }

    const config = db.prepare('SELECT * FROM workspace_configs WHERE business_id = ?').get(businessId);
    const capacity = business.capacity || (config ? config.capacity_threshold : null) || 3;

    // Check how many active projects exist
    const activeCount = db.prepare("SELECT COUNT(*) as count FROM projects WHERE business_id = ? AND status != 'Completed'").get(businessId).count;
    const needed = Math.max(0, (capacity + 1) - activeCount);

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const inThreeDays = new Date(now);
    inThreeDays.setDate(now.getDate() + 3);
    const inThreeDaysStr = inThreeDays.toISOString().split('T')[0];

    // Seed up to needed projects
    const demoItems = [
      { title: '[DEMO RISK] Brand Identity Redesign', deadline: yesterdayStr, desc: 'Urgent redesign package', client: 'Acme Corp' },
      { title: '[DEMO RISK] E-Commerce Integration', deadline: inThreeDaysStr, desc: 'Payment and checkout setup', client: 'Starlight Retail' },
      { title: '[DEMO RISK] Mobile App UI Refresh', deadline: inThreeDaysStr, desc: 'Figma wireframes and high-fidelity prototype', client: 'Orbit Dynamics' },
      { title: '[DEMO RISK] Custom Packaging Suite', deadline: inThreeDaysStr, desc: 'Eco-friendly packaging design', client: 'Verde Organics' }
    ];

    const createdProjects = [];

    for (let i = 0; i < Math.max(needed, 2); i++) {
      const item = demoItems[i % demoItems.length];
      const existingRows = db.prepare('SELECT id FROM customer_requests').all();
      let maxId = 0;
      existingRows.forEach(r => {
        const m = r.id.match(/^R(\d+)$/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxId) maxId = n;
        }
      });
      const reqId = `R${maxId + 1}`;

      db.prepare(`
        INSERT INTO customer_requests (id, business_id, customer_name, request_title, description, budget, deadline, quantity, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'Accepted')
      `).run(reqId, businessId, item.client, item.title, item.desc, 450, item.deadline);

      const projId = `proj_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`
        INSERT INTO projects (id, request_id, business_id, title, status, progress_percentage, deadline)
        VALUES (?, ?, ?, ?, 'In Progress', ?, ?)
      `).run(projId, reqId, businessId, item.title, i === 0 ? 33 : 15, item.deadline);

      // Add milestones
      const m1 = `m_${crypto.randomUUID().slice(0, 8)}`;
      const m2 = `m_${crypto.randomUUID().slice(0, 8)}`;
      const m3 = `m_${crypto.randomUUID().slice(0, 8)}`;

      db.prepare(`INSERT INTO milestones (id, project_id, sequence_order, title, description, status) VALUES (?, ?, 1, 'Initial Scope & Requirements', 'Confirmed brief', 'Completed')`).run(m1, projId);
      
      // If i === 1, make milestone 2 blocked
      const isBlocked = (i === 1);
      db.prepare(`INSERT INTO milestones (id, project_id, sequence_order, title, description, status) VALUES (?, ?, 2, 'Design Drafts & Feedback', ?, ?)`).run(
        m2,
        projId,
        isBlocked ? 'Blocked: Waiting for client feedback and API credentials' : 'Active draft work',
        isBlocked ? 'Blocked' : 'Pending'
      );

      db.prepare(`INSERT INTO milestones (id, project_id, sequence_order, title, description, status) VALUES (?, ?, 3, 'Final Handover & Delivery', 'Export deliverables', 'Pending')`).run(m3, projId);

      createdProjects.push(projId);
    }

    res.json({
      success: true,
      message: `Simulated realistic demo risk scenarios: Capacity overload (> ${capacity}), overdue project, and blocked milestone.`,
      createdProjectsCount: createdProjects.length
    });
  } catch (err) {
    console.error('Error simulating demo risk:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/recovery/clear-demo-risk
 * Remove simulated demo risk requests and projects to leave workspace clean
 */
router.post('/recovery/clear-demo-risk', (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId required' });
    }

    const demoReqs = db.prepare("SELECT id FROM customer_requests WHERE business_id = ? AND request_title LIKE '[DEMO RISK]%'").all(businessId);
    demoReqs.forEach(r => {
      const proj = db.prepare('SELECT id FROM projects WHERE request_id = ?').get(r.id);
      if (proj) {
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
      }
      db.prepare('DELETE FROM customer_requests WHERE id = ?').run(r.id);
    });

    res.json({ success: true, message: `Cleared ${demoReqs.length} simulated demo risk records.` });
  } catch (err) {
    console.error('Error clearing demo risk:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * GET /api/requests/:id
 * Get single request with project and milestones
 */
router.get('/:id', (req, res) => {
  try {
    const r = db.prepare(`
      SELECT r.*, b.name as business_name, b.category as business_category 
      FROM customer_requests r 
      LEFT JOIN businesses b ON r.business_id = b.id 
      WHERE r.id = ?
    `).get(req.params.id);

    if (!r) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE request_id = ?').get(r.id);
    let milestones = [];
    if (project) {
      milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(project.id);
    }

    res.json({
      request: {
        id: r.id,
        businessId: r.business_id,
        businessName: r.business_name || 'Business',
        businessCategory: r.business_category || 'General',
        requestTitle: r.request_title,
        description: r.description,
        budget: r.budget,
        currency: r.currency || 'USD',
        deadline: r.deadline,
        quantity: r.quantity || 1,
        referenceImageUrl: r.reference_image_url || '',
        status: r.status,
        createdAt: r.created_at,
        project: project ? {
          id: project.id,
          title: project.title,
          status: project.status,
          progressPercentage: project.progress_percentage,
          deadline: project.deadline,
          milestones: milestones.map(m => ({
            id: m.id,
            sequenceOrder: m.sequence_order,
            title: m.title,
            description: m.description,
            status: m.status,
            done: m.status === 'Completed'
          }))
        } : null
      }
    });
  } catch (err) {
    console.error('Error fetching request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests
 * Create new customer request
 */
router.post('/', (req, res) => {
  try {
    const { businessId, requestTitle, description, budget, deadline, quantity, customerName, referenceImageUrl } = req.body;

    if (!businessId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessId is required' });
    }
    if (!requestTitle || requestTitle.trim().length < 3) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Request title must be at least 3 characters' });
    }
    if (!description || description.trim().length < 3) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Description must be at least 3 characters' });
    }
    if (!budget || isNaN(budget) || Number(budget) <= 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Valid budget greater than 0 is required' });
    }
    if (!deadline) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Deadline is required' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Target business does not exist' });
    }

    // Robust ID generation: find highest numeric R{id}
    const existingRows = db.prepare('SELECT id FROM customer_requests').all();
    let maxId = 0;
    existingRows.forEach(r => {
      const m = r.id.match(/^R(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxId) maxId = n;
      }
    });
    const requestId = `R${maxId + 1}`;

    const insert = db.prepare(`
      INSERT INTO customer_requests (
        id, business_id, customer_name, request_title, description, budget, deadline, quantity, reference_image_url, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')
    `);

    insert.run(
      requestId,
      businessId,
      customerName || 'Customer',
      requestTitle.trim(),
      description.trim(),
      parseFloat(budget),
      deadline,
      parseInt(quantity, 10) || 1,
      referenceImageUrl || ''
    );

    res.json({
      success: true,
      requestId,
      request: {
        id: requestId,
        businessId,
        businessName: business.name,
        requestTitle: requestTitle.trim(),
        description: description.trim(),
        budget: parseFloat(budget),
        deadline,
        quantity: parseInt(quantity, 10) || 1,
        status: 'New',
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/:id/accept
 * Accept request and create linked project with business-specific milestones
 */
router.post('/:id/accept', (req, res) => {
  try {
    const requestId = req.params.id;
    const request = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(requestId);
    if (!request) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
    }

    // Update request status
    db.prepare("UPDATE customer_requests SET status = 'Accepted', updated_at = datetime('now') WHERE id = ?").run(requestId);

    // Check if project already exists
    let project = db.prepare('SELECT * FROM projects WHERE request_id = ?').get(requestId);

    if (!project) {
      const projectId = `proj_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`
        INSERT INTO projects (id, request_id, business_id, title, status, progress_percentage, deadline)
        VALUES (?, ?, ?, ?, 'In Progress', 0, ?)
      `).run(projectId, requestId, request.business_id, request.request_title, request.deadline);

      // Business category matching for workflow templates
      const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(request.business_id);
      const cat = (biz?.category || '').toLowerCase();
      const bizName = (biz?.name || '').toLowerCase();
      const combined = `${cat} ${bizName}`;

      let milestoneTemplate = [];

      // 1. Bakery / Custom Food Products
      if (combined.includes('baker') || combined.includes('cake') || combined.includes('pastry') || combined.includes('food') || combined.includes('cookie')) {
        milestoneTemplate = [
          { order: 1, title: 'Source Ingredients', description: 'Procure flour, sugar, cream and ingredients' },
          { order: 2, title: 'Bake Base Sponge', description: 'Bake cakes and pastries to recipe specifications' },
          { order: 3, title: 'Decorate & Frost', description: 'Apply fondant, frosting and custom decoration' },
          { order: 4, title: 'Quality Inspection', description: 'Structural audit and taste inspection' },
          { order: 5, title: 'Pack for Delivery', description: 'Food-safe packaging ready for delivery' }
        ];
      }
      // 2. Freelance Developer / Software Agency
      else if (combined.includes('dev') || combined.includes('software') || combined.includes('code') || combined.includes('tech') || combined.includes('web') || combined.includes('app')) {
        milestoneTemplate = [
          { order: 1, title: 'Confirm Requirements', description: 'Finalize user stories and project requirement scope' },
          { order: 2, title: 'Design Architecture', description: 'Setup database schema and architecture design' },
          { order: 3, title: 'Core Implementation', description: 'Build key features and core logic implementation' },
          { order: 4, title: 'QA & Bug Testing', description: 'Run automated QA checks and unit tests' },
          { order: 5, title: 'Deploy to Cloud', description: 'Final release and production deploy handover' }
        ];
      }
      // 3. Design Agency / Creative Studio
      else if (combined.includes('design') || combined.includes('creative') || combined.includes('brand') || combined.includes('graphic') || combined.includes('ui') || combined.includes('ux')) {
        milestoneTemplate = [
          { order: 1, title: 'Review Design Brief', description: 'Analyze brief, brand guidelines and references' },
          { order: 2, title: 'Create Moodboard Drafts', description: 'Develop early concept sketches and directions' },
          { order: 3, title: 'Design Core Assets', description: 'Build core layouts, logos and component systems' },
          { order: 4, title: 'Client Review Round', description: 'Present draft variations for client feedback' },
          { order: 5, title: 'Export Final Files', description: 'Export source files and vector assets' }
        ];
      }
      // 4. Printing & Custom Merchandise
      else if (combined.includes('print') || combined.includes('merch') || combined.includes('mug') || combined.includes('apparel') || combined.includes('vinyl')) {
        milestoneTemplate = [
          { order: 1, title: 'Artwork & Pre-flight', description: 'Check vector resolution and artwork pre-flight proof' },
          { order: 2, title: 'Check Stock Inventory', description: 'Verify blank stock inventory and inks' },
          { order: 3, title: 'Proof & Calibration', description: 'Print sample proof and heat press calibration' },
          { order: 4, title: 'Batch Production Run', description: 'Run complete batch print and heat transfer' },
          { order: 5, title: 'Quality & Curing Check', description: 'Inspect print clarity, adhesion and curing' },
          { order: 6, title: 'Pack and Deliver', description: 'Package items safely for client delivery' }
        ];
      }
      // 5. Beauty / Skincare / Artisan
      else if (combined.includes('beauty') || combined.includes('hair') || combined.includes('skin') || combined.includes('cosmetic')) {
        milestoneTemplate = [
          { order: 1, title: 'Formula & Batch Planning', description: 'Confirm ingredients, formulation ratios, and vessel specs' },
          { order: 2, title: 'Ingredient & Packaging Sourcing', description: 'Procure raw extracts, containers, and label materials' },
          { order: 3, title: 'Batch Production & Blending', description: 'Precision compounding and active ingredient blending' },
          { order: 4, title: 'Quality & Viscosity Check', description: 'Stability, scent, and texture quality inspection' },
          { order: 5, title: 'Bottling & Label Packaging', description: 'Aseptic packaging and tamper-evident sealing' },
          { order: 6, title: 'Dispatch & Order Fulfillment', description: 'Protective packaging and courier dispatch' }
        ];
      }
      // 5. Custom Business Workflow Template
      else {
        // Check if workspace_configs has custom milestones
        const config = db.prepare('SELECT * FROM workspace_configs WHERE business_id = ?').get(request.business_id);
        if (config && config.milestone_templates) {
          try {
            const parsed = JSON.parse(config.milestone_templates);
            if (Array.isArray(parsed) && parsed.length > 0) {
              milestoneTemplate = parsed;
            }
          } catch (e) {}
        }
        if (!milestoneTemplate || !milestoneTemplate.length) {
          milestoneTemplate = [
            { order: 1, title: 'Scope & Specification Review', description: 'Confirm custom requirements, constraints, and delivery goals' },
            { order: 2, title: 'Procure Materials & Resources', description: 'Acquire necessary tools, assets, and raw materials' },
            { order: 3, title: 'Core Production & Execution', description: 'Execute primary production according to client specifications' },
            { order: 4, title: 'Quality Assurance & Standards Check', description: 'Audit against craftsmanship, performance, and durability standards' },
            { order: 5, title: 'Client Review & Refinement', description: 'Share progress preview and apply requested adjustments' },
            { order: 6, title: 'Final Handover & Delivery', description: 'Package final deliverables and provide handover documentation' }
          ];
        }
      }

      // Insert milestones
      const insertMilestone = db.prepare(`
        INSERT INTO milestones (id, project_id, sequence_order, title, description, status)
        VALUES (?, ?, ?, ?, ?, 'Pending')
      `);

      milestoneTemplate.forEach((m, idx) => {
        const mid = `m_${crypto.randomUUID().slice(0, 8)}`;
        const title = typeof m === 'string' ? m : (m.title || `Phase ${idx + 1}`);
        const desc = typeof m === 'string' ? '' : (m.description || '');
        insertMilestone.run(mid, projectId, idx + 1, title, desc);
      });

      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(project.id);

    const mappedMilestones = milestones.map(m => ({
      id: m.id,
      sequenceOrder: m.sequence_order,
      title: m.title,
      description: m.description,
      status: m.status,
      done: m.status === 'Completed'
    }));

    res.json({
      success: true,
      status: 'Accepted',
      milestones: mappedMilestones,
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        progressPercentage: project.progress_percentage,
        deadline: project.deadline,
        milestones: mappedMilestones
      }
    });
  } catch (err) {
    console.error('Error accepting request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/:id/reject
 * Reject request
 */
router.post('/:id/reject', (req, res) => {
  try {
    const requestId = req.params.id;
    const request = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(requestId);
    if (!request) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
    }

    db.prepare("UPDATE customer_requests SET status = 'Rejected', updated_at = datetime('now') WHERE id = ?").run(requestId);

    res.json({ success: true, status: 'Rejected' });
  } catch (err) {
    console.error('Error rejecting request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * POST /api/requests/milestones/:id/toggle
 * Toggle milestone status and update project progress
 */
router.post('/milestones/:id/toggle', (req, res) => {
  try {
    const milestoneId = req.params.id;
    const milestone = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId);
    if (!milestone) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Milestone not found' });
    }

    const nextStatus = milestone.status === 'Completed' ? 'Pending' : 'Completed';
    db.prepare(`
      UPDATE milestones 
      SET status = ?, 
          actual_completion_date = CASE WHEN ? = 'Completed' THEN datetime('now') ELSE NULL END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, nextStatus, milestoneId);

    // Recalculate project progress
    const all = db.prepare('SELECT * FROM milestones WHERE project_id = ?').all(milestone.project_id);
    const completed = all.filter(m => m.status === 'Completed').length;
    const progress = Math.round((completed / all.length) * 100);

    db.prepare(`
      UPDATE projects 
      SET progress_percentage = ?, 
          status = CASE WHEN ? = 100 THEN 'Completed' ELSE 'In Progress' END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(progress, progress, milestone.project_id);

    res.json({
      success: true,
      milestoneId,
      status: nextStatus,
      progressPercentage: progress
    });
  } catch (err) {
    console.error('Error toggling milestone:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/requests/:id
 * Delete an unwanted customer order/request and its associated project & milestones
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const request = db.prepare('SELECT * FROM customer_requests WHERE id = ?').get(id);
    if (!request) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const proj = db.prepare('SELECT id FROM projects WHERE request_id = ?').get(id);
      if (proj) {
        db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM milestones WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM recovery_plans WHERE project_id = ?').run(proj.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
      }
      db.prepare('DELETE FROM customer_requests WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json({ success: true, message: `Request "${request.request_title}" deleted.`, deletedRequestId: id });
  } catch (err) {
    console.error('Error deleting request:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/requests/projects/:id
 * Delete an individual project and its milestones
 */
router.delete('/projects/:id', (req, res) => {
  try {
    const { id } = req.params;
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!proj) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Project not found' });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM blockers_and_history WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM milestones WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM recovery_plans WHERE project_id = ?').run(id);
      if (proj.request_id) {
        db.prepare("UPDATE customer_requests SET status = 'New' WHERE id = ?").run(proj.request_id);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json({ success: true, message: `Project "${proj.title}" deleted.`, deletedProjectId: id });
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: err.message });
  }
});

module.exports = router;
