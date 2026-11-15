const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = process.env.DATABASE_FILE || path.join(__dirname, '..', 'paypilot.db');
const db = new DatabaseSync(dbPath);

// Enable foreign keys and WAL mode for reliability
db.exec('PRAGMA foreign_keys = ON;');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      services TEXT DEFAULT '[]',
      working_hours TEXT DEFAULT 'Mon–Fri, 9:00–17:00',
      capacity INTEGER DEFAULT 5,
      team_size TEXT DEFAULT '1 person',
      published INTEGER DEFAULT 0,
      paypal_merchant_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      id TEXT PRIMARY KEY,
      business_id TEXT,
      business_name TEXT NOT NULL,
      business_description TEXT NOT NULL,
      identified_category TEXT NOT NULL,
      category_confidence REAL DEFAULT 1.0,
      category_reasoning TEXT,
      questions TEXT NOT NULL DEFAULT '[]',
      answers TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_configs (
      id TEXT PRIMARY KEY,
      business_id TEXT,
      category TEXT NOT NULL,
      modules TEXT NOT NULL DEFAULT '["requests", "projects", "workload", "recovery", "finance"]',
      milestone_templates TEXT NOT NULL DEFAULT '[]',
      workflow_rules TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customer_requests (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      customer_email TEXT,
      request_title TEXT NOT NULL,
      description TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0.0,
      currency TEXT DEFAULT 'USD',
      deadline TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      reference_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      business_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'In Progress',
      progress_percentage INTEGER DEFAULT 0,
      deadline TEXT NOT NULL,
      initial_estimated_days INTEGER DEFAULT 7,
      actual_duration_days INTEGER,
      workload_capacity_ratio REAL DEFAULT 1.0,
      is_delayed INTEGER DEFAULT 0,
      delay_days INTEGER DEFAULT 0,
      risk_score REAL DEFAULT 0.0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      planned_start_date TEXT,
      actual_start_date TEXT,
      planned_completion_date TEXT,
      actual_completion_date TEXT,
      remaining_hours INTEGER DEFAULT 0,
      dependencies TEXT DEFAULT '[]',
      is_blocked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blockers_and_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      milestone_id TEXT,
      blocker_type TEXT NOT NULL,
      description TEXT NOT NULL,
      duration_hours INTEGER DEFAULT 0,
      resolved_at TEXT,
      recovery_plan_suggested TEXT,
      recovery_plan_approved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      paypal_order_id TEXT UNIQUE NOT NULL,
      paypal_capture_id TEXT UNIQUE,
      business_id TEXT,
      project_id TEXT,
      payer_id TEXT,
      payer_email TEXT,
      payer_name TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL,
      payment_type TEXT DEFAULT 'pro_subscription',
      idempotency_key TEXT UNIQUE,
      verified_server_side INTEGER DEFAULT 0,
      raw_response TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      payment_id TEXT,
      plan_tier TEXT NOT NULL DEFAULT 'Free',
      status TEXT NOT NULL DEFAULT 'active',
      features_unlocked TEXT DEFAULT '["basic_listing", "up_to_5_projects"]',
      starts_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      business_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      is_read INTEGER DEFAULT 0,
      action_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Phase 3: Business-Specific Resource Intelligence
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'material', 'staff', 'equipment', 'supplier', 'service'
      available_quantity REAL NOT NULL DEFAULT 0,
      allocated_quantity REAL NOT NULL DEFAULT 0,
      required_quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'units', -- 'units', 'kg', 'hours', 'machines', 'slots'
      reorder_threshold REAL NOT NULL DEFAULT 0,
      supplier_lead_time_days INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available', -- 'available', 'low', 'out_of_stock', 'overbooked', 'maintenance'
      cost_per_unit REAL DEFAULT 0.0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Phase 3: Adaptive Recovery Planner & Flowchart Tracking
    CREATE TABLE IF NOT EXISTS recovery_plans (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      project_id TEXT,
      milestone_id TEXT,
      risk_id TEXT,
      risk_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      impact TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      selected_option_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'executed'
      owner_decision_notes TEXT,
      applied_at TEXT,
      reassessment_result TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Phase 3: Continuous Learning Event Log
    CREATE TABLE IF NOT EXISTS operational_events (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      project_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  seedInitialData();
}

function seedInitialData() {
  // Only auto-seed test fixtures if in test mode or explicitly requested via SEED_FIXTURES
  if (process.env.NODE_ENV !== 'test' && process.env.SEED_FIXTURES !== 'true') {
    return;
  }

  const ensureBiz = (id, name, cat, desc, srv, hrs, cap, team) => {
    if (!db.prepare('SELECT id FROM businesses WHERE id = ?').get(id)) {
      db.prepare(`
        INSERT INTO businesses (id, name, category, description, services, working_hours, capacity, team_size, published)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, name, cat, desc, JSON.stringify(srv), hrs, cap, team);
    }
  };

  ensureBiz('s1', 'Sweet Crumb Bakery', 'Bakery', 'Custom cakes and pastries made to order.', ['Custom cakes', 'Dessert boxes'], 'Mon–Sat, 8:00–17:00', 6, '3 people');
  ensureBiz('s2', 'Northwind Dev', 'Freelance developer', 'Websites and web apps for small businesses.', ['Landing pages', 'Web apps'], 'Mon–Fri, 9:00–18:00', 4, '1 person');
  ensureBiz('s3', 'Pixel & Co', 'Design agency', 'Brand identity and marketing design.', ['Logos', 'Brand kits'], 'Mon–Fri, 10:00–18:00', 5, '2 people');
  ensureBiz('s4', 'PrintWave Custom Merch', 'Printing & Custom Merchandise', 'Custom mugs, apparel, banners, and promotional merchandise.', ['Custom mugs', 'Apparel printing', 'Vinyl banners'], 'Mon–Fri, 8:30–17:30', 5, '3 people');

  // Only ensure test fixtures if in test mode or explicitly requested via SEED_FIXTURES
  if (process.env.NODE_ENV !== 'test' && process.env.SEED_FIXTURES !== 'true') {
    return;
  }

  // Ensure s4 exists if database was already initialized
  const s4Check = db.prepare('SELECT id FROM businesses WHERE id = ?').get('s4');
  if (!s4Check) {
    const insertBiz = db.prepare(`
      INSERT INTO businesses (id, name, category, description, services, working_hours, capacity, team_size, published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertBiz.run(
      's4',
      'PrintWave Custom Merch',
      'Printing & Custom Merchandise',
      'Custom mugs, apparel, banners, and promotional merchandise.',
      JSON.stringify(['Custom mugs', 'Apparel printing', 'Vinyl banners']),
      'Mon–Fri, 8:30–17:30',
      5,
      '3 people',
      1
    );
  }

  // Seed default business resources for real-world resource intelligence
  const resCheck = db.prepare('SELECT COUNT(*) as count FROM resources').get();
  if (resCheck.count === 0) {
    const insertRes = db.prepare(`
      INSERT INTO resources (id, business_id, name, type, available_quantity, allocated_quantity, required_quantity, unit, reorder_threshold, supplier_lead_time_days, status, cost_per_unit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Sweet Crumb Bakery (s1)
    insertRes.run('r_s1_flour', 's1', 'Organic Cake Flour', 'material', 25, 10, 15, 'kg', 10, 2, 'available', 2.50, 'Standard supplier: Valley Mills');
    insertRes.run('r_s1_fondant', 's1', 'Specialty Fondant & Decorating Cream', 'material', 4, 4, 8, 'kg', 5, 4, 'low', 12.00, 'Requires 4-day express courier when restocked');
    insertRes.run('r_s1_oven', 's1', 'Deck Oven Unit #1', 'equipment', 2, 2, 2, 'slots', 0, 0, 'available', 0, 'Max 3 simultaneous cake pans');
    insertRes.run('r_s1_baker', 's1', 'Head Baker Sarah', 'staff', 40, 25, 30, 'hours', 10, 0, 'available', 30.00, 'Full-time pastry chef');

    // Northwind Dev (s2)
    insertRes.run('r_s2_dev', 's2', 'Senior Full-Stack Developer', 'staff', 40, 32, 35, 'hours', 8, 0, 'available', 75.00, 'Alex (Principal Engineer)');
    insertRes.run('r_s2_staging', 's2', 'Cloud Testing & Staging Environment', 'service', 1, 1, 1, 'slots', 0, 1, 'available', 45.00, 'AWS ECS & RDS staging cluster');

    // Pixel & Co (s3)
    insertRes.run('r_s3_designer', 's3', 'Senior Brand Designer (Maya)', 'staff', 35, 28, 30, 'hours', 5, 0, 'available', 65.00, 'Identity and Figma specialist');
    insertRes.run('r_s3_stock', 's3', 'Commercial Font & Stock Asset License', 'service', 10, 6, 8, 'credits', 3, 1, 'available', 20.00, 'Adobe Stock & Type Network');

    // PrintWave Custom Merch (s4)
    insertRes.run('r_s4_mugs', 's4', '11oz Ceramic Sublimation Mugs (Blank)', 'material', 30, 20, 50, 'units', 25, 4, 'low', 1.80, 'Shortage detected when large orders > 30 units are active');
    insertRes.run('r_s4_ink', 's4', 'UV Sublimation Ink Set', 'material', 5, 2, 3, 'sets', 2, 2, 'available', 85.00, 'Cyan, Magenta, Yellow, Black');
    insertRes.run('r_s4_press', 's4', 'Dual Heat Press Station #1', 'equipment', 1, 1, 1, 'machines', 0, 3, 'available', 0, 'Max 40 mugs/hour throughput');
    insertRes.run('r_s4_operator', 's4', 'Print Operator (Marcus)', 'staff', 38, 24, 30, 'hours', 8, 0, 'available', 25.00, 'Machine operation & quality control');
  }
}

initDatabase();

module.exports = {
  db,
  initDatabase
};
