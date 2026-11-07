// The host (native app or Python developer server) owns BLE. The lesson consumes the same input API.
import { bluetoothDiagnostic } from './bluetooth-diagnostics.js';
export function startBluetooth(input) {
  const t=(source,params)=>window.PianoI18n.t(source,params);
  const message=source=>window.PianoI18n.message(source);
  const button = document.getElementById('bluetooth-toggle');
  const rediscover=document.getElementById('bluetooth-rediscover');
  const status = document.getElementById('bluetooth-status');
  const activity = document.getElementById('bluetooth-activity');
  const panel = document.getElementById('bluetooth-panel');
  const summary = document.querySelector('#bluetooth-summary .connection-label');
  const explanation=document.getElementById('bluetooth-explanation');
  const help=document.getElementById('bluetooth-help');
  const technical=document.getElementById('bluetooth-technical');
  const technicalText=document.getElementById('bluetooth-technical-text');
  const native = window.webkit?.messageHandlers?.pianoman;
  let state = { phase: 'disconnected', connected: false };
  let stream, live = false, pending = false, connected = false, noteCount = 0;
  let lastNote = null, pedal = null;
  let localDiagnostic=null,renderedDiagnostic='';

  function renderDiagnostic(issue) {
    const key=window.PianoI18n.language+JSON.stringify(issue);
    if(key===renderedDiagnostic) return;
    renderedDiagnostic=key;
    help.replaceChildren();explanation.textContent='';technicalText.textContent='';
    explanation.hidden=help.hidden=technical.hidden=!issue;
    if(!issue) return;
    const guidance=bluetoothDiagnostic(issue,Boolean(native));
    explanation.textContent=guidance.explanation;
    for(const step of guidance.steps) {const item=document.createElement('li');item.textContent=step;help.append(item);}
    const parts=[`Tanı: ${issue.code}`];
    if(issue.stage) parts.push(`Aşama: ${issue.stage}`);
    if(issue.domain) parts.push(`Kaynak: ${issue.domain}`);
    if(issue.osCode!==undefined&&issue.osCode!==null) parts.push(`Kod: ${issue.osCode}`);
    if(issue.detail) parts.push(message(issue.detail));
    if(issue.linkEstablished!==undefined) parts.push(t('Bu denemede Bluetooth bağlantısı kuruldu: {value}',{value:t(issue.linkEstablished?'evet':'hayır')}));
    if(issue.cleanupConfirmed!==undefined) parts.push(t('Bağlantının kapanması onaylandı: {value}',{value:t(issue.cleanupConfirmed?'evet':'hayır')}));
    technicalText.textContent=parts.map(message).join('\n');
    panel.open=true;
  }

  function render() {
    const issue=localDiagnostic||state.diagnostic||(state.phase==='error'?{code:'service_failed',detail:state.message}:null);
    const closing=state.phase==='stopping'||(state.phase==='error'&&state.active);
    panel.dataset.phase = live ? state.phase : 'offline';
    summary.textContent = !live ? t("Piyano") : state.connected ? t("Piyano bağlı") :
      state.phase === 'connecting' ? t("Bağlanıyor…") : state.phase === 'stopping' ? t("Kapatılıyor…") :
      state.phase === 'error' ? t("Bağlantı hatası") : t("Piyanoyu bağla");
    status.textContent = issue?bluetoothDiagnostic(issue,Boolean(native)).title:
      live ? message(state.message) : (native ? t("Piyano bağlantısı hazırlanıyor…") : t("Yerel servise bağlanılıyor…"));
    button.textContent = closing?t("Kapatılıyor…"):state.phase === 'connecting' ? t("Vazgeç") :
      state.connected ? t("Bağlantıyı kes") : state.phase==='error'?t("Tekrar dene"):t("Bağlan");
    button.disabled = !live || pending || closing;
    rediscover.hidden=!issue||!['piano_unreachable','connect_failed'].includes(issue.code);
    rediscover.disabled=!live||pending||state.active;
    renderDiagnostic(issue);
    const note = lastNote ? t('{note} · şiddet {velocity} · {count} basış',{note:lastNote.name,velocity:lastNote.velocity,count:noteCount}) : t("Tuş verisi bekleniyor");
    activity.textContent = state.connected ? note + (pedal ? t(" · sustain basılı") : '') : '';
  }

  function applyStatus(next) {
    localDiagnostic=null;
    state = next;
    noteCount = next.note_count;
    lastNote = next.last_note;
    pedal = next.pedal?.pressed;
    if (state.connected && !connected) {
      input.connect('bluetooth', state.device);
      connected = true;
    } else if (!state.connected && connected) {
      input.disconnect('bluetooth');
      connected = false;
    }
    render();
    window.dispatchEvent(new CustomEvent('pianoman-bluetooth-status',{detail:state}));
  }

  function receive(event) {
    if(event.event==='output_error') {
      window.dispatchEvent(new CustomEvent('pianoman-output-error',{detail:event}));return;
    }
    if (!['snapshot','status','note_on','note_off','pedal','control_change','midi_message'].includes(event.event)) return;
    live = true;
    if (event.event === 'snapshot') {
      input.disconnect('bluetooth');
      connected = false;
      applyStatus(event.status);
      for (const note of event.held) input.receive(note);
    } else if (event.event === 'status') {
      applyStatus(event.status);
    } else {
      input.receive(event);
      if (event.event === 'note_on' && event.velocity > 0) {
        noteCount++;
        lastNote = event;
      } else if (event.event === 'pedal' && event.pedal === 'sustain') {
        pedal = event.pressed;
      }
      render();
    }
  }

  function offline(detail='') {
    localDiagnostic={code:'service_offline',detail};
    live = false;
    connected = false;
    input.disconnect('bluetooth');
    window.dispatchEvent(new CustomEvent('pianoman-bluetooth-status',{detail:{connected:false,output_capable:false}}));
    render();
  }

  function openStream() {
    if (native) {
      native.postMessage({ command: 'subscribe' }).then(snapshot => {
        window.dispatchEvent(new CustomEvent('pianoman-native-event', { detail: snapshot }));
      }).catch(error => {
        offline(error.message);
      });
    } else {
      stream = new EventSource('/api/bluetooth/events');
      stream.onmessage = message => receive(JSON.parse(message.data));
      stream.onerror = ()=>offline();
    }
  }
  if (native) window.addEventListener('pianoman-native-event', event => receive(event.detail));

  async function command(action) {
    if(native) return native.postMessage({command:action});
    const response=await fetch(`/api/bluetooth/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json','X-PianoMan':'1'},body:'{}',
    });
    const result=await response.json();
    if(!response.ok) throw new Error(result.error||'İşlem tamamlanamadı');
    return result;
  }

  rediscover.addEventListener('click',async()=> {
    pending=true;localDiagnostic=null;render();
    try {await command('forget-device');await command('connect');}
    catch(error) {localDiagnostic={code:'command_failed',detail:error.message};}
    finally {pending=false;render();}
  });

  button.addEventListener('click', async () => {
    localDiagnostic=null;
    pending = true;
    const action = state.connected || state.phase === 'connecting' ? 'disconnect' : 'connect';
    render();
    try {
      await command(action);
      // The event stream is authoritative; command replies must not replay notes.
    } catch (error) {
      localDiagnostic={code:'command_failed',detail:error.message};
    } finally {
      pending = false;
      render();
    }
  });
  window.addEventListener('pagehide', () => {
    if (native) native.postMessage({ command: 'unsubscribe' }).catch(() => {});
    else stream.close();
    offline();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) openStream(); });
  window.addEventListener('pianoman-language-change',render);
  openStream();
  render();
}
