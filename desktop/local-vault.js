'use strict';

const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const SCRYPT_N = 16384;
const KEYLEN = 32;
const MAX_SHOP_BYTES = 20_000_000;
const SECRET_KEY = /^(password|passphrase|secret|token|apikey|api_key)$/i;

function accountFile(dir) {
  return path.join(dir, 'offline-account.json');
}

function shopFile(dir) {
  return path.join(dir, 'offline-shop.json');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('Use at least 8 characters.');
  if (value.length > 200) throw new Error('That password is too long.');
  return value;
}

function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), n: SCRYPT_N };
}

function verifyPassword(password, record) {
  const salt = Buffer.from(String(record.salt || ''), 'base64');
  const expected = Buffer.from(String(record.hash || ''), 'base64');
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(String(password || ''), salt, expected.length, { N: Number(record.n) || SCRYPT_N, r: 8, p: 1 });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(item);
  }
  return out;
}

function accountStatus(dir) {
  const record = readJson(accountFile(dir));
  if (!record?.email || !record?.hash || !record?.salt) return { exists: false };
  return { exists: true, email: record.email, name: record.name || '' };
}

function createAccount(dir, input = {}) {
  if (accountStatus(dir).exists) throw new Error('This computer already has a ShopCrank sign-in.');
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.');
  const name = String(input.name || '').trim().slice(0, 80);
  if (name.length < 2) throw new Error('Enter your name.');
  const password = validatePassword(input.password);
  const record = {
    version: 1,
    email,
    name,
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(accountFile(dir), record);
  return { email, name };
}

function signIn(dir, input = {}) {
  const record = readJson(accountFile(dir));
  if (!record?.hash) throw new Error('Create a sign-in on this computer first.');
  const email = normalizeEmail(input.email);
  if (email !== record.email || !verifyPassword(input.password, record)) {
    throw new Error('That email or password does not match this computer.');
  }
  return { email: record.email, name: record.name || '' };
}

function loadShop(dir) {
  const record = readJson(shopFile(dir));
  if (!record?.state || typeof record.state !== 'object' || Array.isArray(record.state)) return null;
  return stripSecrets(record.state);
}

function saveShop(dir, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('The shop file could not be saved.');
  }
  const state = stripSecrets(snapshot);
  const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), state });
  if (Buffer.byteLength(body) > MAX_SHOP_BYTES) throw new Error('This shop file is too large to save on this computer.');
  writeJsonAtomic(shopFile(dir), JSON.parse(body));
  return { saved: true };
}

module.exports = {
  accountStatus,
  createAccount,
  loadShop,
  saveShop,
  signIn,
  stripSecrets,
};
