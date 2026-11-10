// The "With AI" tab of Create a Lesson: a conversation with ChatGPT about which
// piece to learn. ChatGPT shows candidates as cards (a YouTube video, a MIDI file to
// listen to, the first pages of a PDF score); rach3 fetches them, and turns the one
// the person agrees on into a lesson with its own import.
export function startLessonChat({ container, command, openLesson, onBusy }) {
  const t = (key, params) => window.PianoI18n.t(key, params);
  const native = window.webkit?.messageHandlers?.rach3;
  // Where the app serves the candidates' files: next to the page, or on Windows from its own host.
  const asset = path => (window.PianoDeskFiles || '/') + path;
  let state = null, live = null, notice = '', sending = false;
  let player = null, video = null, placed = '';

  const element = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  };
  // **bold** only; everything else stays plain text.
  const rich = text => String(text || '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map(part => part.startsWith('**') && part.endsWith('**') ? element('strong', {}, part.slice(2, -2)) : part);
  const size = bytes => (bytes / 1e9 >= 1 ? (bytes / 1e9).toLocaleString(window.PianoI18n.language === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 1 }) + ' GB'
    : Math.max(1, Math.round(bytes / 1e6)) + ' MB');
  const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  const log = element('div', { class: 'ai-log', 'aria-live': 'polite' });
  const input = element('textarea', { rows: '2', placeholder: t('Hangi parçayı çalışmak istersin?'), 'aria-label': t('Hangi parçayı çalışmak istersin?') });
  const send = element('button', { type: 'button', class: 'primary', onclick: () => submit() }, t('Gönder'));
  const stop = element('button', { type: 'button', onclick: () => command('desk-stop').catch(() => {}) }, t('Durdur'));
  const fresh = element('button', { type: 'button', class: 'subtle-button', onclick: () => clear() }, t('Yeni sohbet'));
  const composer = element('div', { class: 'ai-composer' }, input, element('div', { class: 'ai-composer-actions' }, fresh, stop, send));
  container.append(log, composer);

  input.addEventListener('keydown', event => {
    event.stopPropagation();   // typing here never reaches the player's shortcuts
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });

  async function submit() {
    const text = input.value.trim();
    if (!text || sending || state?.busy) return;
    sending = true; notice = ''; live = { text: '' };
    state = { ...state, busy: true, entries: [...(state?.entries || []), { role: 'user', text }] };
    input.value = ''; render();
    try { await command('desk-send', { text }); }
    catch (error) { notice = errorText(error.message); input.value = text; live = null; await refresh(); }
    finally { sending = false; render(); }
  }

  async function clear() {
    try { await command('desk-clear'); notice = ''; live = null; stopPlayer(); closeVideo(); await refresh(); }
    catch (error) { notice = errorText(error.message); render(); }
  }

  const errorText = code => ({
    busy: t('ChatGPT şu an başka bir iş yapıyor. Bitince yeniden dene.'),
    making: t('Önce hazırlanan dersin bitmesini bekle.'),
    'signed-out': t('Önce ChatGPT hesabınla giriş yap.'), expired: t('Önce ChatGPT hesabınla giriş yap.'),
    offline: t('İnternete bağlanılamadı.'), codex: t('ChatGPT’ye ulaşılamadı. Yeniden dene.'),
  }[code] || code || t('Bir şeyler ters gitti.'));
  const signInText = code => ({
    failed: t('Giriş tamamlanmadı. Yeniden dene.'), denied: t('Giriş iptal edildi.'),
    plan: t('Bu ChatGPT hesabı planını uygulamalarla paylaşamıyor. Planını ChatGPT’de kontrol et.'),
    port: t('rach3 giriş dönüşünü açamadı. rach3’ü yeniden başlatıp tekrar dene.'),
  }[code] || errorText(code));
  async function signIn() {
    notice = ''; render();
    try { await command('desk-sign-in'); }
    catch (error) { notice = signInText(error.message); }
    await refresh();
  }

  async function refresh() {
    if (!native) { state = { unavailable: true }; render(); return; }
    try { state = await command('desk-state'); }
    catch { state = { unavailable: true }; }
    render();
  }

  // MIDI candidates play in the page with a soft synth, nothing is sent to the piano.
  function stopPlayer() {
    if (!player) return;
    clearInterval(player.timer);
    player.voices.forEach(voice => { try { voice.stop(); } catch {} });
    player.context.close().catch(() => {});
    const card = player.card; player = null;
    if (card) render();
  }
  async function playMidi(card) {
    if (player?.card === card.id) { stopPlayer(); return; }
    stopPlayer(); closeVideo();
    try {
      const response = await fetch(asset(card.file));
      const midi = new Midi(await response.arrayBuffer());
      const notes = midi.tracks.flatMap(track => track.notes).sort((a, b) => a.time - b.time);
      if (!notes.length) { notice = t('Bu MIDI’de nota yok.'); render(); return; }
      const context = new AudioContext();
      const master = context.createGain(); master.gain.value = .22; master.connect(context.destination);
      const start = context.currentTime + .1 - notes[0].time;
      player = { card: card.id, context, voices: new Set(), index: 0, duration: notes.at(-1).time + notes.at(-1).duration - notes[0].time };
      const schedule = () => {
        if (!player) return;
        const until = context.currentTime + 1.2;
        while (player.index < notes.length && start + notes[player.index].time < until) {
          const note = notes[player.index++];
          const when = start + note.time, end = when + Math.max(.08, Math.min(note.duration, 4));
          const oscillator = context.createOscillator(), gain = context.createGain();
          oscillator.type = 'triangle'; oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
          gain.gain.setValueAtTime(0, when);
          gain.gain.linearRampToValueAtTime(.25 * (note.velocity || .7), when + .01);
          gain.gain.exponentialRampToValueAtTime(.001, end + .25);
          oscillator.connect(gain); gain.connect(master);
          oscillator.start(when); oscillator.stop(end + .3);
          player.voices.add(oscillator);
          oscillator.onended = () => { player?.voices.delete(oscillator); gain.disconnect(); };
        }
        if (player.index >= notes.length && !player.voices.size) stopPlayer();
      };
      player.timer = setInterval(schedule, 250); schedule();
      render();
    } catch { stopPlayer(); notice = t('MIDI çalınamadı.'); render(); }
  }

  // YouTube plays in a native player laid exactly over the card; the page only tells it where.
  async function playVideo(card) {
    stopPlayer();
    try {
      const result = await command('desk-play', { card: card.id });
      if (result?.external) return;   // opened on YouTube in the browser
      video = card.id; placed = ''; render(); requestAnimationFrame(followVideo);
    }
    catch (error) { notice = errorText(error.message); render(); }
  }
  function closeVideo() {
    if (!video) return;
    video = null; placed = '';
    command('desk-video-close').catch(() => {});
  }
  function followVideo() {
    if (!video) return;
    const frame = log.querySelector('.ai-video.playing');
    if (!frame || !frame.offsetParent) { closeVideo(); render(); return; }
    const box = frame.getBoundingClientRect(), view = log.getBoundingClientRect();
    const left = Math.max(box.left, view.left), top = Math.max(box.top, view.top);
    const clip = [left, top, Math.max(0, Math.min(box.right, view.right) - left), Math.max(0, Math.min(box.bottom, view.bottom) - top)];
    const next = JSON.stringify([box.left, box.top, box.width, box.height, ...clip].map(Math.round));
    if (next !== placed) { placed = next; command('desk-video-place', { frame: [box.left, box.top, box.width, box.height], clip }).catch(() => {}); }
    requestAnimationFrame(followVideo);
  }

  // A small piano roll of the first notes, so the person sees what they will play.
  function midiRoll(card) {
    const canvas = element('canvas', { class: 'ai-roll', width: '640', height: '120', 'aria-hidden': 'true' });
    fetch(asset(card.file)).then(response => response.arrayBuffer()).then(data => {
      const midi = new Midi(data);
      const notes = midi.tracks.flatMap(track => track.notes);
      if (!notes.length) return;
      const first = Math.min(...notes.map(note => note.time));
      const end = Math.max(...notes.map(note => note.time + note.duration));
      const span = Math.min(40, end - first);
      const shown = notes.filter(note => note.time - first < span);
      const low = Math.min(...shown.map(note => note.midi)) - 2, high = Math.max(...shown.map(note => note.midi)) + 2;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#1a1a1d'; draw.fillRect(0, 0, 640, 120);
      for (const note of shown) {
        draw.fillStyle = note.midi < 60 ? '#75a7ff' : '#efab91';
        const x = (note.time - first) / span * 640, y = 120 - (note.midi - low + 1) / (high - low + 1) * 120;
        draw.fillRect(x, y, Math.max(2, note.duration / span * 640), Math.max(2, 120 / (high - low + 1)));
      }
      const info = canvas.parentElement?.querySelector('.ai-midi-info');
      if (info) info.textContent = t('{notes} nota · {length}', { notes: notes.length.toLocaleString(window.PianoI18n.language === 'tr' ? 'tr-TR' : 'en-US'), length: clock(end - first) });
    }).catch(() => {});
    return canvas;
  }

  // A full-window look at a PDF: every page, zoom with a pinch, the buttons or a double
  // click, and drag or scroll to move around.
  function openPages(card, first) {
    stopPlayer(); closeVideo();
    document.querySelector('.ai-viewer')?.remove();
    const count = Math.max(1, card.pageCount || (card.pages || []).length);
    let number = first, scale = 1, x = 0, y = 0, fit = 1, natural = null;
    const image = element('img', { alt: '', draggable: 'false' });
    const loading = element('p', {}, t('Sayfa hazırlanıyor…'));
    const stage = element('div', { class: 'ai-viewer-stage' }, image, loading);
    const counter = element('span', {});
    const previous = element('button', { type: 'button', class: 'ai-viewer-turn', 'data-side': 'previous', 'aria-label': t('Önceki sayfa'), onclick: () => turn(-1) }, '‹');
    const next = element('button', { type: 'button', class: 'ai-viewer-turn', 'data-side': 'next', 'aria-label': t('Sonraki sayfa'), onclick: () => turn(1) }, '›');
    stage.append(previous, next);
    const viewer = element('div', { class: 'ai-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': card.title || t('Nota PDF’si') },
      element('div', { class: 'ai-viewer-bar' },
        element('strong', {}, card.title || ''),
        element('button', { type: 'button', 'aria-label': t('Uzaklaştır'), onclick: () => zoomBy(1 / 1.25) }, '−'),
        element('button', { type: 'button', 'aria-label': t('Yakınlaştır'), onclick: () => zoomBy(1.25) }, '+'),
        element('button', { type: 'button', onclick: () => fitWidth() }, t('Sığdır')),
        counter,
        element('button', { type: 'button', 'aria-label': t('Kapat'), onclick: () => close() }, '✕')),
      stage);

    const box = () => stage.getBoundingClientRect();
    const place = () => {
      if (!natural) return;
      const { width, height } = box(), w = natural.width * scale, h = natural.height * scale;
      // Keep the page on screen: centred when smaller than the window, edge to edge when larger.
      x = w <= width ? (width - w) / 2 : Math.min(0, Math.max(width - w, x));
      y = h <= height ? (height - h) / 2 : Math.min(0, Math.max(height - h, y));
      image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };
    const zoomAt = (factor, px, py) => {
      const next = Math.min(fit * 6, Math.max(fit * 0.5, scale * factor));
      x = px - (px - x) * (next / scale); y = py - (py - y) * (next / scale);
      scale = next; place();
    };
    const zoomBy = factor => { const { width, height } = box(); zoomAt(factor, width / 2, height / 2); };
    const fitWidth = () => {
      if (!natural) return;
      // The whole width of the music, with the top of the page in view.
      fit = Math.max(0.05, (box().width - 48) / natural.width);
      scale = fit; x = 0; y = 12; place();
    };
    const show = () => {
      counter.textContent = `${number} / ${count}`;
      previous.disabled = number <= 1; next.disabled = number >= count;
      natural = null; image.style.visibility = 'hidden'; loading.hidden = false;
      image.onload = () => {
        natural = { width: image.naturalWidth, height: image.naturalHeight };
        loading.hidden = true; image.style.visibility = '';
        fitWidth();
      };
      image.onerror = () => { loading.textContent = t('Bu sayfa açılamadı.'); };
      image.src = asset(`_desk/${card.id}/large-${number}.png`);
    };
    const turn = step => { const target = number + step; if (target >= 1 && target <= count) { number = target; show(); } };

    stage.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = box();
      if (event.ctrlKey) zoomAt(Math.exp(-event.deltaY / 120), event.clientX - rect.left, event.clientY - rect.top);
      else { x -= event.deltaX; y -= event.deltaY; place(); }
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, x, y };
      stage.setPointerCapture(event.pointerId); stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      x = drag.x + event.clientX - drag.sx; y = drag.y + event.clientY - drag.sy; place();
    });
    const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('dblclick', event => {
      if (event.target.closest('button')) return;
      const rect = box();
      if (scale > fit * 1.3) fitWidth(); else zoomAt(2.2, event.clientX - rect.left, event.clientY - rect.top);
    });
    const keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowRight' || event.key === 'PageDown') turn(1);
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') turn(-1);
      else if (event.key === '+' || event.key === '=') zoomBy(1.25);
      else if (event.key === '-') zoomBy(1 / 1.25);
      else if (event.key === '0') fitWidth();
      else return;
      event.stopPropagation();
    };
    const resize = () => fitWidth();
    function close() {
      document.removeEventListener('keydown', keys, true); window.removeEventListener('resize', resize);
      viewer.remove();
    }
    document.addEventListener('keydown', keys, true); window.addEventListener('resize', resize);
    document.body.append(viewer);
    show();
    viewer.querySelector('.ai-viewer-bar button:last-child').focus();
  }

  function cardView(card) {
    if (!card) return null;
    const kind = { youtube: t('YouTube videosu'), midi: 'MIDI', pdf: t('Nota PDF’si') }[card.kind] || '';
    const body = [];
    if (card.kind === 'youtube') {
      if (video === card.id) body.push(element('div', { class: 'ai-video playing', 'data-card': card.id }));
      else body.push(element('button', { type: 'button', class: 'ai-video', 'aria-label': t('Videoyu izle'), onclick: () => playVideo(card) },
        card.thumb ? element('img', { src: asset(card.thumb), alt: '' }) : null, element('span', { class: 'ai-play' }, '▶')));
      const about = [card.author, card.embeddable === false ? t('Sahibi başka uygulamalarda oynatılmasına izin vermiyor; tıklayınca YouTube’da açılır.') : ''].filter(Boolean).join(' · ');
      if (about) body.push(element('small', { class: 'ai-meta' }, about));
    } else if (card.kind === 'midi') {
      body.push(element('div', { class: 'ai-midi' }, midiRoll(card),
        element('div', { class: 'ai-midi-bar' },
          element('button', { type: 'button', onclick: () => playMidi(card) }, player?.card === card.id ? t('Durdur') : t('Dinle')),
          element('small', { class: 'ai-midi-info ai-meta' }, ''))));
    } else if (card.kind === 'pdf') {
      body.push(element('div', { class: 'ai-pages' }, (card.pages || []).map((page, index) =>
        element('button', { type: 'button', 'aria-label': t('{page}. sayfayı büyüt', { page: index + 1 }), onclick: () => openPages(card, index + 1) },
          element('img', { src: asset(page), alt: '', loading: 'lazy' })))));
      body.push(element('small', { class: 'ai-meta' }, t('{count} sayfa', { count: card.pageCount || 0 })));
    }
    const busyElsewhere = state?.busy || state?.making;
    let action = null;
    if (card.state === 'made') action = element('button', { type: 'button', onclick: () => card.lesson && openLesson(card.lesson) }, t('Dersi aç'));
    else if (card.state === 'making') action = element('button', { type: 'button', disabled: true }, t('Ders hazırlanıyor…'));
    else {
      const label = card.state === 'needs-tools' && card.toolBytes ? t('İndir ve ders yap · {size}', { size: size(card.toolBytes) }) : t('Bunu ders yap');
      action = element('button', { type: 'button', class: 'primary', disabled: !!busyElsewhere,
        onclick: () => command('desk-make', { card: card.id }).catch(error => { notice = errorText(error.message); render(); }) }, label);
    }
    return element('article', { class: 'ai-card', 'data-kind': card.kind },
      element('header', {}, element('small', { class: 'ai-kind' }, kind), element('strong', {}, card.title || '')),
      card.note ? element('p', { class: 'ai-note' }, card.note) : null,
      body,
      card.error ? element('p', { class: 'ai-error' }, card.error) : null,
      element('footer', {}, action));
  }

  function render() {
    log.replaceChildren();
    container.dataset.state = state?.unavailable ? 'unavailable' : state && !state.signedIn ? 'signed-out' : 'ready';
    if (!state) return;
    if (state.unavailable) {
      log.append(element('p', { class: 'ai-empty' }, t('AI ile ders yapmak bu bilgisayarda henüz yok.')));
      composer.hidden = true; return;
    }
    if (!state.signedIn) {
      log.append(element('div', { class: 'ai-empty' },
        element('p', {}, t('ChatGPT hesabınla giriş yap; istediğin parçayı birlikte bulup derse çevirelim.')),
        element('button', { type: 'button', class: 'primary', onclick: () => signIn() }, t('ChatGPT ile giriş yap')),
        state.signingIn ? element('p', { class: 'ai-meta' }, t('Tarayıcıda ChatGPT girişi bekleniyor…')) : null,
        notice ? element('p', { class: 'ai-error' }, notice) : null));
      composer.hidden = true; return;
    }
    composer.hidden = false;
    const entries = state.entries || [];
    if (!entries.length && !state.busy) log.append(element('div', { class: 'ai-empty' },
      element('p', {}, t('Çalışmak istediğin parçayı yaz. Sana YouTube videoları, dinleyebileceğin MIDI’ler ve nota sayfaları gösteririm; beğendiğini derse çeviririm.')),
      element('p', { class: 'ai-example' }, t('Örnek: “Für Elise’in kolay bir versiyonunu bul.”'))));
    for (const entry of entries) {
      if (entry.role === 'user') log.append(element('div', { class: 'ai-msg user' }, entry.text));
      else if (entry.role === 'assistant') log.append(element('div', { class: 'ai-msg assistant' + (entry.commentary ? ' commentary' : '') }, rich(entry.text)));
      else if (entry.role === 'card') log.append(cardView(entry.card));
      else if (entry.role === 'error') log.append(element('p', { class: 'ai-error' }, errorText(entry.text)));
    }
    if (state.busy) {
      if (live?.text) log.append(element('div', { class: 'ai-msg assistant' }, rich(live.text)));
      log.append(element('div', { class: 'ai-activity' }, element('span', { class: 'dot' }),
        element('span', {}, live?.activity || t('Düşünüyor…'), element('span', { class: 'ai-elapsed' }, elapsed()))));
    }
    if (state.elsewhere) log.append(element('p', { class: 'ai-meta' }, t('ChatGPT şu an rach3’ü değiştiriyor. Bitince yazabilirsin.')));
    if (notice) log.append(element('p', { class: 'ai-error' }, notice));
    input.disabled = !!state.busy || !!state.elsewhere;
    send.hidden = !!state.busy; stop.hidden = !state.busy;
    send.disabled = sending || !!state.elsewhere;
    fresh.disabled = !!state.busy || !entries.length;
    onBusy?.(!!state.busy);
    log.scrollTop = log.scrollHeight;
  }

  // What ChatGPT is doing right now, and for how long, so a slow site never looks like a hang.
  const amountText = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  const elapsed = () => {
    const seconds = live?.since ? Math.floor((Date.now() - live.since) / 1000) : 0;
    return seconds >= 3 ? ' · ' + t('{seconds} sn', { seconds }) : '';
  };
  const doing = text => { live = live || { text: '' }; if (live.activity !== text) { live.activity = text; live.since = Date.now(); } };
  const toolActivity = item => {
    const args = item.arguments || {};
    if (item.tool === 'show') {
      let host = '';
      try { host = new URL(args.source).hostname.replace(/^www\./, ''); } catch {}
      return t('Açıyor: {what}', { what: args.title || host || t('bağlantı') });
    }
    if (item.tool === 'make_lesson') return t('Ders hazırlıyor…');
    if (item.tool === 'list_lessons' || item.tool === 'read_lesson') return t('Derslerine bakıyor…');
    return t('Çalışıyor…');
  };
  setInterval(() => {
    const line = log.querySelector('.ai-elapsed');
    if (line && state?.busy) line.textContent = elapsed();
  }, 1000);

  window.addEventListener('rach3-native-event', event => {
    const detail = event.detail || {};
    if (detail.event === 'desk-state') { state = detail; if (!state.busy) live = null; render(); }
    else if (detail.event === 'desk-card') refresh();
    else if (detail.event === 'desk-progress') {
      const since = live?.since;
      if (detail.stage === 'download') {
        const amount = detail.total ? amountText(detail.received) + ' / ' + amountText(detail.total) : detail.received ? amountText(detail.received) : '';
        doing(t('{site} sitesinden indiriyor', { site: detail.host.replace(/^www\./, '') }) + (amount ? ' · ' + amount : ''));
        if (since) live.since = since;   // the same download, still counting
      } else if (detail.stage === 'pages') doing(t('Nota sayfalarını hazırlıyor…'));
      else if (detail.stage === 'video') doing(t('YouTube’dan video bilgisini alıyor…'));
      render();
    }
    else if (detail.event === 'desk-finished') { live = null; refresh(); }
    else if (detail.event === 'desk-codex') {
      const { method, params } = detail;
      live = live || { text: '' };
      if (method === 'item/agentMessage/delta') live.text += params.delta || '';
      else if (method === 'item/started') {
        const item = params.item || {};
        if (item.type === 'webSearch') doing(item.query ? t('Web’de arıyor: “{query}”', { query: item.query }) : t('Web’de arıyor…'));
        else if (item.type === 'dynamicToolCall') doing(toolActivity(item));
        else if (item.type === 'reasoning') doing(t('Düşünüyor…'));
        if (item.type === 'agentMessage') live.text = '';
      } else if (method === 'item/completed' && params.item?.type === 'webSearch') {
        const item = params.item, query = item.query || item.action?.query, page = item.action?.url;
        if (page) { let host = page; try { host = new URL(page).hostname.replace(/^www\./, ''); } catch {} doing(t('{site} sayfasını okudu', { site: host })); }
        else if (query) doing(t('“{query}” için sonuçları okuyor…', { query }));
      } else if (method === 'item/completed' && params.item?.type === 'agentMessage') { live.text = ''; refresh(); return; }
      render();
    } else if (detail.event === 'language') {
      input.placeholder = t('Hangi parçayı çalışmak istersin?');
      send.textContent = t('Gönder'); stop.textContent = t('Durdur'); fresh.textContent = t('Yeni sohbet');
      render();
    }
  });
  refresh();
  return { focus: () => { if (!input.disabled && !composer.hidden) input.focus(); }, refresh };
}
