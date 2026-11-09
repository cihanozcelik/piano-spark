(() => {
  const { t, message } = window.PianoI18n;
  const button = document.getElementById('fullscreen');
  let fullscreen = false;
  const native = window.webkit?.messageHandlers?.rach3;
  const show = active => {
    fullscreen = active;
    document.documentElement.dataset.fullscreen = String(active);
    const label = t(active ? 'Tam ekrandan çık' : 'Tam ekran');
    document.getElementById('fullscreen-label').textContent = label;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(active));
  };
  window.addEventListener('rach3-language-change', () => show(fullscreen));
  show(Boolean(document.fullscreenElement));
  if (native) {
    window.addEventListener('rach3-native-event', event => {
      if (event.detail.event === 'fullscreen') show(event.detail.active);
      else if (event.detail.event === 'snapshot') show(event.detail.fullscreen);
    });
    // The header doubles as the Mac title bar: dragging an empty part of it moves the window.
    const header = document.querySelector('.app-bar');
    const interactive = 'button,a,input,select,textarea,label,summary,[role=tab],.popover-content,[contenteditable]';
    header.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.target.closest(interactive)) return;
      native.postMessage({ command: event.detail === 2 ? 'title-double-click' : 'drag-window' }).catch(() => {});
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
  const native=window.webkit?.messageHandlers?.rach3;
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
      update.newVersion?t('{version} yüklendi',{version:update.version}):`rach3 ${update.version}`;
    document.getElementById('update-status').textContent=message(update.message);
    const notes=available?update.availableNotes.split('\n').filter(Boolean):update.notes;
    document.getElementById('update-notes').replaceChildren(...notes.map(note=>{
      const item=document.createElement('li');item.textContent=message(note);return item;
    }));
  }
  window.addEventListener('rach3-native-event',event=>{if(event.detail.event==='update') render(event.detail);});
  document.getElementById('update-check').addEventListener('click',()=>native.postMessage({command:'update-check'}).catch(report));
  panel.addEventListener('toggle',()=>{if(!panel.open&&current?.newVersion) native.postMessage({command:'update-read'}).catch(report);});
  window.addEventListener('rach3-language-change',()=>{if(current) render(current);});
  native.postMessage({command:'update-state'}).then(render).catch(report);
})();
