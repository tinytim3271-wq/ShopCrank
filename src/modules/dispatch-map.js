/**
 * MechPro Dispatched Work Order Location Mapping Module
 * Uses Leaflet & OpenStreetMap (No Google Maps API)
 * Features:
 * - Map dispatched customer work orders with custom status markers
 * - Shop HQ base pin & customer location pins
 * - Route lines and mileage/distance calculations
 * - Interactive popups with customer details, phone, vehicle, and one-click RO editor
 * - Filter by Mobile Dispatches, In Progress, Approved, or All
 * - Standalone single-order customer location mapping modal
 */

import L from 'leaflet';
import { escapeHtml, escapeAttr } from '../shared/html.js';

// Shop HQ Base coordinates (Lubbock, TX)
export const SHOP_HQ = {
  lat: 33.5843,
  lng: -101.8447,
  name: 'MechPro Shop HQ',
  address: '101 Main St, Lubbock, TX 79401',
};

// Preset coordinates for Lubbock area customer addresses
export const KNOWN_DISPATCH_COORDS = {
  'RO-1049': { lat: 33.5658, lng: -101.9325, address: '5812 34th St, Lubbock, TX' },
  'RO-1044': { lat: 33.5365, lng: -101.9540, address: '6604 Milwaukee Ave, Lubbock, TX' },
  'RO-1048': { lat: 33.5840, lng: -101.8715, address: '2410 Broadway St, Lubbock, TX' },
  'RO-1051': { lat: 33.5215, lng: -101.9168, address: '4801 82nd St, Lubbock, TX' },
  'RO-1050': { lat: 33.6050, lng: -101.8790, address: '1202 Clovis Rd, Lubbock, TX' },
  'RO-1052': { lat: 33.5802, lng: -101.8860, address: '3201 19th St, Lubbock, TX' },
  'RO-1046': { lat: 33.5892, lng: -101.8510, address: '502 4th St, Lubbock, TX' },
};

let currentMapInstance = null;
let currentModalMapInstance = null;
let mapMarkers = [];
let routeLines = [];

/**
 * Get coordinates for a work order
 */
export function getOrderCoordinates(order) {
  if (order.lat && order.lng) {
    return { lat: Number(order.lat), lng: Number(order.lng), address: order.jobAddress || order.address || '' };
  }

  if (KNOWN_DISPATCH_COORDS[order.id]) {
    return KNOWN_DISPATCH_COORDS[order.id];
  }

  // Deterministic coordinate offset within Lubbock metro service area
  const seedStr = `${order.id}-${order.customer || ''}`;
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  const latOffset = ((hash % 1000) / 1000) * 0.08 - 0.04;
  const lngOffset = (((hash >> 8) % 1000) / 1000) * 0.10 - 0.05;

  return {
    lat: Math.round((SHOP_HQ.lat + latOffset) * 10000) / 10000,
    lng: Math.round((SHOP_HQ.lng + lngOffset) * 10000) / 10000,
    address: order.jobAddress || order.address || `${400 + (hash % 5000)} Main St, Lubbock, TX`,
  };
}

/**
 * Calculate distance in miles between two coordinates
 */
export function calculateMiles(c1, c2) {
  const R = 3958.8;
  const dLat = ((c2.lat - c1.lat) * Math.PI) / 180;
  const dLng = ((c2.lng - c1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((c1.lat * Math.PI) / 180) *
      Math.cos((c2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const straight = R * c;
  return Math.round(straight * 1.25 * 10) / 10;
}

/**
 * Create custom SVG HTML marker icon for Leaflet
 */
function createMarkerIcon(type, label = '', isMobile = false) {
  let bgColor = '#1f654b'; // green
  let borderColor = '#fff';
  let badgeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>`;

  if (type === 'shop') {
    bgColor = '#18252b';
    borderColor = '#ffd34e';
    badgeIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd34e" stroke-width="2.5"><path d="m14.7 10.7 4.6 4.6a2 2 0 1 1-2.8 2.8l-4.6-4.6"/><path d="M21 3 13.5 10.5"/><path d="M7.7 5.7 3.1 10.3a2 2 0 1 0 2.8 2.8l4.6-4.6"/><path d="m3 21 7.5-7.5"/></svg>`;
  } else if (isMobile || type === 'mobile') {
    bgColor = '#2563eb'; // blue
    badgeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="16" height="10" x="2" y="7" rx="2"/><circle cx="6" cy="17" r="2"/><circle cx="14" cy="17" r="2"/><path d="M18 12h2a2 2 0 0 1 2 2v3h-4"/></svg>`;
  } else if (type === 'in_progress') {
    bgColor = '#ea580c'; // orange
    badgeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  } else if (type === 'waiting_parts') {
    bgColor = '#d97706'; // amber
    badgeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
  }

  const pulseClass = isMobile || type === 'in_progress' ? 'pulse-pin' : '';

  return L.divIcon({
    className: 'custom-leaflet-marker-wrapper',
    html: `
      <div class="custom-map-pin ${type} ${pulseClass}" style="--pin-color: ${bgColor}; --pin-border: ${borderColor};">
        <div class="pin-badge">
          ${badgeIcon}
        </div>
        ${label ? `<span class="pin-label">${escapeHtml(label)}</span>` : ''}
      </div>
    `,
    iconSize: [36, 42],
    iconAnchor: [18, 42],
    popupAnchor: [0, -42],
  });
}

/**
 * Mount and render the full Dispatch Map inside a container element
 */
export function mountDispatchMap(containerId, orders = [], options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  // Clean up existing map instance if any
  if (currentMapInstance) {
    try {
      currentMapInstance.remove();
    } catch {
      // ignore
    }
    currentMapInstance = null;
  }

  const filter = options.filter || 'all'; // 'all', 'mobile', 'in_progress', 'approved'
  const onOpenOrder = options.onOpenOrder || (() => {});

  // Filter orders for mapping
  const dispatchedOrders = orders.filter((o) => {
    if (['completed', 'invoiced', 'declined', 'archived'].includes(o.status)) return false;
    if (filter === 'mobile') return Boolean(o.mobile);
    if (filter === 'in_progress') return o.status === 'in_progress';
    if (filter === 'approved') return o.status === 'approved';
    return true;
  });

  // Initialize Leaflet Map
  const map = L.map(containerId, {
    center: [SHOP_HQ.lat, SHOP_HQ.lng],
    zoom: 12,
    zoomControl: true,
  });

  currentMapInstance = map;

  // Add OpenStreetMap Tile Layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
  }).addTo(map);

  mapMarkers = [];
  routeLines = [];

  // Add Shop HQ marker
  const shopMarker = L.marker([SHOP_HQ.lat, SHOP_HQ.lng], {
    icon: createMarkerIcon('shop', 'HQ'),
  }).addTo(map);

  shopMarker.bindPopup(`
    <div class="map-popup shop-popup">
      <div class="popup-title"><strong>${escapeHtml(SHOP_HQ.name)}</strong></div>
      <p class="popup-addr">${escapeHtml(SHOP_HQ.address)}</p>
      <div class="popup-badge">Central Shop Base</div>
    </div>
  `);

  mapMarkers.push(shopMarker);

  const latLngs = [[SHOP_HQ.lat, SHOP_HQ.lng]];

  // Add Dispatched Customer Work Order Markers
  dispatchedOrders.forEach((order) => {
    const coords = getOrderCoordinates(order);
    const miles = calculateMiles(SHOP_HQ, coords);
    const driveMinutes = Math.round(miles * 2.2);
    const isMobile = Boolean(order.mobile);

    const marker = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(order.status, order.id, isMobile),
    }).addTo(map);

    const popupHtml = `
      <div class="map-popup order-popup">
        <div class="popup-head">
          <span class="popup-ro-id">${escapeHtml(order.id)}</span>
          <span class="popup-status-badge ${order.status}">${escapeHtml(order.status.replace(/_/g, ' '))}</span>
          ${isMobile ? `<span class="popup-mobile-badge">Mobile Dispatch</span>` : ''}
        </div>
        <h4 class="popup-customer">${escapeHtml(order.customer)}</h4>
        <div class="popup-vehicle">${escapeHtml(order.vehicle || 'Vehicle pending')}</div>
        <div class="popup-location">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>${escapeHtml(coords.address)}</span>
        </div>
        <div class="popup-meta">
          <span><strong>${miles} mi</strong> from shop (approx ${driveMinutes} min)</span>
          ${order.phone ? `<a href="tel:${escapeAttr(order.phone)}" class="popup-phone-link">Call ${escapeHtml(order.phone)}</a>` : ''}
        </div>
        ${order.complaint ? `<p class="popup-complaint">“${escapeHtml(order.complaint)}”</p>` : ''}
        <div class="popup-actions">
          <button type="button" class="popup-btn primary" data-open-ro="${escapeAttr(order.id)}">Open Work Order</button>
          <a href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${SHOP_HQ.lat}%2C${SHOP_HQ.lng}%3B${coords.lat}%2C${coords.lng}" target="_blank" rel="noopener noreferrer" class="popup-btn secondary">Directions</a>
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml);

    // Route line from Shop HQ to dispatched location
    const routeLine = L.polyline(
      [
        [SHOP_HQ.lat, SHOP_HQ.lng],
        [coords.lat, coords.lng],
      ],
      {
        color: isMobile ? '#2563eb' : '#087e6a',
        weight: 3,
        opacity: 0.65,
        dashArray: isMobile ? '6, 8' : undefined,
      },
    ).addTo(map);

    routeLines.push(routeLine);
    mapMarkers.push(marker);
    latLngs.push([coords.lat, coords.lng]);

    // Handle popup button click
    marker.on('popupopen', () => {
      const btn = document.querySelector(`[data-open-ro="${order.id}"]`);
      if (btn) {
        btn.onclick = () => onOpenOrder(order.id);
      }
    });
  });

  // Fit bounds to show all markers
  if (latLngs.length > 1) {
    map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });
  }

  // Invalidate size after layout stabilization
  setTimeout(() => {
    map.invalidateSize();
  }, 200);

  return map;
}

/**
 * Open a modal displaying the mapped customer location for a single work order
 */
export function openWorkOrderLocationModal(order, _onOpenOrder) {
  const coords = getOrderCoordinates(order);
  const miles = calculateMiles(SHOP_HQ, coords);
  const driveMinutes = Math.round(miles * 2.2);
  const isMobile = Boolean(order.mobile);

  let backdrop = document.querySelector('#work-order-map-modal');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'work-order-map-modal';
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
  }

  backdrop.innerHTML = `
    <div class="modal wide map-location-modal" role="dialog" aria-modal="true" aria-label="Customer Location Map">
      <div class="modal-head">
        <div>
          <span class="eyebrow">${isMobile ? 'Mobile Dispatch Map' : 'Customer Service Location'}</span>
          <h2>${escapeHtml(order.id)} · ${escapeHtml(order.customer)}</h2>
        </div>
        <button type="button" class="close" id="close-map-modal" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="modal-body map-modal-body">
        <div class="map-modal-info-bar">
          <div class="map-info-item">
            <span class="info-label">Customer Location</span>
            <strong>${escapeHtml(coords.address)}</strong>
          </div>
          <div class="map-info-item">
            <span class="info-label">Distance from Shop HQ</span>
            <strong>${miles} miles <small>(${driveMinutes} min drive)</small></strong>
          </div>
          <div class="map-info-item">
            <span class="info-label">Vehicle &amp; Promise</span>
            <strong>${escapeHtml(order.vehicle)} · ${escapeHtml(order.promise || 'Scheduled')}</strong>
          </div>
          <div class="map-info-actions">
            ${order.phone ? `<a href="tel:${escapeAttr(order.phone)}" class="secondary">Call Customer</a>` : ''}
            <a href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${SHOP_HQ.lat}%2C${SHOP_HQ.lng}%3B${coords.lat}%2C${coords.lng}" target="_blank" rel="noopener noreferrer" class="primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
              <span>Turn-by-turn Navigation</span>
            </a>
          </div>
        </div>
        <div id="modal-leaflet-map" class="single-order-map-canvas" style="height: 440px; width: 100%; border-radius: 6px; overflow: hidden;"></div>
      </div>
    </div>
  `;

  backdrop.style.display = 'grid';

  const closeBtn = document.querySelector('#close-map-modal');
  const close = () => {
    if (currentModalMapInstance) {
      try { currentModalMapInstance.remove(); } catch {
        // ignore
      }
      currentModalMapInstance = null;
    }
    backdrop.style.display = 'none';
  };

  closeBtn?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Initialize Map for single modal
  setTimeout(() => {
    if (currentModalMapInstance) {
      try { currentModalMapInstance.remove(); } catch {
        // ignore
      }
    }

    const modalMap = L.map('modal-leaflet-map', {
      center: [coords.lat, coords.lng],
      zoom: 13,
      zoomControl: true,
    });
    currentModalMapInstance = modalMap;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(modalMap);

    // Shop Marker
    L.marker([SHOP_HQ.lat, SHOP_HQ.lng], {
      icon: createMarkerIcon('shop', 'HQ'),
    }).addTo(modalMap).bindPopup(`<b>${escapeHtml(SHOP_HQ.name)}</b><br>${escapeHtml(SHOP_HQ.address)}`);

    // Customer Location Marker
    const customerMarker = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(order.status, order.id, isMobile),
    }).addTo(modalMap);

    customerMarker.bindPopup(`
      <b>${escapeHtml(order.customer)} (${escapeHtml(order.id)})</b><br>
      ${escapeHtml(coords.address)}<br>
      ${miles} miles from shop
    `).openPopup();

    // Route line
    L.polyline(
      [
        [SHOP_HQ.lat, SHOP_HQ.lng],
        [coords.lat, coords.lng],
      ],
      {
        color: isMobile ? '#2563eb' : '#087e6a',
        weight: 4,
        dashArray: isMobile ? '6, 8' : undefined,
      },
    ).addTo(modalMap);

    modalMap.fitBounds(
      L.latLngBounds([
        [SHOP_HQ.lat, SHOP_HQ.lng],
        [coords.lat, coords.lng],
      ]),
      { padding: [50, 50] },
    );

    modalMap.invalidateSize();
  }, 100);
}

/**
 * Render the full Dispatch Map View HTML string
 */
export function dispatchMapHtml(orders = [], activeFilter = 'all') {
  const activeOrders = orders.filter((o) => !['completed', 'invoiced', 'declined', 'archived'].includes(o.status));
  const mobileCount = activeOrders.filter((o) => o.mobile).length;
  const inProgressCount = activeOrders.filter((o) => o.status === 'in_progress').length;
  const approvedCount = activeOrders.filter((o) => o.status === 'approved').length;

  const orderCards = activeOrders.map((o) => {
    const coords = getOrderCoordinates(o);
    const miles = calculateMiles(SHOP_HQ, coords);
    return `
      <div class="map-order-card ${o.mobile ? 'mobile' : ''} ${o.status}" data-fly-to="${escapeAttr(o.id)}" data-lat="${coords.lat}" data-lng="${coords.lng}">
        <div class="card-head">
          <strong>${escapeHtml(o.id)}</strong>
          <span class="badge ${o.status}">${escapeHtml(o.status.replace(/_/g, ' '))}</span>
          ${o.mobile ? `<span class="badge mobile">Mobile</span>` : ''}
        </div>
        <div class="card-customer">${escapeHtml(o.customer)}</div>
        <div class="card-vehicle">${escapeHtml(o.vehicle)}</div>
        <div class="card-location">${escapeHtml(coords.address)}</div>
        <div class="card-footer">
          <span>${miles} miles</span>
          <button type="button" class="mini-action" data-open-order="${escapeAttr(o.id)}">Open RO</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="dispatch-map-workspace">
      <div class="dispatch-map-toolbar">
        <div class="map-kpis">
          <div class="map-kpi"><span>Dispatched Locations</span><strong>${activeOrders.length}</strong></div>
          <div class="map-kpi mobile"><span>Mobile Dispatches</span><strong>${mobileCount}</strong></div>
          <div class="map-kpi in-progress"><span>In Progress</span><strong>${inProgressCount}</strong></div>
          <div class="map-kpi approved"><span>Approved Jobs</span><strong>${approvedCount}</strong></div>
        </div>
        <div class="map-filter-tabs">
          <button type="button" class="tab ${activeFilter === 'all' ? 'active' : ''}" data-map-filter="all">All Dispatched</button>
          <button type="button" class="tab ${activeFilter === 'mobile' ? 'active' : ''}" data-map-filter="mobile">Mobile Only (${mobileCount})</button>
          <button type="button" class="tab ${activeFilter === 'in_progress' ? 'active' : ''}" data-map-filter="in_progress">In Progress (${inProgressCount})</button>
          <button type="button" class="tab ${activeFilter === 'approved' ? 'active' : ''}" data-map-filter="approved">Approved</button>
        </div>
      </div>
      <div class="dispatch-map-layout">
        <div class="dispatch-map-panel" id="dispatch-leaflet-map" style="min-height: 560px; height: calc(100vh - 240px);"></div>
        <aside class="dispatch-map-sidebar">
          <div class="sidebar-head">
            <h3>Dispatched Work Orders</h3>
            <span class="count">${activeOrders.length} mapped</span>
          </div>
          <div class="sidebar-order-list">
            ${orderCards || '<div class="empty-lane">No dispatched customer locations to map</div>'}
          </div>
        </aside>
      </div>
    </div>
  `;
}
