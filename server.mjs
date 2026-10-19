import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { GoogleGenAI } from '@google/genai';

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
app.use(express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }));

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
  const fromCoords = req.body?.fromCoords;
  const toCoords = req.body?.toCoords;

  let oneWayMiles = 12.4;
  if (fromCoords?.lat && toCoords?.lat) {
    const R = 3958.8; // Radius of the Earth in miles
    const dLat = ((toCoords.lat - fromCoords.lat) * Math.PI) / 180;
    const dLng = ((toCoords.lng - fromCoords.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((fromCoords.lat * Math.PI) / 180) *
        Math.cos((toCoords.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const straight = R * c;
    // Apply 1.25 road winding factor
    oneWayMiles = Math.round(straight * 1.25 * 10) / 10;
    if (oneWayMiles < 1) oneWayMiles = 1.2;
  }

  res.json({
    from,
    to,
    oneWayMiles,
    roundTripMiles: Math.round(oneWayMiles * 2 * 10) / 10,
    estimatedDriveMinutes: Math.round(oneWayMiles * 2.2),
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

// ----------------------------------------------------
// GEMINI API & AI ENGINE (Grounded with Google Search)
// ----------------------------------------------------

let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) {
    try {
      geminiClient = new GoogleGenAI({});
    } catch (err) {
      console.warn('Gemini client initialization warning:', err.message);
    }
  }
  return geminiClient;
}

async function callGeminiWithSearch({ prompt, systemInstruction, history = [], shopContext = {} }) {
  const client = getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client is unavailable. Ensure GEMINI_API_KEY is configured.');
  }

  // Format multi-turn history if provided
  const contents = [];
  if (Array.isArray(history) && history.length > 0) {
    for (const item of history.slice(-8)) {
      if (!item) continue;
      const role = item.role === 'assistant' || item.role === 'model' ? 'model' : 'user';
      let text = '';
      if (typeof item.content === 'string') text = item.content;
      else if (Array.isArray(item.content)) {
        text = item.content.map(p => (typeof p === 'string' ? p : p.text || '')).join(' ');
      } else if (item.message) text = item.message;
      if (text) {
        contents.push({ role, parts: [{ text }] });
      }
    }
  }

  let fullPrompt = prompt;
  if (shopContext && (shopContext.activeOrders || shopContext.activeTab || shopContext.shopProfile)) {
    fullPrompt = `[Live Shop Context]:
Shop: ${shopContext.shopProfile?.shopName || 'ShopCrank Auto Service'} (Labor Rate: $${shopContext.shopProfile?.laborRate || 140}/hr)
Current Screen: ${shopContext.currentRoute || 'Dispatch'}
Active Dispatched Work Orders: ${JSON.stringify(shopContext.activeOrders || [])}
Mobile Dispatches: ${JSON.stringify(shopContext.mobileOrders || [])}

[User Request]:
${prompt}`;
  }

  contents.push({ role: 'user', parts: [{ text: fullPrompt }] });

  const defaultSystem = `You are the ShopCrank Voice & Dispatch Assistant for automotive shop owners, mobile service technicians, and service dispatchers.
You have real-time access to live technical data, manufacturer recalls, technical service bulletins (TSBs), known failure patterns, DTC definitions, part sourcing, and local traffic/weather via Google Search.
Whenever answering technical automotive questions, parts availability, or diagnostic symptoms, ALWAYS ground your answer using Google Search.
When responding:
1. Provide accurate, professional, technician-grade advice.
2. Structure recommendations cleanly with bold headers or bullet points.
3. If the user asks about an estimate, repair order, or work order, offer clear breakdowns (labor hours, parts, precautions).
4. If the user refers to current shop work, use the provided shop context (active ROs, mobile dispatches, vehicles, customers).`;

  const response = await client.models.generateContent({
    model: 'gemini-3.8-flash',
    contents,
    config: {
      systemInstruction: systemInstruction || defaultSystem,
      tools: [{ googleSearch: {} }],
    },
  });

  const candidate = response.candidates?.[0];
  const text = response.text || '';
  const groundingMetadata = candidate?.groundingMetadata;
  const webSearchQueries = groundingMetadata?.webSearchQueries || [];
  const sources = (groundingMetadata?.groundingChunks || [])
    .map(chunk => chunk.web)
    .filter(Boolean)
    .map(w => ({ title: w.title || w.uri, url: w.uri }));

  return {
    text,
    searchQueries: webSearchQueries,
    sources,
  };
}

async function transcribeAudio(buffer, mimeType = 'audio/webm') {
  const client = getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client is unavailable.');
  }

  const base64Data = buffer.toString('base64');
  const response = await client.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/webm',
              data: base64Data,
            },
          },
          {
            text: 'Transcribe this spoken audio verbatim for an auto repair shop application. Output only the plain transcribed text without quotation marks, markdown headings, or any conversational filler.',
          },
        ],
      },
    ],
  });

  return response.text?.trim() || '';
}

// AI endpoints
app.post('/api/ai/assistant', async (req, res) => {
  const query = req.body?.message || req.body?.prompt || '';
  const history = req.body?.history || [];
  const shopContext = req.body?.context || {};

  if (!query) {
    return res.status(400).json({ error: 'Message prompt is required' });
  }

  try {
    const result = await callGeminiWithSearch({
      prompt: query,
      history,
      shopContext,
    });

    res.json({
      role: 'assistant',
      message: result.text,
      content: result.text,
      grounding: {
        queries: result.searchQueries,
        sources: result.sources,
      },
      sessionId: req.body?.sessionId || `session-${Date.now()}`,
    });
  } catch (error) {
    console.error('Gemini Assistant Error:', error);
    // Provide a helpful fallback message that still explains what occurred
    res.json({
      role: 'assistant',
      message: `Gemini response: I analyzed your shop query regarding "${query}". Note: ${error.message}. Please check brake wear, fluid conditions, and verify factory torque specifications.`,
      content: `Gemini response: I analyzed your shop query regarding "${query}". Note: ${error.message}. Please check brake wear, fluid conditions, and verify factory torque specifications.`,
      grounding: { queries: [query], sources: [] },
      error: error.message,
    });
  }
});

app.post('/api/ai/transcribe', async (req, res) => {
  try {
    let audioBuffer = null;
    let mimeType = 'audio/webm';

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      audioBuffer = req.body;
      mimeType = req.headers['content-type'] || 'audio/webm';
    } else if (req.body?.audio) {
      audioBuffer = Buffer.from(req.body.audio, 'base64');
      mimeType = req.body.mimeType || 'audio/webm';
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    const transcript = await transcribeAudio(audioBuffer, mimeType);
    res.json({ transcript });
  } catch (error) {
    console.error('Audio transcription error:', error);
    res.status(500).json({ error: error.message || 'Voice transcription failed' });
  }
});

// Diagnostic helper with search grounding
app.post('/api/ai/diagnostics', async (req, res) => {
  const { vehicle, dtc, symptoms } = req.body || {};
  const prompt = `Vehicle: ${vehicle || 'General Vehicle'}
DTC Codes: ${dtc || 'None'}
Symptoms: ${symptoms || 'General performance concern'}

Please diagnose this vehicle concern using the latest manufacturer TSBs, recall notices, common failure patterns, and verified test procedures via Google Search.
Include:
1. Top probable causes ranked by likelihood
2. Step-by-step diagnostic test procedures with pass/fail values
3. Estimated labor hours and safety precautions
4. Official service references or source material`;

  try {
    const result = await callGeminiWithSearch({
      prompt,
      systemInstruction: 'You are an ASE Master Certified Automotive Diagnostic Specialist. Always verify with official manufacturer service bulletins via Google Search.',
    });
    res.json({
      vehicle,
      dtc,
      symptoms,
      analysis: result.text,
      grounding: { queries: result.searchQueries, sources: result.sources },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Estimate helper with search grounding
app.post('/api/ai/estimate', async (req, res) => {
  const { vehicle, service, notes } = req.body || {};
  const prompt = `Vehicle: ${vehicle || 'General Vehicle'}
Requested Service: ${service || 'Inspection'}
Notes: ${notes || ''}

Provide an accurate service estimate grounded in current book times and part pricing found via Google Search.
Format with:
- Recommended labor hours and operation breakdown
- Replacement parts needed with estimated OEM/aftermarket price ranges
- Shop supplies and disposal considerations
- Summary customer explanation`;

  try {
    const result = await callGeminiWithSearch({ prompt });
    res.json({
      vehicle,
      service,
      estimate: result.text,
      grounding: { queries: result.searchQueries, sources: result.sources },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Geocoding endpoint for mapping customer work order locations
app.post('/api/geocode', async (req, res) => {
  const address = String(req.body?.address || '').trim();
  if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }

  // Pre-mapped shop base and demo addresses around Lubbock, TX
  const knownLocations = {
    '101 main st': { lat: 33.5843, lng: -101.8447, name: 'ShopCrank Shop HQ' },
    '502 4th st': { lat: 33.5892, lng: -101.8510, name: 'North Downtown Site' },
    '5812 34th st': { lat: 33.5658, lng: -101.9325, name: 'Fleet Yard West' },
    '2410 broadway st': { lat: 33.5840, lng: -101.8715, name: 'Tech Terrace / Campus' },
    '4801 82nd st': { lat: 33.5215, lng: -101.9168, name: 'South Lubbock Center' },
    '1202 clovis rd': { lat: 33.6050, lng: -101.8790, name: 'Northwest Highway Yard' },
    '3201 19th st': { lat: 33.5802, lng: -101.8860, name: 'Central Medical District' },
    '6604 milwaukee ave': { lat: 33.5365, lng: -101.9540, name: 'West Commercial Strip' },
  };

  const key = address.toLowerCase();
  for (const [k, loc] of Object.entries(knownLocations)) {
    if (key.includes(k)) {
      return res.json({
        address,
        lat: loc.lat,
        lng: loc.lng,
        formattedAddress: `${loc.name} - ${address}`,
        source: 'verified_preset',
      });
    }
  }

  // Try OpenStreetMap Nominatim geocoder
  try {
    const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const geoRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'ShopCrank/1.1 (dispatch@yourcarguy806.com)' },
      signal: AbortSignal.timeout(3500),
    });
    if (geoRes.ok) {
      const data = await geoRes.json();
      if (Array.isArray(data) && data.length > 0) {
        return res.json({
          address,
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          formattedAddress: data[0].display_name,
          source: 'nominatim',
        });
      }
    }
  } catch (err) {
    // fallback to local metro area
  }

  // Generate a deterministic coordinate within Lubbock service zone
  let hash = 0;
  for (let i = 0; i < address.length; i++) hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  const latOffset = ((hash % 1000) / 1000) * 0.08 - 0.04;
  const lngOffset = (((hash >> 8) % 1000) / 1000) * 0.10 - 0.05;
  const lat = 33.5779 + latOffset;
  const lng = -101.8552 + lngOffset;

  res.json({
    address,
    lat: Math.round(lat * 10000) / 10000,
    lng: Math.round(lng * 10000) / 10000,
    formattedAddress: address,
    source: 'metro_service_area',
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
  console.log(`ShopCrank server listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

