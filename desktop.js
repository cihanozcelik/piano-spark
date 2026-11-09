(() => {
  const { t, message } = window.PianoI18n;
  const button = document.getElementById('fullscreen');
  let fullscreen = false;
  const native = window.webkit?.messageHandlers?.pianoman;
  const show = active => {
    fullscreen = active;
    const label = t(active ? 'Tam ekrandan çık' : 'Tam ekran');
    document.getElementById('fullscreen-label').textContent = label;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(active));
  };
  window.addEventListener('pianoman-language-change', () => show(fullscreen));
  show(Boolean(document.fullscreenElement));
  if (native) {
    window.addEventListener('pianoman-native-event', event => {
      if (event.detail.event === 'fullscreen') show(event.detail.active);
      else if (event.detail.event === 'snapshot') show(event.detail.fullscreen);
    });
    button.addEventListener('click', () => {
      native.postMessage({ command: 'fullscreen' }).catch(error => {
        document.getElementById('error').textContent = message(error.message);
        document.getElementById('error').hidden = false;
      });
    });
  } else {
    button.hidden = !document.fullscreenEnabled;
    button.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) {
        document.getElementById('error').textContent = message(error.message);
        document.getElementById('error').hidden = false;
      }
    });
    document.addEventListener('fullscreenchange', () => show(Boolean(document.fullscreenElement)));
  }
})();

// Native updater owns networking, credentials and installation; this only renders state.
(() => {
  const { t, message } = window.PianoI18n;
  const native=window.webkit?.messageHandlers?.pianoman;
  if(!native) return;
  const panel=document.getElementById('update-panel');
  const label=document.getElementById('update-label');
  let current;
  const report=error=>{document.getElementById('update-status').textContent=message(error.message);};
  function render(update) {
    current=update; panel.hidden=false;
    const available=Boolean(update.availableVersion);
    panel.dataset.available=String(available);
    panel.dataset.installed=String(update.newVersion&&!available);
    label.textContent=available?t('Güncelleme'):update.newVersion?t('Yeni sürüm yüklendi'):`v${update.version}`;
    document.getElementById('update-heading').textContent=available?t('{version} sürümü hazır',{version:update.availableVersion}):
      update.newVersion?t('{version} yüklendi',{version:update.version}):`Rach3 ${update.version}`;
    document.getElementById('update-status').textContent=message(update.message);
    const notes=available?update.availableNotes.split('\n').filter(Boolean):update.notes;
    document.getElementById('update-notes').replaceChildren(...notes.map(note=>{
      const item=document.createElement('li');item.textContent=message(note);return item;
    }));
  }
  window.addEventListener('pianoman-native-event',event=>{if(event.detail.event==='update') render(event.detail);});
  document.getElementById('update-check').addEventListener('click',()=>native.postMessage({command:'update-check'}).catch(report));
  panel.addEventListener('toggle',()=>{if(!panel.open&&current?.newVersion) native.postMessage({command:'update-read'}).catch(report);});
  window.addEventListener('pianoman-language-change',()=>{if(current) render(current);});
  native.postMessage({command:'update-state'}).then(render).catch(report);
})();
