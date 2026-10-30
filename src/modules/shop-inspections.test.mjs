import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { escapeHtml } from '../shared/html.js';
import {
  SHOP_INSPECTIONS,
  catalogInspectionFormHtml,
  closeInspectionIssues,
  customerInspectionDocument,
  inspectionItems,
  inspectionMenuHtml,
  inspectionPhotoSrc,
  shopInspection,
} from './shop-inspections.js';

test('inspection uploads render actual shop object keys without accepting traversal', () => {
  const key = 'shops/shop-123/inspection/12740bf5-7dfc-4c25-86e4-7e6a3ada445e';
  assert.equal(inspectionPhotoSrc(key, '/api'), `/api/files/object?key=${encodeURIComponent(key)}`);
  assert.equal(inspectionPhotoSrc('shops/shop-123/inspection/../secret', '/api'), '');
  const html = customerInspectionDocument({ catalogId: 'brakes', items: [{ label: 'Pads', status: 'critical', photoKeys: [key] }] }, {}, escapeHtml, '/api');
  assert.ok(html.includes(escapeHtml(`/api/files/object?key=${encodeURIComponent(key)}`)));
  assert.match(html, /rating-chip/);
});

test('inspection and finding images survive failed or empty uploads; failed video blocks saving', async () => {
  const source = readFileSync(new URL('../runtime/catalog-inspection-ui.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function fileToDataUrl('), source.indexOf('function bindDictation('));
  const attachPhotos = vm.runInNewContext(`${functions}; attachPhotos`, {
    inspectionUploadKind: file => file.type.startsWith('video/') ? 'inspection-video' : 'inspection',
    Image: class {
      constructor() { this.width = 2000; this.height = 1000; }
      set src(_value) { this.onload(); }
    },
    URL: { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} },
    document: { createElement: () => ({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => 'data:image/jpeg;base64,retained',
    }) },
  });
  const image = { type: 'image/jpeg' };
  for (const uploadFileToR2 of [async () => { throw new Error('offline'); }, async () => '']) {
    const record = { photoKeys: ['existing'], items: [{ id: 'pads', photoKeys: ['existing-finding'] }] };
    const keys = await attachPhotos({ elements: { photos: { files: [image] }, 'photos-pads': { files: [image] } } }, record, { uploadFileToR2 });
    assert.deepEqual([...keys], ['existing', 'data:image/jpeg;base64,retained']);
    assert.deepEqual([...record.items[0].photoKeys], ['existing-finding', 'data:image/jpeg;base64,retained']);
  }
  await assert.rejects(attachPhotos({ elements: { photos: { files: [{ type: 'video/mp4' }] } } },
    { photoKeys: [], items: [] }, { uploadFileToR2: async () => { throw new Error('Video upload failed'); } }), /Video upload failed/);
});

const prices = {
  'Flagship Pre-Purchase Inspection': 229,
  'Brake Inspection': 89,
  'Tire and Wheel Inspection': 79,
  'Battery and Charging System Inspection': 89,
  'Cooling System Inspection': 89,
  'Transmission Inspection': 109,
  'Differential / 4x4 Inspection': 99,
  'Steering and Suspension Inspection': 99,
  'Exhaust Inspection': 79,
  'Fuel System Inspection': 89,
  'Electrical and Lighting Inspection': 99,
  'HVAC Inspection': 89,
  'Engine Performance / Compression Inspection': 129,
  'Alignment Check': 79,
  'General Multi-Point Inspection': 129,
};

test('the shop menu has the fifteen Lubbock inspection fees', () => {
  assert.equal(SHOP_INSPECTIONS.length, 15);
  for (const [name, price] of Object.entries(prices)) {
    assert.equal(SHOP_INSPECTIONS.find(item => item.name === name).price, price);
  }
  assert.deepEqual(shopInspection('pre-purchase').verdicts.map(item => item.label), ['BUY', 'NEGOTIATE', 'WALK AWAY']);
  const menu = inspectionMenuHtml(escapeHtml);
  assert.match(menu, /Flagship Pre-Purchase Inspection/);
  assert.match(menu, /\$229/);
  assert.equal(menu.includes('menu-synthetic-oil'), false);
});

test('scan inspections tell the tech not to clear codes', () => {
  for (const id of ['pre-purchase', 'battery', 'transmission', 'differential', 'exhaust', 'fuel', 'electrical', 'engine', 'multipoint']) {
    const text = JSON.stringify(shopInspection(id));
    assert.match(text, /not cleared/i, id);
  }
});

test('closing requires a result, acknowledgment, verdict, and photos on each urgent finding', () => {
  const items = inspectionItems(shopInspection('brakes')).map(item => ({ ...item, status: 'ok' }));
  items[1].status = 'critical';
  assert.deepEqual(closeInspectionIssues({ catalogId: 'brakes', items, customerName: '', photoKeys: [] }), [
    `Attach a photo to each critical or soon finding before closing (${items[1].label}).`,
    'Add the customer name on the acknowledgment.',
  ]);
  const ppi = inspectionItems(shopInspection('pre-purchase')).map(item => ({ ...item, status: '' }));
  const issues = closeInspectionIssues({ catalogId: 'pre-purchase', items: ppi, customerName: 'Ada', photoKeys: [], verdict: '' });
  assert.equal(issues.some(item => item.includes('WALK AWAY')), true);
  assert.equal(issues.some(item => item.includes('need a result')), true);
  items[1].photoKeys = ['photo-1'];
  assert.deepEqual(closeInspectionIssues({
    catalogId: 'brakes',
    items,
    customerName: 'Ada',
    photoKeys: [],
  }), []);
});

test('the customer copy is a branded inspection sheet, not a repair quote', () => {
  const catalog = shopInspection('pre-purchase');
  const html = customerInspectionDocument({
    catalogId: 'pre-purchase',
    number: 'INSP-1',
    customer: '<script>',
    vehicle: '2014 Tahoe',
    vin: '1GNEC13Z94R123456',
    mileage: '186000',
    techName: 'Sam',
    verdict: 'negotiate',
    sellerSummary: 'Negotiate the rust.',
    recommendations: 'Quote the brake work separately.',
    photoKeys: ['data:image/jpeg;base64,abc', 'r2-key'],
    customerName: 'Ada',
    customerSignature: 'data:image/png;base64,sig',
    items: inspectionItems(catalog).map(item => ({ ...item, status: item.id === 'scan' ? 'soon' : 'ok', photoKeys: item.id === 'scan' ? ['r2-finding-photo'] : [], measurement: item.id === 'tread' ? '4/32' : '' })),
  }, { shopName: 'Reliable Automotive Services' }, escapeHtml, 'https://api.example.test');
  assert.match(html, /Inspection fee 229.00 USD/);
  assert.match(html, /Repairs, parts, and disassembly are quoted separately/);
  assert.match(html, /NEGOTIATE/);
  assert.match(html, /Photo for All accessible modules scanned/i);
  assert.match(html, /Seller summary/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /data:image\/jpeg;base64,abc/);
  assert.match(html, /https:\/\/api\.example\.test\/files\/r2-key/);
  assert.match(html, /Stored codes were recorded and were not cleared/);
  assert.match(html, /4\/32/);
  const form = catalogInspectionFormHtml(shopInspection('brakes'), null, {}, escapeHtml);
  assert.match(form, /Dictate/);
  assert.match(form, /data-dictate="recommendations"/);
  assert.match(form, /Pad or shoe thickness/);
  assert.match(form, /\$89/);
});
