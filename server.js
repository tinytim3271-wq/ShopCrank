import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure bundle exists before starting
const appJsPath = join(__dirname, 'app.js');
if (!existsSync(appJsPath)) {
  console.log('Building web bundle...');
  try {
    execSync('npm run build:web', { stdio: 'inherit', cwd: __dirname });
  } catch (error) {
    console.error('Initial build failed', error);
  }
}

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// In-memory store for entities
const entitiesStore = new Map();

function getEntitiesList(type) {
  if (!entitiesStore.has(type)) {
    entitiesStore.set(type, new Map());
  }
  return entitiesStore.get(type);
}

// Coverage bundle loader
let coverageBundle = null;
try {
  const coveragePath = join(__dirname, 'worker/data/coverage.json');
  if (existsSync(coveragePath)) {
    coverageBundle = JSON.parse(readFileSync(coveragePath, 'utf8'));
  } else {
    const seedPath = join(__dirname, 'diagnostics/coverage/seed/dodge-ram-coverage.json');
    if (existsSync(seedPath)) {
      coverageBundle = JSON.parse(readFileSync(seedPath, 'utf8'));
    }
  }
} catch {
  coverageBundle = { coverageVersion: '2026.08.31.1', records: [] };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Auth Session endpoint: return active admin session for seamless local preview
app.get('/api/auth/session', (req, res) => {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  res.json({
    claims: {
      sub: 'user_local_owner',
      email: 'lee@yourcarguy806.com',
      name: 'Lee (Your Car Guy)',
      'custom:shopId': 'shop_yourcarguy',
      'custom:role': 'admin',
      exp: Math.floor(expiresAt / 1000),
    },
    expiresAt,
  });
});

app.post('/api/auth/magic-link', (req, res) => {
  res.json({
    ok: true,
    message: 'One-time sign-in link ready.',
    url: '/app',
    loginUrl: '/app',
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// Founding member status & validation
app.get('/api/founding/status', (req, res) => {
  res.json({ claimed: 14, cap: 50, valid: true });
});

app.get('/api/founding/validate', (req, res) => {
  res.json({ valid: true, claimed: 14, cap: 50, planId: 'founding_shop' });
});

app.post('/api/founding/claim', (req, res) => {
  res.json({ ok: true, claimed: true });
});

// Diagnostics coverage and authorization
app.get('/api/diagnostics/coverage', (req, res) => {
  res.json(coverageBundle || { coverageVersion: '2026.08.31.1', records: [] });
});

app.post('/api/diagnostics/authorize', (req, res) => {
  res.json({
    authorized: true,
    token: 'simulated_capability_token_active',
    mode: 'simulate',
    expiresAt: Date.now() + 3600000,
  });
});

app.post('/api/diagnostics/audit', (req, res) => {
  res.json({ ok: true });
});

// Vehicle decode endpoint
app.get('/api/vehicles/decode/:vin', (req, res) => {
  const vin = String(req.params.vin || '').toUpperCase();
  res.json({
    vin,
    year: '2021',
    make: 'Ram',
    model: '1500',
    trim: 'Big Horn / Lone Star 5.7L HEMI',
    cached: true,
  });
});

// Mileage calculate endpoint
app.post('/api/mileage/calculate', (req, res) => {
  const from = req.body?.from || req.body?.shopAddress || '101 Main St, Lubbock, TX';
  const to = req.body?.to || req.body?.jobAddress || '502 4th St, Lubbock, TX';
  res.json({
    from,
    to,
    oneWayMiles: 12.4,
    roundTripMiles: 24.8,
    source: 'OSRM driving route',
  });
});

// Integrations status and mock operations
app.get('/api/integrations/status', (req, res) => {
  res.json({
    labor: {
      motor: { configured: true },
      alldata: { configured: false },
    },
    parts: {
      partstech: { configured: true, hasPunchout: false },
      nexpart: { configured: false },
    },
    quickbooks: { configured: false },
    support: { statusPageUrl: '' },
  });
});

app.get('/api/integrations/partstech', (req, res) => {
  res.json({ connected: true, loaded: true });
});

app.post('/api/integrations/partstech/quote', (req, res) => {
  res.json({
    items: [
      {
        id: 'pt-part-1',
        description: 'Brake Rotor - Front Premium',
        partNumber: 'BR-900214',
        unitPrice: 68.5,
        supplier: 'AutoZone Commercial',
      },
      {
        id: 'pt-part-2',
        description: 'Ceramic Brake Pads - Front Set',
        partNumber: 'CP-1052',
        unitPrice: 42.0,
        supplier: 'AutoZone Commercial',
      },
    ],
  });
});

app.get('/api/integrations/labor-guide', (req, res) => {
  res.json({ connected: true, provider: 'motor', loaded: true });
});

app.post('/api/integrations/labor-guide/search', (req, res) => {
  res.json({
    provider: 'motor',
    lines: [
      {
        id: 'lg-op-1',
        description: 'Brake Pads & Rotors - Front R&R',
        hours: 1.8,
        laborRate: 165,
        total: 297,
      },
    ],
  });
});

app.get('/api/settings/ai', (req, res) => {
  res.json({ hasKey: false, loaded: true, loading: false });
});

app.post('/api/support', (req, res) => {
  res.json({ id: `TICK-${Date.now()}`, queued: false });
});

// AI endpoints
app.post('/api/ai/assistant', (req, res) => {
  const query = req.body?.message || '';
  res.json({
    role: 'assistant',
    content: `I analyzed your shop query regarding "${query}". For this job, verify brake hardware wear and check factory torque specifications before final test drive.`,
  });
});

// Generic entity CRUD routes
app.get('/api/entities/:type', (req, res) => {
  const type = req.params.type.toLowerCase();
  const map = getEntitiesList(type);
  res.json(Array.from(map.values()));
});

app.get('/api/entities/:type/:id', (req, res) => {
  const type = req.params.type.toLowerCase();
  const id = decodeURIComponent(req.params.id);
  const map = getEntitiesList(type);
  if (map.has(id)) {
    return res.json(map.get(id));
  }
  res.status(404).json({ error: 'Not found' });
});

app.post('/api/entities/:type', (req, res) => {
  const type = req.params.type.toLowerCase();
  const body = req.body || {};
  const id = String(body.id || body.number || body.name || `item-${Date.now()}`);
  const record = { ...body, id, updatedAt: new Date().toISOString() };
  const map = getEntitiesList(type);
  map.set(id, record);
  res.status(201).json(record);
});

app.put('/api/entities/:type/:id', (req, res) => {
  const type = req.params.type.toLowerCase();
  const id = decodeURIComponent(req.params.id);
  const body = req.body || {};
  const record = { ...body, id, updatedAt: new Date().toISOString() };
  const map = getEntitiesList(type);
  map.set(id, record);
  res.json(record);
});

app.delete('/api/entities/:type/:id', (req, res) => {
  const type = req.params.type.toLowerCase();
  const id = decodeURIComponent(req.params.id);
  const map = getEntitiesList(type);
  map.delete(id);
  res.status(204).end();
});

// Fallback for any other API route
app.use('/api', (req, res) => {
  res.json({ ok: true });
});

// ----------------------------------------------------
// STATIC PAGES & MARKETING ROUTES
// ----------------------------------------------------

const publicPages = [
  'features',
  'pricing',
  'downloads',
  'login',
  'signup',
  'terms',
  'privacy',
  'founding',
];

for (const page of publicPages) {
  app.get(`/${page}`, (req, res) => {
    const pageHtml = join(__dirname, `public/${page}/index.html`);
    if (existsSync(pageHtml)) {
      return res.sendFile(pageHtml);
    }
    const dlHtml = join(__dirname, `${page}/index.html`);
    if (existsSync(dlHtml)) {
      return res.sendFile(dlHtml);
    }
    res.sendFile(join(__dirname, 'index.html'));
  });
}

// Serve public directory (market.css, graphics, etc.)
app.use(express.static(join(__dirname, 'public')));

// Serve downloads directory
app.use('/downloads', express.static(join(__dirname, 'downloads')));

// Serve root static assets (app.js, styles.css, theme.css, assets, etc.)
app.use(express.static(__dirname));

// Health checks for container orchestration and Cloud Run
app.get(['/health', '/healthz', '/_health', '/api/health'], (req, res) => {
  res.status(200).send('OK');
});

// App SPA fallback
app.get('/app', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Catch-all SPA route
app.use((req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

const PORT = 3000;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`MechPro server listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

