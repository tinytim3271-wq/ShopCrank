import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantMediaHtml, bindAssistantMedia, createYouTubePlayer, speakableText, youtubeEmbedUrl } from './assistant-media.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<i data-lucide="${name}"></i>`;
const helpers = { escapeHtml, icon };

// Just enough DOM for the player and the bind step.
function fakeElement(tag) {
  const element = {
    tagName: tag.toUpperCase(), className: '', children: [], attributes: {}, dataset: {}, classList: { added: [], add(name) { this.added.push(name); } },
    get firstChild() { return this.children[0] || null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(child) { this.children.push(child); },
  };
  return element;
}
const fakeDoc = { createElement: fakeElement };

test('search results render thumbnails, play buttons and rebuilt links, escaping everything', () => {
  const html = assistantMediaHtml([{
    kind: 'youtube_search_results',
    videos: [
      { videoId: 'abcDEF12345', title: 'Brakes <b>fast</b>', channelTitle: 'Chris "Fix"', thumbnailUrl: 'https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg', url: 'javascript:alert(1)' },
      { videoId: 'not valid', title: 'dropped' },
      { videoId: 'xyzXYZ_9-87', title: 'Off-site thumb', thumbnailUrl: 'https://evil.example/x.jpg' },
    ],
  }], helpers);
  assert.match(html, /data-youtube-play="abcDEF12345"/);
  assert.match(html, /src="https:\/\/i\.ytimg\.com\/vi\/abcDEF12345\/mqdefault\.jpg"/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=abcDEF12345"/);
  assert.match(html, /Brakes &lt;b&gt;fast&lt;\/b&gt;/);
  assert.doesNotMatch(html, /javascript:|evil\.example|dropped|<iframe/);
  assert.match(html, /data-youtube-play="xyzXYZ_9-87"/);
});

test('a player result renders a mount point (not an iframe the sanitizer would strip)', () => {
  const html = assistantMediaHtml([{ kind: 'youtube_player', videoId: 'abcDEF12345', title: 'Rear brakes' }], helpers);
  assert.match(html, /data-youtube-mount="abcDEF12345"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.equal(assistantMediaHtml([{ kind: 'youtube_player', videoId: '"><script>' }], helpers), '');
  assert.equal(assistantMediaHtml([{ kind: 'something_else' }], helpers), '');
  assert.equal(assistantMediaHtml(undefined, helpers), '');
});

test('createYouTubePlayer builds a privacy-enhanced embed that sends a referrer; autoplay only when asked', () => {
  const player = createYouTubePlayer(fakeDoc, 'abcDEF12345', 'Rear brakes');
  const frame = player.children[0];
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.src, 'https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0');
  assert.equal(frame.attributes.referrerpolicy, 'strict-origin-when-cross-origin');
  assert.equal(frame.title, 'Rear brakes');
  assert.equal(createYouTubePlayer(fakeDoc, 'abcDEF12345', '', { autoplay: true }).children[0].src, youtubeEmbedUrl('abcDEF12345', { autoplay: true }));
  assert.match(youtubeEmbedUrl('abcDEF12345', { autoplay: true }), /autoplay=1/);
  assert.equal(createYouTubePlayer(fakeDoc, 'bad'), null);
});

test('bindAssistantMedia mounts players once and swaps a thumbnail for a playing embed on click', () => {
  const mount = Object.assign(fakeElement('div'), { dataset: { youtubeMount: 'abcDEF12345', youtubeTitle: 'Rear brakes' } });
  const card = fakeElement('article');
  let replacement = null;
  const button = Object.assign(fakeElement('button'), {
    dataset: { youtubePlay: 'xyzXYZ_9-87', youtubeTitle: 'Pads' },
    closest: () => card,
    replaceWith(node) { replacement = node; },
  });
  const root = { ownerDocument: fakeDoc, querySelectorAll: selector => (selector === '[data-youtube-mount]' ? [mount] : [button]) };
  bindAssistantMedia(root);
  bindAssistantMedia(root);
  assert.equal(mount.children.length, 1, 'mounting is idempotent across re-renders');
  assert.doesNotMatch(mount.children[0].children[0].src, /autoplay/);
  button.onclick();
  assert.match(replacement.children[0].src, /xyzXYZ_9-87\?rel=0&autoplay=1/);
  assert.deepEqual(card.classList.added, ['is-playing']);
  bindAssistantMedia(null);
});

test('speakableText drops links so spoken replies never read a URL aloud', () => {
  assert.equal(speakableText('Watch this: https://www.youtube.com/watch?v=abcDEF12345 for the steps.'), 'Watch this: for the steps.');
  assert.equal(speakableText('See www.example.com/page, then torque to spec.'), 'See, then torque to spec.');
  assert.equal(speakableText('No links here.'), 'No links here.');
  assert.equal(speakableText(undefined), '');
});
