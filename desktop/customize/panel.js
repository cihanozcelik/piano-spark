// The "Customize" panel. It runs in its own script world, apart from the page,
// so a design changed by ChatGPT can neither hide it nor send it commands.
(() => {
  if (window.rach3Customize) return;
  const native = window.webkit?.messageHandlers?.customize;
  if (!native) return;
  const call = (action, fields = {}) => native.postMessage({ action, ...fields });

  const TEXT = {
    en: {
      customize: 'Customize', close: 'Close',
      intro: 'Describe a change in your own words, like “make the falling bars green” or “add a metronome”. ChatGPT makes it in rach3 and you can always go back.',
      privacy: 'ChatGPT only sees rach3’s own interface files. It can’t open your documents or anything else on this computer.',
      signIn: 'Continue with ChatGPT', signingIn: 'Waiting for ChatGPT in your browser…', cancel: 'Cancel',
      signInFailed: 'Sign-in didn’t finish. Try again.', signInDenied: 'Sign-in was cancelled.',
      signInPlan: 'This ChatGPT account can’t share its plan with apps. Check your plan in ChatGPT.', signInPort: 'rach3 couldn’t open its sign-in callback. Restart rach3 and try again.',
      unavailable: 'This copy of rach3 doesn’t include ChatGPT changes.',
      chat: 'Chat', designs: 'Designs', history: 'History',
      placeholder: 'What should change?', send: 'Make it', stop: 'Stop', newChat: 'New chat',
      working: 'Working…', reading: 'Looking through rach3…', editing: 'Making the change…',
      saved: 'Saved as a new design', noChange: 'Nothing was changed.', stopped: 'Stopped.', failed: 'Something went wrong. Nothing was changed.',
      outside: 'ChatGPT tried to change something outside rach3. The change was not saved.',
      undo: 'Go back', useThis: 'Use this design', inUse: 'On screen', remove: 'Delete',
      original: 'Original', originalNote: 'rach3 as it came', thisChange: 'This change', thisChat: 'This chat',
      tokens: n => `${n} tokens`, cached: n => `${n} from cache`, today: 'Today',
      plan: 'Using ChatGPT plan', manage: 'Manage usage', signOut: 'Sign out',
      limit: 'You’ve reached the usage limit for your ChatGPT plan.', offline: 'rach3 couldn’t reach ChatGPT. Check your connection.',
      expired: 'Your ChatGPT sign-in ended. Sign in again.', busy: 'Wait for the current change to finish.',
      welcomeTitle: 'You’re using your ChatGPT plan',
      welcomeBody: 'Changes you ask for here use your ChatGPT subscription, just like chatting in ChatGPT. You’ll see how much each change used right below it.',
      gotIt: 'Got it', emptyHistory: 'Your chats will appear here.', emptyChat: 'Your conversation will appear here.',
      files: n => n === 1 ? '1 file' : `${n} files`, confirmDelete: 'Delete this design?',
      errorTitle: 'This design shows an error.', fixIt: 'Fix it', lessonSaved: 'Lesson saved',
      fixPrompt: 'The design on screen shows an error. Find it with page_errors and fix it.',
    },
    tr: {
      customize: 'Değiştir', close: 'Kapat',
      intro: 'Ne değişsin istiyorsan kendi cümlelerinle yaz: “düşen çubuklar yeşil olsun” ya da “metronom ekle” gibi. ChatGPT bunu rach3’te yapar, istediğin zaman geri dönebilirsin.',
      privacy: 'ChatGPT yalnızca rach3’ün kendi arayüz dosyalarını görür. Belgelerini ya da bu bilgisayardaki başka hiçbir şeyi açamaz.',
      signIn: 'ChatGPT ile devam et', signingIn: 'Tarayıcıda ChatGPT girişi bekleniyor…', cancel: 'Vazgeç',
      signInFailed: 'Giriş tamamlanmadı. Yeniden dene.', signInDenied: 'Giriş iptal edildi.',
      signInPlan: 'Bu ChatGPT hesabı planını uygulamalarla paylaşamıyor. Planını ChatGPT’de kontrol et.', signInPort: 'rach3 giriş dönüşünü açamadı. rach3’ü yeniden başlatıp tekrar dene.',
      unavailable: 'rach3’ün bu kopyasında ChatGPT ile değiştirme yok.',
      chat: 'Sohbet', designs: 'Tasarımlar', history: 'Geçmiş',
      placeholder: 'Ne değişsin?', send: 'Yap', stop: 'Durdur', newChat: 'Yeni sohbet',
      working: 'Çalışıyor…', reading: 'rach3 inceleniyor…', editing: 'Değişiklik yapılıyor…',
      saved: 'Yeni tasarım olarak kaydedildi', noChange: 'Hiçbir şey değişmedi.', stopped: 'Durduruldu.', failed: 'Bir şeyler ters gitti. Hiçbir şey değişmedi.',
      outside: 'ChatGPT rach3’ün dışında bir şeyi değiştirmeye çalıştı. Değişiklik kaydedilmedi.',
      undo: 'Geri dön', useThis: 'Bu tasarımı kullan', inUse: 'Ekranda', remove: 'Sil',
      original: 'Orijinal', originalNote: 'rach3’ün ilk hali', thisChange: 'Bu değişiklik', thisChat: 'Bu sohbet',
      tokens: n => `${n} token`, cached: n => `${n} önbellekten`, today: 'Bugün',
      plan: 'ChatGPT planın kullanılıyor', manage: 'Kullanımı yönet', signOut: 'Çıkış yap',
      limit: 'ChatGPT planının kullanım sınırına ulaştın.', offline: 'rach3 ChatGPT’ye ulaşamadı. Bağlantını kontrol et.',
      expired: 'ChatGPT oturumun sona erdi. Yeniden giriş yap.', busy: 'Önce süren değişikliğin bitmesini bekle.',
      welcomeTitle: 'ChatGPT aboneliğin kullanılıyor',
      welcomeBody: 'Burada istediğin değişiklikler, ChatGPT’de sohbet eder gibi aboneliğini kullanır. Her değişikliğin altında ne kadar harcadığını görürsün.',
      gotIt: 'Anladım', emptyHistory: 'Sohbetlerin burada görünecek.', emptyChat: 'Konuşman burada görünecek.',
      files: n => `${n} dosya`, confirmDelete: 'Bu tasarım silinsin mi?',
      errorTitle: 'Bu tasarımda bir hata çıkıyor.', fixIt: 'Düzelt', lessonSaved: 'Ders kaydedildi',
      fixPrompt: 'Ekrandaki tasarımda bir hata çıkıyor. page_errors ile bulup düzeltir misin?',
    },
  };
  let language = 'en';
  const t = key => TEXT[language][key] ?? TEXT.en[key];
  const number = value => new Intl.NumberFormat(language === 'tr' ? 'tr-TR' : 'en-US').format(Math.round(value || 0));
  const when = ms => new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));

  let state = null, view = 'chat', entries = [], live = null, threads = null, notice = null;

  const host = document.createElement('rach3-customize');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .toggle { position: fixed; top: 9px; right: 14px; z-index: 2147483000; height: 30px; padding: 0 12px; border-radius: 8px;
      border: 1px solid #ffffff1f; background: #2c2c30; color: #f1f1f3; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .toggle:hover { background: #36363b; }
    .toggle[aria-expanded=true] { background: #86b8ff; color: #15243c; border-color: transparent; }
    .toggle svg { width: 14px; height: 14px; }
    aside { position: fixed; top: 48px; right: 0; bottom: 0; width: min(400px, 100vw); z-index: 2147482999; display: flex; flex-direction: column;
      background: #1c1c1f; color: #f1f1f3; border-left: 1px solid #ffffff14; box-shadow: -16px 0 40px #0006;
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
    .thread { text-align: left; display: flex; flex-direction: column; gap: 2px; border-radius: 10px; padding: 10px 12px; }
    .thread .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .modal { position: absolute; inset: 0; background: #000a; display: grid; place-items: center; padding: 20px; }
    .modal .box { background: #26262a; border: 1px solid #ffffff1a; border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .modal h2 { margin: 0; font-size: 15px; }
    .modal p { margin: 0; color: #c4c4cc; }
  </style>
  <button class="toggle" type="button" aria-expanded="false"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0l1.6 4.8L14.4 6 9.6 7.6 8 12.4 6.4 7.6 1.6 6l4.8-1.2zM13 10l.8 2.2L16 13l-2.2.8L13 16l-.8-2.2L10 13l2.2-.8z"/></svg><span class="label"></span></button>
  <aside hidden aria-label=""></aside>`;
  const toggle = root.querySelector('.toggle');
  const panel = root.querySelector('aside');
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  // Keep the panel attached even if the page rewrites itself.
  // Make room for the button at the end of the page's header.
  const room = document.createElement('style');
  const attach = () => {
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (!room.isConnected) (document.head || document.documentElement).appendChild(room);
  };
  const makeRoom = () => { room.textContent = `.app-bar { padding-right: ${Math.ceil(toggle.getBoundingClientRect().width) + 28}px !important; }`; };
  new MutationObserver(attach).observe(document.documentElement, { childList: true });
  attach();

  function setOpen(open) {
    panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    call('panel', { open });
    if (open && view === 'history') loadThreads();
    if (open) render();
  }

  const element = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
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
  const errorText = code => ({ offline: t('offline'), expired: t('expired'), 'signed-out': t('expired'), busy: t('busy') }[code] || t('failed'));

  function render() {
    language = state?.language === 'tr' ? 'tr' : (document.documentElement.lang || '').startsWith('tr') ? 'tr' : 'en';
    toggle.querySelector('.label').textContent = t('customize');
    makeRoom();
    panel.setAttribute('aria-label', t('customize'));
    if (panel.hidden || !state) return;
    panel.replaceChildren();
    if (!state.available) { panel.append(element('div', { class: 'body' }, element('p', { class: 'muted' }, t('unavailable')))); return; }
    if (!state.signedIn) { panel.append(renderSignIn()); return; }
    const tab = (name) => element('button', { type: 'button', role: 'tab', 'aria-selected': String(view === name),
      onclick: () => { view = name; if (name === 'history') loadThreads(); render(); } }, t(name));
    panel.append(element('div', { class: 'tabs', role: 'tablist' }, tab('chat'), tab('designs'), tab('history'), element('span', { class: 'spacer' }),
      view === 'chat' ? element('button', { type: 'button', disabled: !!state.turn, onclick: newChat }, t('newChat')) : null));
    if (view === 'chat') panel.append(renderChat(), renderComposer());
    if (view === 'designs') panel.append(renderDesigns());
    if (view === 'history') panel.append(renderHistory());
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
    if (made) title = t('saved');
    else if (entry.lessons?.length) title = `${t('lessonSaved')}: ${entry.lessons.map(lesson => `“${lesson.title}”`).join(', ')}`;
    const actions = [];
    if (entry.limit) actions.push(element('button', { type: 'button', class: 'primary', onclick: () => call('open-usage') }, t('manage')));
    if (made && state.active === made.id && made.parent && design(made.parent) !== undefined || made && state.active === made.id && made.parent === 'original')
      actions.push(element('button', { type: 'button', onclick: () => call('use-design', { design: made.parent }) }, t('undo')));
    else if (made && state.active !== made.id) actions.push(element('button', { type: 'button', onclick: () => call('use-design', { design: made.id }) }, t('useThis')));
    return element('div', { class: 'card' },
      element('div', { class: 'row' }, element('strong', {}, title), made && state.active === made.id ? element('span', { class: 'badge' }, t('inUse')) : null),
      tokens ? element('div', { class: 'small muted usage' }, `${t('thisChange')}: ${tokens}`) : null,
      actions.length ? element('div', { class: 'row' }, actions, element('span')) : null);
  }

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
      if (entry.kind === 'assistant') body.append(element('div', { class: entry.commentary ? 'msg commentary' : 'msg assistant' }, entry.text));
      if (entry.kind === 'result') body.append(resultCard(entry));
    }
    if (state.turn) {
      const tokens = tokenLine(state.turn.tokens);
      if (live?.text) body.append(element('div', { class: 'msg assistant' }, live.text));
      body.append(element('div', { class: 'activity' }, element('span', { class: 'dot' }),
        live?.activity || t('working'), tokens ? element('span', { class: 'usage' }, `· ${tokens}`) : null));
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
      element('span', { class: 'small muted' }, '⌘↩'),
      state.turn ? element('button', { type: 'button', onclick: () => call('stop') }, t('stop'))
                 : element('button', { type: 'button', class: 'primary', onclick: submit }, t('send'))));
  }
  let draft = '';
  function sendText(text) {
    if (!text || state.turn) return false;
    notice = null;
    entries.push({ kind: 'user', text });
    live = { text: '', activity: t('working') };
    call('send', { text }).catch(error => { live = null; entries.pop(); notice = errorText(String(error?.message || error)); render(); });
    render();
    return true;
  }

  function renderDesigns() {
    const body = element('div', { class: 'body' });
    const card = (id, title, note, tokens, files, created) => element('div', { class: 'design', 'aria-current': String(state.active === id) },
      element('div', { class: 'row' }, element('span', { class: 'title' }, title), state.active === id ? element('span', { class: 'badge' }, t('inUse')) : null),
      element('div', { class: 'small muted' }, [note, created ? when(created) : null, files?.length ? t('files')(files.length) : null].filter(Boolean).join(' · ')),
      tokens ? element('div', { class: 'small muted usage' }, tokenLine(tokens)) : null,
      element('div', { class: 'row' },
        state.active === id ? element('span') : element('button', { type: 'button', disabled: !!state.turn, onclick: () => call('use-design', { design: id }) }, t('useThis')),
        id === 'original' ? null : element('button', { type: 'button', class: 'link', disabled: !!state.turn,
          onclick: () => { if (window.confirm(t('confirmDelete'))) call('delete-design', { design: id }); } }, t('remove'))));
    for (const item of [...designs()].reverse()) body.append(card(item.id, item.title, null, item.tokens, item.files, item.created));
    body.append(card('original', t('original'), t('originalNote')));
    return body;
  }

  async function loadThreads() {
    try { threads = (await call('threads'))?.data || []; } catch { threads = []; }
    render();
  }
  function renderHistory() {
    const body = element('div', { class: 'body' });
    if (!threads) return body;
    if (!threads.length) body.append(element('p', { class: 'muted' }, t('emptyHistory')));
    for (const thread of threads) {
      const usage = state.threadUsage?.[thread.id];
      body.append(element('button', { type: 'button', class: 'thread', disabled: !!state.turn, onclick: () => openThread(thread.id) },
        element('span', { class: 'title' }, thread.name || thread.preview || '…'),
        element('span', { class: 'small muted usage' }, [thread.createdAt ? when(thread.createdAt * 1000) : null, usage?.total ? tokenLine(usage) : null].filter(Boolean).join(' · '))));
    }
    return body;
  }

  async function openThread(id) {
    try {
      const result = await call('open-thread', { thread: id });
      entries = fromHistory(id, result?.thread?.turns || []);
      view = 'chat'; render();
    } catch (error) { notice = errorText(String(error?.message || error)); render(); }
  }
  function fromHistory(threadId, turns) {
    const usage = Object.fromEntries((state.threadUsage?.[threadId]?.turns || []).map(item => [item.turn, item.tokens]));
    const list = [];
    for (const turn of turns) {
      for (const item of turn.items || []) {
        if (item.type === 'userMessage') list.push({ kind: 'user', text: (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') });
        if (item.type === 'agentMessage' && item.text) list.push({ kind: 'assistant', text: item.text, commentary: item.phase === 'commentary' });
      }
      const made = designs().find(item => item.turn === turn.id);
      const record = (state.threadUsage?.[threadId]?.turns || []).find(item => item.turn === turn.id);
      list.push({ kind: 'result', status: turn.status, design: made?.id, tokens: usage[turn.id] || made?.tokens, lessons: record?.lessons });
    }
    return list;
  }
  async function newChat() { await call('new-thread'); entries = []; live = null; notice = null; render(); }

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
        if (state?.thread && !event.thread) { entries = []; live = null; notice = null; }
        state = event;
        if (opened) { if (state.open) setOpen(true); if (state.thread && !state.turn) openThread(state.thread); }
        render();
      }
      if (event.event === 'customize-codex') codex(event.method, event.params);
      if (event.event === 'customize-finished') {
        entries.push({ kind: 'result', status: event.status, design: event.design, tokens: event.tokens, files: event.files,
          outside: event.outside, error: event.error, lessons: event.lessons, limit: usageLimit(event.error) || usageLimit(live?.error) });
        live = null;
        render();
      }
    },
    toggle() { setOpen(panel.hidden); },
    show(name) { if (['chat', 'designs', 'history'].includes(name)) view = name; setOpen(true); },
  });
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  call('state').then(event => window.rach3Customize.receive(event)).catch(() => {});
})();
