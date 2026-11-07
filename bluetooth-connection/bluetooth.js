// The host (native app or Python developer server) owns BLE. The lesson consumes the same input API.
import { bluetoothDiagnostic } from './bluetooth-diagnostics.js';
export function startBluetooth(input) {
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
    const key=JSON.stringify(issue);
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
    if(issue.detail) parts.push(issue.detail);
    if(issue.linkEstablished!==undefined) parts.push(`Bu denemede Bluetooth bağlantısı kuruldu: ${issue.linkEstablished?'evet':'hayır'}`);
    if(issue.cleanupConfirmed!==undefined) parts.push(`Bağlantının kapanması onaylandı: ${issue.cleanupConfirmed?'evet':'hayır'}`);
    technicalText.textContent=parts.join('\n');
    panel.open=true;
  }

  function render() {
    const issue=localDiagnostic||state.diagnostic||(state.phase==='error'?{code:'service_failed',detail:state.message}:null);
    const closing=state.phase==='stopping'||(state.phase==='error'&&state.active);
    panel.dataset.phase = live ? state.phase : 'offline';
    summary.textContent = !live ? 'Piyano' : state.connected ? 'Piyano bağlı' :
      state.phase === 'connecting' ? 'Bağlanıyor…' : state.phase === 'stopping' ? 'Kapatılıyor…' :
      state.phase === 'error' ? 'Bağlantı hatası' : 'Piyanoyu bağla';
    status.textContent = issue?bluetoothDiagnostic(issue,Boolean(native)).title:
      live ? state.message : (native ? 'Piyano bağlantısı hazırlanıyor…' : 'Yerel servise bağlanılıyor…');
    button.textContent = closing?'Kapatılıyor…':state.phase === 'connecting' ? 'Vazgeç' :
      state.connected ? 'Bağlantıyı kes' : state.phase==='error'?'Tekrar dene':'Bağlan';
    button.disabled = !live || pending || closing;
    rediscover.hidden=!issue||!['piano_unreachable','connect_failed'].includes(issue.code);
    rediscover.disabled=!live||pending||state.active;
    renderDiagnostic(issue);
    const note = lastNote ? `${lastNote.name} · şiddet ${lastNote.velocity} · ${noteCount} basış` : 'Tuş verisi bekleniyor';
    activity.textContent = state.connected ? note + (pedal ? ' · sustain basılı' : '') : '';
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
  openStream();
  render();
}
