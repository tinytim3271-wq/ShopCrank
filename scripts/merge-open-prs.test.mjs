#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/merge-open-prs.sh');

function createMockCurl(dir) {
  const mockCurlPath = join(dir, 'curl');
  writeFileSync(
    mockCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail

method="GET"
out_file=""
url=""

for ((i=1; i<=$#; i++)); do
  arg=\"\${!i}\"
  if [[ \"$arg\" == \"-X\" ]]; then
    next=$((i+1))
    method=\"\${!next}\"
  elif [[ \"$arg\" == \"-o\" ]]; then
    next=$((i+1))
    out_file=\"\${!next}\"
  elif [[ \"$arg\" == http*://* ]]; then
    url=\"$arg\"
  fi
done

if [[ -z \"$out_file\" || -z \"$url\" ]]; then
  echo \"mock curl missing required args\" >&2
  exit 2
fi

endpoint=\"$url\"
endpoint=\"\${endpoint#https://api.github.com}\"

method_log_file=\"\${MOCK_CURL_METHOD_LOG_FILE:-}\"
if [[ -n \"$method_log_file\" ]]; then
  printf '%s %s\\n' \"$method\" \"$endpoint\" >> \"$method_log_file\"
fi

counter_file=\"\${MOCK_CURL_COUNTER_FILE:-}\"
if [[ -n \"$counter_file\" ]]; then
  count=0
  if [[ -f \"$counter_file\" ]]; then
    count=$(cat \"$counter_file\")
  fi
  count=$((count + 1))
  echo \"$count\" > \"$counter_file\"
fi

status=200
body='{}'

if [[ \"\${MOCK_CURL_RETRY_FIRST_GET:-false}\" == \"true\" && \"$method\" == \"GET\" && \"$endpoint\" == */pulls/3 ]]; then
  retry_flag_file=\"\${MOCK_CURL_RETRY_FLAG_FILE:-}\"
  if [[ -n \"$retry_flag_file\" && ! -f \"$retry_flag_file\" ]]; then
    echo retry > \"$retry_flag_file\"
    status=503
    body='{"message":"Service Unavailable"}'
    printf '%s' \"$body\" > \"$out_file\"
    printf '%s' \"$status\"
    exit 0
  fi
fi

case \"$method $endpoint\" in
  \"GET /repos/test-owner/test-repo/pulls/3\")
    body='{"state":"open","draft":true}'
    ;;
  \"PATCH /repos/test-owner/test-repo/pulls/3\")
    body='{"draft":false}'
    ;;
  \"PUT /repos/test-owner/test-repo/pulls/3/merge\")
    body='{"merged":true}'
    ;;
  *)
    status=404
    body='{"message":"Not Found"}'
    ;;
esac

printf '%s' \"$body\" > \"$out_file\"
printf '%s' \"$status\"
`,
  );
  chmodSync(mockCurlPath, 0o755);
  return mockCurlPath;
}

function runScript({ extraEnv = {}, draftPrs = '3', mergePrs = '3', dryRun = false } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'merge-open-prs-test-'));
  createMockCurl(sandbox);

  const result = spawnSync(
    'bash',
    [
      scriptPath,
      '--owner',
      'test-owner',
      '--repo',
      'test-repo',
      '--token',
      'test-token',
      '--draft-prs',
      draftPrs,
      '--merge-prs',
      mergePrs,
      '--retry-delay',
      '0',
      '--max-retries',
      '2',
      ...(dryRun ? ['--dry-run'] : []),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${sandbox}:${process.env.PATH}`,
        ...extraEnv,
      },
    },
  );

  return { result, sandbox };
}

test('merges configured PR after draft conversion', () => {
  const { result } = runScript();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Converted PR #3 to ready for review/);
  assert.match(result.stdout, /Merged PR #3/);
  assert.match(result.stdout, /Failures: 0/);
});

test('retries transient failures and succeeds', () => {
  const counterFile = join(tmpdir(), `merge-open-prs-counter-${Date.now()}`);
  const retryFlagFile = join(tmpdir(), `merge-open-prs-retry-${Date.now()}`);

  const { result } = runScript({
    extraEnv: {
      MOCK_CURL_RETRY_FIRST_GET: 'true',
      MOCK_CURL_COUNTER_FILE: counterFile,
      MOCK_CURL_RETRY_FLAG_FILE: retryFlagFile,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Transient HTTP 503, retrying 1\/2/);
  assert.match(result.stdout, /Failures: 0/);

  const requestCount = Number(readFileSync(counterFile, 'utf8').trim());
  assert.ok(requestCount >= 4);
});

test('returns non-zero with failure summary when API fetch fails', () => {
  const { result } = runScript({ draftPrs: '3', mergePrs: '99' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /PR #99 fetch failed/);
  assert.match(result.stdout, /Failures: 1/);
});

test('fails fast when PR list includes non-numeric values', () => {
  const { result } = runScript({ draftPrs: 'abc', mergePrs: '3' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Invalid PR number 'abc' in draft-prs list/);
});

test('dry-run logs planned mutations without calling PATCH or PUT', () => {
  const methodLogFile = join(tmpdir(), `merge-open-prs-methods-${Date.now()}`);
  const { result } = runScript({
    dryRun: true,
    extraEnv: { MOCK_CURL_METHOD_LOG_FILE: methodLogFile },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[dry-run\] Would convert PR #3 from draft to ready/);
  assert.match(result.stdout, /\[dry-run\] Would merge PR #3 using method 'merge'/);
  assert.match(result.stdout, /Drafts converted: 0/);
  assert.match(result.stdout, /Drafts that would convert \(dry-run\): 1/);
  assert.match(result.stdout, /PRs merged: 0/);
  assert.match(result.stdout, /PRs that would merge \(dry-run\): 1/);

  const methodLog = readFileSync(methodLogFile, 'utf8');
  assert.ok(!methodLog.includes('PATCH '), methodLog);
  assert.ok(!methodLog.includes('PUT '), methodLog);
});
