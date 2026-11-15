/**
 * PayPilot Catalog & Pricing Service
 * Single source of truth for realistic ~$90-$95 pricing across all 4 categories
 */

const PRODUCT_CATALOG = {
  'Printing': [
    {
      id: 'mug',
      name: 'Custom Sublimation Mugs (Box of 10)',
      desc: '11oz coated ceramic mugs with high-definition vibrant print and packaging',
      priceFrom: 90.00,
      pricePer: '10-pack',
      normalDays: 4,
      urgentDays: 2,
      unit: 'packs'
    },
    {
      id: 'tshirt',
      name: 'Screen-Printed Apparel Pack (5 pcs)',
      desc: '100% ring-spun cotton with durable DTF full-color transfer',
      priceFrom: 95.00,
      pricePer: 'pack',
      normalDays: 4,
      urgentDays: 2,
      unit: 'packs'
    },
    {
      id: 'banner',
      name: 'Heavyweight Vinyl Display Banner',
      desc: '510gsm weatherproof outdoor vinyl banner with nickel-plated eyelets',
      priceFrom: 92.00,
      pricePer: 'banner',
      normalDays: 3,
      urgentDays: 1,
      unit: 'banners'
    },
    {
      id: 'bizcard',
      name: 'Deluxe Velvet Business Cards (500 pcs)',
      desc: '350gsm silk matte cardstock with soft-touch velvet lamination',
      priceFrom: 90.00,
      pricePer: 'box',
      normalDays: 3,
      urgentDays: 1,
      unit: 'boxes'
    },
    {
      id: 'brochure',
      name: 'Full-Color Marketing Brochure Bundle',
      desc: 'A4 tri-fold premium brochures printed on 150gsm gloss stock (200 pcs)',
      priceFrom: 90.00,
      pricePer: 'bundle',
      normalDays: 3,
      urgentDays: 1,
      unit: 'bundles'
    },
    {
      id: 'custom',
      name: 'Branded Merchandise Starter Kit',
      desc: 'Custom promotional pack with branded mugs, stickers, and tote bag',
      priceFrom: 95.00,
      pricePer: 'kit',
      normalDays: 5,
      urgentDays: 2,
      unit: 'kits'
    }
  ],
  'Bakery': [
    {
      id: 'cake',
      name: 'Custom Tiered Celebration Cake',
      desc: 'Fondant sculpted birthday or event centerpiece cake made to order',
      priceFrom: 95.00,
      pricePer: 'cake',
      normalDays: 4,
      urgentDays: 2,
      unit: 'cakes'
    },
    {
      id: 'cupcakes',
      name: 'Gourmet Cupcake Selection (36 pcs)',
      desc: '3 dozen cupcakes with custom frosting swirls, sprinkles and flavors',
      priceFrom: 92.00,
      pricePer: 'box',
      normalDays: 2,
      urgentDays: 1,
      unit: 'boxes'
    },
    {
      id: 'cookies',
      name: 'Artisanal Royal Iced Cookie Platter',
      desc: 'Custom decorated shortbread cookies with royal icing artwork (30 pcs)',
      priceFrom: 90.00,
      pricePer: 'platter',
      normalDays: 3,
      urgentDays: 1,
      unit: 'platters'
    },
    {
      id: 'bread',
      name: 'Organic Sourdough & Loaf Hamper',
      desc: 'Naturally fermented stone-baked sourdough loaves & specialty pastries',
      priceFrom: 90.00,
      pricePer: 'hamper',
      normalDays: 1,
      urgentDays: 1,
      unit: 'hampers'
    },
    {
      id: 'pastries',
      name: 'French Butter Croissant & Pastry Box',
      desc: 'Artisanal morning French croissants, pain au chocolat & danish box (24 pcs)',
      priceFrom: 90.00,
      pricePer: 'box',
      normalDays: 1,
      urgentDays: 1,
      unit: 'boxes'
    },
    {
      id: 'dessert',
      name: 'Luxury Event Dessert Selection',
      desc: 'Assorted handcrafted mini tarts, eclairs and French macarons package',
      priceFrom: 95.00,
      pricePer: 'package',
      normalDays: 3,
      urgentDays: 1,
      unit: 'packages'
    }
  ],
  'Software Development': [
    {
      id: 'website',
      name: 'Custom Landing Page & Form Setup',
      desc: 'High-converting responsive landing page with contact form & analytics',
      priceFrom: 95.00,
      pricePer: 'module',
      normalDays: 5,
      urgentDays: 2,
      unit: 'modules'
    },
    {
      id: 'api',
      name: 'API Integration & Cloud Webhook Sprint',
      desc: 'REST API endpoint integration, webhook handling, and secure data sync',
      priceFrom: 92.00,
      pricePer: 'task',
      normalDays: 4,
      urgentDays: 2,
      unit: 'tasks'
    },
    {
      id: 'app',
      name: 'Database Schema & Admin View Module',
      desc: 'CRUD interface, SQL schema setup, and authenticated admin table view',
      priceFrom: 95.00,
      pricePer: 'sprint',
      normalDays: 6,
      urgentDays: 3,
      unit: 'sprints'
    },
    {
      id: 'maint',
      name: 'Monthly Code QA & Security Audit',
      desc: 'Dependency vulnerability scan, performance profiling, and test fixes',
      priceFrom: 90.00,
      pricePer: 'audit',
      normalDays: 3,
      urgentDays: 1,
      unit: 'audits'
    },
    {
      id: 'custom_dev',
      name: 'Business Automation Script Setup',
      desc: 'Automated data processing, recurring cron jobs, or notification bot',
      priceFrom: 92.00,
      pricePer: 'script',
      normalDays: 5,
      urgentDays: 2,
      unit: 'scripts'
    },
    {
      id: 'mobile',
      name: 'Mobile App Bug Fix & Optimization',
      desc: 'Cross-platform UI bug fix, responsive layout adjustment & store readiness',
      priceFrom: 95.00,
      pricePer: 'task',
      normalDays: 4,
      urgentDays: 2,
      unit: 'tasks'
    }
  ],
  'Design Agency': [
    {
      id: 'logo',
      name: 'Brand Logo & Vector Identity Suite',
      desc: 'Primary logo, alternate marks, vector exports (SVG/EPS), and color palette',
      priceFrom: 95.00,
      pricePer: 'suite',
      normalDays: 5,
      urgentDays: 2,
      unit: 'suites'
    },
    {
      id: 'brand_kit',
      name: 'Complete Brand Style Guide & Assets',
      desc: 'Typography system, digital asset guidelines, brand colors, and iconography',
      priceFrom: 95.00,
      pricePer: 'kit',
      normalDays: 5,
      urgentDays: 2,
      unit: 'kits'
    },
    {
      id: 'social',
      name: 'Social Media Content Pack (8 assets)',
      desc: 'Bespoke Instagram, LinkedIn & Twitter promotional banner templates',
      priceFrom: 90.00,
      pricePer: 'pack',
      normalDays: 3,
      urgentDays: 1,
      unit: 'packs'
    },
    {
      id: 'poster',
      name: 'Marketing Poster & Print Collateral',
      desc: 'Print-ready high-resolution promotional marketing posters and flyers',
      priceFrom: 92.00,
      pricePer: 'set',
      normalDays: 3,
      urgentDays: 1,
      unit: 'sets'
    },
    {
      id: 'ui',
      name: 'UI/UX Mobile Flow Prototype (Figma)',
      desc: '3-to-5 screen clickable Figma prototype flow with component library',
      priceFrom: 95.00,
      pricePer: 'flow',
      normalDays: 5,
      urgentDays: 2,
      unit: 'flows'
    },
    {
      id: 'custom_des',
      name: 'Digital Illustration & Graphic Asset',
      desc: 'Custom vector artwork, blog cover illustrations, or website hero graphic',
      priceFrom: 90.00,
      pricePer: 'design',
      normalDays: 4,
      urgentDays: 2,
      unit: 'designs'
    }
  ]
};

function normalizeCategory(category) {
  if (!category) return 'Printing';
  const c = category.toLowerCase();
  if (c.includes('print') || c.includes('merch') || c.includes('apparel')) return 'Printing';
  if (c.includes('bake') || c.includes('pastr') || c.includes('cake') || c.includes('food')) return 'Bakery';
  if (c.includes('dev') || c.includes('software') || c.includes('tech') || c.includes('code')) return 'Software Development';
  if (c.includes('design') || c.includes('brand') || c.includes('creative') || c.includes('graphic')) return 'Design Agency';
  return 'Printing';
}

function getCatalog() {
  return PRODUCT_CATALOG;
}

function getProductsForCategory(category) {
  const norm = normalizeCategory(category);
  return PRODUCT_CATALOG[norm] || PRODUCT_CATALOG['Printing'];
}

function findProduct(category, productId) {
  const products = getProductsForCategory(category);
  return products.find(p => p.id === productId) || null;
}

function calculatePrice(product, quantity = 1, isUrgent = false) {
  if (!product) return 90.00;
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  let total = product.priceFrom * qty;
  if (isUrgent) total *= 1.2; // 20% express turnaround
  return Math.round(total * 100) / 100;
}

module.exports = {
  PRODUCT_CATALOG,
  normalizeCategory,
  getCatalog,
  getProductsForCategory,
  findProduct,
  calculatePrice
};
