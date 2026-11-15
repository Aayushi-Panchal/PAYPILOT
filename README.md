# PayPilot — Adaptive Business Operating Platform

PayPilot is an AI-powered adaptive business operating platform designed for freelancers, artisans, and small businesses for the **“Build What's Next with PayPal and AI”** global hackathon.

Unlike rigid generic project management tools, PayPilot adapts its workspace modules, milestones, intake questions, and risk monitoring to the specific nature of each business (e.g. Bakeries, Freelance Developers, Design Agencies, Caterers, and bespoke artisans).

---

## Phase 1 Implementation Summary

- **Official PayPal Branding:** Verified official double-PP monogram SVG integrated in headers, footers, checkout buttons, and navigation.
- **Adaptive AI Onboarding Agent:**
  - Accepts business name and natural language description.
  - Automatically identifies business category with confidence score and reasoning.
  - Generates 6–7 dynamic multiple-choice questions tailored to the category, with interactive "Other" custom text inputs.
  - Generates a tailored 6-stage milestone pipeline, recommended workspace modules, and capacity thresholds.
  - Persists completed onboarding sessions and workspace configurations to the database.
- **Database Foundation (PostgreSQL / Supabase + SQLite):**
  - Full PostgreSQL/Supabase DDL schema in [`db/schema.sql`](file:///c:/Users/LENOVO/OneDrive/Documents/PAYPILOT%20NEW/db/schema.sql).
  - High-performance, zero-config native SQLite runtime in [`db/database.js`](file:///c:/Users/LENOVO/OneDrive/Documents/PAYPILOT%20NEW/db/database.js) persisting to `paypilot.db`.
  - ML-ready columns prepared for Phase 3 (planned vs. actual timestamps, remaining hours, dependency graphs, workload ratios, delay labels).
- **PayPal Sandbox Developer API Foundation:**
  - Secure server-side credential handling with zero secret leakage to the browser.
  - Server endpoints for order creation (`POST /api/paypal/create-order`) and order capture (`POST /api/paypal/capture-order`).
  - Strict server-side verification: status must be `COMPLETED` and captured amount must match expected billing amount before entitlements are unlocked.
  - Verified transaction recording with idempotency protection.
- **Preserved Core UI:**
  - Light theme with persistent Dark Mode toggle.
  - Responsive layouts, sidebars, marketplace, customer order trackers, owner portals, and empty/loading states.

---

## Getting Started

### 1. Prerequisites
- Node.js v18+ (Node.js v24 recommended)
- npm v9+

### 2. Installation
```bash
git clone <repo-url>
cd "PAYPILOT NEW"
npm install
```

### 3. Environment Configuration
Copy the template environment file:
```bash
cp .env.example .env
```

Open `.env` and configure your credentials:
```env
PORT=3000
NODE_ENV=development

# PayPal Sandbox Developer Credentials
# (https://developer.paypal.com/dashboard/applications/sandbox)
PAYPAL_MODE=sandbox
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_CLIENT_ID=your_paypal_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_paypal_sandbox_client_secret_here

# AI Provider Configuration ('gemini', 'openai', 'anthropic', or 'fallback')
AI_PROVIDER=fallback
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Database
DATABASE_FILE=paypilot.db
```

> **Note:** If `GEMINI_API_KEY` or `OPENAI_API_KEY` are left blank or `AI_PROVIDER=fallback`, PayPilot automatically uses its built-in adaptive semantic reasoning engine. If PayPal credentials are not configured, server endpoints return a structured status code (`PAYPAL_CREDENTIALS_MISSING`) and guide the user on how to add their sandbox credentials.

### 4. Running the Application
```bash
npm start
```
Open your browser at: **`http://localhost:3000`**

### 5. Running the Automated Test Suite
```bash
npm test
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Service health status and runtime details |
| `POST` | `/api/onboarding/identify` | AI category identification & confidence reasoning |
| `POST` | `/api/onboarding/questions` | Generates 6–7 adaptive questions with options |
| `POST` | `/api/onboarding/generate-workspace` | Generates personalized milestones & modules |
| `POST` | `/api/onboarding/save-session` | Persists onboarding session and business profile |
| `GET` | `/api/businesses` | Lists active marketplace businesses |
| `GET` | `/api/businesses/:id` | Returns business profile & workspace config |
| `GET` | `/api/paypal/status` | Verifies PayPal Sandbox configuration status |
| `POST` | `/api/paypal/create-order` | Creates a PayPal Sandbox order (server-side) |
| `POST` | `/api/paypal/capture-order` | Captures order and performs server-side verification |
| `GET` | `/api/paypal/transactions` | Retrieves verified payment transactions |

---

## Roadmap

- [x] **Phase 1:** Foundation + AI Agents + PayPal APIs *(Complete)*
  - Truly Adaptive AI Onboarding: one question at a time, Gemini LLM + semantic fallback engine
  - PayPal Sandbox server-side order creation & verified capture
  - SQLite + PostgreSQL schema, ML-ready columns for Phase 3
- [x] **Phase 2:** Dynamic Business Workspace *(Complete)*
  - Two-way portal switching (Customer ⇄ Business Owner)
  - Customer request submission with full validation → persists to DB
  - Owner accept/reject workflow with category-specific milestone auto-generation
  - Real-time milestone toggle with live progress percentage recalculation
  - Owner project tracker, weekly workload schedule, and Recovery Centre stub
  - My Orders customer tracking view with live milestone progress bars
- [ ] **Phase 3:** ML Delay Prediction Model + Intelligent Recovery Agent (scikit-learn / FastAPI)
- [ ] **Phase 4:** Advanced Payments + Business Growth (Milestone Invoices & Entitlements)
- [ ] **Phase 5:** Deployment + Hackathon Submission

---

## Running the Dev Server (with auto-restart)

```bash
npm run dev
```

The dev script uses Node.js built-in `--watch` mode (v18+) — no extra tools needed.
