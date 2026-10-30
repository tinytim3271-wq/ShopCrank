import { inspectionUploadKind } from '../modules/inspection-ratings.js';
import {
  catalogInspectionFormHtml,
  closeInspectionIssues,
  customerInspectionDocument,
  shopInspection,
} from '../modules/shop-inspections.js';
import { openPrintDocument } from '../modules/print-document.js';

function readItems(form, catalog, existing) {
  const source = existing?.items?.length ? existing.items : null;
  const base = source || (catalog.sections || []).flatMap(section => section.items.map(item => ({ ...item, section: section.title })));
  return base.map(item => ({
    id: item.id,
    section: item.section,
    label: item.label,
    measure: item.measure || '',
    status: String(form.elements[`status-${item.id}`]?.value || ''),
    note: String(form.elements[`note-${item.id}`]?.value || ''),
    measurement: String(form.elements[`measure-${item.id}`]?.value || ''),
    photoKeys: [...(item.photoKeys || [])],
  }));
}

function readRecord(form, catalog, existing, app) {
  const data = new FormData(form);
  let photoKeys = [];
  try { photoKeys = JSON.parse(String(data.get('existingPhotos') || '[]')); } catch { photoKeys = existing?.photoKeys || []; }
  if (!Array.isArray(photoKeys)) photoKeys = [];
  return {
    id: existing?.id || `insp-${Date.now()}`,
    number: existing?.number || `INSP-${Date.now().toString().slice(-6)}`,
    catalogId: catalog.id,
    inspectionName: catalog.name,
    price: catalog.price,
    limits: catalog.limits,
    customer: String(data.get('customer') || '').trim(),
    vehicle: String(data.get('vehicle') || '').trim(),
    vin: String(data.get('vin') || '').trim(),
    mileage: String(data.get('mileage') || '').trim(),
    techName: String(data.get('tech') || '').trim(),
    vehicleId: String(data.get('vehicleId') || ''),
    workOrderId: String(data.get('workOrderId') || ''),
    conditions: [...form.querySelectorAll('[name=condition]:checked')].map(item => item.value),
    items: readItems(form, catalog, existing),
    recommendations: String(data.get('recommendations') || '').trim(),
    sellerSummary: String(data.get('sellerSummary') || '').trim(),
    verdict: String(data.get('verdict') || ''),
    customerName: String(data.get('customerName') || '').trim(),
    customerSignature: form.dataset.signature || existing?.customerSignature || '',
    photoKeys,
    createdAt: existing?.createdAt || app.now(),
    updatedAt: existing?.updatedAt,
    closedAt: existing?.closedAt || '',
    recordStatus: existing?.recordStatus || 'draft',
    approvalStatus: existing?.approvalStatus || 'pending',
    approvalHistory: existing?.approvalHistory || [],
    damageZones: existing?.damageZones || [],
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not retain inspection photo'));
    };
    image.src = url;
  });
}

async function retainPhoto(file, app) {
  try {
    const key = await app.uploadFileToR2(file, inspectionUploadKind(file), file.type || 'image/jpeg');
    if (!key) throw new Error('Inspection upload did not return a file key');
    return key;
  } catch (error) {
    if (/^video\//.test(file.type)) throw error;
    const dataUrl = await fileToDataUrl(file);
    if (!dataUrl) throw new Error('Could not retain inspection photo');
    return dataUrl;
  }
}

async function attachPhotos(form, record, app) {
  const files = [...(form.elements.photos?.files || [])];
  const keys = [...record.photoKeys];
  for (const file of files) {
    keys.push(await retainPhoto(file, app));
  }
  record.items = await Promise.all(record.items.map(async item => {
    const filesForItem = [...(form.elements[`photos-${item.id}`]?.files || [])];
    const itemKeys = [...item.photoKeys];
    for (const file of filesForItem) {
      itemKeys.push(await retainPhoto(file, app));
    }
    return { ...item, photoKeys: itemKeys };
  }));
  return keys;
}

function bindDictation(form, toast) {
  let active = null;
  form.querySelectorAll('[data-dictate]').forEach(button => {
    button.onclick = () => {
      const field = form.elements[button.dataset.dictate];
      const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Speech || !field) {
        toast('Dictation is not available in this browser. Type the note.');
        field?.focus();
        return;
      }
      if (active) {
        active.stop();
        return;
      }
      const recognition = new Speech();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.onresult = event => {
        const text = [...event.results].map(result => result[0]?.transcript || '').join(' ').trim();
        if (text) field.value = `${field.value} ${text}`.trim();
      };
      recognition.onerror = () => toast('Dictation stopped. Type the note.');
      recognition.onend = () => {
        active = null;
        button.textContent = button.dataset.dictate === 'note' ? 'Dictate' : button.textContent.replace('Stop', 'Dictate');
        if (button.dataset.dictate.startsWith('note-')) button.textContent = 'Dictate';
        if (button.dataset.dictate === 'recommendations') button.textContent = 'Dictate recommendations';
        if (button.dataset.dictate === 'sellerSummary') button.textContent = 'Dictate seller summary';
      };
      active = recognition;
      button.textContent = 'Stop';
      recognition.start();
    };
  });
}

function bindSignature(form, existing) {
  const canvas = form.querySelector('#inspection-signature');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  context.strokeStyle = '#172029';
  context.lineWidth = 2;
  let drawing = false;
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    const source = event.touches ? event.touches[0] : event;
    return {
      x: (source.clientX - rect.left) * (canvas.width / rect.width),
      y: (source.clientY - rect.top) * (canvas.height / rect.height),
    };
  };
  canvas.onpointerdown = event => {
    drawing = true;
    const start = point(event);
    context.beginPath();
    context.moveTo(start.x, start.y);
  };
  canvas.onpointermove = event => {
    if (!drawing) return;
    const next = point(event);
    context.lineTo(next.x, next.y);
    context.stroke();
  };
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    form.dataset.signature = canvas.toDataURL('image/png');
  };
  canvas.onpointerup = finish;
  canvas.onpointerleave = finish;
  form.querySelector('#clear-signature').onclick = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    form.dataset.signature = '';
  };
  if (String(existing?.customerSignature || '').startsWith('data:image/')) {
    const image = new Image();
    image.onload = () => context.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = existing.customerSignature;
    form.dataset.signature = existing.customerSignature;
  }
}

export function printCatalogInspection(app, inspection) {
  const profile = app.shopProfile();
  const brand = app.printableBrand(profile);
  const body = customerInspectionDocument(inspection, profile, app.escapeHtml, app.cloudflareConfig.apiUrl);
  openPrintDocument(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${app.escapeHtml(inspection.number)} inspection</title><style>${brand.style}body{font:13px/1.5 system-ui,sans-serif;max-width:860px;margin:auto;padding:22px;color:#172029}h1{margin:8px 0 4px;font-size:26px}h2{margin:18px 0 6px;color:var(--brand);font-size:15px}table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border:1px solid #d6ddd7;text-align:left;vertical-align:top}th{color:#fff;background:var(--brand)}.fee{font-weight:700}.verdict{display:inline-block;margin:8px 0;padding:6px 10px;color:#fff;background:var(--brand);font-weight:800;letter-spacing:.04em}.result.critical{color:#a93428;font-weight:700}.result.soon{color:#9b4821;font-weight:700}.result.ok{color:#08705f}.photos,.finding-photos{display:flex;flex-wrap:wrap;gap:8px}.photos img,.signature{max-width:180px;border:1px solid #d6ddd7}.finding-photos img{width:120px;height:90px;max-width:100%;max-height:90px;object-fit:contain;border:1px solid #d6ddd7}</style></head><body>${brand.header}${body}<button type="button">Print inspection</button></body></html>`, {
    toast: app.toast,
    blockedMessage: 'Allow pop-ups to print the inspection',
    autoPrint: true,
  });
}

export function presentCatalogInspection(app, existing = null, catalogId = existing?.catalogId) {
  const catalog = shopInspection(catalogId);
  if (!catalog) {
    app.toast('That inspection is not on the menu');
    return;
  }
  const html = catalogInspectionFormHtml(catalog, existing, {
    vehicles: app.state.vehicles.map(vehicle => ({ id: vehicle.id, label: `${vehicle.customer || 'Customer'} · ${app.vehicleLabel(vehicle)}` })),
    orders: (app.state.orders || []).map(order => ({ id: order.id, label: `${order.id} · ${order.customer || ''}` })),
    techName: app.currentUser()?.techName || app.currentUser()?.name || '',
    apiUrl: app.cloudflareConfig.apiUrl,
  }, app.escapeHtml);
  app.showModal(html);
  const form = document.querySelector('#catalog-inspection-form');
  if (!form) return;
  form.elements.customer?.addEventListener('change', () => {
    if (!form.elements.customerName.value) form.elements.customerName.value = form.elements.customer.value;
  });
  form.elements.vehicleId?.addEventListener('change', () => {
    const vehicle = app.state.vehicles.find(item => item.id === form.elements.vehicleId.value);
    if (!vehicle) return;
    if (!form.elements.customer.value) form.elements.customer.value = vehicle.customer || '';
    if (!form.elements.vehicle.value) form.elements.vehicle.value = app.vehicleLabel(vehicle);
    if (!form.elements.vin.value) form.elements.vin.value = vehicle.vin || '';
    if (!form.elements.mileage.value && vehicle.mileage) form.elements.mileage.value = vehicle.mileage;
  });
  form.querySelectorAll('[data-mark-section]').forEach(button => {
    button.onclick = () => {
      form.querySelectorAll(`[data-section="${CSS.escape(button.dataset.markSection)}"] select`).forEach(select => {
        if (!select.value) select.value = 'ok';
      });
    };
  });
  bindDictation(form, app.toast);
  bindSignature(form, existing);
  form.onsubmit = async event => {
    event.preventDefault();
    const intent = event.submitter?.dataset.intent || 'draft';
    const record = readRecord(form, catalog, existing, app);
    if (intent === 'close') {
      const items = record.items.map(item => ({
        ...item,
        photoKeys: [
          ...item.photoKeys,
          ...(form.elements[`photos-${item.id}`]?.files?.length ? ['pending'] : []),
        ],
      }));
      const issues = closeInspectionIssues({
        ...record,
        items,
        photoKeys: [...record.photoKeys, ...(form.elements.photos?.files?.length ? ['pending'] : [])],
      });
      if (issues.length) {
        app.toast(issues[0]);
        return;
      }
    }
    try {
      record.photoKeys = await attachPhotos(form, record, app);
      if (intent === 'close') {
        const issues = closeInspectionIssues(record);
        if (issues.length) {
          app.toast(issues[0]);
          return;
        }
        record.closedAt = app.now();
        record.recordStatus = 'closed';
      }
      const saved = await app.saveShopEntity('inspections', record);
      existing = saved;
      app.toast(intent === 'close' ? 'Inspection closed' : 'Inspection saved');
      if (intent === 'print' || intent === 'close') printCatalogInspection(app, saved);
      app.closeModal();
      app.render();
    } catch (error) {
      const localPreview = typeof app.isLocalShell === 'function' && app.isLocalShell() && /404|Failed to fetch|NetworkError/i.test(error?.message || '');
      if (!localPreview) {
        app.toast(error?.message || 'Could not save the inspection');
        return;
      }
      const index = app.state.inspections.findIndex(item => item.id === record.id);
      if (index >= 0) app.state.inspections[index] = record;
      else app.state.inspections.push(record);
      app.save();
      app.toast(intent === 'close' ? 'Inspection closed on this device' : 'Inspection saved on this device');
      if (intent === 'print' || intent === 'close') printCatalogInspection(app, record);
      app.closeModal();
      app.render();
    }
  };
}
