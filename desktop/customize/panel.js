// The "Customize" panel. It runs in its own web view beside the page, so a
// version changed by ChatGPT can't hide it, cover it, read it or catch its keys.
(() => {
  if (window.rach3Customize) return;
  // core.js, loaded just before this, does the work; this file only draws the panel.
  const native = window.rach3Core;
  if (!native) return;
  const call = (action, fields = {}) => native.postMessage({ action, ...fields });

  const TEXT = {
    en: {
      customize: 'Customize', close: 'Close',
      intro: 'Describe a change in your own words, like “make the falling bars green” or “add a metronome”. ChatGPT makes it on a branch of your own, and the original rach3 always stays as it is.',
      privacy: 'ChatGPT only sees rach3’s own interface files. It can’t open your documents or anything else on this computer.',
      signIn: 'Continue with ChatGPT', signingIn: 'Waiting for ChatGPT in your browser…', cancel: 'Cancel',
      signInFailed: 'Sign-in didn’t finish. Try again.', signInDenied: 'Sign-in was cancelled.',
      signInPlan: 'This ChatGPT account can’t share its plan with apps. Check your plan in ChatGPT.', signInPort: 'rach3 couldn’t open its sign-in callback. Restart rach3 and try again.',
      unavailable: 'This copy of rach3 doesn’t include ChatGPT changes.',
      chat: 'Chat', branches: 'Branches',
      placeholder: 'What should change?', send: 'Make it', stop: 'Stop', newChat: 'New chat',
      working: 'Working…', reading: 'Looking through rach3…', editing: 'Making the change…',
      saved: 'Saved as a new version on this branch', newBranch: 'New branch', branchStarted: name => `Started a new branch: ${name}`, noChange: 'Nothing was changed.', stopped: 'Stopped.', failed: 'Something went wrong. Nothing was changed.',
      outside: 'ChatGPT tried to change something outside rach3. The change was not saved.',
      previous: 'Activate previous', switchTo: 'Activate', fork: 'Clone', forkName: name => `${name} (clone)`, inUse: 'On screen', remove: 'Delete',
      rename: 'Rename', save: 'Save', yesDelete: 'Yes, delete', confirmDelete: 'Delete this branch and all its versions?',
      confirmLessons: n => n === 1 ? 'The lesson made in it goes to the Trash too.' : `The ${n} lessons made in it go to the Trash too.`,
      lessonsHere: 'Lessons made in this branch', keepLesson: 'Add to my lessons',
      mainNote: 'rach3 as it came. It can’t be changed.', untitled: 'Untitled branch', noVersions: 'No changes yet.',
      changes: n => n === 1 ? '1 change' : `${n} changes`, version: n => `Version ${n}`,
      fromBranch: name => `Branched from ${name}`, fromOriginal: 'Started from the original',
      onMain: 'You’re on the original rach3. Your first change starts a new branch; the original always stays as it is.',
      onBranch: (name, n, total) => `Branch: ${name} · version ${n} of ${total}`,
      onOld: 'You’re looking at an earlier version. A change from here starts a new branch.',
      versions: 'Versions', hasErrors: 'has errors',
      checking: 'rach3 is checking the change…',
      fixingErrors: n => `rach3 found ${n === 1 ? 'an error' : `${n} errors`} and asked ChatGPT to fix ${n === 1 ? 'it' : 'them'}.`,
      broken: 'This version still shows errors, so rach3 kept the previous one on screen.',
      restoredNote: 'Parts of rach3 that can’t be changed were put back as they were.', thisChange: 'This change', thisChat: 'This chat',
      tokens: n => `${n} tokens`, cached: n => `${n} from cache`, today: 'Today',
      plan: 'Using ChatGPT plan', manage: 'Manage usage', signOut: 'Sign out',
      limit: 'You’ve reached the usage limit for your ChatGPT plan.', offline: 'rach3 couldn’t reach ChatGPT. Check your connection.',
      expired: 'Your ChatGPT sign-in ended. Sign in again.', busy: 'Wait for the current change to finish.', deskBusy: 'ChatGPT is helping in Create a Lesson…',
      welcomeTitle: 'You’re using your ChatGPT plan',
      welcomeBody: 'Changes you ask for here use your ChatGPT subscription, just like chatting in ChatGPT. You’ll see how much each change used right below it.',
      gotIt: 'Got it', emptyChat: 'Your conversation will appear here.',
      files: n => n === 1 ? '1 file' : `${n} files`,
      errorTitle: 'This version shows an error.', fixIt: 'Fix it', lessonSaved: 'Lesson saved',
      fixPrompt: 'The version on screen shows an error. Find it with page_errors and fix it.',
    },
    tr: {
      customize: 'Değiştir', close: 'Kapat',
      intro: 'Ne değişsin istiyorsan kendi cümlelerinle yaz: “düşen çubuklar yeşil olsun” ya da “metronom ekle” gibi. ChatGPT bunu sana ait bir dalda yapar; orijinal rach3 hep olduğu gibi kalır.',
      privacy: 'ChatGPT yalnızca rach3’ün kendi arayüz dosyalarını görür. Belgelerini ya da bu bilgisayardaki başka hiçbir şeyi açamaz.',
      signIn: 'ChatGPT ile devam et', signingIn: 'Tarayıcıda ChatGPT girişi bekleniyor…', cancel: 'Vazgeç',
      signInFailed: 'Giriş tamamlanmadı. Yeniden dene.', signInDenied: 'Giriş iptal edildi.',
      signInPlan: 'Bu ChatGPT hesabı planını uygulamalarla paylaşamıyor. Planını ChatGPT’de kontrol et.', signInPort: 'rach3 giriş dönüşünü açamadı. rach3’ü yeniden başlatıp tekrar dene.',
      unavailable: 'rach3’ün bu kopyasında ChatGPT ile değiştirme yok.',
      chat: 'Sohbet', branches: 'Dallar',
      placeholder: 'Ne değişsin?', send: 'Yap', stop: 'Durdur', newChat: 'Yeni sohbet',
      working: 'Çalışıyor…', reading: 'rach3 inceleniyor…', editing: 'Değişiklik yapılıyor…',
      saved: 'Bu dala yeni sürüm olarak kaydedildi', newBranch: 'Yeni dal', branchStarted: name => `Yeni dal açıldı: ${name}`, noChange: 'Hiçbir şey değişmedi.', stopped: 'Durduruldu.', failed: 'Bir şeyler ters gitti. Hiçbir şey değişmedi.',
      outside: 'ChatGPT rach3’ün dışında bir şeyi değiştirmeye çalıştı. Değişiklik kaydedilmedi.',
      previous: 'Öncekini etkinleştir', switchTo: 'Etkinleştir', fork: 'Klonla', forkName: name => `${name} (klon)`, inUse: 'Ekranda', remove: 'Sil',
      rename: 'Yeniden adlandır', save: 'Kaydet', yesDelete: 'Evet, sil', confirmDelete: 'Bu dal ve bütün sürümleri silinsin mi?',
      confirmLessons: n => n === 1 ? 'Bu dalda yapılan ders de Çöp Sepeti’ne gider.' : `Bu dalda yapılan ${n} ders de Çöp Sepeti’ne gider.`,
      lessonsHere: 'Bu dalda yapılan dersler', keepLesson: 'Kütüphaneme ekle',
      mainNote: 'rach3’ün orijinali. Değiştirilemez.', untitled: 'Adsız dal', noVersions: 'Henüz değişiklik yok.',
      changes: n => `${n} değişiklik`, version: n => `${n}. sürüm`,
      fromBranch: name => `${name} dalından ayrıldı`, fromOriginal: 'Orijinalden başladı',
      onMain: 'Orijinal rach3’tesin. İlk değişiklik yeni bir dal açar; orijinal hep olduğu gibi kalır.',
      onBranch: (name, n, total) => `Dal: ${name} · ${n}/${total}. sürüm`,
      onOld: 'Eski bir sürüme bakıyorsun. Buradan yapacağın değişiklik yeni bir dal açar.',
      versions: 'Sürümler', hasErrors: 'hatalı',
      checking: 'rach3 değişikliği kontrol ediyor…',
      fixingErrors: n => `rach3 ${n} hata buldu ve ChatGPT’den düzeltmesini istedi.`,
      broken: 'Bu sürümde hâlâ hata var; rach3 ekranda bir öncekini tuttu.',
      restoredNote: 'rach3’ün değiştirilemeyen parçaları eski haline getirildi.', thisChange: 'Bu değişiklik', thisChat: 'Bu sohbet',
      tokens: n => `${n} token`, cached: n => `${n} önbellekten`, today: 'Bugün',
      plan: 'ChatGPT planın kullanılıyor', manage: 'Kullanımı yönet', signOut: 'Çıkış yap',
      limit: 'ChatGPT planının kullanım sınırına ulaştın.', offline: 'rach3 ChatGPT’ye ulaşamadı. Bağlantını kontrol et.',
      expired: 'ChatGPT oturumun sona erdi. Yeniden giriş yap.', busy: 'Önce süren değişikliğin bitmesini bekle.', deskBusy: 'ChatGPT, Ders oluştur’da yardım ediyor…',
      welcomeTitle: 'ChatGPT aboneliğin kullanılıyor',
      welcomeBody: 'Burada istediğin değişiklikler, ChatGPT’de sohbet eder gibi aboneliğini kullanır. Her değişikliğin altında ne kadar harcadığını görürsün.',
      gotIt: 'Anladım', emptyChat: 'Konuşman burada görünecek.',
      files: n => `${n} dosya`,
      errorTitle: 'Bu sürümde bir hata çıkıyor.', fixIt: 'Düzelt', lessonSaved: 'Ders kaydedildi',
      fixPrompt: 'Ekrandaki sürümde bir hata çıkıyor. page_errors ile bulup düzeltir misin?',
    },
  };
  let language = 'en';
  const t = key => TEXT[language][key] ?? TEXT.en[key];
  const number = value => new Intl.NumberFormat(language === 'tr' ? 'tr-TR' : 'en-US').format(Math.round(value || 0));
  const when = ms => new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));

  let state = null, view = 'chat', entries = [], live = null, notice = null, loadedThread;
  let expanded = new Set(), renaming = null, confirming = null;

  const host = document.createElement('rach3-customize');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .strip { position: fixed; top: 0; left: 0; right: 0; height: 48px; }
    .strip.open { background: #1c1c1f; border-left: 1px solid #ffffff14; border-bottom: 1px solid #ffffff12; }
    .toggle { position: fixed; top: 9px; right: 14px; z-index: 2147483000; height: 30px; padding: 0 12px; border-radius: 8px;
      border: 1px solid #ffffff1f; background: #2c2c30; color: #f1f1f3; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .toggle:hover { background: #36363b; }
    .toggle[aria-expanded=true] { background: #86b8ff; color: #15243c; border-color: transparent; }
    .toggle svg { width: 14px; height: 14px; }
    aside { position: fixed; top: 48px; right: 0; bottom: 0; left: 0; display: flex; flex-direction: column;
      background: #1c1c1f; color: #f1f1f3; border-left: 1px solid #ffffff14;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
    aside[hidden] { display: none; }
    button { font: inherit; color: inherit; cursor: pointer; border-radius: 7px; border: 1px solid #ffffff1a; background: #2c2c30; padding: 6px 11px; }
    button:hover { background: #36363b; }
    button.primary { background: #86b8ff; color: #15243c; border-color: transparent; font-weight: 600; }
    button.primary:hover { background: #9cc6ff; }
    button.link { border: 0; background: none; padding: 0; color: #86b8ff; }
    button.link:hover { text-decoration: underline; background: none; }
    button:disabled { opacity: .5; cursor: default; }
    :focus-visible { outline: 2px solid #86b8ff; outline-offset: 2px; }
    .tabs { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid #ffffff12; }
    .tabs button { border: 0; background: none; border-radius: 6px 6px 0 0; padding: 7px 10px 9px; color: #96969f; }
    .tabs button[aria-selected=true] { color: #f1f1f3; box-shadow: inset 0 -2px 0 #86b8ff; }
    .tabs .spacer { flex: 1; }
    .body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .muted { color: #96969f; }
    .small { font-size: 11.5px; }
    .intro p { margin: 0 0 12px; }
    .intro .privacy { display: flex; gap: 8px; padding: 10px 12px; border-radius: 9px; background: #ffffff08; color: #b9b9c2; font-size: 12px; }
    .signin { display: flex; flex-direction: column; gap: 10px; align-items: stretch; margin-top: 16px; }
    .signin .primary { height: 38px; font-size: 13.5px; }
    .error { color: #ffb4a8; }
    .msg { padding: 9px 12px; border-radius: 10px; max-width: 92%; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.user { align-self: flex-end; background: #86b8ff22; border: 1px solid #86b8ff33; }
    .msg.assistant { align-self: flex-start; background: #ffffff0a; }
    .msg.commentary { align-self: flex-start; color: #a6a6ae; font-size: 12px; padding: 2px 4px; }
    .activity { align-self: flex-start; color: #96969f; font-size: 12px; display: flex; gap: 8px; align-items: center; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #86b8ff; animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .25; } }
    .card { border: 1px solid #ffffff14; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; background: #ffffff05; }
    .card .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .card strong { font-weight: 600; }
    .usage { font-variant-numeric: tabular-nums; }
    .composer { border-top: 1px solid #ffffff12; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
    textarea { width: 100%; min-height: 64px; max-height: 180px; resize: vertical; font: inherit; color: inherit; background: #26262a;
      border: 1px solid #ffffff1a; border-radius: 9px; padding: 9px 11px; }
    textarea:focus { outline: none; border-color: #86b8ff88; }
    .composer .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .footer { border-top: 1px solid #ffffff12; padding: 9px 16px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-size: 11.5px; color: #96969f; }
    .footer .grow { flex: 1; }
    .design { border: 1px solid #ffffff14; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
    .design[aria-current=true] { border-color: #86b8ff88; background: #86b8ff0d; }
    .design .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .design .title { font-weight: 600; overflow-wrap: anywhere; }
    .badge { font-size: 11px; color: #86b8ff; white-space: nowrap; }
    .badge.error { color: #ffb4a8; }
    .design .title.clip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .design .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .design .actions button, .version button { white-space: nowrap; }
    .design .links { display: flex; gap: 12px; align-items: center; margin-left: auto; }
    .lock { display: inline-flex; align-items: center; gap: 6px; }
    .lock svg { width: 12px; height: 12px; color: #96969f; }
    .versions { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; border-top: 1px solid #ffffff10; padding-top: 6px; }
    .version { display: flex; gap: 10px; align-items: flex-start; padding: 6px 4px; border-radius: 7px; }
    .version[aria-current=true] { background: #86b8ff12; }
    .version .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .version .title { font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .version .side { flex: none; padding-top: 1px; display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
    .version button { padding: 3px 9px; font-size: 12px; }
    .status { padding: 10px 16px 0; }
    .where { padding: 8px 12px; border-radius: 9px; background: #ffffff08; color: #b9b9c2; font-size: 12px; }
    .rename { display: flex; gap: 6px; }
    .rename input { flex: 1; min-width: 0; font: inherit; color: inherit; background: #26262a; border: 1px solid #86b8ff88; border-radius: 7px; padding: 5px 8px; }
    .modal { position: absolute; inset: 0; background: #000a; display: grid; place-items: center; padding: 20px; }
    .modal .box { background: #26262a; border: 1px solid #ffffff1a; border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .modal h2 { margin: 0; font-size: 15px; }
    .modal p { margin: 0; color: #c4c4cc; }
  </style>
  <div class="strip"></div>
  <button class="toggle" type="button" aria-expanded="false"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0l1.6 4.8L14.4 6 9.6 7.6 8 12.4 6.4 7.6 1.6 6l4.8-1.2zM13 10l.8 2.2L16 13l-2.2.8L13 16l-.8-2.2L10 13l2.2-.8z"/></svg><span class="label"></span></button>
  <aside hidden aria-label=""></aside>`;
  const toggle = root.querySelector('.toggle');
  const panel = root.querySelector('aside');
  const strip = root.querySelector('.strip');
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  document.documentElement.appendChild(host);
  // rach3 sizes this view to the button when the panel is closed.
  const reportSize = () => call('panel', { open: !panel.hidden, toggle: Math.ceil(toggle.getBoundingClientRect().width) });

  function setOpen(open) {
    panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    strip.classList.toggle('open', open);
    reportSize();
    if (open) render();
  }

  const element = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'html') node.innerHTML = value;
      else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    return node;
  };

  function tokenLine(tokens) {
    if (!tokens || !tokens.total) return null;
    const parts = [t('tokens')(number(tokens.total))];
    if (tokens.cached) parts.push(t('cached')(number(tokens.cached)));
    return parts.join(' · ');
  }
  const designs = () => state?.designs || [];
  const design = id => designs().find(item => item.id === id);
  const branches = () => state?.branches || [];
  const branchOf = id => branches().find(item => item.id === id);
  const versionsOf = id => designs().filter(item => item.branch === id).sort((a, b) => a.created - b.created);
  const branchName = branch => branch?.name || t('untitled');
  // Lessons ChatGPT made on a branch's versions: [id, record].
  const lessonsOf = id => { const versions = new Set(versionsOf(id).map(item => item.id));
    return Object.entries(state?.lessons || {}).filter(([, record]) => (record.anchors || []).some(anchor => versions.has(anchor))); };
  const sum = list => list.reduce((total, item) => ({ total: total.total + (item.tokens?.total || 0), cached: total.cached + (item.tokens?.cached || 0) }), { total: 0, cached: 0 });
  const LOCK = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7zm2 0h4V5a2 2 0 1 0-4 0z"/></svg>';
  const errorText = code => ({ offline: t('offline'), expired: t('expired'), 'signed-out': t('expired'), busy: t('busy') }[code] || t('failed'));

  function render() {
    language = state?.language === 'tr' ? 'tr' : 'en';
    const label = toggle.querySelector('.label');
    if (label.textContent !== t('customize')) { label.textContent = t('customize'); reportSize(); }
    panel.setAttribute('aria-label', t('customize'));
    if (panel.hidden || !state) return;
    panel.replaceChildren();
    if (!state.available) { panel.append(element('div', { class: 'body' }, element('p', { class: 'muted' }, t('unavailable')))); return; }
    if (!state.signedIn) { panel.append(renderSignIn()); return; }
    const tab = (name) => element('button', { type: 'button', role: 'tab', 'aria-selected': String(view === name),
      onclick: () => { view = name; render(); } }, t(name));
    panel.append(element('div', { class: 'tabs', role: 'tablist' }, tab('chat'), tab('branches'), element('span', { class: 'spacer' }),
      view === 'chat' ? element('button', { type: 'button', disabled: !!state.turn, onclick: newChat }, t('newChat'))
                      : element('button', { type: 'button', disabled: !!state.turn, onclick: () => call('new-branch') }, `+ ${t('newBranch')}`)));
    if (view === 'chat') panel.append(element('div', { class: 'status' }, whereLine()), renderChat(), renderComposer());
    if (view === 'branches') panel.append(renderBranches());
    panel.append(renderFooter());
    if (!state.welcomed) panel.append(element('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      element('div', { class: 'box' }, element('h2', {}, t('welcomeTitle')), element('p', {}, t('welcomeBody')),
        element('button', { type: 'button', class: 'primary', onclick: () => call('welcomed') }, t('gotIt')))));
    const scroller = panel.querySelector('.body.chat');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderSignIn() {
    const errors = { denied: t('signInDenied'), plan: t('signInPlan'), port: t('signInPort') };
    return element('div', { class: 'body intro' },
      element('p', {}, t('intro')),
      element('div', { class: 'privacy' }, t('privacy')),
      element('div', { class: 'signin' },
        state.signingIn
          ? [element('p', { class: 'muted' }, t('signingIn')), element('button', { type: 'button', onclick: () => call('cancel-sign-in') }, t('cancel'))]
          : element('button', { type: 'button', class: 'primary', onclick: () => call('sign-in') }, t('signIn')),
        state.signInError ? element('p', { class: 'error' }, errors[state.signInError] || t('signInFailed')) : null));
  }

  function resultCard(entry) {
    const made = entry.design && design(entry.design);
    const tokens = tokenLine(entry.tokens);
    let title = t('noChange');
    if (entry.status === 'interrupted') title = t('stopped');
    if (entry.outside) title = t('outside');
    else if (entry.limit) title = t('limit');
    else if (entry.error && !made) title = errorText(entry.error);
    if (made?.errors?.length && state.active !== made.id) title = t('broken');
    else if (made) {
      const versions = versionsOf(made.branch);
      title = versions[0]?.id === made.id ? t('branchStarted')(branchName(branchOf(made.branch))) : t('saved');
    } else if (entry.lessons?.length) title = `${t('lessonSaved')}: ${entry.lessons.map(lesson => `“${lesson.title}”`).join(', ')}`;
    const actions = [];
    if (entry.limit) actions.push(element('button', { type: 'button', class: 'primary', onclick: () => call('open-usage') }, t('manage')));
    const parent = made && design(made.parent);
    if (made?.errors?.length && state.active !== made.id) {
      actions.push(element('button', { type: 'button', class: 'primary', disabled: !!state.turn, onclick: () => fixVersion(made.id) }, t('fixIt')));
      actions.push(element('button', { type: 'button', disabled: !!state.turn, onclick: () => call('use-design', { design: made.id }) }, t('switchTo')));
    } else if (made && state.active === made.id && parent?.branch === made.branch)
      actions.push(element('button', { type: 'button', disabled: !!state.turn, onclick: () => call('use-design', { design: parent.id }) }, t('previous')));
    else if (made && state.active !== made.id)
      actions.push(element('button', { type: 'button', disabled: !!state.turn, onclick: () => call('use-design', { design: made.id }) }, t('switchTo')));
    return element('div', { class: 'card' },
      element('div', { class: 'row' }, element('strong', {}, title), made && state.active === made.id ? element('span', { class: 'badge' }, t('inUse')) : null),
      tokens ? element('div', { class: 'small muted usage' }, `${t('thisChange')}: ${tokens}`) : null,
      (entry.restored || made?.restored)?.length ? element('div', { class: 'small muted' }, t('restoredNote')) : null,
      actions.length ? element('div', { class: 'row' }, actions, element('span')) : null);
  }

  // Puts a version that still had errors on screen and asks ChatGPT to fix it there.
  async function fixVersion(id) {
    try { await call('use-design', { design: id }); } catch { return; }
    state = { ...state, active: id, forking: false };
    sendText(t('fixPrompt'));
  }

  // Where the person is: the original, a branch, or an earlier version of one.
  function whereLine() {
    const branch = branchOf(state.branch);
    if (!branch) return element('div', { class: 'where lock', html: LOCK }, t('onMain'));
    if (state.forking) return element('div', { class: 'where' }, t('onOld'));
    const versions = versionsOf(branch.id);
    const index = versions.findIndex(item => item.id === state.active);
    return element('div', { class: 'where' }, t('onBranch')(branchName(branch), index + 1, versions.length));
  }

  // Replies may mark words **like this**; show them bold, everything else as plain text.
  const rich = text => String(text).split(/\*\*(.+?)\*\*/g).map((part, index) => index % 2 ? element('strong', {}, part) : part);

  function renderChat() {
    const body = element('div', { class: 'body chat', role: 'log', 'aria-live': 'polite' });
    const errors = state.active !== 'original' ? state.pageErrors || [] : [];
    if (errors.length && !state.turn) body.append(element('div', { class: 'card' },
      element('strong', { class: 'error' }, t('errorTitle')),
      element('div', { class: 'small muted' }, errors[0].message || ''),
      element('div', { class: 'row' }, element('button', { type: 'button', class: 'primary', onclick: () => sendText(t('fixPrompt')) }, t('fixIt')), element('span'))));
    if (!entries.length && !live) body.append(element('p', { class: 'muted' }, t('emptyChat')));
    for (const entry of entries) {
      if (entry.kind === 'user') body.append(element('div', { class: 'msg user' }, entry.text));
      if (entry.kind === 'assistant') body.append(element('div', { class: entry.commentary ? 'msg commentary' : 'msg assistant' }, rich(entry.text)));
      if (entry.kind === 'result') body.append(resultCard(entry));
      if (entry.kind === 'note') body.append(element('div', { class: 'msg commentary' }, entry.text));
    }
    if (state.turn) {
      const tokens = tokenLine(state.turn.tokens);
      if (live?.text) body.append(element('div', { class: 'msg assistant' }, rich(live.text)));
      body.append(element('div', { class: 'activity' }, element('span', { class: 'dot' }),
        live?.activity || (state.turn.desk ? t('deskBusy') : t('working')), tokens ? element('span', { class: 'usage' }, `· ${tokens}`) : null));
    }
    const usage = state.thread && state.threadUsage?.[state.thread];
    if (usage?.total && !state.turn) body.append(element('div', { class: 'small muted usage' }, `${t('thisChat')}: ${tokenLine(usage)}`));
    if (notice) body.append(element('p', { class: 'error' }, notice));
    return body;
  }

  function renderComposer() {
    const input = element('textarea', { placeholder: t('placeholder'), 'aria-label': t('placeholder'), disabled: !!state.turn });
    input.value = draft;
    input.addEventListener('input', () => { draft = input.value; });
    const submit = () => { if (sendText(input.value.trim())) draft = ''; };
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } });
    queueMicrotask(() => { if (!state.turn && view === 'chat') input.focus(); });
    return element('div', { class: 'composer' }, input, element('div', { class: 'row' },
      element('span', { class: 'small muted' }, window.PianoPlatform === 'windows' ? 'Ctrl+↩' : '⌘↩'),
      state.turn ? element('button', { type: 'button', onclick: () => call('stop') }, t('stop'))
                 : element('button', { type: 'button', class: 'primary', onclick: submit }, t('send'))));
  }
  let draft = '';
  function sendText(text) {
    if (!text || state.turn) return false;
    notice = null;
    // A change from an earlier version starts a new branch with its own chat.
    if (state.forking) entries = [];
    entries.push({ kind: 'user', text });
    live = { text: '', activity: t('working') };
    call('send', { text }).then(result => { if (result?.thread) loadedThread = result.thread; }).catch(error => { live = null; entries.pop(); notice = errorText(String(error?.message || error)); render(); });
    render();
    return true;
  }

  function renderBranches() {
    const body = element('div', { class: 'body' });
    const busy = !!state.turn;
    const onMain = !branchOf(state.branch);
    body.append(element('div', { class: 'design', 'aria-current': String(onMain) },
      element('div', { class: 'row' }, element('span', { class: 'title lock', html: LOCK }, 'main'), onMain ? element('span', { class: 'badge' }, t('inUse')) : null),
      element('div', { class: 'small muted' }, t('mainNote')),
      element('div', { class: 'actions' },
        onMain ? null : element('button', { type: 'button', disabled: busy, onclick: () => call('use-branch', { branch: 'main' }) }, t('switchTo')),
        forkButton('original', 'main', busy))));
    const latest = branch => versionsOf(branch.id).at(-1)?.created || branch.created;
    for (const branch of [...branches()].sort((a, b) => latest(b) - latest(a))) body.append(branchCard(branch, busy));
    return body;
  }

  function branchCard(branch, busy) {
    const current = state.branch === branch.id;
    const versions = versionsOf(branch.id);
    const open = expanded.has(branch.id) || current;
    const usage = tokenLine(sum(versions));
    const from = design(branch.base);
    const title = renaming === branch.id ? renameField(branch) : element('span', { class: 'title clip', title: branchName(branch) }, branchName(branch));
    const card = element('div', { class: 'design', 'aria-current': String(current) },
      element('div', { class: 'row' }, title, current ? element('span', { class: 'badge' }, t('inUse')) : null),
      element('div', { class: 'small muted' }, [t('changes')(versions.length), when(latestTime(branch, versions)),
        from ? t('fromBranch')(branchName(branchOf(from.branch))) : t('fromOriginal')].join(' · ')),
      usage ? element('div', { class: 'small muted usage' }, usage) : null);
    if (confirming === branch.id) {
      const made = lessonsOf(branch.id).length;
      card.append(element('div', { class: 'small' }, t('confirmDelete'), made ? ` ${t('confirmLessons')(made)}` : ''), element('div', { class: 'actions' },
        element('button', { type: 'button', class: 'primary', disabled: busy, onclick: () => { confirming = null; call('delete-branch', { branch: branch.id }); } }, t('yesDelete')),
        element('button', { type: 'button', onclick: () => { confirming = null; render(); } }, t('cancel'))));
      return card;
    }
    card.append(element('div', { class: 'actions' },
      !current ? element('button', { type: 'button', disabled: busy, onclick: () => call('use-branch', { branch: branch.id }) }, t('switchTo'))
        : state.forking ? element('button', { type: 'button', disabled: busy, onclick: () => call('use-branch', { branch: branch.id }) }, t('switchTo')) : null,
      forkButton(versions.at(-1)?.id || branch.base || 'original', branchName(branch), busy),
      current || !versions.length ? null : element('button', { type: 'button', class: 'link',
        onclick: () => { open ? expanded.delete(branch.id) : expanded.add(branch.id); render(); } }, `${t('versions')} ${open ? '▴' : '▾'}`),
      element('span', { class: 'links' },
        element('button', { type: 'button', class: 'link', onclick: () => { renaming = branch.id; render(); } }, t('rename')),
        element('button', { type: 'button', class: 'link', disabled: busy, onclick: () => { confirming = branch.id; render(); } }, t('remove')))));
    if (open && versions.length) card.append(element('div', { class: 'versions' },
      [...versions].reverse().map(item => versionRow(item, versions.indexOf(item) + 1, busy))));
    else if (open) card.append(element('div', { class: 'small muted' }, t('noVersions')));
    const lessons = lessonsOf(branch.id);
    if (open && lessons.length) card.append(element('div', { class: 'versions' },
      element('span', { class: 'small muted' }, t('lessonsHere')),
      lessons.map(([id, record]) => element('div', { class: 'version' },
        element('div', { class: 'text' }, element('span', { class: 'title' }, record.title || '…')),
        element('div', { class: 'side' }, element('button', { type: 'button', disabled: busy, onclick: () => call('keep-lesson', { lesson: id }) }, t('keepLesson')))))));
    return card;
  }
  const latestTime = (branch, versions) => versions.at(-1)?.created || branch.created;

  function versionRow(item, position, busy) {
    const shown = state.active === item.id;
    return element('div', { class: 'version', 'aria-current': String(shown) },
      element('div', { class: 'text' },
        element('span', { class: 'title', title: item.title }, item.title, item.errors?.length ? element('span', { class: 'badge error' }, ` · ${t('hasErrors')}`) : null),
        element('span', { class: 'small muted usage' }, [t('version')(position), when(item.created), item.files?.length ? t('files')(item.files.length) : null,
          item.tokens?.total ? t('tokens')(number(item.tokens.total)) : null].filter(Boolean).join(' · '))),
      element('div', { class: 'side' }, shown ? element('span', { class: 'badge' }, t('inUse'))
        : element('button', { type: 'button', disabled: busy, onclick: () => call('use-design', { design: item.id }) }, t('switchTo')),
        forkButton(item.id, branchName(branchOf(item.branch)), busy)));
  }

  // A new branch that starts from this version, with its own chat.
  const forkButton = (from, name, busy) => element('button', { type: 'button', disabled: busy,
    onclick: () => { view = 'chat'; call('new-branch', { from, name: t('forkName')(name) }); } }, t('fork'));

  function renameField(branch) {
    const input = element('input', { 'aria-label': t('rename'), maxlength: '60' });
    input.value = branch.name || '';
    const save = () => { const name = input.value.trim(); renaming = null; if (name && name !== branch.name) call('rename-branch', { branch: branch.id, name }); render(); };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); save(); }
      if (event.key === 'Escape') { event.preventDefault(); renaming = null; render(); }
    });
    queueMicrotask(() => { input.focus(); input.select(); });
    return element('div', { class: 'rename' }, input, element('button', { type: 'button', class: 'primary', onclick: save }, t('save')));
  }

  async function openThread(id) {
    try {
      const result = await call('open-thread', { thread: id });
      if (loadedThread !== id) return;
      entries = fromHistory(id, result?.thread?.turns || []);
      render();
    } catch (error) { if (loadedThread === id) { notice = errorText(String(error?.message || error)); render(); } }
  }
  function fromHistory(threadId, turns) {
    const usage = Object.fromEntries((state.threadUsage?.[threadId]?.turns || []).map(item => [item.turn, item.tokens]));
    const list = [];
    let pending = null;
    const flush = () => { if (pending) list.push(pending); pending = null; };
    for (const turn of turns) {
      const text = item => (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const check = (turn.items || []).some(item => item.type === 'userMessage' && text(item).startsWith(CHECK));
      if (!check) flush();
      for (const item of turn.items || []) {
        if (item.type === 'userMessage') {
          if (check) list.push({ kind: 'note', text: t('fixingErrors')(Math.max(1, (text(item).match(/"message"/g) || []).length)) });
          else list.push({ kind: 'user', text: text(item) });
        }
        if (item.type === 'agentMessage' && item.text) list.push({ kind: 'assistant', text: item.text, commentary: item.phase === 'commentary' });
      }
      if (check) continue;
      const made = designs().find(item => item.turn === turn.id);
      const record = (state.threadUsage?.[threadId]?.turns || []).find(item => item.turn === turn.id);
      pending = { kind: 'result', status: turn.status, design: made?.id, tokens: usage[turn.id] || made?.tokens, lessons: record?.lessons };
    }
    flush();
    return list;
  }
  const CHECK = '[rach3 check]';
  async function newChat() { await call('new-thread'); }

  function renderFooter() {
    const today = state.today?.total ? tokenLine(state.today) : t('tokens')(0);
    return element('div', { class: 'footer' },
      element('span', {}, t('plan')),
      element('button', { type: 'button', class: 'link', onclick: () => call('open-usage') }, `${t('manage')} ↗`),
      element('span', { class: 'grow' }),
      element('span', { class: 'usage' }, `${t('today')}: ${today}`),
      element('span', { class: 'grow' }),
      element('span', {}, state.account?.email || ''),
      element('button', { type: 'button', class: 'link', disabled: !!state.turn, onclick: () => call('sign-out') }, t('signOut')));
  }

  function codex(method, params) {
    if (!state?.turn || params.threadId !== state.turn.thread) return;
    if (method === 'item/agentMessage/delta') { live = live || {}; live.text = (live.text || '') + (params.delta || ''); }
    if (method === 'item/started') {
      const type = params.item?.type;
      if (type === 'commandExecution') live = { ...live, activity: t('reading') };
      if (type === 'fileChange') live = { ...live, activity: t('editing') };
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text) {
      entries.push({ kind: 'assistant', text: params.item.text, commentary: params.item.phase === 'commentary' });
      live = { ...live, text: '' };
    }
    if (method === 'thread/tokenUsage/updated') {
      const last = params.tokenUsage?.last || {};
      const tokens = state.turn.tokens;
      tokens.total += last.totalTokens || 0; tokens.cached += last.cachedInputTokens || 0;
    }
    if (method === 'error' && !params.willRetry) live = { ...live, error: params.error };
    render();
  }

  const usageLimit = value => /usage.?limit|subscription_sharing_usage|rate.?limit/i.test(JSON.stringify(value || ''));
  window.rach3Customize = Object.freeze({
    receive(event) {
      if (event.event === 'customize-state') {
        const opened = !state;
        state = event;
        if (opened && state.open) setOpen(true);
        // Each branch keeps its own chat; show the one that belongs to what is on screen.
        if (!state.turn && (state.thread || null) !== (loadedThread ?? null)) {
          loadedThread = state.thread || null; entries = []; live = null; notice = null;
          if (loadedThread) openThread(loadedThread);
        }
        render();
      }
      if (event.event === 'customize-codex') codex(event.method, event.params);
      if (event.event === 'customize-check') {
        if (event.phase === 'checking') live = { ...live, activity: t('checking') };
        if (event.phase === 'fixing') { entries.push({ kind: 'note', text: t('fixingErrors')(event.errors || 1) }); live = { ...live, text: '', activity: t('working') }; }
        render();
      }
      if (event.event === 'customize-finished') {
        entries.push({ kind: 'result', status: event.status, design: event.design, tokens: event.tokens, files: event.files,
          outside: event.outside, error: event.error, lessons: event.lessons, restored: event.restored, limit: usageLimit(event.error) || usageLimit(live?.error) });
        live = null;
        render();
      }
    },
    toggle() { setOpen(panel.hidden); },
    show(name) { if (['chat', 'branches'].includes(name)) view = name; setOpen(true); },
  });
  call('state').then(event => window.rach3Customize.receive(event)).catch(() => {});
})();
