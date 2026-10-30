/** Media the text assistant's tools return (YouTube results, a video player), rendered under a reply. */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const THUMBNAIL = /^https:\/\/i\.ytimg\.com\/[^\s"'<>]+$/;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;

export const isYouTubeVideoId = value => VIDEO_ID.test(String(value || ''));
// Links are rebuilt from the validated id, never taken from the response.
export const youtubeWatchUrl = videoId => `https://www.youtube.com/watch?v=${videoId}`;
export const youtubeEmbedUrl = (videoId, { autoplay = false } = {}) => `https://www.youtube-nocookie.com/embed/${videoId}?rel=0${autoplay ? '&autoplay=1' : ''}`;

/** Reply text for speech synthesis: links are dropped so nothing reads a URL aloud. */
export function speakableText(text) {
  return String(text || '').replace(URL_IN_TEXT, url => url.match(/[.,;:!?]+$/)?.[0] || '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/**
 * Player element built with DOM APIs: the app's HTML sanitizer strips iframes
 * from rendered markup, so players are mounted after each render instead.
 * YouTube needs a referrer from the embedding page or it refuses to play.
 */
export function createYouTubePlayer(doc, videoId, title = '', { autoplay = false } = {}) {
  if (!isYouTubeVideoId(videoId)) return null;
  const wrapper = doc.createElement('div');
  wrapper.className = 'assistant-video-player';
  const frame = doc.createElement('iframe');
  frame.src = youtubeEmbedUrl(videoId, { autoplay });
  frame.title = String(title || 'YouTube video');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen');
  frame.setAttribute('allowfullscreen', '');
  wrapper.append(frame);
  return wrapper;
}

function videoCard(video, { escapeHtml, icon }) {
  if (!isYouTubeVideoId(video?.videoId)) return '';
  const thumb = THUMBNAIL.test(video.thumbnailUrl || '') ? `<img src="${escapeHtml(video.thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="assistant-video-placeholder">${icon('play', 22)}</span>`;
  return `<article class="assistant-video-card" data-youtube-card="${video.videoId}"><button type="button" class="assistant-video-thumb" data-youtube-play="${video.videoId}" data-youtube-title="${escapeHtml(video.title || '')}" aria-label="Play ${escapeHtml(video.title || 'video')}">${thumb}<span class="assistant-video-play">${icon('play', 18)}</span></button><div class="assistant-video-meta"><b>${escapeHtml(video.title || 'YouTube video')}</b><small>${escapeHtml(video.channelTitle || '')}</small><a href="${youtubeWatchUrl(video.videoId)}" target="_blank" rel="noopener noreferrer">${icon('external-link', 12)} Open on YouTube</a></div></article>`;
}

/** Markup for one reply's media list; unknown kinds and invalid ids render nothing. */
export function assistantMediaHtml(media, helpers) {
  const blocks = (Array.isArray(media) ? media : []).map((item) => {
    if (item?.kind === 'youtube_search_results') {
      const cards = (item.videos || []).map(video => videoCard(video, helpers)).join('');
      return cards ? `<div class="assistant-video-grid">${cards}</div>` : '';
    }
    if (item?.kind === 'youtube_player' && isYouTubeVideoId(item.videoId)) {
      return `<div class="assistant-video-card is-playing" data-youtube-card="${item.videoId}"><div data-youtube-mount="${item.videoId}" data-youtube-title="${helpers.escapeHtml(item.title || '')}"></div><div class="assistant-video-meta"><b>${helpers.escapeHtml(item.title || 'YouTube video')}</b><a href="${youtubeWatchUrl(item.videoId)}" target="_blank" rel="noopener noreferrer">${helpers.icon('external-link', 12)} Open on YouTube</a></div></div>`;
    }
    return '';
  }).join('');
  return blocks ? `<div class="assistant-media">${blocks}</div>` : '';
}

/**
 * Mount requested players and wire click-to-play on thumbnails (a search result
 * loads YouTube only when someone presses play). Safe to call after every render.
 */
export function bindAssistantMedia(root) {
  if (!root?.querySelectorAll) return;
  const doc = root.ownerDocument || root;
  root.querySelectorAll('[data-youtube-mount]').forEach((mount) => {
    if (mount.firstChild) return;
    const player = createYouTubePlayer(doc, mount.dataset.youtubeMount, mount.dataset.youtubeTitle);
    if (player) mount.append(player);
  });
  root.querySelectorAll('[data-youtube-play]').forEach((button) => {
    button.onclick = () => {
      const player = createYouTubePlayer(doc, button.dataset.youtubePlay, button.dataset.youtubeTitle, { autoplay: true });
      if (!player) return;
      button.closest('[data-youtube-card]')?.classList.add('is-playing');
      button.replaceWith(player);
    };
  });
}
