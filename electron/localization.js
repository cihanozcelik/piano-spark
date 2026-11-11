'use strict';
// One persisted language for the shell and the page: a port of desktop/Localization.m
// (PianoLanguage, PianoSetLanguage, PianoText, PianoLocalizedStatus).
//
//   const l = createLocalization({ settings, systemLocale });
//   l.language()               'en' | 'tr'
//   l.setLanguage('tr')        saved in the settings (settings.js) as Rach3Language
//   l.text(source)             Turkish source string -> the current language
//   l.localizedStatus(object)  translates only app-owned text (message, detail, error, diagnostic)
//
// The strings are not copied here. They are read from the Mac's own table:
//   packaged     <resources>/strings.json, written at build time by nativeStrings()
//                (the same extraction windows/build.py native_strings() does)
//   development  desktop/Localization.m, parsed directly
// Optional: `strings` (an object, or a path to such a JSON file) replaces that lookup, and
// `extra` ({ turkishSource: english }) adds strings only this shell says.
const fs = require('fs');
const path = require('path');

// Said by this shell but absent from Localization.m (the Windows shell kept its own copy).
const SHELL = {
  'Ders motoru bu bilgisayarda bulunamadı. rach3’ü yeniden yükle.': 'The lesson engine is missing. Reinstall rach3.',
};

// The Turkish -> English pairs of desktop/Localization.m, from its source text.
function nativeStrings(source) {
  if (source == null) source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'Localization.m'), 'utf8');
  const start = source.indexOf('english = @{');
  if (start < 0) throw new Error('Localization.m has no english table');
  const block = source.slice(start, source.indexOf('};', start));
  const unescape = text => text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const pairs = {};
  for (const match of block.matchAll(/@"((?:[^"\\]|\\.)*)":@"((?:[^"\\]|\\.)*)"/g)) pairs[unescape(match[1])] = unescape(match[2]);
  if (Object.keys(pairs).length < 80) throw new Error(`Only ${Object.keys(pairs).length} strings found in Localization.m`);
  return pairs;
}

function loadStrings(strings) {
  if (strings && typeof strings === 'object') return strings;
  const candidates = [strings, process.resourcesPath && path.join(process.resourcesPath, 'strings.json'), path.join(__dirname, 'strings.json')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch { /* try the next place */ }
  }
  return nativeStrings();
}

// PianoLocalizedStatus, for any text function.
function localizeStatus(status, text) {
  const localized = { ...status };
  for (const key of ['message', 'detail', 'error'])
    if (typeof status[key] === 'string') localized[key] = text(status[key]);
  const diagnostic = status.diagnostic;
  if (diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)) localized.diagnostic = localizeStatus(diagnostic, text);
  return localized;
}

function createLocalization({ settings, systemLocale, strings, extra }) {
  const english = new Map(), turkish = new Map();
  let loaded = false;
  const load = () => {
    if (loaded) return;
    for (const [tr, en] of Object.entries({ ...loadStrings(strings), ...SHELL, ...(extra || {}) }))
      if (typeof en === 'string') { english.set(tr, en); turkish.set(en, tr); }
    loaded = true;
  };

  // The language lives where both old apps kept it, so an installed copy keeps its language.
  let saved;   // undefined until the settings have been read
  const language = () => {
    if (saved === undefined) saved = settings.get('Rach3Language');
    if (saved === 'en' || saved === 'tr') return saved;
    const locale = typeof systemLocale === 'function' ? systemLocale() : systemLocale;
    return String(locale || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
  };
  const setLanguage = value => { saved = value; settings.set('Rach3Language', value); };

  const text = source => {
    if (source == null) return null;
    if (typeof source !== 'string') return source;
    load();
    const useTurkish = language() === 'tr';
    const translated = (useTurkish ? turkish : english).get(source);
    if (translated !== undefined) return translated;
    // The worker emits a count after this app-owned progress prefix.
    const from = useTurkish ? 'Preparing note sections: ' : 'Nota bölümleri hazırlanıyor: ';
    const to = useTurkish ? 'Nota bölümleri hazırlanıyor: ' : 'Preparing note sections: ';
    return source.startsWith(from) ? to + source.slice(from.length) : source;
  };

  return { language, setLanguage, text, localizedStatus: status => localizeStatus(status, text) };
}

module.exports = { createLocalization, localizeStatus, nativeStrings };
