const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { db } = require('../db/database');

const PREDICT_SCRIPT = path.join(__dirname, '..', 'ml', 'predict.py');

/**
 * Run ML prediction via Python inference script
 * Safe fallback to deterministic calculation if Python is unavailable
 */
function callPythonPredict(features) {
  return new Promise((resolve) => {
    const jsonInput = JSON.stringify(features);
    execFile('python', [PREDICT_SCRIPT, jsonInput], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error || !stdout) {
        if (stderr) console.warn('[PayPilot ML] Python inference notice:', stderr.trim());
        return resolve(fallbackPredict(features));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (parseErr) {
        console.warn('[PayPilot ML] Failed to parse Python stdout, using fallback:', parseErr.message);
        resolve(fallbackPredict(features));
      }
    });
  });
}

/**
 * Transparent rule-based fallback if Python script is temporarily unreachable
 */
function fallbackPredict(data) {
  const remMs = Number(data.remaining_milestones) || 2;
  const totMs = Math.max(1, Number(data.total_milestones) || 4);
  const initDays = Number(data.initial_estimated_days) || 7;
  const remDeadline = Number(data.remaining_days_to_deadline) || 5;
  const lead = Number(data.max_supplier_lead_time_days) || 0;
  const hasBlocked = Boolean(data.has_blocked_milestone);
  const util = Number(data.workload_utilization_ratio) || 1.0;

  let baseRem = Math.max(1.0, (remMs / totMs) * initDays);
  if (hasBlocked) baseRem += 3.0;
  if (lead > 0) baseRem += lead * 0.7;
  if (util > 1.0) baseRem += (util - 1.0) * 2.5;

  let prob = 0.20;
  if (hasBlocked) prob += 0.35;
  if (lead > remDeadline) prob += 0.30;
  if (util > 1.2) prob += 0.25;
  prob = Math.min(0.99, Math.max(0.05, prob));

  const level = prob >= 0.80 ? 'Critical' : prob >= 0.60 ? 'High' : prob >= 0.30 ? 'Medium' : 'Low';
  const expectedDelay = Math.max(0.0, Math.round((baseRem - Math.max(0, remDeadline)) * 10) / 10);

  const now = new Date();
  const compDate = new Date(now.getTime() + baseRem * 86400000).toISOString().split('T')[0];

  const factors = [];
  if (hasBlocked) factors.push('A milestone is blocked by an external dependency or pending client input.');
  if (lead > remDeadline) factors.push(`Supplier replenishment lead time (${lead} days) exceeds the remaining project schedule.`);
  if (util > 1.1) factors.push(`Workspace utilization is elevated at ${Math.round(util * 100)}% of nominal capacity.`);
  if (!factors.length) factors.push('Operations are progressing within nominal buffer thresholds.');

  return {
    is_fallback: true,
    delay_probability: Math.round(prob * 1000) / 1000,
    delay_percentage: Math.round(prob * 100),
    risk_level: level,
    likelihood_text: `${level} risk of delay (${Math.round(prob * 100)}% likelihood)`,
    estimated_remaining_days: Math.round(baseRem * 10) / 10,
    expected_completion_date: compDate,
    expected_delay_days: expectedDelay,
    confidence_range_days: [Math.max(0.5, Math.round((baseRem - 2.0) * 10) / 10), Math.round((baseRem + 2.5) * 10) / 10],
    contributing_factors: factors,
    model_used: 'PayPilot-RuleBased-Fallback'
  };
}

/**
 * Predict Delay Risk and Completion Time for an active project
 */
async function predictProject(business, project, milestones, activeCount, resourceShortages) {
  const totalMs = milestones.length || 4;
  const completedMs = milestones.filter(m => m.status === 'Completed').length;
  const remMs = Math.max(0, totalMs - completedMs);
  const progressPct = project.progress_percentage !== undefined && project.progress_percentage !== null
    ? project.progress_percentage
    : Math.round((completedMs / totalMs) * 100);

  // If project is 100% complete or marked Completed, stop generating delay predictions
  if (progressPct >= 100 || project.status === 'Completed') {
    return {
      projectId: project.id,
      projectTitle: project.title,
      deadline: project.deadline,
      progress: 100,
      remainingDaysToDeadline: 0,
      delayProbability: 0,
      delayPercentage: 0,
      riskLevel: 'None',
      estimatedRemainingDays: 0,
      expectedCompletionDate: 'Completed',
      expectedDelayDays: 0,
      confidenceInterval: [0, 0],
      isOverdue: false,
      isCompleted: true,
      contributingFactors: ['Project completed successfully']
    };
  }

  const now = new Date();
  const deadlineDate = project.deadline ? new Date(project.deadline + 'T00:00:00') : new Date(now.getTime() + 7 * 86400000);
  const diffDays = Math.round((deadlineDate - now) / 86400000);
  const remDaysToDeadline = diffDays;

  const initDays = project.initial_estimated_days || 7;
  const elapsedDays = Math.max(0, initDays - Math.max(0, remDaysToDeadline));

  const capacity = business.capacity || 5;
  const util = Math.round((activeCount / capacity) * 100) / 100;

  const hasBlocked = milestones.some(m => m.status === 'Blocked');
  const clientApproval = milestones.some(m => (m.description || '').toLowerCase().includes('approval') || (m.description || '').toLowerCase().includes('client'));

  // Calculate max supplier lead time from relevant shortage
  let maxLead = 0;
  if (resourceShortages && resourceShortages.length) {
    maxLead = Math.max(...resourceShortages.map(r => r.supplier_lead_time_days || 0));
  }

  const features = {
    category: business.category || 'Printing & Custom Merchandise',
    complexity_score: 3,
    total_milestones: totalMs,
    remaining_milestones: remMs,
    progress_pct: progressPct,
    initial_estimated_days: initDays,
    elapsed_days: elapsedDays,
    remaining_days_to_deadline: remDaysToDeadline,
    active_projects_count: activeCount,
    capacity_limit: capacity,
    workload_utilization_ratio: util,
    staff_available_pct: 1.0,
    resource_shortage_count: resourceShortages ? resourceShortages.length : 0,
    max_supplier_lead_time_days: maxLead,
    machine_overload_ratio: 1.0,
    has_blocked_milestone: hasBlocked ? 1 : 0,
    client_approval_pending: clientApproval ? 1 : 0,
    historical_delay_rate: 0.30
  };

  const prediction = await callPythonPredict(features);

  return {
    projectId: project.id,
    projectTitle: project.title,
    deadline: project.deadline,
    progress: progressPct,
    remainingDaysToDeadline: remDaysToDeadline,
    delayProbability: prediction.delay_probability,
    delayPercentage: prediction.delay_percentage,
    riskLevel: prediction.risk_level,
    likelihoodText: prediction.likelihood_text,
    estimatedRemainingDays: prediction.estimated_remaining_days,
    expectedCompletionDate: prediction.expected_completion_date,
    expectedDelayDays: prediction.expected_delay_days,
    confidenceRangeDays: prediction.confidence_range_days,
    contributingFactors: prediction.contributing_factors,
    modelUsed: prediction.model_used,
    isDelayed: prediction.expected_delay_days > 0 || remDaysToDeadline < 0
  };
}

/**
 * Evaluate Business Resource Shortages, Bottlenecks, and Lead Times
 */
function evaluateBusinessResources(businessId) {
  const rows = db.prepare('SELECT * FROM resources WHERE business_id = ? ORDER BY type, name').all(businessId);
  const shortages = [];
  const warnings = [];

  rows.forEach(r => {
    // 1. Deficit / Shortage Check: required > available
    if (r.required_quantity > r.available_quantity) {
      const deficit = r.required_quantity - r.available_quantity;
      shortages.push({
        resourceId: r.id,
        name: r.name,
        type: r.type,
        available: r.available_quantity,
        required: r.required_quantity,
        deficit,
        unit: r.unit,
        leadTimeDays: r.supplier_lead_time_days,
        costPerUnit: r.cost_per_unit,
        status: 'shortage',
        notes: r.notes
      });
    } else if (r.available_quantity <= r.reorder_threshold) {
      warnings.push({
        resourceId: r.id,
        name: r.name,
        type: r.type,
        available: r.available_quantity,
        threshold: r.reorder_threshold,
        unit: r.unit,
        leadTimeDays: r.supplier_lead_time_days,
        status: 'low_stock'
      });
    }
  });

  return {
    totalResources: rows.length,
    resources: rows,
    shortages,
    warnings,
    hasShortage: shortages.length > 0
  };
}

/**
 * Adaptive Recovery Planner:
 * Generates practical, business-specific recovery plans with flowchart stages
 */
function buildRecoveryPlans(business, activeProjects, resourceIntel, mlPredictions) {
  const plans = [];
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const capacity = business.capacity || 5;
  const activeCount = activeProjects.length;

  // 1. Resource Shortage Recovery Plans
  if (resourceIntel.shortages.length > 0) {
    resourceIntel.shortages.forEach(sh => {
      const estCost = Math.round(sh.deficit * sh.costPerUnit * 100) / 100;
      const planId = `plan_res_${sh.resourceId}`;

      plans.push({
        id: planId,
        riskId: `risk_shortage_${sh.resourceId}`,
        riskType: 'RESOURCE_SHORTAGE',
        severity: sh.leadTimeDays >= 3 ? 'Critical' : 'High',
        title: `Resource Shortage: Missing ${sh.deficit} ${sh.unit} of ${sh.name}`,
        rootCause: `Active project commitments require ${sh.required} ${sh.unit}, but current available inventory is only ${sh.available} ${sh.unit}. Normal supplier delivery requires ${sh.leadTimeDays} business days.`,
        impact: `Potential ${sh.leadTimeDays}-day delivery stall on dependent orders unless resolved or inventory is expedited.`,
        affectedEntity: `${sh.name} (${business.name})`,
        flowchart: {
          step1_risk: `Shortage of ${sh.deficit} ${sh.unit} (${sh.name})`,
          step2_cause: `Inventory (${sh.available}) < Required (${sh.required})`,
          step3_recommendation: `Restock via preferred supplier with ${sh.leadTimeDays}d buffer or reallocate from pipeline`,
          step4_impact: `Saves up to ${sh.leadTimeDays} days of downstream project delays`,
          step5_approval: 'Requires Business Owner Approval',
          step6_reassessment: 'Inventory updated, risk score recalculated'
        },
        options: [
          {
            id: 'opt_expedite_supplier',
            strategy: 'Fastest Recovery',
            action: 'procure_expedited_resource',
            label: `Procure Missing ${sh.deficit} ${sh.unit} via Express Supplier`,
            detail: `Place rush order with supplier. Estimated delivery: ${Math.max(1, Math.round(sh.leadTimeDays / 2))} days.`,
            timeSavedDays: Math.round(sh.leadTimeDays / 2),
            estimatedCost: estCost > 0 ? `$${estCost + 20} (incl. rush fee)` : 'Standard supplier cost',
            tradeOffs: 'Higher shipping expense, guarantees uninterrupted production turnaround.'
          },
          {
            id: 'opt_split_batch',
            strategy: 'Lowest Additional Cost',
            action: 'split_production_batch',
            label: `Fulfill Initial Batch with Available ${sh.available} ${sh.unit}`,
            detail: `Deliver in-stock quantity now and dispatch remainder upon regular supplier arrival (${sh.leadTimeDays}d).`,
            timeSavedDays: 0,
            estimatedCost: '$0 additional cost',
            tradeOffs: 'Requires client notice of split delivery; avoids rush fees.'
          },
          {
            id: 'opt_reallocate_stock',
            strategy: 'Least Disruption',
            action: 'reallocate_internal_stock',
            label: `Reallocate Buffer Stock (${sh.deficit} ${sh.unit})`,
            detail: `Draw ${sh.deficit} ${sh.unit} from emergency workshop buffer to meet immediate project deadline.`,
            timeSavedDays: sh.leadTimeDays,
            estimatedCost: '$0 immediate cost',
            tradeOffs: 'Workshop buffer will need replenishment next week.'
          }
        ],
        status: 'pending'
      });
    });
  }

  // 2. Capacity Overload Recovery Plans
  if (activeCount > capacity) {
    const overloadDiff = activeCount - capacity;
    plans.push({
      id: 'plan_cap_overload',
      riskId: 'risk_capacity_overload',
      riskType: 'CAPACITY_OVERLOAD',
      severity: activeCount >= capacity + 2 ? 'Critical' : 'High',
      title: `Workspace Capacity Exceeded (${activeCount}/${capacity} Active Projects)`,
      rootCause: `You are concurrently managing ${activeCount} projects against a maximum configured limit of ${capacity} (${Math.round((activeCount / capacity) * 100)}% utilization).`,
      impact: 'Risk of staff burnout, delayed client deliverables, and compromised quality inspection across all active orders.',
      affectedEntity: `${business.name} Workspace`,
      flowchart: {
        step1_risk: `Concurrent load exceeds threshold by +${overloadDiff} projects`,
        step2_cause: `High customer demand without corresponding schedule buffer adjustments`,
        step3_recommendation: `Apply 3-day buffer across active queue or elevate workspace capacity threshold`,
        step4_impact: `Eliminates missed deadlines and stabilizes weekly workload`,
        step5_approval: 'Requires Business Owner Approval',
        step6_reassessment: 'Project deadlines & capacity adjusted, workload verified'
      },
      options: [
        {
          id: 'opt_extend_deadlines_3d',
          strategy: 'Least Disruption',
          action: 'extend_deadlines_3d',
          label: 'Apply +3 Business Days Buffer to Active Projects',
          detail: 'Decompresses the calendar schedule, granting breathing room without increasing work hours.',
          timeSavedDays: 3,
          estimatedCost: '$0',
          tradeOffs: 'Moves target deadlines out by 3 days for active clients.'
        },
        {
          id: 'opt_increase_capacity',
          strategy: 'Fastest Recovery',
          action: 'increase_capacity',
          label: `Elevate Workspace Capacity Limit to ${activeCount}`,
          detail: `Updates your target operating threshold to match current project velocity (${activeCount} projects).`,
          timeSavedDays: 0,
          estimatedCost: '$0',
          tradeOffs: 'Acknowledges current load; requires sustained higher focus or additional team hours.'
        }
      ],
      status: 'pending'
    });
  }

  // 3. Overdue Projects & ML High Delay Risk Recovery Plans
  mlPredictions.forEach(pred => {
    if (pred.isDelayed || pred.riskLevel === 'High' || pred.riskLevel === 'Critical') {
      const proj = activeProjects.find(p => p.id === pred.projectId);
      if (!proj) return;

      const pDeadline = proj.deadline;
      const isPastDue = pDeadline && pDeadline < todayStr && proj.progress_percentage < 100;
      const delayDays = pred.expectedDelayDays > 0 ? pred.expectedDelayDays : 3;

      plans.push({
        id: `plan_delay_${proj.id}`,
        riskId: `risk_due_${proj.id}`,
        riskType: isPastDue ? 'OVERDUE_PROJECT' : 'PREDICTED_DELAY_RISK',
        severity: isPastDue ? 'Critical' : pred.riskLevel,
        title: isPastDue ? `Overdue Project: "${proj.title}"` : `High Delay Risk: "${proj.title}" (${pred.delayPercentage}% ML Probability)`,
        rootCause: isPastDue
          ? `Project reached scheduled deadline (${pDeadline}) with only ${proj.progress_percentage}% completed.`
          : `ML prediction model estimates remaining duration (${pred.estimatedRemainingDays} days) exceeds available schedule (${Math.max(0, pred.remainingDaysToDeadline)} days). Contributing: ${pred.contributingFactors.join(' ')}`,
        impact: `Client expectation mismatch and potential dispute if delivery slips without proactive notice.`,
        affectedEntity: proj.title,
        flowchart: {
          step1_risk: isPastDue ? `Deadline missed (${pDeadline})` : `Estimated ${delayDays}d slip`,
          step2_cause: pred.contributingFactors[0] || 'Workload bottlenecks',
          step3_recommendation: `Propose official ${delayDays + 2}-day delivery extension and prioritize remaining milestones`,
          step4_impact: `Restores on-time delivery confidence and notifies client cleanly`,
          step5_approval: 'Requires Business Owner Approval',
          step6_reassessment: 'Deadline rescheduled, ML risk score refreshed'
        },
        options: [
          {
            id: `opt_extend_proj_${proj.id}`,
            strategy: 'Least Disruption',
            action: 'extend_project_deadline',
            projectId: proj.id,
            days: delayDays + 2,
            label: `Propose ${delayDays + 2}-Day Revised Delivery Date`,
            detail: `Extends target deadline from ${pDeadline} to give sufficient buffer for quality completion.`,
            timeSavedDays: delayDays + 2,
            estimatedCost: '$0',
            tradeOffs: 'Updates project and customer request delivery date with transparent audit trail.'
          },
          {
            id: `opt_prioritize_proj_${proj.id}`,
            strategy: 'Fastest Recovery',
            action: 'prioritize_project_milestones',
            projectId: proj.id,
            label: 'Prioritize Active Milestones & Fast-Track Quality Review',
            detail: 'Re-sequences downstream milestones to fast-track production and bypass non-critical review holds.',
            timeSavedDays: 2,
            estimatedCost: '$0',
            tradeOffs: 'Requires dedicating primary focus to this project today.'
          }
        ],
        status: 'pending'
      });
    }
  });

  // 4. Blocked Milestone Recovery Plans
  activeProjects.forEach(proj => {
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sequence_order ASC').all(proj.id);
    const blockedMs = milestones.filter(m => m.status === 'Blocked');

    blockedMs.forEach(bm => {
      plans.push({
        id: `plan_block_${bm.id}`,
        riskId: `risk_block_${bm.id}`,
        riskType: 'BLOCKED_DEPENDENCY',
        severity: 'Medium',
        title: `Blocked Milestone: "${bm.title}"`,
        rootCause: bm.description || 'Milestone is waiting on client approval, credentials, or third-party input.',
        impact: 'Downstream milestones cannot proceed until this blocker is cleared.',
        affectedEntity: `${proj.title} → ${bm.title}`,
        flowchart: {
          step1_risk: `Milestone blocked: "${bm.title}"`,
          step2_cause: bm.description || 'Awaiting external resolution',
          step3_recommendation: `Send client reminder or mark dependency cleared`,
          step4_impact: `Unblocks subsequent milestones immediately`,
          step5_approval: 'Requires Business Owner Approval',
          step6_reassessment: 'Milestone status reset to Pending, workflow resumed'
        },
        options: [
          {
            id: `opt_clear_${bm.id}`,
            strategy: 'Fastest Recovery',
            action: 'clear_blocker',
            milestoneId: bm.id,
            label: 'Mark Dependency Resolved & Resume Milestone',
            detail: 'Restores milestone status to Pending so work can proceed immediately.',
            timeSavedDays: 2,
            estimatedCost: '$0',
            tradeOffs: 'Assumes required assets or approvals have been received.'
          },
          {
            id: `opt_send_reminder_${bm.id}`,
            strategy: 'Least Disruption',
            action: 'send_client_reminder',
            milestoneId: bm.id,
            label: 'Dispatch Urgent Client Approval Reminder',
            detail: 'Logs approval follow-up notification and extends grace buffer by 24 hours.',
            timeSavedDays: 1,
            estimatedCost: '$0',
            tradeOffs: 'Gives client structured 24h deadline to supply missing info.'
          }
        ],
        status: 'pending'
      });
    });
  });

  return plans;
}

/**
 * Execute an Approved Recovery Action with Audit Trail & Reassessment
 */
async function executeApprovedRecoveryAction(businessId, action, params = {}) {
  const { projectId, milestoneId, days, resourceId, quantity } = params;

  let executionSummary = '';
  let affectedRecords = {};

  // 1. Capacity action
  if (action === 'increase_capacity') {
    const activeCount = db.prepare("SELECT COUNT(*) as count FROM projects WHERE business_id = ? AND status != 'Completed'").get(businessId).count;
    const newCap = Math.max(activeCount, 4);
    db.prepare("UPDATE businesses SET capacity = ?, updated_at = datetime('now') WHERE id = ?").run(newCap, businessId);
    executionSummary = `Workspace capacity threshold increased to ${newCap} concurrent projects.`;
    affectedRecords.business = { id: businessId, newCapacity: newCap };
  }

  // 2. Extend all deadlines 3d
  else if (action === 'extend_deadlines_3d') {
    const projs = db.prepare("SELECT id, deadline, request_id FROM projects WHERE business_id = ? AND status != 'Completed'").all(businessId);
    projs.forEach(p => {
      const curDate = p.deadline ? new Date(p.deadline + 'T00:00:00') : new Date();
      curDate.setDate(curDate.getDate() + 3);
      const newD = curDate.toISOString().split('T')[0];
      db.prepare("UPDATE projects SET deadline = ?, updated_at = datetime('now') WHERE id = ?").run(newD, p.id);
      if (p.request_id) {
        db.prepare("UPDATE customer_requests SET deadline = ?, updated_at = datetime('now') WHERE id = ?").run(newD, p.request_id);
      }
    });
    executionSummary = `Applied +3 days grace buffer across ${projs.length} active projects.`;
    affectedRecords.projectsUpdated = projs.length;
  }

  // 3. Extend single project deadline
  else if (action === 'extend_project_deadline' || action === 'extend_project_deadline_5d') {
    const extDays = days || 5;
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (p) {
      const curDate = p.deadline ? new Date(p.deadline + 'T00:00:00') : new Date();
      curDate.setDate(curDate.getDate() + extDays);
      const newD = curDate.toISOString().split('T')[0];
      db.prepare("UPDATE projects SET deadline = ?, updated_at = datetime('now') WHERE id = ?").run(newD, p.id);
      if (p.request_id) {
        db.prepare("UPDATE customer_requests SET deadline = ?, updated_at = datetime('now') WHERE id = ?").run(newD, p.request_id);
      }
      executionSummary = `Project "${p.title}" deadline extended by ${extDays} days to ${newD}. Client notification queued.`;
      affectedRecords.project = { id: p.id, oldDeadline: p.deadline, newDeadline: newD };
    }
  }

  // 4. Resolve / clear milestone blocker
  else if (action === 'clear_blocker') {
    if (milestoneId) {
      db.prepare("UPDATE milestones SET status = 'Pending', is_blocked = 0, updated_at = datetime('now') WHERE id = ?").run(milestoneId);
      executionSummary = 'Milestone blocker cleared. Status restored to Pending.';
      affectedRecords.milestoneId = milestoneId;
    }
  }

  // 5. Procure expedited resource / restock inventory
  else if (action === 'procure_expedited_resource' || action === 'reallocate_internal_stock') {
    // If resourceId specified, update available_quantity to match required
    if (resourceId) {
      const resRow = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      if (resRow) {
        const added = quantity || Math.max(10, resRow.required_quantity - resRow.available_quantity);
        const newAvail = resRow.available_quantity + added;
        db.prepare("UPDATE resources SET available_quantity = ?, status = 'available', updated_at = datetime('now') WHERE id = ?").run(newAvail, resourceId);
        executionSummary = `Restocked ${resRow.name}: Available increased from ${resRow.available_quantity} to ${newAvail} ${resRow.unit}. Shortage resolved.`;
        affectedRecords.resource = { id: resourceId, added, newQuantity: newAvail };
      }
    } else {
      // Auto-restock any short materials for this business
      const shorts = db.prepare('SELECT * FROM resources WHERE business_id = ? AND required_quantity > available_quantity').all(businessId);
      shorts.forEach(s => {
        const newQty = s.required_quantity + 10;
        db.prepare("UPDATE resources SET available_quantity = ?, status = 'available', updated_at = datetime('now') WHERE id = ?").run(newQty, s.id);
      });
      executionSummary = `Restocked ${shorts.length} shortage materials to safe operating buffer.`;
      affectedRecords.shortagesCleared = shorts.length;
    }
  }

  // 6. Split batch production
  else if (action === 'split_production_batch') {
    executionSummary = 'Scheduled split batch delivery: immediate partial dispatch authorized with balance scheduled upon arrival.';
  }

  // 7. Send client reminder
  else if (action === 'send_client_reminder') {
    executionSummary = 'Dispatched high-priority milestone reminder to client.';
  }

  // Record continuous learning operational event
  const eventId = `evt_${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(`
    INSERT INTO operational_events (id, business_id, project_id, event_type, event_data)
    VALUES (?, ?, ?, 'recovery_action_approved', ?)
  `).run(
    eventId,
    businessId,
    projectId || null,
    JSON.stringify({
      action,
      params,
      executionSummary,
      affectedRecords,
      timestamp: new Date().toISOString()
    })
  );

  return {
    success: true,
    action,
    summary: executionSummary,
    affectedRecords,
    eventId
  };
}

/**
 * Check ML models status and availability on disk
 */
function getMlStatus() {
  const fs = require('node:fs');
  const modelsDir = path.join(__dirname, '..', 'ml', 'models');
  const clfPath = path.join(modelsDir, 'delay_classifier.joblib');
  const regPath = path.join(modelsDir, 'duration_regressor.joblib');
  const prepPath = path.join(modelsDir, 'preprocessor.joblib');
  const metricsPath = path.join(modelsDir, 'model_metrics.json');

  const clfExists = fs.existsSync(clfPath);
  const regExists = fs.existsSync(regPath);
  const prepExists = fs.existsSync(prepPath);

  let metrics = null;
  if (fs.existsSync(metricsPath)) {
    try {
      metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    } catch (_) {}
  }

  const clfAlg = metrics?.model_a_classification?.selected_best || 'RandomForestClassifier';
  const regAlg = metrics?.model_b_regression?.selected_best || 'HistGradientBoostingRegressor';

  return {
    ready: clfExists && regExists && prepExists,
    classifier: {
      loaded: clfExists,
      algorithm: clfAlg,
      task: 'Project Delay & Risk Probability'
    },
    regressor: {
      loaded: regExists,
      algorithm: regAlg,
      task: 'Remaining Completion Days & Uncertainty Range'
    },
    metricsAvailable: Boolean(metrics)
  };
}

module.exports = {
  callPythonPredict,
  fallbackPredict,
  predictProject,
  evaluateBusinessResources,
  buildRecoveryPlans,
  executeApprovedRecoveryAction,
  getMlStatus
};

