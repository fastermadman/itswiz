'use strict';

// Gør plugin/main.js require-bar uden for Obsidian: en attrap for 'obsidian' foran modul-indlæseren
// (samme mønster som Horus). Attrappen dækker kun det modul-niveau-koden rører; har en test brug
// for mere, tester den ikke længere ren logik og skal prøves live i Obsidian.

const Module = require('node:module');
const path = require('node:path');

const stub = {
  Plugin: class {},
  ItemView: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {},
  TFile: class {},
  TFolder: class {},
  normalizePath: (p) => p,
  requestUrl: async () => { throw new Error('requestUrl er ikke tilgængelig i test'); },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return stub;
  return load.call(this, request, ...rest);
};

module.exports = require(path.join(__dirname, '..', 'main.js'));
