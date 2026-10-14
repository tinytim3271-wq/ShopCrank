#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

const HELP_TEXT = `Guided Shop Crank email sign-in setup

Usage:
  node scripts/setup-email-signin.mjs [--dry-run] [--local]
  npm run setup:email -- [--dry-run] [--local]

Options:
  --help, -h   Show this help text
  --dry-run    Walk through the prompts without writing any Worker secrets
  --local      Allow an http://localhost... or http://127.0.0.1... webhook URL

This script:
  1. Explains what Shop Crank needs for email sign-in
  2. Prompts for your email webhook URL
  3. Optionally prompts for a webhook bearer secret
  4. Confirms before writing Worker secrets with Wrangler

Requirements:
  - Run this in a terminal
  - Be signed in to Wrangler (npx wrangler login)
  - Have an HTTPS webhook that accepts { email, loginUrl, returnTo } and sends the email
`;

export class SetupError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'SetupError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    help: false,
    local: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--local') {
      options.local = true;
      continue;
    }
    throw new SetupError(`Unknown option: ${arg}\n\n${HELP_TEXT}`, { exitCode: 1 });
  }

  return options;
}

function isLocalHostname(hostname) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

export function validateWebhookUrl(value, { allowLocal = false } = {}) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new SetupError('Enter the webhook URL. It cannot be blank.');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SetupError('Enter a valid webhook URL, such as https://mailer.example.com/shopcrank-login.');
  }

  if (url.protocol === 'https:') {
    return url.toString();
  }

  if (allowLocal && url.protocol === 'http:' && isLocalHostname(url.hostname)) {
    return url.toString();
  }

  if (url.protocol === 'http:') {
    throw new SetupError('Use an HTTPS webhook URL. Plain http:// is only allowed with --local for localhost testing.');
  }

  throw new SetupError('Use an HTTPS webhook URL.');
}

function requireInteractiveTerminal() {
  if (!input.isTTY || !output.isTTY) {
    throw new SetupError(
      'This guided setup needs an interactive terminal. Re-run it in a terminal, or use `npx wrangler secret put AUTH_EMAIL_WEBHOOK` manually.',
    );
  }
}

function printIntro({ dryRun, local }) {
  console.log('Shop Crank email sign-in setup');
  console.log('');
  console.log('This guided setup stores Worker secrets for the email sign-in webhook.');
  console.log('The built-in sender is https://www.shopcrank.com/api/auth/send-login');
  console.log('It accepts Shop Crank JSON { email, loginUrl, returnTo } and returns 202');
  console.log('only after Cloudflare Email accepts the message.');
  console.log('');
  console.log('Important:');
  console.log('- The normal setup uses an HTTPS webhook URL.');
  console.log('- This script writes Worker secrets through Wrangler and does not save them in source files or .dev.vars.');
  console.log('- Do not enable AUTH_EXPOSE_LOGIN_LINK=1 in production.');
  if (dryRun) console.log('- Dry run is on, so nothing will be written.');
  if (local) console.log('- --local is on, so localhost http:// URLs are allowed for local testing only.');
  console.log('');
}

async function promptLine(prompt) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try {
    return await rl.question(prompt);
  } catch {
    throw new SetupError('Setup cancelled. No secrets were written.', { exitCode: 130 });
  } finally {
    rl.close();
  }
}

async function promptYesNo(prompt, defaultValue = false) {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  while (true) {
    const answer = String(await promptLine(`${prompt}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('Please answer yes or no.');
  }
}

async function promptHidden(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return String(await promptLine(prompt)).trim();
  }

  return await new Promise((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };

    const finish = () => {
      cleanup();
      output.write('\n');
      resolve(value.trim());
    };

    const cancel = () => {
      cleanup();
      output.write('\n');
      reject(new SetupError('Setup cancelled. No secrets were written.', { exitCode: 130 }));
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cancel();
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

let activeChild = null;

async function runWranglerSecretPut(name, value) {
  if (!value) {
    throw new SetupError(`Cannot write ${name} because no value was provided.`);
  }

  await new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const command = isWin ? 'npx.cmd' : 'npx';
    const child = spawn(command, ['wrangler', 'secret', 'put', name, '--name', 'shopcrank-api'], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: isWin,
    });
    activeChild = child;

    child.once('error', (error) => {
      activeChild = null;
      reject(new SetupError(`Unable to start Wrangler while writing ${name}: ${error.message}`));
    });

    child.once('close', (code, signal) => {
      activeChild = null;
      if (signal) {
        reject(new SetupError(`Wrangler stopped while writing ${name} (${signal}).`));
        return;
      }
      if (code !== 0) {
        reject(new SetupError(`Wrangler failed while writing ${name}. Fix the error above and try again.`));
        return;
      }
      resolve();
    });

    child.stdin.on('error', () => {});
    child.stdin.end(`${value}\n`);
  });
}

function printNextSteps({ dryRun, wroteSecret, local }) {
  console.log('');
  console.log(dryRun ? 'Dry run complete.' : 'Setup complete.');
  console.log('');
  console.log('Next steps:');
  if (dryRun) {
    console.log('1. Run `npm run setup:email` again when you are ready to save the Worker secrets.');
  } else if (wroteSecret) {
    console.log('1. Deploy the Worker so the updated remote secret is active: `npm run deploy:worker`.');
  }
  console.log('2. Open your Shop Crank site and go to `/login`.');
  console.log('3. Enter an email address you control and request a sign-in link.');
  console.log('4. Confirm your webhook receives `{ email, loginUrl, returnTo }` and that the email arrives.');
  if (local) {
    console.log('5. Replace any temporary localhost webhook with a real HTTPS endpoint before production use.');
  }
  console.log('');
  console.log('Reminder: local `.dev.vars` values are only for `wrangler dev`. Production email sign-in uses remote Worker secrets.');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  requireInteractiveTerminal();
  printIntro(options);

  const webhookUrl = validateWebhookUrl(
    await promptLine('Webhook URL for Shop Crank sign-in emails: '),
    { allowLocal: options.local },
  );
  if (options.local && !options.dryRun && new URL(webhookUrl).protocol === 'http:') {
    throw new SetupError('Localhost webhooks cannot be stored as remote Worker secrets. Put AUTH_EMAIL_WEBHOOK in .dev.vars for `wrangler dev` instead, or re-run with --dry-run.');
  }
  const useBearerSecret = await promptYesNo('Does this webhook require a bearer secret?');
  const webhookSecret = useBearerSecret
    ? await promptHidden('Webhook bearer secret (input hidden): ')
    : '';

  console.log('');
  console.log('Ready to continue:');
  console.log('- AUTH_EMAIL_WEBHOOK will be written to your Worker.');
  if (webhookSecret) {
    console.log('- AUTH_EMAIL_WEBHOOK_SECRET will also be written to your Worker.');
  } else {
    console.log('- AUTH_EMAIL_WEBHOOK_SECRET will be left unchanged.');
  }
  console.log('- The entered values will not be printed back to the terminal.');

  const confirmed = await promptYesNo(options.dryRun
    ? 'Continue with this dry run?'
    : 'Write these Worker secrets now?');
  if (!confirmed) {
    throw new SetupError('Setup cancelled. No secrets were written.', { exitCode: 130 });
  }

  let wroteWebhook = false;
  if (!options.dryRun) {
    console.log('');
    console.log('Writing AUTH_EMAIL_WEBHOOK with Wrangler...');
    await runWranglerSecretPut('AUTH_EMAIL_WEBHOOK', webhookUrl);
    wroteWebhook = true;

    if (webhookSecret) {
      console.log('Writing AUTH_EMAIL_WEBHOOK_SECRET with Wrangler...');
      try {
        await runWranglerSecretPut('AUTH_EMAIL_WEBHOOK_SECRET', webhookSecret);
      } catch (error) {
        if (error instanceof SetupError) {
          throw new SetupError(
            `${error.message} AUTH_EMAIL_WEBHOOK was already written, so re-run this setup to finish the optional bearer secret.`,
            { exitCode: error.exitCode },
          );
        }
        throw error;
      }
    }
  }

  printNextSteps({ dryRun: options.dryRun, wroteSecret: wroteWebhook, local: options.local });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGINT', () => {
    if (activeChild) activeChild.kill('SIGINT');
    stderr.write('\nSetup cancelled. No secrets were written by this script after the interruption.\n');
    process.exit(130);
  });

  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exit(error instanceof SetupError ? error.exitCode : 1);
  });
}
