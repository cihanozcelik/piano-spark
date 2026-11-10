(() => {
  const translations = {
  "Çalış": "Practice",
  "Ders oluştur": "Create a Lesson",
  "MIDI / Nota PDF’si içe aktar…": "Import MIDI / sheet music PDF…",
  "Dersin MIDI’sini indir": "Download lesson MIDI",
  "PARÇA HAZIR": "LESSON READY",
  "Videodan çıkarılan notalar yüklü.": "Notes extracted from the video are loaded.",
  "Mod": "Mode",
  "Dinle": "Listen",
  "Parti": "Part",
  "İki el birlikte": "Both hands",
  "Sürüm": "Version",
  "Güncellemeleri denetle": "Check for updates",
  "Piyano": "Piano",
  "Bağlantı hazırlanıyor…": "Preparing connection…",
  "Teknik ayrıntı": "Technical details",
  "Bağlan": "Connect",
  "Kayıtlı piyanoyu yeniden ara": "Find saved piano again",
  "Tam ekran": "Full screen",
  "Tam ekrandan çık": "Exit full screen",
  "Büyüt": "Expand",
  "Küçült": "Collapse",
  "Partisyon hazırlanıyor…": "Preparing score…",
  "Piyanonu bağla.": "Connect your piano.",
  "Çalışta şiddet ve pedal isteğe bağlı": "Dynamics and pedal are optional in practice",
  "Sol el": "Left hand",
  "Sağ el": "Right hand",
  "Görünüm": "View",
  "Şiddet (1–127): —": "Velocity (1–127): —",
  "Çubuklarda porte": "Staff on falling notes",
  "Yakınlık": "Zoom",
  "Nota adları": "Note names",
  "Gizle": "Hide",
  "Klavye": "Keyboard",
  "Notalara sığdır": "Fit to notes",
  "88 tuş": "88 keys",
  "Tekrarla": "Repeat",
  "Dinleme sesi": "Playback sound",
  "Uygulama sentezleyicisi": "App synthesizer",
  "Ses": "Volume",
  "Boşluk: başlat / duraklat": "Space: play / pause",
  "← →: 5 saniye geri / ileri": "← →: back / forward 5 seconds",
  "VERİ YOK": "NO DATA",
  "MIDI dosyanı bırak": "Drop your MIDI file",
  "▶ Başlat": "▶ Play",
  "Çalma hızı": "Playback speed",
  "Çalışmak istediğin videoyu ekle.": "Add the music you want to practice.",
  "AI ile": "With AI",
  "Video dosyası": "Video file",
  "YouTube bağlantısı": "YouTube link",
  "MIDI / Nota PDF": "MIDI / sheet music PDF",
  "MIDI veya nota PDF’si seç…": "Choose MIDI or sheet music PDF…",
  "Dosya seçilmedi": "No file selected",
  "Tempo işareti yoksa (BPM)": "Fallback tempo (BPM)",
  "MIDI doğrudan okunur. PDF’deki notalar otomatik tanınır; okuma hataları olabilir.": "MIDI is read directly. Notes in PDFs are recognized automatically and may contain errors.",
  "Videonu buraya sürükle": "Drag your video here",
  "Video seç…": "Choose video…",
  "MP4, MOV, M4V veya WebM": "MP4, MOV, M4V or WebM",
  "Kaldır": "Remove",
  "YouTube video bağlantısı": "YouTube video link",
  "Bağlantıyı kullan": "Use link",
  "Ders adı": "Lesson title",
  "Vokali ayır": "Separate vocals",
  "İptal": "Cancel",
  "Video bu Mac’te işlenir. Notlar, şiddet ve pedal otomatik tahmindir.": "Video is processed on this Mac. Notes, dynamics, and pedal are automatic estimates.",
  "Derslerim": "My lessons",
  "Bu uygulama için JavaScript açık olmalıdır.": "JavaScript must be enabled to use this app.",
  "Uygulama bölümleri": "App sections",
  "Ders işlemleri": "Lesson actions",
  "Çalınacak piyano partisi": "Piano part to play",
  "Sürüm ve güncellemeler": "Version and updates",
  "Piyano bağlantısı": "Piano connection",
  "Piyano çalışma alanı": "Piano practice workspace",
  "Dersin nota dizeği": "Lesson score",
  "Önceki sayfa": "Previous page",
  "Sonraki sayfa": "Next page",
  "Partisyon oluşturma ilerlemesi": "Score preparation progress",
  "Beyaz kâğıt üzerinde klasik piyano partisyonu": "Classical piano score on white paper",
  "Partisyon yüksekliği": "Score height",
  "Görünüm ayarları": "View settings",
  "Akan nota çubuklarında küçük dizekleri göster.": "Show small staves on falling notes.",
  "Ses düzeyi": "Volume level",
  "Notalar piyano tuşlarına doğru akar. Porte nota yüksekliğini, çubuk uzunluğu basılı tutma süresini gösterir.": "Notes fall toward the piano keys. The staff shows pitch and the bar length shows how long to hold each note.",
  "Mor pedal aralıkları, notalarla aynı hızda yukarıdan aşağı akar.": "Purple pedal intervals fall at the same speed as the notes.",
  "Klavye yüksekliği": "Keyboard height",
  "Piyano tuşları": "Piano keys",
  "Başlat": "Play",
  "Başa dön": "Restart",
  "Parçada konum": "Lesson position",
  "Video kaynağı": "Lesson source",
  "Parçanın adı": "Name of the piece",
  "Ders oluşturma ilerlemesi": "Lesson creation progress",
  "Dil": "Language",
  "rach3 ile kendi hızında piyano çalış.": "Practice piano at your own pace with rach3.",
  "Güncelleme": "Update",
  "Yeni sürüm yüklendi": "New version installed",
  "{version} sürümü hazır": "Version {version} is ready",
  "{version} yüklendi": "{version} installed",
  "{count} piksel": "{count} pixels",
  "0,25×": "0.25×",
  "0,50×": "0.50×",
  "0,75×": "0.75×",
  "1,00×": "1.00×",
  "1,25×": "1.25×",
  "1,50×": "1.50×",
  "2,00×": "2.00×",
  "%100": "100%",
  "%150": "150%",
  "%200": "200%"
};
  const storageKey = 'rach3-language';
  const native = window.webkit?.messageHandlers?.rach3;
  const valid = value => value === 'tr' || value === 'en';
  let language = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en';
  try { const saved = localStorage.getItem(storageKey); if (valid(saved)) language = saved; } catch (_) { /* Native preferences still work when browser storage is unavailable. */ }
  let revision = 0;
  let patterns = { en: [], tr: [] };
  let reverse = {};
  // Platform wording (the Windows app): source -> [Turkish, English]. Empty on the Mac.
  const platformText = window.PianoPlatformText || {};
  function t(source, params = {}) {
    const platform = Object.hasOwn(platformText, source) ? platformText[source] : null;
    const text = platform ? platform[language === 'en' ? 1 : 0] : language === 'en' ? translations[source] ?? source : source;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
  }
  function register(dictionary) {
    Object.assign(translations, dictionary);
    reverse = Object.fromEntries(Object.entries(translations).map(([source, english]) => [english, source]));
    const compile = (source, template) => {
      const names = [];
      const pieces = template.split(/(\{\w+\})/).map(part => {
        if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]+?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      });
      return { source, names, expression: new RegExp('^' + pieces.join('') + '$') };
    };
    const templates = Object.keys(translations).filter(source => /\{\w+\}/.test(source));
    patterns = {
      en: templates.map(source => compile(source, source)),
      tr: templates.map(source => compile(source, translations[source])),
    };
    // Dictionaries loaded after startup must also translate static controls.
    if(window.PianoI18n) renderStatic();
  }
  function message(raw) {
    const text = String(raw ?? '');
    if (Object.hasOwn(platformText, text)) return t(text);
    if (language === 'en' && Object.hasOwn(translations, text)) return t(text);
    if (language === 'tr' && Object.hasOwn(reverse, text)) return t(reverse[text]);
    for (const pattern of patterns[language]) {
      const match = pattern.expression.exec(text);
      if (match) return t(pattern.source, Object.fromEntries(pattern.names.map((name, index) => [name,
        /^(error|message|reason|detail|status)$/.test(name) && match[index + 1] !== text ? message(match[index + 1]) : match[index + 1]])));
    }
    return text;
  }
  function renderStatic() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    for (const attribute of ['aria-label', 'title', 'placeholder', 'content']) {
      document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(node => node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`))));
    }
    const selector = document.getElementById('app-language');
    if (selector) selector.value = language;
  }
  function apply(value) {
    if (!valid(value)) return;
    language = value;
    try { localStorage.setItem(storageKey, value); } catch (_) { /* Browser persistence is optional in native storage contexts. */ }
    renderStatic();
    window.dispatchEvent(new CustomEvent('rach3-language-change', { detail: { language } }));
  }
  async function setLanguage(value) {
    if (!valid(value)) return;
    revision += 1;
    apply(value);
    if (native) await native.postMessage({ command: 'set-language', language: value });
  }
  register({});
  window.PianoI18n = { t, register, message, setLanguage, get language() { return language; }, ready: Promise.resolve() };
  document.querySelectorAll('[data-i18n-initial]').forEach(node => { node.textContent = t(node.dataset.i18nInitial); node.removeAttribute('data-i18n-initial'); });
  renderStatic();
  document.getElementById('app-language')?.addEventListener('change', event => {
    setLanguage(event.target.value).catch(error => { const node = document.getElementById('error'); node.textContent = message(error.message); node.hidden = false; });
  });
  window.addEventListener('rach3-native-event', event => {
    if ((event.detail.event === 'language' || event.detail.event === 'snapshot') && valid(event.detail.language) && event.detail.language !== language) apply(event.detail.language);
  });
  if (native) {
    const initialRevision = revision;
    window.PianoI18n.ready = native.postMessage({ command: 'get-language' }).then(result => {
      if (revision === initialRevision) apply(result.language);
    }).catch(error => { console.warn('Language preference could not be loaded:', error); });
  }
})();
