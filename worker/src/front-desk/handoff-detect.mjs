// Detectors that decide, server-side, when a Front Desk caller goes to a human.
// They run on every finished caller transcript and on keypad presses, so the
// transfer never depends on the model choosing to call transfer_to_staff.

const PERSON_WORDS = String.raw`(?:a\s+)?(?:real\s+|live\s+|actual\s+)?(?:human(?:\s+being)?|person|people|somebody|someone|anyone|representative|rep|agent|operator|manager|supervisor|owner|boss|staff|employee|mechanic|tech(?:nician)?|service\s+advisor|customer\s+service|front\s+desk)`;

// After "get me a manager" / "I want a person" the request must end there, so
// "can I get a mechanic to look at it" or "the owner's manual" do not match.
const REQUEST_END = String.raw`(?!'s)(?=\s*(?:$|[.!?,;]|please\b|now\b|right\s+now|immediately|on\s+the\s+(?:phone|line)|who\b|i\s+can\b|asap))`;

const REQUEST_PATTERNS = [
  // "can I talk to a person", "let me speak with someone", "connect me to the manager"
  new RegExp(String.raw`\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:the\s+|your\s+|a\s+|an\s+)?${PERSON_WORDS}\b(?!'s)`, 'i'),
  new RegExp(String.raw`\b(?:connect|transfer|put|patch)\s+me\s+(?:through\s+)?(?:to|with)\s+(?:the\s+|your\s+|a\s+|an\s+)?${PERSON_WORDS}\b(?!'s)`, 'i'),
  new RegExp(String.raw`\b(?:get|give)\s+me\s+(?:the\s+|your\s+|a\s+|an\s+)?${PERSON_WORDS}${REQUEST_END}`, 'i'),
  new RegExp(String.raw`\b(?:i\s+(?:want|need|would\s+like|'d\s+like)|i'd\s+like|can\s+i\s+(?:get|have)|could\s+i\s+(?:get|have)|may\s+i\s+have)\s+(?:the\s+|your\s+|a\s+|an\s+)?${PERSON_WORDS}${REQUEST_END}`, 'i'),
  new RegExp(String.raw`\b(?:i\s+(?:want|need|would\s+like|'d\s+like)|i'd\s+like|can\s+i|could\s+i|may\s+i|let\s+me)\s+(?:to\s+)?(?:talk|speak)\s+(?:to|with)\s+(?:the\s+|your\s+|a\s+|an\s+)?${PERSON_WORDS}\b(?!'s)`, 'i'),
  new RegExp(String.raw`\b(?:is\s+there|are\s+there)\s+(?:a\s+|an\s+|any\s+)?(?:real\s+|live\s+|actual\s+)?(?:human|person|people|someone|somebody|anyone)\b.{0,20}\b(?:i\s+can|to)\s+(?:talk|speak)\b`, 'i'),
  /\b(?:real|live|actual)\s+(?:human|person|people|agent)\b/i,
  /\bare\s+you\s+(?:a\s+)?(?:robot|bot|machine|computer|ai)\b.{0,40}\b(?:person|human|someone)\b/i,
  /\b(?:not|stop)\s+(?:talking\s+to\s+)?(?:a\s+)?(?:robot|bot|machine|computer)\b/i,
];

// The whole utterance is (nearly) just the request word: "Representative!", "operator please".
const BARE_REQUEST = /^\W*(?:um+\W+|uh+\W+|yeah\W+|hey\W+)?(?:a\s+)?(?:real\s+)?(?:human|person|representative|rep|agent|operator|manager|owner|customer\s+service|someone|somebody|a\s+person)(?:\W+please)?\W*$/i;

const NEGATED_REQUEST = /\b(?:no|don'?t|do\s+not|doesn'?t|not)\s+(?:need|want|have)\s+(?:to\s+)?(?:talk|speak|a|an|the|to)?\s*(?:\w+\s+){0,3}(?:human|person|someone|representative|agent|operator|manager|owner)\b/i;

/** Intent match for "let me talk to a person" and its many phrasings. */
export function detectHandoffRequest(text) {
  const value = String(text || '').trim();
  if (!value) return { matched: false };
  if (NEGATED_REQUEST.test(value)) return { matched: false };
  if (BARE_REQUEST.test(value)) return { matched: true, reason: 'asked_for_person' };
  if (REQUEST_PATTERNS.some(pattern => pattern.test(value))) return { matched: true, reason: 'asked_for_person' };
  return { matched: false };
}

const PROFANITY = /\b(?:f+u+c+k+\w*|sh[i1]+t+\w*|bullsh[i1]t|damn(?:ed|it)?|goddamn\w*|ass(?:hole)?s?|bitch\w*|crap|piss(?:ed)?|wtf|bastard|screw\s+(?:you|this))\b/i;
const THREATS = /\b(?:sue|suing|lawsuit|lawyer|attorney|small\s+claims|better\s+business\s+bureau|bbb|report\s+(?:you|this|your)|call(?:ing)?\s+the\s+(?:police|cops)|news\s+station|bad\s+review|one[-\s]star|chargeback|dispute\s+the\s+charge)\b/i;
const FRUSTRATION_PHRASES = [
  /\bthis\s+is\s+(?:ridiculous|unacceptable|absurd|insane|a\s+joke|crazy|stupid|bs)\b/i,
  /\b(?:ridiculous|unacceptable|outrageous|incompetent|useless|worthless|pathetic)\b/i,
  /\b(?:fed\s+up|sick\s+(?:and\s+tired\s+)?of|had\s+enough|waste\s+of\s+(?:my\s+)?time|worst\s+(?:service|shop|experience))\b/i,
  /\b(?:you(?:'re|\s+are)\s+not\s+listening|are\s+you\s+(?:even\s+)?listening|i\s+(?:already|just)\s+(?:told|said)|how\s+many\s+times|stupid\s+(?:bot|robot|machine))\b/i,
  /\b(?:i'?m|i\s+am)\s+(?:so\s+)?(?:angry|furious|livid|pissed|upset|frustrated|mad)\b/i,
];

function meaningfulTokens(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9']+/g) || []).filter(token => token.length > 2));
}

function similarity(a, b) {
  const left = meaningfulTokens(a);
  const right = meaningfulTokens(b);
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function isShouting(text) {
  const letters = String(text || '').replace(/[^a-z]/gi, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  const words = String(text || '').split(/\s+/).filter(word => /^[A-Z]{2,}[!?.,]*$/.test(word)).length;
  return letters.length >= 12 && upper / letters.length >= 0.7 && words >= 3;
}

/**
 * Frustration from wording, repetition, and optional sentiment signals.
 * `sentiment` is a score in [-1, 1] and/or a tone label when the speech
 * pipeline provides one.
 */
export function detectFrustration({ text, previousCallerTurns = [], sentiment = null, tone = '' } = {}) {
  const value = String(text || '');
  const signals = [];
  if (PROFANITY.test(value)) signals.push('profanity');
  if (THREATS.test(value)) signals.push('threat');
  if (FRUSTRATION_PHRASES.some(pattern => pattern.test(value))) signals.push('frustrated_wording');
  if (isShouting(value)) signals.push('shouting');
  if (previousCallerTurns.some(turn => similarity(turn, value) >= 0.6)) signals.push('repeated_complaint');
  if (Number.isFinite(Number(sentiment)) && sentiment !== null && Number(sentiment) <= -0.6) signals.push('negative_sentiment');
  if (/^(?:angry|frustrated|annoyed|hostile|upset)$/i.test(String(tone || '').trim())) signals.push('angry_tone');
  return signals.length ? { matched: true, reason: 'frustration', signals } : { matched: false, signals };
}

export function classifyCallerTurn({ text, previousCallerTurns = [], sentiment = null, tone = '' }) {
  const request = detectHandoffRequest(text);
  if (request.matched) return { handoff: true, trigger: 'request', reason: request.reason, signals: [] };
  const frustration = detectFrustration({ text, previousCallerTurns, sentiment, tone });
  if (frustration.matched) return { handoff: true, trigger: 'frustration', reason: frustration.signals.join(','), signals: frustration.signals };
  return { handoff: false };
}

/** Two or more 0 presses, or two or more * presses, within the window. */
export function createDtmfTracker({ windowMs = 6000, now = () => Date.now() } = {}) {
  let last = '';
  let count = 0;
  let lastAt = 0;
  return {
    press(digit) {
      const key = String(digit || '');
      const at = now();
      if (key === last && at - lastAt <= windowMs) count += 1;
      else count = 1;
      last = key;
      lastAt = at;
      return (key === '0' || key === '*') && count >= 2;
    },
  };
}

export const HANDOFF_LINE = 'Sure, connecting you now.';
