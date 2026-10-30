// Plain text from uploaded documents. PDFs go through Workers AI toMarkdown when
// the binding supports it, otherwise a small text-operator extractor that covers
// ordinary text PDFs (scanned images need OCR and come back empty).

import { HttpError } from '../http.mjs';

const decoder = new TextDecoder();
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

function documentBudget(maxBytes) {
  let used = 0;
  return count => {
    used += count;
    if (used > maxBytes) throw new HttpError(413, 'Document extraction exceeds the cumulative size limit');
  };
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || '').replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

async function inflate(bytes, consume) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(value.byteLength);
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodePdfString(raw) {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, code) => {
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[code];
  });
}

function textFromContentStream(content) {
  const out = [];
  const tokens = /\((?:\\.|[^\\)])*\)|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD|ET|'|"/g;
  let match;
  while ((match = tokens.exec(content))) {
    const token = match[0];
    if (token.startsWith('(')) {
      const after = content.slice(tokens.lastIndex, tokens.lastIndex + 4);
      if (/^\s*(Tj|'|")/.test(after)) out.push(decodePdfString(token.slice(1, -1)));
    } else if (token.startsWith('[')) {
      const parts = token.match(/\((?:\\.|[^\\)])*\)/g) || [];
      out.push(parts.map(part => decodePdfString(part.slice(1, -1))).join(''));
    } else if (['T*', 'Td', 'TD', 'ET', "'", '"'].includes(token)) {
      out.push('\n');
    }
  }
  return out.join('').replace(/[ \t]+\n/g, '\n');
}

export async function extractPdfTextFallback(bytes, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  const consume = documentBudget(maxBytes);
  consume(bytes.byteLength);
  const source = latin1(bytes);
  const chunks = [];
  const streamPattern = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let match;
  while ((match = streamPattern.exec(source))) {
    const start = streamPattern.lastIndex;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    const declaredLength = /\/Length\s+(\d+)\s*(?:\/|$)/.exec(match[1]);
    let bodyEnd = declaredLength ? start + Number(declaredLength[1]) : end;
    if (bodyEnd > end) throw new HttpError(400, 'Invalid PDF stream length');
    if (!declaredLength) {
      if (bytes[bodyEnd - 1] === 10) bodyEnd--;
      if (bytes[bodyEnd - 1] === 13) bodyEnd--;
    }
    let body = bytes.subarray(start, bodyEnd);
    if (/\/FlateDecode/.test(match[1])) {
      try {
        body = await inflate(body, consume);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        continue;
      }
    } else if (/\/Filter/.test(match[1])) {
      continue;
    }
    const text = textFromContentStream(latin1(body));
    consume(new TextEncoder().encode(text).byteLength + 2);
    if (text.trim()) chunks.push(text.trim());
    streamPattern.lastIndex = end;
  }
  return chunks.join('\n\n');
}

export async function extractDocumentText(env, { bytes, mimeType = '', name = 'document' }) {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'Document exceeds the size limit');
  const type = String(mimeType || '').toLowerCase();
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  if (!isPdf) return decoder.decode(bytes);
  if (typeof env?.AI?.toMarkdown === 'function') {
    try {
      const [result] = await env.AI.toMarkdown([{ name, blob: new Blob([bytes], { type: 'application/pdf' }) }]);
      if (result?.data && String(result.data).trim()) {
        documentBudget(MAX_DOCUMENT_BYTES)(bytes.byteLength + new TextEncoder().encode(String(result.data)).byteLength);
        return String(result.data);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Fall through to the local extractor.
    }
  }
  return extractPdfTextFallback(bytes);
}
