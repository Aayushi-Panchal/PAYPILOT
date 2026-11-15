const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const aiOnboardingService = require('../services/aiOnboardingService');
const { db } = require('../db/database');

/**
 * Step 1: Identify business category from natural description
 */
router.post('/identify', async (req, res) => {
  try {
    const { businessName, description } = req.body;
    if (!description && !businessName) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Please provide at least a business name or a description.'
      });
    }

    const result = await aiOnboardingService.identifyCategory(businessName, description);
    return res.json(result);
  } catch (error) {
    console.error('Error in /api/onboarding/identify:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to identify category. Please select one manually.',
      details: error.message
    });
  }
});

/**
 * Step 2: Generate next single adaptive question (conversational, step-by-step)
 */
router.post('/next-question', async (req, res) => {
  try {
    const { businessName, description, category, questionIndex, history } = req.body;
    if (!category) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Business category is required to generate the next question.'
      });
    }

    const result = await aiOnboardingService.generateNextQuestion({
      businessName: businessName || '',
      description: description || '',
      category,
      questionIndex: parseInt(questionIndex, 10) || 0,
      history: Array.isArray(history) ? history : []
    });

    return res.json(result);
  } catch (error) {
    console.error('Error in /api/onboarding/next-question:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to generate next adaptive question.',
      details: error.message
    });
  }
});

/**
 * GET /api/onboarding/ai-status
 * Report active AI provider, model, and readiness without exposing secret keys
 */
router.get('/ai-status', (req, res) => {
  try {
    const status = aiOnboardingService.getAiStatus();
    return res.json({ success: true, ai: status });
  } catch (error) {
    console.error('Error in /api/onboarding/ai-status:', error);
    return res.status(500).json({ error: 'SERVER_ERROR', message: error.message });
  }
});

/**
 * Legacy / batch question generation for backwards compatibility
 */
router.post('/questions', async (req, res) => {
  try {
    const { category, description, previousAnswers } = req.body;
    if (!category) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Business category is required to generate adaptive questions.'
      });
    }

    const questions = [];
    for (let i = 0; i < 6; i++) {
      const q = await aiOnboardingService.generateNextQuestion({
        businessName: '',
        description: description || '',
        category,
        questionIndex: i,
        history: []
      });
      questions.push(q);
    }

    return res.json({ category, questions, totalQuestions: questions.length });
  } catch (error) {
    console.error('Error in /api/onboarding/questions:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to generate adaptive questions.',
      details: error.message
    });
  }
});

/**
 * Step 3: Generate tailored workspace & milestone template
 */
router.post('/generate-workspace', async (req, res) => {
  try {
    const { businessName, category, description, answers } = req.body;
    if (!category) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Category is required to generate workspace template.'
      });
    }

    const result = await aiOnboardingService.generateWorkspaceConfig(
      businessName,
      category,
      description || '',
      answers || {}
    );
    return res.json(result);
  } catch (error) {
    console.error('Error in /api/onboarding/generate-workspace:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to generate workspace configuration.',
      details: error.message
    });
  }
});

/**
 * Step 4: Validate and save completed onboarding session & persist to database
 */
router.post('/save-session', (req, res) => {
  try {
    const { businessName, category, description, answers, workspaceConfig, services, workingHours, capacity, teamSize } = req.body;

    if (!businessName || !category) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Business name and category are required to save session.'
      });
    }

    const businessId = 'b_' + crypto.randomUUID().slice(0, 8);
    const sessionId = crypto.randomUUID();

    const isPublished = req.body.published === false ? 0 : 1;

    // Calculate capacity accurately from payload, onboarding answers, or documented fallback (5)
    let finalCapacity = parseInt(capacity, 10);
    if (!finalCapacity || isNaN(finalCapacity) || finalCapacity <= 0) {
      finalCapacity = aiOnboardingService.extractCapacityFromAnswers(answers || {});
    }
    if (!finalCapacity || isNaN(finalCapacity) || finalCapacity <= 0) {
      finalCapacity = 5;
    }

    // 1. Create Business Record
    const insertBiz = db.prepare(`
      INSERT INTO businesses (id, name, category, description, services, working_hours, capacity, team_size, published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertBiz.run(
      businessId,
      businessName.trim(),
      category,
      description ? description.trim() : '',
      JSON.stringify(services || []),
      workingHours || 'Mon–Fri, 9:00–17:00',
      finalCapacity,
      teamSize || '1 person',
      isPublished
    );

    // 2. Record Onboarding Session
    const insertSession = db.prepare(`
      INSERT INTO onboarding_sessions (id, business_id, business_name, business_description, identified_category, questions, answers, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
    `);

    insertSession.run(
      sessionId,
      businessId,
      businessName.trim(),
      description || '',
      category,
      JSON.stringify(workspaceConfig?.questions || []),
      JSON.stringify(answers || {})
    );

    // 3. Create Workspace Configuration
    const insertConfig = db.prepare(`
      INSERT INTO workspace_configs (id, business_id, category, modules, milestone_templates, workflow_rules)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertConfig.run(
      crypto.randomUUID(),
      businessId,
      category,
      JSON.stringify(workspaceConfig?.recommendedModules || ['requests', 'projects', 'workload', 'recovery', 'finance']),
      JSON.stringify(workspaceConfig?.milestoneTemplate || []),
      JSON.stringify(workspaceConfig?.workflowRules || {})
    );

    // 4. Seed initial business resources according to category
    const insertRes = db.prepare(`
      INSERT INTO resources (id, business_id, name, type, available_quantity, allocated_quantity, required_quantity, unit, reorder_threshold, supplier_lead_time_days, status, cost_per_unit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
    `);

    const normCat = category.toLowerCase();
    if (normCat.includes('print') || normCat.includes('merch')) {
      insertRes.run(`r_${businessId}_mugs`, businessId, '11oz Ceramic Blank Mugs', 'material', 40, 15, 30, 'units', 20, 4, 1.85, 'Supplier: EcoBlank Supplies (4-day lead time)');
      insertRes.run(`r_${businessId}_ink`, businessId, 'UV Sublimation Ink Set', 'material', 4, 1, 2, 'sets', 2, 2, 85.00, 'CYMK Sublimation Inks');
      insertRes.run(`r_${businessId}_press`, businessId, 'Dual Heat Press Station #1', 'equipment', 1, 1, 1, 'machines', 0, 0, 0, 'Capacity: 40 mugs/hour');
      insertRes.run(`r_${businessId}_staff`, businessId, 'Print Technician', 'staff', 38, 20, 25, 'hours', 8, 0, 25.00, 'Full-time machine operator');
    } else if (normCat.includes('baker') || normCat.includes('food')) {
      insertRes.run(`r_${businessId}_flour`, businessId, 'Organic Cake Flour', 'material', 30, 10, 15, 'kg', 10, 2, 2.50, 'Valley Mills (2-day lead time)');
      insertRes.run(`r_${businessId}_fondant`, businessId, 'Specialty Decorating Fondant', 'material', 6, 2, 4, 'kg', 4, 4, 12.00, 'Express courier required');
      insertRes.run(`r_${businessId}_oven`, businessId, 'Deck Oven Unit #1', 'equipment', 2, 1, 2, 'slots', 0, 0, 0, 'Deck baking oven');
      insertRes.run(`r_${businessId}_baker`, businessId, 'Pastry Baker', 'staff', 40, 25, 30, 'hours', 10, 0, 30.00, 'Lead pastry chef');
    } else if (normCat.includes('dev') || normCat.includes('software')) {
      insertRes.run(`r_${businessId}_dev`, businessId, 'Senior Full-Stack Engineer', 'staff', 40, 28, 32, 'hours', 8, 0, 75.00, 'Lead engineer availability');
      insertRes.run(`r_${businessId}_cloud`, businessId, 'Staging & Testing Cluster', 'service', 2, 1, 1, 'slots', 0, 1, 45.00, 'AWS ECS & staging DB');
      insertRes.run(`r_${businessId}_apis`, businessId, 'Commercial API & SDK Licenses', 'service', 10, 4, 6, 'credits', 3, 0, 15.00, 'Third-party developer API quotas');
    } else {
      insertRes.run(`r_${businessId}_designer`, businessId, 'Senior Brand & UI Designer', 'staff', 35, 24, 28, 'hours', 5, 0, 65.00, 'Creative lead hours');
      insertRes.run(`r_${businessId}_stock`, businessId, 'Commercial Font & Asset License', 'service', 12, 5, 7, 'credits', 4, 1, 20.00, 'Adobe Stock & Type Network');
      insertRes.run(`r_${businessId}_figma`, businessId, 'Figma Team Seats', 'service', 2, 1, 2, 'seats', 0, 0, 15.00, 'Vector prototyping licenses');
    }

    return res.json({
      success: true,
      businessId,
      sessionId,
      business: {
        id: businessId,
        name: businessName,
        category,
        description,
        services: services || [],
        workingHours: workingHours || 'Mon–Fri, 9:00–17:00',
        capacity: finalCapacity,
        published: Boolean(isPublished)
      },
      workspaceConfig
    });
  } catch (error) {
    console.error('Error in /api/onboarding/save-session:', error);
    return res.status(500).json({
      error: 'DATABASE_ERROR',
      message: 'Failed to persist onboarding session and business profile.',
      details: error.message
    });
  }
});

/**
 * List known categories
 */
router.get('/categories', (req, res) => {
  res.json({ categories: aiOnboardingService.KNOWN_CATEGORIES });
});

module.exports = router;
