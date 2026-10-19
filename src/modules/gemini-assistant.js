/**
 * ShopCrank Gemini Voice & Chat Assistant Module
 * Features:
 * - Real-time conversational AI powered by Gemini 2.5 Flash / 3.8 Flash
 * - Grounded with Google Search data on all responses
 * - Voice features: Speech-to-text recording, audio transcription, and voice playback (TTS)
 * - Accessible via button on every page in the app
 * - Context-aware of active work orders, customer dispatches, vehicles, and shop operations
 */

import { escapeHtml, escapeAttr } from '../shared/html.js';

let conversationHistory = [];
let isVoiceRecording = false;
let mediaRecorder = null;
let audioStream = null;
let audioChunks = [];
let speechSynthUtterance = null;
let isSpeaking = false;
let voiceOutputEnabled = true;
let isModalOpen = false;

export function isAssistantOpen() {
  return isModalOpen;
}

// Quick action suggestions
const QUICK_PROMPTS = [
  'Status of today\'s mobile dispatches',
  'Diagnose DTC code P0300 on Ram 1500',
  'Look up front brake rotor torque specs',
  'Search manufacturer recall for Ford F-150',
  'Estimate labor time for water pump replacement',
];

/**
 * Gather current application state for shop context
 */
function getShopContext() {
  try {
    const rawState = window.__SHOP_CRANK_STATE__ || {};
    const orders = Array.isArray(rawState.orders) ? rawState.orders : [];
    const activeOrders = orders
      .filter((o) => !['completed', 'invoiced', 'declined', 'archived'].includes(o.status))
      .map((o) => ({
        id: o.id,
        customer: o.customer,
        vehicle: o.vehicle,
        complaint: o.complaint,
        status: o.status,
        mobile: Boolean(o.mobile),
        tech: o.tech,
        promise: o.promise,
        address: o.jobAddress || o.address || '',
      }));

    const mobileOrders = activeOrders.filter((o) => o.mobile);

    return {
      currentRoute: rawState.route || 'dispatch',
      activeOrders: activeOrders.slice(0, 10),
      mobileOrders,
      orderCount: activeOrders.length,
      shopProfile: {
        shopName: 'ShopCrank Mobile & Shop Service',
        laborRate: 140,
        address: '101 Main St, Lubbock, TX',
      },
    };
  } catch {
    return { currentRoute: 'dispatch', activeOrders: [] };
  }
}

/**
 * Format grounding search queries and web sources markup
 */
function renderGroundingSources(grounding) {
  if (!grounding) return '';
  const queries = Array.isArray(grounding.queries) ? grounding.queries : [];
  const sources = Array.isArray(grounding.sources) ? grounding.sources : [];

  if (queries.length === 0 && sources.length === 0) return '';

  const queriesHtml = queries.length
    ? `<div class="grounding-queries">
        <span class="grounding-label">Google Search:</span>
        ${queries.map((q) => `<span class="search-query-chip">${escapeHtml(q)}</span>`).join('')}
       </div>`
    : '';

  const sourcesHtml = sources.length
    ? `<div class="grounding-sources">
        <span class="grounding-label">Sources:</span>
        <ul class="grounding-links-list">
          ${sources
            .slice(0, 4)
            .map((s) => {
              const url = s.url || '#';
              const title = s.title || url.replace(/^https?:\/\//, '').split('/')[0];
              return `<li><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="grounding-link">${escapeHtml(title)}</a></li>`;
            })
            .join('')}
        </ul>
       </div>`
    : '';

  return `<div class="gemini-grounding-box">
    <div class="grounding-header">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Grounded with Google Search data</span>
    </div>
    ${queriesHtml}
    ${sourcesHtml}
  </div>`;
}

/**
 * Render single message markup
 */
function renderMessageItem(msg) {
  const isUser = msg.role === 'user';
  const roleLabel = isUser ? 'You' : 'Gemini Assistant';
  const timeStr = msg.time || new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const groundingHtml = !isUser && msg.grounding ? renderGroundingSources(msg.grounding) : '';

  return `
    <article class="gemini-msg ${isUser ? 'user' : 'assistant'}">
      <div class="gemini-msg-header">
        <span class="gemini-msg-author">${roleLabel}</span>
        <time class="gemini-msg-time">${timeStr}</time>
      </div>
      <div class="gemini-msg-body">
        ${escapeHtml(msg.content).replace(/\n/g, '<br>')}
      </div>
      ${groundingHtml}
    </article>
  `;
}

/**
 * Text-to-speech speak function
 */
function speakText(text) {
  if (!voiceOutputEnabled || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    // Clean markdown or technical noise for smoother speech
    const cleanSpeech = text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_#`~]/g, '')
      .slice(0, 450);

    const UtteranceClass = window.SpeechSynthesisUtterance;
    if (!UtteranceClass) return;
    speechSynthUtterance = new UtteranceClass(cleanSpeech);
    speechSynthUtterance.rate = 1.05;
    speechSynthUtterance.pitch = 1.0;
    speechSynthUtterance.onstart = () => {
      isSpeaking = true;
      updateVoicePlayButton(true);
    };
    speechSynthUtterance.onend = () => {
      isSpeaking = false;
      updateVoicePlayButton(false);
    };
    speechSynthUtterance.onerror = () => {
      isSpeaking = false;
      updateVoicePlayButton(false);
    };
    window.speechSynthesis.speak(speechSynthUtterance);
  } catch (err) {
    console.warn('Speech synthesis error:', err);
  }
}

export function isAssistantSpeaking() {
  return isSpeaking;
}

function stopSpeaking() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  isSpeaking = false;
  updateVoicePlayButton(false);
}

function updateVoicePlayButton(speaking) {
  const btn = document.querySelector('#gemini-tts-toggle');
  if (btn) {
    btn.classList.toggle('active', speaking);
    btn.setAttribute('title', speaking ? 'Stop voice playback' : 'Voice output active');
  }
}

/**
 * Start/Stop audio recording with microphone
 */
async function toggleVoiceRecording() {
  const micBtn = document.querySelector('#gemini-mic-btn');
  const statusEl = document.querySelector('#gemini-voice-indicator');

  if (isVoiceRecording) {
    // Stop recording
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    isVoiceRecording = false;
    if (micBtn) {
      micBtn.classList.remove('recording');
      micBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg> <span>Speak</span>`;
    }
    if (statusEl) statusEl.textContent = 'Transcribing with Gemini…';
    return;
  }

  // Try browser Web Speech API for immediate live speech recognition if supported
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      const input = document.querySelector('#gemini-chat-input');

      recognition.onstart = () => {
        isVoiceRecording = true;
        if (micBtn) {
          micBtn.classList.add('recording');
          micBtn.innerHTML = `<span class="rec-dot"></span> <span>Listening…</span>`;
        }
        if (statusEl) statusEl.textContent = 'Listening to speech…';
      };

      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join('');
        if (input) input.value = transcript;
      };

      recognition.onend = () => {
        isVoiceRecording = false;
        if (micBtn) {
          micBtn.classList.remove('recording');
          micBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg> <span>Speak</span>`;
        }
        if (statusEl) statusEl.textContent = '';
        if (input && input.value.trim()) {
          handleSendMessage(input.value.trim());
          input.value = '';
        }
      };

      recognition.onerror = () => {
        // Fallback to MediaRecorder audio upload
        fallbackMediaRecorderRecording();
      };

      recognition.start();
      return;
    } catch {
      // Fallback to mediaRecorder
    }
  }

  fallbackMediaRecorderRecording();
}

async function fallbackMediaRecorderRecording() {
  const micBtn = document.querySelector('#gemini-mic-btn');
  const statusEl = document.querySelector('#gemini-voice-indicator');

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    if (statusEl) statusEl.textContent = 'Audio input is not supported in this browser.';
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new window.MediaRecorder(audioStream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      audioStream?.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });

      if (statusEl) statusEl.textContent = 'Transcribing with Gemini…';

      try {
        const response = await fetch('/api/ai/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': audioBlob.type },
          body: audioBlob,
        });

        const data = await response.json();
        if (data.transcript && data.transcript.trim()) {
          const input = document.querySelector('#gemini-chat-input');
          if (input) input.value = data.transcript;
          handleSendMessage(data.transcript);
          if (input) input.value = '';
        } else {
          if (statusEl) statusEl.textContent = 'Could not catch audio, please try again.';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Voice transcription error: ' + err.message;
      }
    };

    mediaRecorder.start();
    isVoiceRecording = true;
    if (micBtn) {
      micBtn.classList.add('recording');
      micBtn.innerHTML = `<span class="rec-dot"></span> <span>Recording…</span>`;
    }
    if (statusEl) statusEl.textContent = 'Recording speech (click to send)…';
  } catch {
    if (statusEl) statusEl.textContent = 'Microphone permission was not granted.';
  }
}

/**
 * Send user message to Gemini endpoint
 */
async function handleSendMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;

  const sendBtn = document.querySelector('#gemini-send-btn');
  const statusEl = document.querySelector('#gemini-voice-indicator');

  // Push user message
  conversationHistory.push({
    role: 'user',
    content: trimmed,
    time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  });

  // Re-render list
  renderMessagesInContainer();

  if (sendBtn) sendBtn.disabled = true;
  if (statusEl) statusEl.textContent = 'Gemini searching Google & generating answer…';

  try {
    const shopContext = getShopContext();
    const historyPayload = conversationHistory.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await fetch('/api/ai/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: trimmed,
        history: historyPayload,
        context: shopContext,
      }),
    });

    const data = await response.json();
    const answer = data.message || data.content || 'I completed the request.';

    conversationHistory.push({
      role: 'assistant',
      content: answer,
      grounding: data.grounding || null,
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    });

    renderMessagesInContainer();

    // Auto-speak reply if enabled
    if (voiceOutputEnabled) {
      speakText(answer);
    }
  } catch (err) {
    conversationHistory.push({
      role: 'assistant',
      content: `Sorry, an error occurred: ${err.message}. Please verify your connection.`,
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    });
    renderMessagesInContainer();
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (statusEl) statusEl.textContent = '';
  }
}

function renderMessagesInContainer() {
  const container = document.querySelector('#gemini-messages-list');
  if (!container) return;

  if (conversationHistory.length === 0) {
    container.innerHTML = `
      <div class="gemini-welcome-empty">
        <div class="gemini-empty-badge">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>
        </div>
        <h3>Gemini Voice &amp; Dispatch Assistant</h3>
        <p>Ask anything about active work orders, customer dispatches, vehicle diagnostics, torque specs, or repair procedures. Grounded with live Google Search data.</p>
        <div class="gemini-quick-prompts">
          ${QUICK_PROMPTS.map((qp) => `<button type="button" class="gemini-chip" data-quick-prompt="${escapeAttr(qp)}">${escapeHtml(qp)}</button>`).join('')}
        </div>
      </div>
    `;
    bindQuickChips();
    return;
  }

  container.innerHTML = conversationHistory.map(renderMessageItem).join('');
  container.scrollTop = container.scrollHeight;
}

function bindQuickChips() {
  document.querySelectorAll('[data-quick-prompt]').forEach((btn) => {
    btn.onclick = () => {
      const qp = btn.dataset.quickPrompt;
      if (qp) handleSendMessage(qp);
    };
  });
}

/**
 * Open the Gemini Assistant Modal
 */
export function openGeminiAssistant(initialPrompt = '') {
  isModalOpen = true;

  let modalBackdrop = document.querySelector('#gemini-assistant-modal');
  if (!modalBackdrop) {
    modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'gemini-assistant-modal';
    modalBackdrop.className = 'gemini-modal-backdrop';
    document.body.appendChild(modalBackdrop);
  }

  modalBackdrop.innerHTML = `
    <div class="gemini-drawer" role="dialog" aria-modal="true" aria-label="Gemini Assistant">
      <header class="gemini-drawer-head">
        <div class="gemini-brand-box">
          <div class="gemini-sparkle-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>
          </div>
          <div>
            <h2>Gemini AI Assistant</h2>
            <div class="gemini-status-tag">
              <span class="pulse-indicator"></span>
              <span>Grounded with Google Search · Live Voice Active</span>
            </div>
          </div>
        </div>
        <div class="gemini-head-actions">
          <button type="button" class="gemini-icon-btn ${voiceOutputEnabled ? 'active' : ''}" id="gemini-tts-toggle" title="${voiceOutputEnabled ? 'Voice output is enabled' : 'Voice output is muted'}">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          </button>
          <button type="button" class="gemini-icon-btn" id="gemini-clear-btn" title="Clear chat history">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
          <button type="button" class="gemini-close-btn" id="gemini-close-drawer" aria-label="Close Gemini Assistant">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </header>

      <div class="gemini-messages-wrapper" id="gemini-messages-list"></div>

      <div class="gemini-footer">
        <div id="gemini-voice-indicator" class="gemini-status-text"></div>
        <form class="gemini-chat-form" id="gemini-chat-form">
          <textarea
            id="gemini-chat-input"
            name="message"
            rows="2"
            placeholder="Type or click 'Speak' to ask Gemini with Google Search data…"
            aria-label="Ask Gemini"
          ></textarea>
          <div class="gemini-controls-row">
            <button type="button" class="gemini-mic-btn" id="gemini-mic-btn" title="Speak question">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
              <span>Speak</span>
            </button>
            <button type="button" class="gemini-stop-speech-btn" id="gemini-stop-speech-btn" title="Stop speaking">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" x2="23" y1="1" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>
            </button>
            <button type="submit" class="gemini-send-btn" id="gemini-send-btn" title="Send message">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              <span>Ask Gemini</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  modalBackdrop.style.display = 'flex';

  // Bind close
  document.querySelector('#gemini-close-drawer')?.addEventListener('click', closeGeminiAssistant);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeGeminiAssistant();
  });

  // Bind clear
  document.querySelector('#gemini-clear-btn')?.addEventListener('click', () => {
    conversationHistory = [];
    stopSpeaking();
    renderMessagesInContainer();
  });

  // Bind TTS toggle
  document.querySelector('#gemini-tts-toggle')?.addEventListener('click', () => {
    voiceOutputEnabled = !voiceOutputEnabled;
    const btn = document.querySelector('#gemini-tts-toggle');
    if (btn) btn.classList.toggle('active', voiceOutputEnabled);
    if (!voiceOutputEnabled) stopSpeaking();
  });

  // Bind mic
  document.querySelector('#gemini-mic-btn')?.addEventListener('click', toggleVoiceRecording);
  document.querySelector('#gemini-stop-speech-btn')?.addEventListener('click', stopSpeaking);

  // Bind form
  const form = document.querySelector('#gemini-chat-form');
  const input = document.querySelector('#gemini-chat-input');

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input) return;
    const text = input.value.trim();
    if (text) {
      handleSendMessage(text);
      input.value = '';
    }
  });

  // Ctrl+Enter / Enter to send
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form?.requestSubmit();
    }
  });

  renderMessagesInContainer();

  if (initialPrompt) {
    handleSendMessage(initialPrompt);
  } else {
    input?.focus();
  }
}

export function closeGeminiAssistant() {
  isModalOpen = false;
  stopSpeaking();
  if (isVoiceRecording) toggleVoiceRecording();
  const modalBackdrop = document.querySelector('#gemini-assistant-modal');
  if (modalBackdrop) {
    modalBackdrop.style.display = 'none';
  }
}

/**
 * Mount the Universal Gemini Assistant launcher button on every page
 */
export function mountUniversalGeminiButton() {
  if (document.querySelector('#gemini-universal-launcher')) return;

  const launcher = document.createElement('div');
  launcher.id = 'gemini-universal-launcher';
  launcher.className = 'gemini-universal-launcher';
  launcher.innerHTML = `
    <button type="button" class="gemini-float-btn" id="gemini-fab-button" title="Open Gemini AI Voice Assistant (Grounded with Google Search)" aria-label="Open Gemini Voice &amp; Chat Assistant">
      <span class="gemini-fab-sparkle">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>
      </span>
      <span class="gemini-fab-text">Gemini AI</span>
      <span class="gemini-fab-voice-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      </span>
    </button>
  `;

  document.body.appendChild(launcher);

  document.querySelector('#gemini-fab-button')?.addEventListener('click', () => {
    openGeminiAssistant();
  });
}
