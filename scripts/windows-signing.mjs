#!/usr/bin/env node
/**
 * Windows code signing for electron-builder, chosen by what CI has secrets for:
 *
 *  - Azure Trusted Signing (recommended: no hardware token, about $10/month)
 *    AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE,
 *    AZURE_SIGNING_PUBLISHER (full subject, e.g. "CN=Alderman Enterprises LLC, O=Alderman Enterprises LLC, L=Lubbock, S=Texas, C=US"),
 *    plus AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET for the app registration.
 *  - A certificate file: CSC_LINK + CSC_KEY_PASSWORD (electron-builder reads these itself).
 *  - Neither: the build stays unsigned and CI warns.
 *
 * Usage: node scripts/windows-signing.mjs <source config: package.json | builder.json> <output.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AZURE_KEYS = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'AZURE_SIGNING_PUBLISHER'];

export function signingMethod(env = process.env) {
  if (AZURE_KEYS.every(key => String(env[key] || '').trim())) return 'azure';
  if (String(env.CSC_LINK || env.WIN_CSC_LINK || '').trim()) return 'certificate';
  return 'none';
}

/** Returns the electron-builder config with Azure signing added when it is configured. */
export function withWindowsSigning(config, env = process.env) {
  if (signingMethod(env) !== 'azure') return config;
  const publisher = String(env.AZURE_SIGNING_PUBLISHER).trim();
  if (!/^CN=/.test(publisher)) throw new Error('AZURE_SIGNING_PUBLISHER must be the full certificate subject, starting with CN=');
  return {
    ...config,
    win: {
      ...(config.win || {}),
      sign: {
        type: 'azure',
        endpoint: String(env.AZURE_SIGNING_ENDPOINT).trim(),
        codeSigningAccountName: String(env.AZURE_SIGNING_ACCOUNT).trim(),
        certificateProfileName: String(env.AZURE_SIGNING_PROFILE).trim(),
        publisherName: publisher,
      },
    },
  };
}

export function builderConfigFrom(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return path.endsWith('package.json') ? json.build : json;
}

export function writeSignedConfig(source, output, env = process.env) {
  const config = withWindowsSigning(builderConfigFrom(source), env);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  return signingMethod(env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) { console.error('usage: windows-signing.mjs <source> <output>'); process.exit(2); }
  console.log(`Windows signing: ${writeSignedConfig(source, output)}`);
}
