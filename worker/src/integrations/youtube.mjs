// YouTube Data API v3 for the text assistant's video tools. Platform key:
// YOUTUBE_API_KEY (Google Cloud API key restricted to the YouTube Data API).
// search.list costs 100 quota units per call (default quota 10,000/day).

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 8;
const TIMEOUT_MS = 8_000;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'" };

export function youtubeConfigured(env) {
  return Boolean(String(env?.YOUTUBE_API_KEY || '').trim());
}

export function isYouTubeVideoId(value) {
  return VIDEO_ID.test(String(value || ''));
}

/** Video id from an id, a youtube.com/watch?v= URL, a youtu.be link, or an embed/shorts URL. */
export function parseYouTubeVideoId(input) {
  const value = String(input || '').trim();
  if (isYouTubeVideoId(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.split('/')[1] || '';
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] || '';
  }
  return isYouTubeVideoId(id) ? id : '';
}

export const youtubeWatchUrl = videoId => `https://www.youtube.com/watch?v=${videoId}`;
export const youtubeEmbedUrl = videoId => `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`;

function decodeEntities(text) {
  return String(text || '').replace(/&(amp|lt|gt|quot|#39|#039);/g, match => ENTITIES[match]);
}

function thumbnail(thumbnails = {}) {
  const best = thumbnails.medium || thumbnails.high || thumbnails.default || {};
  return /^https:\/\/i\.ytimg\.com\//.test(best.url || '') ? best.url : '';
}

/**
 * Search embeddable, safe-search-strict videos. Returns { query, videos }, each
 * video { videoId, title, channelTitle, publishedAt, thumbnailUrl, url }.
 * Throws on HTTP or network errors (with .status / .code when YouTube gives one).
 */
export async function searchYouTubeVideos(env, { query, maxResults = DEFAULT_RESULTS } = {}, { fetcher = env?.fetch || fetch } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw Object.assign(new Error('A search query is required'), { code: 'missing_query' });
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(Number(maxResults)) || DEFAULT_RESULTS));
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: 'strict',
    maxResults: String(limit),
    q,
    key: String(env.YOUTUBE_API_KEY || '').trim(),
  });
  const response = await fetcher(`${YOUTUBE_API_BASE}/search?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
    throw Object.assign(new Error(body?.error?.message || `YouTube API returned HTTP ${response.status}`), { status: response.status, code: reason || 'youtube_error' });
  }
  const videos = (body.items || [])
    .map(item => ({ videoId: item?.id?.videoId, snippet: item?.snippet || {} }))
    .filter(({ videoId }) => isYouTubeVideoId(videoId))
    .map(({ videoId, snippet }) => ({
      videoId,
      title: decodeEntities(snippet.title).slice(0, 200),
      channelTitle: decodeEntities(snippet.channelTitle).slice(0, 120),
      publishedAt: String(snippet.publishedAt || ''),
      thumbnailUrl: thumbnail(snippet.thumbnails),
      url: youtubeWatchUrl(videoId),
    }));
  return { query: q, videos };
}

/** Cheapest authenticated call (1 quota unit) for the health check. */
export async function pingYouTube(env, { fetcher = env?.fetch || fetch } = {}) {
  const params = new URLSearchParams({ part: 'snippet', hl: 'en', key: String(env.YOUTUBE_API_KEY || '').trim() });
  const response = await fetcher(`${YOUTUBE_API_BASE}/i18nLanguages?${params}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body?.error?.message || `YouTube API returned HTTP ${response.status}`), { status: response.status, code: body?.error?.errors?.[0]?.reason || 'youtube_error' });
  }
  return true;
}
