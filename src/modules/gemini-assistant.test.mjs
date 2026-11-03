import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSourceUrl } from './gemini-assistant.js';

test('search source links keep http(s) URLs and drop script or local URLs', () => {
  assert.equal(safeSourceUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeSourceUrl('http://example.com/'), 'http://example.com/');
  assert.equal(safeSourceUrl('javascript:alert(1)'), '#');
  assert.equal(safeSourceUrl(' JavaScript:alert(1)'), '#');
  assert.equal(safeSourceUrl('data:text/html,<script>1</script>'), '#');
  assert.equal(safeSourceUrl('file:///C:/Windows/System32/calc.exe'), '#');
  assert.equal(safeSourceUrl(''), '#');
  assert.equal(safeSourceUrl(undefined), '#');
});
