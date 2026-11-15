/**
 * PayPilot AI Onboarding Agent Service
 * 
 * Supports dynamic step-by-step adaptive questioning (one question at a time),
 * multi-format questions (MCQ, MSQ, Descriptive), category classification
 * (including Beauty & Personal Care / Haircare), and tailored workspace generation.
 */

const crypto = require('node:crypto');

const KNOWN_CATEGORIES = [
  'Printing',
  'Bakery',
  'Software Development',
  'Design Agency'
];

/**
 * Safely parse JSON from LLM output, extracting code fences or JSON structures
 */
function parseJsonSafely(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch (e) {}

  // 2. Try removing markdown code blocks (```json ... ``` or ``` ...)
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {}

  // 3. Extract substring between first { and last } or first [ and last ]
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch (e) {}
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch (e) {}
  }

  return null;
}

let currentAiStatus = 'Configured';

/**
 * Extract OpenRouter API key supporting both OPENROUTER_API_KEY and GEMINI_API_KEY fallback
 */
function getOpenRouterKey() {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey && orKey.trim().length > 10) return orKey.trim();
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey.trim().startsWith('sk-or-')) return geminiKey.trim();
  return null;
}

/**
 * Call OpenRouter Chat Completions API with exponential backoff on 429
 * and automatic fallback between free tier models
 * POST https://openrouter.ai/api/v1/chat/completions
 */
async function callOpenRouter(prompt, maxTokens = 600) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    currentAiStatus = 'Unavailable';
    throw new Error('OPENROUTER_API_KEY_MISSING');
  }

  const primaryModel = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free';
  const modelCandidates = [
    primaryModel,
    'nvidia/nemotron-3.5-lightning:free',
    'google/gemma-4-26b-a4b-it:free'
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  let lastError = null;

  for (const model of modelCandidates) {
    // Retry up to 2 times on 429 with exponential backoff
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        const delay = attempt * 750;
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const payload = {
          model: model,
          messages: [
            {
              role: 'system',
              content: 'You are PayPilot\'s AI Onboarding Engine. Respond strictly with valid JSON. Do not include markdown tags, code blocks, or explanatory commentary.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3,
          max_tokens: Math.min(maxTokens, 800)
        };

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'PayPilot'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000)
        });

        if (res.status === 429) {
          currentAiStatus = 'Rate Limited';
          lastError = new Error(`OpenRouter ${model} error (429): Rate limited upstream.`);
          if (attempt < 2) continue; // retry after backoff
          break; // move to next fallback model candidate
        }

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          let safeMessage = `HTTP ${res.status}`;
          try {
            const parsedErr = JSON.parse(errorBody);
            if (parsedErr.error?.message) safeMessage = parsedErr.error.message;
          } catch (e) {
            if (errorBody && errorBody.length < 150) safeMessage = errorBody;
          }
          lastError = new Error(`OpenRouter ${model} error (${res.status}): ${safeMessage}`);
          break; // break retry loop, try next model
        }

        const data = await res.json();
        const rawText = data.choices?.[0]?.message?.content;
        if (!rawText) {
          lastError = new Error(`OpenRouter ${model} returned empty content.`);
          break;
        }

        const parsed = parseJsonSafely(rawText);
        if (!parsed) {
          lastError = new Error(`OpenRouter ${model} response could not be parsed as JSON.`);
          break;
        }

        currentAiStatus = (model === primaryModel) ? 'Connected' : 'Using Fallback';
        return { data: parsed, modelUsed: model, provider: 'openrouter' };
      } catch (err) {
        lastError = err;
        if (err.name === 'TimeoutError' || err.message?.includes('timeout')) {
          break; // try next candidate on timeout
        }
      }
    }
  }

  if (currentAiStatus !== 'Rate Limited') {
    currentAiStatus = 'Using Fallback';
  }
  throw lastError || new Error('All OpenRouter model candidates failed.');
}

/**
 * Call Gemini model with automatic fallback between 3.5-flash-lite, flash-latest, and 3.8-flash
 */
async function callGemini(prompt, maxTokens = 600) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error('GEMINI_API_KEY_MISSING');

  const models = ['gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: maxTokens
        }
      };

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Gemini ${model} error (${res.status}): ${errorText.slice(0, 100)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Empty response from ${model}`);

      const parsed = parseJsonSafely(text);
      if (!parsed) throw new Error(`Gemini ${model} output was not valid JSON`);
      return { data: parsed, modelUsed: model, provider: 'gemini' };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

/**
 * Unified AI caller respecting AI_PROVIDER
 * Gracefully falls back to null on failure so caller can run deterministic heuristics
 */
async function callConfiguredAi(prompt, maxTokens = 600) {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase().trim();

  if (provider === 'openrouter') {
    try {
      return await callOpenRouter(prompt, maxTokens);
    } catch (err) {
      console.warn(`[AI Service] OpenRouter call failed, falling back to adaptive engine: ${err.message}`);
      return null;
    }
  } else if (provider === 'gemini') {
    try {
      return await callGemini(prompt, maxTokens);
    } catch (err) {
      console.warn(`[AI Service] Gemini call failed, falling back to adaptive engine: ${err.message}`);
      return null;
    }
  }

  return null;
}

/**
 * Return current AI provider configuration status (never exposes secrets)
 */
function getAiStatus() {
  const provider = (process.env.AI_PROVIDER || 'adaptive-engine').toLowerCase().trim();
  const orKey = getOpenRouterKey();
  const orModel = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free';
  const geminiKey = process.env.GEMINI_API_KEY;

  let activeProvider = provider || 'adaptive-engine';
  let activeModel = 'Adaptive Rule Engine (Built-in)';
  let configured = false;
  let keyMasked = null;
  let status = 'Unavailable';

  if (provider === 'openrouter') {
    activeModel = orModel;
    configured = Boolean(orKey && orKey.length > 10);
    if (configured) {
      keyMasked = `${orKey.slice(0, 8)}...${orKey.slice(-4)}`;
      status = currentAiStatus || 'Configured';
    }
  } else if (provider === 'gemini') {
    activeModel = 'gemini-3.5-flash-lite / 3.8-flash';
    configured = Boolean(geminiKey && geminiKey.trim().length > 10);
    if (configured) {
      keyMasked = `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)}`;
      status = 'Configured';
    }
  }

  return {
    provider: activeProvider,
    model: activeModel,
    configured,
    status: configured ? status : 'Unavailable',
    keyMasked,
    fallbackReady: true
  };
}

/**
 * Identify Business Category
 */
async function identifyCategory(businessName, description = '') {
  const combined = `${businessName || ''} ${description || ''}`.toLowerCase();

  // Try configured AI model (OpenRouter or Gemini)
  const prompt = `You are the PayPilot AI Onboarding Agent.
Analyze this business:
Business Name: ${businessName || 'N/A'}
Description: ${description || 'N/A'}

Identify the most accurate business category.
Examples of common categories:
- Beauty & Personal Care (haircare, skincare, cosmetics, serums, soaps, perfumes, beard care)
- Bakery & Baked Goods (cakes, pastries, bread, confectioneries)
- Freelance developer (web development, mobile apps, software, full-stack, APIs)
- Design agency (brand identity, UI/UX, logos, graphics, visual assets)
- Catering & Food Service (event catering, meal prep, private dining)
- Photography & Media (commercial photography, video production, studio shoots)
- Custom Artisan / Craft (handmade ceramics, woodwork, leathercraft, jewelry)
- Consulting & Professional Services (strategy, marketing, legal, business coaching)
Or suggest a concise descriptive category.

Return strictly valid JSON:
{
  "category": "category name",
  "confidence": 0.96,
  "reasoning": "Clear 1-2 sentence explanation of why this fits the business description",
  "suggestedAlternativeCategories": ["Alternative 1", "Alternative 2", "Alternative 3"]
}`;

  const aiResult = await callConfiguredAi(prompt, 350);
  if (aiResult && aiResult.data && aiResult.data.category) {
    return {
      ...aiResult.data,
      source: `${aiResult.provider}:${aiResult.modelUsed}`,
      isLLM: true
    };
  }

  // Robust Semantic Heuristic Engine (Honest fallback for the 4 core categories)
  let identifiedCategory = 'Printing';
  let confidence = 0.90;
  let reasoning = 'Classified into core operating category based on business profile.';

  if (combined.match(/\b(print|printing|merch|merchandise|mug|mugs|tshirt|shirt|apparel|banner|sublimation|heat press|vinyl|screenprint|flyer|poster|sticker)\b/)) {
    identifiedCategory = 'Printing';
    confidence = 0.98;
    reasoning = 'Detected custom printing, merchandise production, and apparel personalization.';
  } else if (combined.match(/\b(cake|cupcake|pastry|bake|bakery|bread|icing|cookie|dessert|flour|confection|sourdough)\b/)) {
    identifiedCategory = 'Bakery';
    confidence = 0.98;
    reasoning = 'Detected artisanal baking, custom cake orders, and bakery production.';
  } else if (combined.match(/\b(developer|code|software|web|app|frontend|backend|api|fullstack|react|node|saas|programming|dev)\b/)) {
    identifiedCategory = 'Freelance developer';
    confidence = 0.97;
    reasoning = 'Detected software engineering, web application development, and tech services.';
  } else if (combined.match(/\b(design|brand|logo|creative|ui|ux|graphic|identity|typography|figma|illustration)\b/)) {
    identifiedCategory = 'Design agency';
    confidence = 0.96;
    reasoning = 'Detected branding, creative direction, graphic design, and UI/UX design.';
  }

  const suggestedAlternativeCategories = ['Printing', 'Bakery', 'Software Development', 'Design Agency']
    .filter(c => c.toLowerCase() !== identifiedCategory.toLowerCase())
    .slice(0, 3);

  return {
    category: identifiedCategory,
    confidence,
    reasoning,
    suggestedAlternativeCategories,
    source: 'paypilot-adaptive-engine',
    isLLM: false
  };
}

/**
 * Generate Next Single Question (Conversational, Adaptive)
 * Evaluates business context + full history of previous answers
 */
async function generateNextQuestion({ businessName, description, category, questionIndex, history = [] }) {
  // Try configured AI model (OpenRouter or Gemini)
  const historySummary = history.map((h, i) => 
    `Q${i+1} (${h.type}): "${h.question}" -> Answer: "${Array.isArray(h.answer) ? h.answer.join(', ') : h.answer}"${h.customText ? ` (Custom Note: ${h.customText})` : ''}`
  ).join('\n');

  // Category-specific topic areas to prevent cross-contamination of questions
  const CATEGORY_TOPICS = {
    'Printing': 'custom printing equipment (sublimation, DTF, UV), blank merchandise inventory, production turnaround, apparel & drinkware fulfillment, shipping and dispatch',
    'Bakery': 'baking specialties (cakes, pastries, bread), kitchen capacity, delivery logistics, allergen management, advance order booking, perishable supply chain',
    'Software Development': 'software project types (web apps, APIs, mobile), tech stack, QA and testing workflow, client approval gates, sprint cadence, billing milestones',
    'Design Agency': 'creative services (branding, UI/UX, illustration, social media), design toolchain (Figma/Adobe), revision cycles, client feedback, file delivery, retainer billing'
  };
  const catTopics = CATEGORY_TOPICS[category] || CATEGORY_TOPICS['Printing'];

  const prompt = `You are PayPilot's AI Onboarding Agent.
Your goal is to learn how this specific business operates in order to configure a custom operating workspace (milestones, modules, capacity, fulfillment, approvals).

Business Name: ${businessName || 'Business'}
BUSINESS CATEGORY: ${category}
IMPORTANT: You MUST only ask questions relevant to a ${category} business. Do NOT ask about other business types.
Relevant topic areas for ${category}: ${catTopics}
Original Description: ${description}

Current Question Index: ${questionIndex} (Goal: 6 to 7 total focused questions)
Answers collected so far:
${historySummary || 'No previous questions answered yet.'}

Decide what critical piece of information is still needed to set up their ${category} workflow.
Choose the most appropriate question type from:
- "mcq" (single choice where only one option applies)
- "msq" (multi-select where multiple options can be chosen, e.g. "Select all that apply")
- "descriptive" (open written text field when detailed specifics or custom formulas/processes are needed)

Rules:
1. Use clear, friendly, non-technical English.
2. Directly adapt your question based on their previous answers.
3. For "mcq" and "msq", provide 4 to 5 realistic choices specific to ${category}, plus "allowsCustomInput": true.
4. NEVER ask a ${category} business about topics from other categories (e.g. do NOT ask a Design Agency about printing equipment, do NOT ask a Bakery about software stacks).
5. If questionIndex >= 6, set "isComplete": true if sufficient info is gathered.

Return strictly valid JSON:
{
  "questionId": "q_${questionIndex + 1}_${Date.now()}",
  "question": "Question text specific to ${category}",
  "helpText": "Short 1-sentence guidance on how this impacts their PayPilot workspace",
  "type": "mcq" | "msq" | "descriptive",
  "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
  "allowsCustomInput": true,
  "categoryTag": "Category Tag relevant to ${category}",
  "isComplete": false
}`;

  let aiResult = null;
  try {
    const aiPromise = callConfiguredAi(prompt, 450);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2500));
    aiResult = await Promise.race([aiPromise, timeoutPromise]);
  } catch(e) {
    aiResult = null;
  }
  if (aiResult && aiResult.data && aiResult.data.question) {
    // Validate the question is relevant to the category to prevent cross-contamination
    const q = aiResult.data;
    const catNorm = category.toLowerCase();
    const wrongCatTerms = {
      'Printing': ['software', 'web app', 'figma', 'adobe', 'baking', 'cake', 'sourdough', 'figma'],
      'Bakery': ['printing', 'heat press', 'sublimation', 'software stack', 'api', 'figma', 'adobe'],
      'Software Development': ['heat press', 'sublimation', 'baking', 'oven', 'cake', 'printer ink'],
      'Design Agency': ['heat press', 'sublimation', 'baking', 'oven', 'cake', 'code', 'api endpoint']
    };
    const badTerms = wrongCatTerms[category] || [];
    const qText = (q.question + ' ' + (q.options || []).join(' ')).toLowerCase();
    const hasWrongContent = badTerms.some(t => qText.includes(t));
    if (!hasWrongContent) {
      return {
        ...q,
        questionIndex,
        source: `${aiResult.provider}:${aiResult.modelUsed}`,
        isLLM: true
      };
    }
    // LLM returned off-category content — fall through to the adaptive bank
    console.warn(`[AI Onboarding] LLM returned off-category question for "${category}", using fallback bank.`);
  }

  // Fallback Category-Adaptive Sequence (Adapting to step & previous answers)
  const fallbackQ = getAdaptiveQuestionFromBank(category, description, questionIndex, history);
  return {
    ...fallbackQ,
    questionIndex,
    source: 'paypilot-adaptive-engine',
    isLLM: false
  };
}

/**
 * High-Quality Adaptive Question Bank with Multi-Type Support
 */
function getAdaptiveQuestionFromBank(category, description = '', step = 0, history = []) {
  const normCat = (category || '').toLowerCase();

  // 1. Printing & Custom Merchandise
  if (normCat.includes('print') || normCat.includes('merch') || normCat.includes('apparel') || normCat.includes('mug') || normCat.includes('sign')) {
    const printingQuestions = [
      {
        questionId: 'print_products',
        question: 'What types of custom merchandise and printing do you produce?',
        helpText: 'Select all products you handle to configure your production milestones.',
        type: 'msq',
        options: [
          'Ceramic mugs, tumblers & drinkware (sublimation)',
          'Custom apparel (t-shirts, hoodies, embroidered caps)',
          'Vinyl banners, large-format posters & signage',
          'Promotional gifts, tote bags & corporate swag packs',
          'Paper print (stickers, labels, business cards, flyers)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Product Catalog'
      },
      {
        questionId: 'print_production_equipment',
        question: 'What is your primary production equipment setup?',
        helpText: 'Calibrates machine availability and setup calibration stages.',
        type: 'mcq',
        options: [
          'Dye-sublimation heat presses (mugs, tumblers, small gifts)',
          'Direct-to-Film (DTF) & Screen Printing stations (garments)',
          'Large-format UV flatbed or eco-solvent roll printers',
          'Commercial digital laser presses & vinyl plotters'
        ],
        allowsCustomInput: true,
        categoryTag: 'Equipment & Methods'
      },
      {
        questionId: 'print_team_size',
        question: 'What is your operational team setup?',
        helpText: 'Establishes staff availability and shift scheduling.',
        type: 'mcq',
        options: [
          'Solo print specialist (1 person shop)',
          'Small studio crew (2 to 3 operators & pre-press designer)',
          'Mid-sized production facility (4 to 8 staff members)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Team Size'
      },
      {
        questionId: 'print_turnaround',
        question: 'What is your typical production turnaround for custom orders?',
        helpText: 'Configures project deadline buffer timers and overdue risk detection.',
        type: 'mcq',
        options: [
          '24 to 48 hours rapid express turnaround',
          '3 to 5 business days standard batch production',
          '1 to 2 weeks for bulk quantities & specialty orders',
          'Scheduled delivery dates for recurring corporate batches'
        ],
        allowsCustomInput: true,
        categoryTag: 'Turnaround Times'
      },
      {
        questionId: 'print_capacity',
        question: 'How many active print jobs can your equipment handle simultaneously?',
        helpText: 'Sets your concurrent project capacity limit in the Workload calendar.',
        type: 'mcq',
        options: [
          '2 to 3 active orders concurrently',
          '4 to 6 simultaneous print jobs (Recommended)',
          '7 to 12 parallel production runs',
          '15+ high-volume commercial runs'
        ],
        allowsCustomInput: true,
        categoryTag: 'Production Capacity'
      },
      {
        questionId: 'print_supplies',
        question: 'Which raw materials do you regularly restock from suppliers?',
        helpText: 'Enables Resource Intelligence to predict inventory shortage delays.',
        type: 'msq',
        options: [
          'Blank ceramic sublimation mugs & drinkware (3–5 day lead time)',
          'Apparel blanks (cotton t-shirts, hoodies, caps) (2–4 day lead time)',
          'Sublimation & UV ink sets, transfer paper & PET films (1–2 days)',
          'Protective foam shipping boxes & custom packaging (1–3 days)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Resource Inventory'
      },
      {
        questionId: 'print_payment_terms',
        question: 'How do you collect customer payments with PayPal?',
        helpText: 'Sets up PayPal Sandbox checkout and invoicing triggers.',
        type: 'mcq',
        options: [
          '100% upfront payment upon order approval before production begins',
          '50% deposit to procure blank materials, 50% upon dispatch',
          'Corporate invoice (Net 15 / Net 30)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Payment Terms'
      }
    ];

    const q = printingQuestions[Math.min(step, printingQuestions.length - 1)];
    return { ...q, isComplete: step >= printingQuestions.length - 1 };
  }

  // 2. Bakery & Food Craft
  if (normCat.includes('baker') || normCat.includes('food') || normCat.includes('pastr') || normCat.includes('cake')) {
    const bakeryQuestions = [
      {
        questionId: 'bake_specialty',
        question: 'What types of baked orders do you primarily produce?',
        helpText: 'Select all specialties that apply to your kitchen.',
        type: 'msq',
        options: [
          'Custom event & celebration cakes (fondant, tiered, wedding)',
          'Artisanal breads & daily sourdough loaves',
          'Pastries, cookies & dessert treat boxes',
          'Wholesale supply for local cafes and restaurants',
          'Allergen-free (Gluten-free, vegan, nut-safe)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Kitchen Specialty'
      },
      {
        questionId: 'bake_lead_time',
        question: 'What is your required minimum advance notice for custom orders?',
        helpText: 'Configures intake rules and deadline buffer warnings.',
        type: 'mcq',
        options: [
          '24 to 48 hours notice',
          '3 to 5 business days',
          '1 to 2 weeks advance booking',
          '1+ month for wedding / centerpiece orders'
        ],
        allowsCustomInput: true,
        categoryTag: 'Lead Times'
      },
      {
        questionId: 'bake_team_size',
        question: 'What is your operational kitchen staff setup?',
        helpText: 'Establishes staff availability and baker shift scheduling.',
        type: 'mcq',
        options: [
          'Solo pastry artisan / head baker (1 person)',
          'Small kitchen crew (2 to 3 bakers & decorators)',
          'Full bakery team (4 to 6 kitchen staff)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Kitchen Staff'
      },
      {
        questionId: 'bake_delivery_mode',
        question: 'How do customers receive their completed orders?',
        helpText: 'Configures the final fulfillment phase in your workspace.',
        type: 'mcq',
        options: [
          'Customer pickup at bakery / kitchen studio only',
          'Direct hand-delivery by our kitchen staff',
          'Third-party courier / on-demand driver',
          'Temperature-controlled shipping'
        ],
        allowsCustomInput: true,
        categoryTag: 'Logistics'
      },
      {
        questionId: 'bake_capacity',
        question: 'How many custom orders can you comfortably handle per weekend?',
        helpText: 'Prevents kitchen overbooking in your weekly Workload schedule.',
        type: 'mcq',
        options: [
          '1 to 3 high-detail centerpiece cakes',
          '4 to 8 medium custom cakes or boxes',
          '9 to 20 volume orders',
          '20+ volume batch orders'
        ],
        allowsCustomInput: true,
        categoryTag: 'Kitchen Capacity'
      },
      {
        questionId: 'bake_payments',
        question: 'How do you collect payments using PayPal?',
        helpText: 'Sets up PayPal Sandbox order creation triggers.',
        type: 'mcq',
        options: [
          '50% deposit via PayPal to book slot, 50% upon pickup/delivery',
          '100% full payment upfront before baking starts',
          'Reservation deposit, balance on delivery'
        ],
        allowsCustomInput: true,
        categoryTag: 'Payment Terms'
      }
    ];

    const q = bakeryQuestions[Math.min(step, bakeryQuestions.length - 1)];
    return { ...q, isComplete: step >= bakeryQuestions.length - 1 };
  }

  // 3. Freelance Developer & Software
  if (normCat.includes('dev') || normCat.includes('software') || normCat.includes('tech') || normCat.includes('web')) {
    const devQuestions = [
      {
        questionId: 'dev_project_types',
        question: 'What kind of software projects do you primarily deliver?',
        helpText: 'Select all project domains you handle.',
        type: 'msq',
        options: [
          'Full-stack custom web applications (React, Node, PostgreSQL, Next.js)',
          'High-converting marketing sites & landing pages',
          'E-commerce platforms & payment gateway integrations',
          'Mobile apps (React Native, Flutter, iOS/Android)',
          'APIs, automation scripts, and backend cloud systems'
        ],
        allowsCustomInput: true,
        categoryTag: 'Project Types'
      },
      {
        questionId: 'dev_team_size',
        question: 'What is your developer team setup?',
        helpText: 'Tracks developer capacity and hour allocation.',
        type: 'mcq',
        options: [
          'Solo freelance full-stack engineer (1 person)',
          'Dev partnership (2 to 3 engineers & UI designer)',
          'Agile product team (4 to 8 developers)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Team Capacity'
      },
      {
        questionId: 'dev_approvals',
        question: 'What approval checkpoints do you require from clients before coding?',
        helpText: 'Establishes client governance gates before dev phases.',
        type: 'mcq',
        options: [
          'Sign-off on written Scope of Work & wireframe mockups',
          'Weekly sprint reviews and staging demonstrations',
          'Final user acceptance testing (UAT) before live release',
          'Flexible agile iteration without formal gates'
        ],
        allowsCustomInput: true,
        categoryTag: 'Client Governance'
      },
      {
        questionId: 'dev_qa_process',
        question: 'What quality assurance and testing steps are included in your workflow?',
        helpText: 'Configures dedicated QA milestones.',
        type: 'msq',
        options: [
          'Automated unit & integration tests',
          'Manual cross-browser and mobile responsiveness audits',
          'End-to-end automated testing (Playwright / Cypress)',
          'Lighthouse performance and security audits'
        ],
        allowsCustomInput: true,
        categoryTag: 'QA & Testing'
      },
      {
        questionId: 'dev_concurrency',
        question: 'How many active client projects can you manage simultaneously?',
        helpText: 'Sets workload threshold warnings.',
        type: 'mcq',
        options: [
          '1 dedicated project at a time (deep focus)',
          '2 to 3 concurrent client projects',
          '4 to 6 concurrent retainer tasks',
          'Agency team managing multiple parallel pipelines'
        ],
        allowsCustomInput: true,
        categoryTag: 'Concurrency'
      },
      {
        questionId: 'dev_billing',
        question: 'How do you structure client payments via PayPal?',
        helpText: 'Links milestone payments to PayPal Sandbox invoices.',
        type: 'mcq',
        options: [
          '33% upfront, 33% on staging completion, 34% on final deployment',
          '50% deposit upfront, 50% upon code handover',
          'Monthly retainer billing via PayPal',
          'Hourly invoices billed bi-weekly'
        ],
        allowsCustomInput: true,
        categoryTag: 'Milestone Payments'
      }
    ];

    const q = devQuestions[Math.min(step, devQuestions.length - 1)];
    return { ...q, isComplete: step >= devQuestions.length - 1 };
  }

  // 4. Design Agency & Creative Studio
  if (normCat.includes('design') || normCat.includes('creative') || normCat.includes('brand') || normCat.includes('graphic') || normCat.includes('ui') || normCat.includes('ux')) {
    const designQuestions = [
      {
        questionId: 'design_services',
        question: 'What creative services does your agency primarily offer?',
        helpText: 'Select all design disciplines you deliver.',
        type: 'msq',
        options: [
          'Brand identity systems (logos, color palettes, typography, guidelines)',
          'UI/UX product design, mobile app wireframes & Figma prototypes',
          'Print collateral, packaging & merchandise layouts',
          'Marketing visuals, social media templates & advertising assets'
        ],
        allowsCustomInput: true,
        categoryTag: 'Design Services'
      },
      {
        questionId: 'design_toolchain',
        question: 'What is your primary creative toolchain?',
        helpText: 'Calibrates asset export and master package milestones.',
        type: 'mcq',
        options: [
          'Figma vector component systems & live interactive prototypes',
          'Adobe Creative Cloud (Illustrator vector art, Photoshop, InDesign)',
          'Hybrid studio suite (Figma + Adobe CC + 3D rendering)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Creative Tools'
      },
      {
        questionId: 'design_team_size',
        question: 'What is your studio creative team size?',
        helpText: 'Determines designer availability and workload limits.',
        type: 'mcq',
        options: [
          'Solo brand / UI designer (1 person)',
          'Creative duo (Art Director + Visual Designer)',
          'Design agency team (3 to 6 designers & strategists)'
        ],
        allowsCustomInput: true,
        categoryTag: 'Creative Team'
      },
      {
        questionId: 'design_turnaround',
        question: 'What is your typical delivery timeline for design packages?',
        helpText: 'Sets baseline milestone buffer and overdue timers.',
        type: 'mcq',
        options: [
          '3 to 7 business days for focused sprint assets',
          '2 to 4 weeks for complete brand identity systems',
          '4 to 8 weeks for comprehensive digital UI/UX projects'
        ],
        allowsCustomInput: true,
        categoryTag: 'Design Timelines'
      },
      {
        questionId: 'design_capacity',
        question: 'How many active client design projects do you handle concurrently?',
        helpText: 'Sets concurrent project limit on your Workload calendar.',
        type: 'mcq',
        options: [
          '1 to 2 deep-focus branding projects',
          '3 to 5 simultaneous active client projects (Recommended)',
          '6 to 10 parallel design retainers'
        ],
        allowsCustomInput: true,
        categoryTag: 'Studio Capacity'
      },
      {
        questionId: 'design_revisions',
        question: 'How are client feedback and revision rounds structured?',
        helpText: 'Informs ML model regarding revision cycle buffers.',
        type: 'mcq',
        options: [
          '2 rounds of structured consolidated client revisions included',
          '3 rounds of iterative revisions with formal client sign-off',
          'Unlimited agile revisions within active project timeline'
        ],
        allowsCustomInput: true,
        categoryTag: 'Client Revisions'
      },
      {
        questionId: 'design_payments',
        question: 'What payment terms do you require with PayPal?',
        helpText: 'Sets up PayPal Sandbox invoice triggers.',
        type: 'mcq',
        options: [
          '50% deposit upfront, 50% upon delivery of master vector files',
          '100% payment upfront before creative kickoff',
          'Monthly retainer billing via PayPal'
        ],
        allowsCustomInput: true,
        categoryTag: 'PayPal Invoicing'
      }
    ];

    const q = designQuestions[Math.min(step, designQuestions.length - 1)];
    return { ...q, isComplete: step >= designQuestions.length - 1 };
  }

  // Fallback Generic Questions
  const genericQuestions = [
    {
      questionId: 'gen_offerings',
      question: 'What are the main products or services your business provides?',
      helpText: 'Select all offering models that apply.',
      type: 'msq',
      options: [
        'Custom bespoke orders created per client requirements',
        'Standard catalog products or fixed packages',
        'Time-based consulting, advisory, or hourly services',
        'Ongoing monthly retainer or maintenance contracts',
        'Scheduled on-location bookings and sessions'
      ],
      allowsCustomInput: true,
      categoryTag: 'Core Offering'
    },
    {
      questionId: 'gen_workflow_notes',
      question: 'Describe your typical work process from initial client contact to delivery:',
      helpText: 'Used by the AI to map realistic stages in your milestone workflow.',
      type: 'descriptive',
      options: [],
      allowsCustomInput: false,
      categoryTag: 'Process Details'
    },
    {
      questionId: 'gen_delivery_window',
      question: 'What is your typical project completion turnaround?',
      helpText: 'Configures deadline scheduling and reminder buffers.',
      type: 'mcq',
      options: [
        'Rapid turnarounds (24 to 48 hours)',
        '3 to 7 business days',
        '2 to 4 weeks',
        'Multi-month phased execution'
      ],
      allowsCustomInput: true,
      categoryTag: 'Turnaround'
    },
    {
      questionId: 'gen_risk_factors',
      question: 'What external dependencies most commonly risk delaying your work?',
      helpText: 'Directly informs the Adaptive Recovery Centre risk monitor.',
      type: 'msq',
      options: [
        'Delays in client feedback, content, or approval sign-offs',
        'Supplier or vendor delays in raw materials / parts',
        'Third-party software, cloud APIs, or courier delivery issues',
        'Staff availability or unexpected capacity crunches'
      ],
      allowsCustomInput: true,
      categoryTag: 'Risk Dependencies'
    },
    {
      questionId: 'gen_capacity',
      question: 'What is your maximum concurrent workload capacity?',
      helpText: 'Sets threshold warnings on your Workload calendar.',
      type: 'mcq',
      options: [
        '1 to 3 active clients (solo deep focus)',
        '4 to 8 concurrent active jobs',
        '9 to 15 active orders',
        '15+ high volume concurrent tasks'
      ],
      allowsCustomInput: true,
      categoryTag: 'Capacity'
    },
    {
      questionId: 'gen_paypal',
      question: 'How do you collect payments using PayPal?',
      helpText: 'Configures PayPal Sandbox invoices and payment triggers.',
      type: 'mcq',
      options: [
        '50% deposit upfront, 50% upon final delivery',
        '100% payment upfront before work commences',
        'Multi-stage milestone payments tied to deliverable sign-offs',
        'Net 15 / Net 30 day business invoicing'
      ],
      allowsCustomInput: true,
      categoryTag: 'PayPal Invoicing'
    }
  ];

  const q = genericQuestions[Math.min(step, genericQuestions.length - 1)];
  return { ...q, isComplete: step >= genericQuestions.length - 1 };
}

/**
 * Accurately extract concurrent capacity threshold from user's onboarding answers
 * Supports ranges (e.g. "1 to 3 active clients" -> 3, "2 to 3 concurrent client projects" -> 3)
 * or explicit integers / custom text. Default fallback: 5.
 */
function extractCapacityFromAnswers(answers) {
  if (!answers) return 5;

  const entries = Array.isArray(answers)
    ? answers
    : Object.entries(answers).map(([k, v]) => ({ questionId: k, answer: v }));

  for (const entry of entries) {
    const qid = (entry.questionId || entry.id || '').toLowerCase();
    const ansText = typeof entry.answer === 'string'
      ? entry.answer
      : (Array.isArray(entry.answer) ? entry.answer.join(' ') : JSON.stringify(entry.answer || ''));
    const combined = `${qid} ${ansText} ${entry.customText || ''}`.toLowerCase();

    // Check if this answer was about capacity / workload / volume
    if (
      qid.includes('capacity') ||
      qid.includes('volume') ||
      combined.includes('concurrent') ||
      combined.includes('active client') ||
      combined.includes('active job') ||
      combined.includes('active order') ||
      combined.includes('batches / week') ||
      combined.includes('orders / week')
    ) {
      // 1. If user typed custom input (e.g. "3" or "3 clients")
      if (entry.customText && entry.customText.trim()) {
        const customMatch = entry.customText.match(/\b(\d+)\b/);
        if (customMatch) {
          const num = parseInt(customMatch[1], 10);
          if (num > 0) return num;
        }
      }

      // 2. Look for range: e.g. "1 to 3", "2 to 3", "4 to 8", "9 to 15"
      const rangeMatch = ansText.match(/(\d+)\s*(?:to|-)\s*(\d+)/i);
      if (rangeMatch) {
        return parseInt(rangeMatch[2], 10);
      }

      // 3. Single number: e.g. "3", "5", "15+"
      const numMatch = ansText.match(/\b(\d+)\b/);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        if (num > 0) return num;
      }
    }
  }

  return 5;
}

/**
 * Generate Complete Tailored Business Workspace
 */
async function generateWorkspaceConfig(businessName, category, description = '', answers = {}) {
  const normCat = (category || '').toLowerCase();
  const determinedCapacity = extractCapacityFromAnswers(answers);

  // Try configured AI model (OpenRouter or Gemini)
  const answersText = Object.entries(answers).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const prompt = `You are PayPilot's Adaptive Workspace Architect.
Generate a tailored business operating workspace for:
Business Name: ${businessName}
Category: ${category}
Description: ${description}
Onboarding Q&A Profile:
${answersText}

Requirements:
1. Generate exactly 6 realistic, sequential milestones reflecting the real-world operational phases of THIS specific business.
   - For Beauty/Haircare: e.g. Formulation Planning -> Ingredient Sourcing -> Batch Production -> Safety/Viscosity QA -> Packaging & Bottling -> Order Fulfillment.
   - For Bakery: e.g. Recipe & Design Review -> Ingredient Sourcing -> Baking & Cooling -> Decorating & Finishing -> Quality & Chill Check -> Customer Pickup/Delivery.
   - For Developer: e.g. Architecture Spec -> UI/UX Wireframe Approval -> Core Development -> Testing & QA -> Staging UAT -> Production Launch.
   - Customize milestone titles and descriptions specifically for their product/service.
2. Recommend appropriate workspace modules.
3. Determine sensible capacity limit (configured: ${determinedCapacity}).

Return strictly valid JSON:
{
  "category": "${category}",
  "services": ["Service 1", "Service 2", "Service 3"],
  "recommendedModules": ["requests", "projects", "workload", "recovery", "finance"],
  "milestoneTemplate": [
    { "order": 1, "title": "Milestone 1 Title", "description": "Short 1-sentence description" },
    { "order": 2, "title": "Milestone 2 Title", "description": "Short 1-sentence description" },
    { "order": 3, "title": "Milestone 3 Title", "description": "Short 1-sentence description" },
    { "order": 4, "title": "Milestone 4 Title", "description": "Short 1-sentence description" },
    { "order": 5, "title": "Milestone 5 Title", "description": "Short 1-sentence description" },
    { "order": 6, "title": "Milestone 6 Title", "description": "Short 1-sentence description" }
  ],
  "initialCapacity": ${determinedCapacity},
  "workflowRules": {
    "approvalRequired": true,
    "qualityCheckStep": 4
  }
}`;

  const aiResult = await callConfiguredAi(prompt, 650);
  if (aiResult && aiResult.data && aiResult.data.milestoneTemplate && aiResult.data.milestoneTemplate.length >= 4) {
    return {
      ...aiResult.data,
      initialCapacity: determinedCapacity || aiResult.data.initialCapacity || 5,
      businessName,
      category,
      source: `${aiResult.provider}:${aiResult.modelUsed}`,
      isLLM: true,
      generatedAt: new Date().toISOString()
    };
  }

  // Reliable Category-Tailored Fallback
  let milestones = [];
  let services = ['Core Services'];

  if (normCat.includes('print') || normCat.includes('merch') || normCat.includes('apparel') || normCat.includes('mug') || normCat.includes('sign')) {
    services = ['Custom Merchandise', 'Sublimation Mugs & Drinkware', 'Apparel & Banners'];
    milestones = [
      { order: 1, title: 'Artwork & Vector Pre-flight Review', description: 'Confirm print resolution, vector outlines, CMYK color balance, and bleed margins.' },
      { order: 2, title: 'Blank Stock & Consumables Allocation', description: 'Verify inventory for blank substrate stock (mugs/garments) and sublimation inks.' },
      { order: 3, title: 'Sample Proof & Machine Calibration', description: 'Produce first proof sample and calibrate transfer heat & press pressure.' },
      { order: 4, title: 'Batch Production & Heat Transfer', description: 'Run complete print batch with automated continuous temperature curing.' },
      { order: 5, title: 'Quality Inspection & Curing Audit', description: 'Inspect print clarity, adhesion durability, and packaging readiness.' },
      { order: 6, title: 'Protective Packaging & Dispatch', description: 'Foam-wrap merchandise and generate courier dispatch manifest.' }
    ];
  } else if (normCat.includes('baker') || normCat.includes('food') || normCat.includes('pastr') || normCat.includes('cake')) {
    services = ['Custom Cakes', 'Artisanal Breads', 'Event Desserts'];
    milestones = [
      { order: 1, title: 'Confirm Custom Recipe & Design', description: 'Review dietary restrictions, flavors, reference sketches, and client sign-off.' },
      { order: 2, title: 'Source & Inspect Fresh Ingredients', description: 'Check perishables, dairy, specialty organic flours, and packaging materials.' },
      { order: 3, title: 'Baking & Sponge Assembly', description: 'Bake bases, cool tiers, level sponges, apply crumb coat and fillings.' },
      { order: 4, title: 'Decoration & Finishing Touches', description: 'Piping, handcrafted sugar flowers, custom lettering, and final embellishment.' },
      { order: 5, title: 'Quality & Temperature Assurance', description: 'Inspect structure, verify weight, chill to safe transport temperature.' },
      { order: 6, title: 'Customer Pickup / Chilled Delivery', description: 'Coordinate customer collection or handover to climate-controlled courier.' }
    ];
  } else if (normCat.includes('dev') || normCat.includes('software') || normCat.includes('tech') || normCat.includes('web')) {
    services = ['Full-Stack Web Apps', 'API Integrations', 'Mobile Development'];
    milestones = [
      { order: 1, title: 'Requirements & Architecture Specification', description: 'Define database schema, system architecture, API contracts, and sprint scope.' },
      { order: 2, title: 'UI/UX Wireframes & Component Alignment', description: 'Confirm layouts, component hierarchy, design system, and client signoff.' },
      { order: 3, title: 'Core Frontend & Backend Implementation', description: 'Develop feature logic, state management, payment routes, and endpoints.' },
      { order: 4, title: 'Automated Testing & Security Validation', description: 'Unit testing, cross-browser compatibility, security review, and performance checks.' },
      { order: 5, title: 'Staging Deployment & Client UAT', description: 'Deploy to preview environment, collect feedback, and apply refinements.' },
      { order: 6, title: 'Production Launch & Repository Handover', description: 'DNS cutover, live environment verification, documentation, and repo transfer.' }
    ];
  } else if (normCat.includes('design') || normCat.includes('brand') || normCat.includes('creative')) {
    services = ['Brand Identity', 'UI/UX Design', 'Visual Systems'];
    milestones = [
      { order: 1, title: 'Creative Discovery & Strategic Brief', description: 'Review target demographic, visual aspirations, and competitor landscape.' },
      { order: 2, title: 'Moodboards & Concept Directions', description: 'Present 2-3 visual explorations, typography samples, and color systems.' },
      { order: 3, title: 'Initial Draft Deliverables & Prototypes', description: 'Execute comprehensive draft assets aligned with the selected concept.' },
      { order: 4, title: 'Consolidated Client Revisions', description: 'Incorporate client feedback and fine-tune vectors, layouts, and spacing.' },
      { order: 5, title: 'Final Client Signoff & Pre-Flight Check', description: 'Verify asset resolution, print bleed margins, and accessibility standards.' },
      { order: 6, title: 'Master File Package & License Delivery', description: 'Export production vector bundles, brand guidelines, and transfer usage rights.' }
    ];
  } else {
    services = ['Bespoke Services', 'Custom Client Orders'];
    milestones = [
      { order: 1, title: 'Scope Definition & Client Consultation', description: 'Confirm specific client expectations, requirements, and milestones.' },
      { order: 2, title: 'Resource & Material Procurement', description: 'Source required tools, dependencies, components, or initial research.' },
      { order: 3, title: 'Primary Production & Execution', description: 'Execute core deliverable according to confirmed specifications.' },
      { order: 4, title: 'Quality Assurance & Inspection', description: 'Verify deliverable against standards and client satisfaction criteria.' },
      { order: 5, title: 'Client Review & Refinement', description: 'Present draft deliverable for client review and perform final adjustments.' },
      { order: 6, title: 'Final Delivery & Completion Signoff', description: 'Handover finished order, verify customer satisfaction, and issue final receipt.' }
    ];
  }

  return {
    businessName: businessName || 'My Business',
    category,
    services,
    recommendedModules: ['requests', 'projects', 'workload', 'recovery', 'finance', 'settings'],
    milestoneTemplate: milestones,
    initialCapacity: determinedCapacity || 5,
    workflowRules: { approvalRequired: true },
    source: 'paypilot-adaptive-engine',
    isLLM: false,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  KNOWN_CATEGORIES,
  identifyCategory,
  generateNextQuestion,
  generateWorkspaceConfig,
  extractCapacityFromAnswers,
  getAiStatus,
  callConfiguredAi
};
