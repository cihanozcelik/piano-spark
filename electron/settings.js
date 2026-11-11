// Small preferences, kept where each system's rach3 always kept them so an installed
// copy keeps its language and piano: the app's own defaults on the Mac (NSUserDefaults),
// settings.json in the data folder on Windows.
const fs = require('fs');
const path = require('path');

function fileSettings(file) {
  let values = {};
  try { values = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; } catch {}
  return {
    get: key => values[key] ?? null,
    set(key, value) {
      if (value == null) delete values[key]; else values[key] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.pending', JSON.stringify(values));
      fs.renameSync(file + '.pending', file);
    },
  };
}

// Text values live in the defaults; anything else (the window's place) as JSON text.
function macSettings(systemPreferences) {
  return {
    get(key) {
      const value = systemPreferences.getUserDefault(key, 'string');
      if (!value) return null;
      if (key === 'Window') { try { return JSON.parse(value); } catch { return null; } }
      return value;
    },
    set(key, value) {
      if (value == null) systemPreferences.removeUserDefault(key);
      else systemPreferences.setUserDefault(key, 'string', typeof value === 'string' ? value : JSON.stringify(value));
    },
  };
}

module.exports = { fileSettings, macSettings };
