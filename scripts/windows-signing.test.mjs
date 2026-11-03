import test from 'node:test';
import assert from 'node:assert/strict';
import { signingMethod, withWindowsSigning } from './windows-signing.mjs';

const azure = {
  AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
  AZURE_SIGNING_ACCOUNT: 'shopcrank',
  AZURE_SIGNING_PROFILE: 'public',
  AZURE_SIGNING_PUBLISHER: 'CN=Alderman Enterprises LLC, O=Alderman Enterprises LLC, C=US',
};

test('picks Azure, then a certificate file, then unsigned', () => {
  assert.equal(signingMethod(azure), 'azure');
  assert.equal(signingMethod({ CSC_LINK: 'base64' }), 'certificate');
  assert.equal(signingMethod({ AZURE_SIGNING_ENDPOINT: 'x' }), 'none');
});

test('adds the Azure sign block and keeps the rest of the config', () => {
  const out = withWindowsSigning({ appId: 'a', win: { target: ['nsis'] } }, azure);
  assert.equal(out.appId, 'a');
  assert.deepEqual(out.win.target, ['nsis']);
  assert.equal(out.win.sign.type, 'azure');
  assert.equal(out.win.sign.certificateProfileName, 'public');
  assert.deepEqual(withWindowsSigning({ appId: 'a' }, {}), { appId: 'a' });
});

test('a bare publisher name is refused (electron-builder needs the full subject)', () => {
  assert.throws(() => withWindowsSigning({}, { ...azure, AZURE_SIGNING_PUBLISHER: 'Alderman Enterprises' }), /CN=/);
});
