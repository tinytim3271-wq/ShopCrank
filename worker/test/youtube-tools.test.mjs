import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { runAnthropicTurn } from '../src/ai.mjs';
import {
  TEXT_ONLY_TOOL_LIST,
  authorizeAssistantTool,
  executeAssistantTool,
  normalizeChannel,
  toolsFor,
} from '../src/assistant/tools.mjs';
import { PERSONAS } from '../src/assistant/personas.mjs';
import { checkToolOutput } from '../src/health/schema.mjs';
import { parseYouTubeVideoId, searchYouTubeVideos } from '../src/integrations/youtube.mjs';

const KEY = 'test-only-youtube-key';
const VIDEO_TOOLS = ['search_youtube_videos', 'show_youtube_video'];

function youtubeFetch({ status = 200, body } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(new URL(String(url)));
    return Response.json(body ?? {
      items: [
        { id: { kind: 'youtube#video', videoId: 'abcDEF12345' }, snippet: { title: 'Rear Brake Pads &amp; Rotors &#39;15 F-150', channelTitle: 'ChrisFix', publishedAt: '2024-01-02T00:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg' } } } },
        { id: { kind: 'youtube#video', videoId: 'bad id' }, snippet: { title: 'dropped' } },
        { id: { kind: 'youtube#video', videoId: 'xyzXYZ_9-87' }, snippet: { title: 'No thumb', channelTitle: 'Shop', thumbnails: { default: { url: 'https://evil.example/x.jpg' } } } },
      ],
    }, { status });
  };
  return { fetcher, calls };
}

const textArgs = { shopId: 'shop-1', persona: PERSONAS.TECH, role: 'technician', channel: 'text' };

test('parseYouTubeVideoId accepts ids and YouTube links only', () => {
  for (const input of ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']) {
    assert.equal(parseYouTubeVideoId(input), 'dQw4w9WgXcQ', input);
  }
  for (const input of ['', 'short', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com/watch?v=<script>']) {
    assert.equal(parseYouTubeVideoId(input), '', input);
  }
});

test('searchYouTubeVideos asks for embeddable safe-search videos and returns titles, thumbnails and URLs', async () => {
  const { fetcher, calls } = youtubeFetch();
  const result = await searchYouTubeVideos({ YOUTUBE_API_KEY: KEY }, { query: '  F-150 rear brakes ', maxResults: 50 }, { fetcher });
  const url = calls[0];
  assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/search');
  assert.equal(url.searchParams.get('q'), 'F-150 rear brakes');
  assert.equal(url.searchParams.get('type'), 'video');
  assert.equal(url.searchParams.get('safeSearch'), 'strict');
  assert.equal(url.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(url.searchParams.get('maxResults'), '8');
  assert.equal(url.searchParams.get('key'), KEY);
  assert.deepEqual(result.videos[0], {
    videoId: 'abcDEF12345',
    title: "Rear Brake Pads & Rotors '15 F-150",
    channelTitle: 'ChrisFix',
    publishedAt: '2024-01-02T00:00:00Z',
    thumbnailUrl: 'https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=abcDEF12345',
  });
  assert.equal(result.videos.length, 2, 'invalid ids are dropped');
  assert.equal(result.videos[1].thumbnailUrl, '', 'only i.ytimg.com thumbnails are passed through');

  const denied = youtubeFetch({ status: 403, body: { error: { message: 'quota exceeded', errors: [{ reason: 'quotaExceeded' }] } } });
  await assert.rejects(searchYouTubeVideos({ YOUTUBE_API_KEY: KEY }, { query: 'x' }, { fetcher: denied.fetcher }), error => error.status === 403 && error.code === 'quotaExceeded');
});

test('video tools are offered only to the tech assistant on the text channel', () => {
  const names = (persona, role, options) => toolsFor(persona, role, 'anthropic', options).map(tool => tool.name);
  assert.deepEqual(TEXT_ONLY_TOOL_LIST, VIDEO_TOOLS);
  for (const name of VIDEO_TOOLS) {
    assert.ok(names(PERSONAS.TECH, 'technician', { channel: 'text' }).includes(name));
    assert.ok(!names(PERSONAS.TECH, 'technician').includes(name), 'default channel is voice');
    assert.ok(!names(PERSONAS.TECH, 'admin', { channel: 'voice' }).includes(name));
    assert.ok(!names(PERSONAS.FRONT_DESK, '', { channel: 'text' }).includes(name));
  }
  assert.ok(!toolsFor(PERSONAS.TECH, 'technician', 'grok').some(tool => VIDEO_TOOLS.includes(tool.name)), 'Grok voice sessions never see them');
  const withoutKey = names(PERSONAS.TECH, 'technician', { channel: 'text', env: {} });
  assert.ok(!withoutKey.includes('search_youtube_videos'), 'search is hidden until YOUTUBE_API_KEY is set');
  assert.ok(withoutKey.includes('show_youtube_video'));
  assert.ok(names(PERSONAS.TECH, 'technician', { channel: 'text', env: { YOUTUBE_API_KEY: KEY } }).includes('search_youtube_videos'));
  assert.equal(normalizeChannel('TEXT'), 'voice');
  assert.equal(normalizeChannel(undefined), 'voice');
});

test('authorization denies video tools on any non-text channel even if the model calls them', async () => {
  for (const channel of [undefined, 'voice', 'sms', 'phone']) {
    for (const name of VIDEO_TOOLS) {
      assert.equal(authorizeAssistantTool({ persona: PERSONAS.TECH, role: 'admin', name, channel }).code, 'channel_denied');
    }
  }
  assert.equal(authorizeAssistantTool({ persona: PERSONAS.TECH, role: 'technician', name: 'show_youtube_video', channel: 'text' }).allowed, true);
  assert.equal(authorizeAssistantTool({ persona: PERSONAS.FRONT_DESK, name: 'show_youtube_video', channel: 'text' }).code, 'persona_denied');
  assert.equal(authorizeAssistantTool({ persona: PERSONAS.TECH, role: 'technician', name: 'lookup_dtc' }).allowed, true, 'other tools keep working on voice');

  const { fetcher, calls } = youtubeFetch();
  const env = { DB: createD1(), YOUTUBE_API_KEY: KEY, fetch: fetcher };
  const result = await executeAssistantTool(env, { ...textArgs, channel: 'voice', name: 'search_youtube_videos', args: { query: 'brakes' } });
  assert.equal(result.denied, true);
  assert.equal(result.code, 'channel_denied');
  assert.doesNotMatch(JSON.stringify(result), /https?:/);
  assert.equal(calls.length, 0, 'a denied voice call never reaches YouTube');
});

test('on the text channel both tools return their contract shapes', async () => {
  const { fetcher } = youtubeFetch();
  const env = { DB: createD1(), YOUTUBE_API_KEY: KEY, fetch: fetcher };
  const found = await executeAssistantTool(env, { ...textArgs, name: 'search_youtube_videos', args: { query: 'brakes', maxResults: 3 } });
  assert.equal(found.kind, 'youtube_search_results');
  assert.equal(found.displayedInApp, true);
  assert.equal(checkToolOutput('search_youtube_videos', found).kind, 'ok');

  const player = await executeAssistantTool(env, { ...textArgs, name: 'show_youtube_video', args: { video: found.videos[0].url, title: found.videos[0].title } });
  assert.equal(player.kind, 'youtube_player');
  assert.equal(player.videoId, 'abcDEF12345');
  assert.equal(player.embedUrl, 'https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0');
  assert.equal(checkToolOutput('show_youtube_video', player).kind, 'ok');
  assert.match((await executeAssistantTool(env, { ...textArgs, name: 'show_youtube_video', args: { video: 'https://evil.example/v' } })).error, /not a YouTube/);
});

test('YouTube failures become a soft error without leaking the API key into logs', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const failing = { DB: createD1(), YOUTUBE_API_KEY: KEY, fetch: youtubeFetch({ status: 403, body: { error: { message: 'API key not valid' } } }).fetcher };
  const result = await executeAssistantTool(failing, { ...textArgs, name: 'search_youtube_videos', args: { query: 'brakes' } });
  assert.match(result.error, /quota or key restriction/);
  assert.ok(warnings.some(line => line.includes('youtube search failed')));
  assert.ok(warnings.every(line => !line.includes(KEY)));

  const unconfigured = await executeAssistantTool({ DB: createD1() }, { ...textArgs, name: 'search_youtube_videos', args: { query: 'brakes' } });
  assert.match(unconfigured.error, /not set up/);
});

function anthropicScript(steps) {
  const requests = [];
  const fetcher = async (_url, init) => {
    const payload = JSON.parse(init.body);
    requests.push(payload);
    return Response.json({ content: steps[requests.length - 1](payload), usage: { input_tokens: 1, output_tokens: 1 } });
  };
  return { fetcher, requests };
}

test('a text chat turn returns video results as media for the UI, not as links in the reply', async () => {
  const { fetcher: youtube } = youtubeFetch();
  const env = { DB: createD1(), AI_ENABLED: '1', ANTHROPIC_API_KEY: 'test-only-anthropic', YOUTUBE_API_KEY: KEY, fetch: youtube };
  const { fetcher, requests } = anthropicScript([
    payload => {
      assert.ok(payload.tools.some(tool => tool.name === 'search_youtube_videos'));
      return [{ type: 'tool_use', id: 'yt', name: 'search_youtube_videos', input: { query: 'F-150 rear brakes' } }];
    },
    payload => {
      const result = JSON.parse(payload.messages.at(-1).content[0].content);
      assert.equal(result.kind, 'youtube_search_results');
      return [{ type: 'text', text: 'I found two brake videos; the first one from ChrisFix covers your truck.' }];
    },
  ]);
  const result = await runAnthropicTurn(env, { shopId: 'shop-1', role: 'technician', message: 'show me a video on F-150 rear brakes', fetcher, channel: 'text' });
  assert.equal(requests.length, 2);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].videos[0].videoId, 'abcDEF12345');
  assert.doesNotMatch(result.text, /https?:\/\//);
});

test('a voice turn through the same text assistant never offers or runs the video tools', async () => {
  const env = { DB: createD1(), AI_ENABLED: '1', ANTHROPIC_API_KEY: 'test-only-anthropic', YOUTUBE_API_KEY: KEY, fetch: async () => assert.fail('voice must not call YouTube') };
  for (const channel of [undefined, 'voice']) {
    const { fetcher, requests } = anthropicScript([
      payload => {
        assert.ok(!payload.tools.some(tool => VIDEO_TOOLS.includes(tool.name)), 'video tools must not be advertised on voice');
        return [{ type: 'tool_use', id: 'forged', name: 'show_youtube_video', input: { video: 'dQw4w9WgXcQ' } }];
      },
      payload => {
        assert.equal(JSON.parse(payload.messages.at(-1).content[0].content).code, 'channel_denied');
        return [{ type: 'text', text: 'Pull the caliper bolts first, then the pads.' }];
      },
    ]);
    const result = await runAnthropicTurn(env, { shopId: 'shop-1', role: 'technician', message: 'how do I do rear brakes', fetcher, channel });
    assert.equal(requests.length, 2);
    assert.equal(result.media, undefined);
  }
});
