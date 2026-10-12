'use strict';

const { mkdirSync, accessSync, constants } = require('node:fs');
const path = require('node:path');

function configurePortableData(app, edition, executable = process.execPath) {
  if (edition.portable !== true) return null;
  const dir = path.join(path.dirname(executable), 'Shop Crank Demo Data');
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  for (const name of ['logs', 'crashDumps']) {
    const child = path.join(dir, name);
    mkdirSync(child, { recursive: true });
    app.setPath(name, child);
  }
  return dir;
}

module.exports = { configurePortableData };
