// Native owns discovery/connection; WorkspaceState owns all remembered device preferences.
// Both hosts expose the same snapshot and command contract. No vendor-name allowlist.
import { bluetoothDiagnostic } from './bluetooth-diagnostics.js';
export function startBluetooth(input, workspace) {
  const t=(source,params)=>window.PianoI18n.t(source,params);
  const message=source=>window.PianoI18n.message(source);
  const el=id=>document.getElementById(`bluetooth-${id}`);
  const button=el('toggle'),scan=el('scan'),status=el('status'),activity=el('activity'),panel=el('panel');
  const summary=document.querySelector('#bluetooth-summary .connection-label');
  const explanation=el('explanation'),help=el('help'),technical=el('technical'),technicalText=el('technical-text');
  const devices=el('devices'),settings=el('settings'),name=el('name'),channel=el('channel');
  const preferred=el('default'),automatic=el('auto'),forget=el('forget'),test=el('test');
  const native=window.webkit?.messageHandlers?.rach3;
  const uuidPattern=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const saved=workspace.data.bluetooth;
  const preferences={version:1,devices:{},defaultUUID:null,migrated:false,...(saved?.version===1?saved:{})};
  preferences.devices=Object.fromEntries(Object.entries(preferences.devices).filter(([uuid,device])=>
    uuidPattern.test(uuid)&&device&&typeof device.name==='string'&&Number.isInteger(device.channel)&&device.channel>=1&&device.channel<=16));
  let state={phase:'disconnected',connected:false,devices:[]};
  let stream,live=false,pending=false,connected=false,noteCount=0,lastNote=null,pedal=null;
  let selected=preferences.defaultUUID,localDiagnostic=null,renderedDiagnostic='',renderedDevices='',renderedSettings='';
  let retryTimer=null,retryUUID=null,retryCount=0,initialStatus=false,disposed=false,testPending=false;
  const canChoose=()=>live&&!pending&&(!state.active||['scanning','idle'].includes(state.phase));
  const profile=uuid=>preferences.devices[uuid];
  const recommendedChannel=deviceName=>/\bFP[- ]?(30X|60X|90X)\b/i.test(deviceName)?4:1;
  function save() {workspace.update('bluetooth',preferences);workspace.flush();}
  function emitStatus() {
    window.dispatchEvent(new CustomEvent('rach3-bluetooth-status',{detail:{...state,
      connected:live&&state.connected,output_channel:profile(state.uuid)?.channel||1}}));
  }
  for(let value=1;value<=16;value++) {const option=document.createElement('option');option.value=value;option.textContent=value;channel.append(option);}

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
    const parts=[t('Tanı: {code}',{code:issue.code})];
    if(issue.stage) parts.push(t('Aşama: {stage}',{stage:issue.stage}));
    if(issue.domain) parts.push(`Domain: ${issue.domain}`);
    if(issue.osCode!==undefined&&issue.osCode!==null) parts.push(`Code: ${issue.osCode}`);
    if(issue.detail) parts.push(message(issue.detail));
    if(issue.linkEstablished!==undefined) parts.push(t('Bu denemede Bluetooth bağlantısı kuruldu: {value}',{value:t(issue.linkEstablished?'evet':'hayır')}));
    if(issue.cleanupConfirmed!==undefined) parts.push(t('Bağlantının kapanması onaylandı: {value}',{value:t(issue.cleanupConfirmed?'evet':'hayır')}));
    technicalText.textContent=parts.join('\n');
    panel.open=true;
  }

  const sections=['Kayıtlı piyanolar','Yakındaki MIDI cihazları'].map(title=> {
    const element=document.createElement('section'),heading=document.createElement('h3');
    element.append(heading);devices.append(element);
    return {element,heading,title,rows:new Map()};
  });
  function renderDevices() {
    const nearby=state.devices||[];
    const key=JSON.stringify([preferences,nearby,selected,state.uuid,state.connected,state.phase,canChoose(),window.PianoI18n.language]);
    if(key===renderedDevices) return;
    renderedDevices=key;
    const groups=[Object.entries(preferences.devices).map(([uuid,item])=>({...item,uuid})),nearby.filter(item=>!profile(item.uuid))];
    groups.forEach((items,groupIndex)=> {
      const section=sections[groupIndex];
      section.element.hidden=!items.length;section.heading.textContent=t(section.title);
      const current=new Set(items.map(item=>item.uuid));
      for(const [uuid,view] of section.rows) if(!current.has(uuid)) {view.row.remove();section.rows.delete(uuid);}
      items.sort((a,b)=>(b.uuid===preferences.defaultUUID)-(a.uuid===preferences.defaultUUID)||a.name.localeCompare(b.name)||a.uuid.localeCompare(b.uuid));
      items.forEach((device,index)=> {
        const uuid=device.uuid,remembered=profile(uuid),found=nearby.find(item=>item.uuid===uuid);
        let view=section.rows.get(uuid);
        if(!view) {
          const row=document.createElement('div');row.className='bluetooth-device';
          const select=document.createElement('button');select.type='button';select.className='device-select';
          const label=document.createElement('span'),detail=document.createElement('small');select.append(label,detail);
          select.addEventListener('click',()=>{selected=uuid;render();});
          const connect=document.createElement('button');connect.type='button';connect.addEventListener('click',()=>connectDevice(uuid));
          row.append(select,connect);view={row,label,detail,connect};section.rows.set(uuid,view);
        }
        view.row.setAttribute('aria-current',String(selected===uuid));view.label.textContent=remembered?.name||device.name;
        const signal=found?.rssi;
        const connection=state.connected&&state.uuid===uuid?t('Bağlı'):
          found?t(state.phase!=='scanning'||Date.now()/1000-found.time_unix>10?'Son taramada görüldü':Number.isFinite(signal)?(signal>=-65?'Sinyal güçlü':signal>=-80?'Sinyal orta':'Sinyal zayıf'):'Bulundu'):t('Kayıtlı · yakında olduğu doğrulanmadı');
        view.detail.textContent=`${connection} · ${uuid.slice(-6)}${preferences.defaultUUID===uuid?' · '+t('Varsayılan'):''}`;
        view.connect.textContent=t(state.connected&&state.uuid===uuid?'Bağlı':'Bağlan');view.connect.disabled=!canChoose();
        // Keep focused buttons in place while RSSI advertisements update.
        const next=section.element.children[index+1];
        if(next!==view.row) section.element.insertBefore(view.row,next||null);
      });
    });
    el('empty').hidden=groups.some(items=>items.length);
    el('empty').textContent=t(state.phase==='scanning'?'Bluetooth MIDI cihazları aranıyor…':'Henüz cihaz bulunmadı. Piyanoyu açıp yeniden tara.');
  }

  function render() {
    const issue=localDiagnostic||state.diagnostic||(state.phase==='error'?{code:'service_failed',detail:state.message}:null);
    const closing=state.phase==='stopping'||(state.phase==='error'&&state.active);
    const busy=['starting','connecting'].includes(state.phase);
    panel.dataset.phase=live?state.phase:'offline';
    summary.textContent=!live?t('Piyano'):state.connected?(profile(state.uuid)?.name||state.device):
      busy?t('Bağlanıyor…'):state.phase==='scanning'?t('Aranıyor…'):state.phase==='error'?t('Bağlantı hatası'):t('Piyanoyu bağla');
    status.textContent=issue?bluetoothDiagnostic(issue,Boolean(native)).title:
      live?message(state.message):(native?t('Piyano bağlantısı hazırlanıyor…'):t('Yerel servise bağlanılıyor…'));
    scan.textContent=t(state.phase==='scanning'?'Taramayı durdur':state.devices?.length?'Yeniden tara':'Yakındaki piyanoları ara');
    scan.disabled=!live||pending||closing||state.connected||busy;
    button.hidden=!state.active&&!retryTimer;
    button.textContent=t(closing?'Kapatılıyor…':busy||retryTimer?'Vazgeç':'Bağlantıyı kes');
    button.disabled=!live||pending||closing;
    renderDiagnostic(issue);renderDevices();
    const device=profile(selected);
    settings.hidden=!device;
    const settingsKey=JSON.stringify([selected,device,preferences.defaultUUID]);
    if(settingsKey!==renderedSettings) {
      renderedSettings=settingsKey;
      if(device) {name.value=device.name;channel.value=device.channel;automatic.checked=device.auto===true;preferred.checked=preferences.defaultUUID===selected;}
    }
    forget.disabled=Boolean(state.active&&state.uuid===selected);
    el('channel-help').textContent=t(device&&recommendedChannel(device.originalName||device.name)===4?
      'Bu Roland FP modeli için seçili piyano sesi kanal 4 üzerinden çalar.':
      'Piyanonun MIDI alım kanalını seç. İki el aynı ses kanalından çalar; nota görünümü değişmez.');
    const note=lastNote?t('{note} · şiddet {velocity} · {count} basış',{note:lastNote.name,velocity:lastNote.velocity,count:noteCount}):t('Bir tuşa basarak girişi görebilirsin.');
    activity.textContent=state.connected?note+(pedal?t(' · sustain basılı'):''):'';
    const capabilities=el('capabilities');capabilities.hidden=!state.connected;
    capabilities.textContent=t(noteCount>0?'Giriş: tuş verisi alınıyor':'Giriş: hazır · tuş bekleniyor')+'\n'+
      t(state.output_capable?'Çıkış: MIDI gönderimi kullanılabilir':'Çıkış: bu bağlantıda kullanılamıyor');
    capabilities.style.whiteSpace='pre-line';
    test.hidden=!state.connected;test.disabled=!state.output_capable||pending||testPending;
    test.textContent=t(testPending?'Test sesi gönderiliyor…':'Piyanoda kısa test sesi çal');
    el('retry').textContent=retryTimer?t('Yeniden bağlanma denemesi {attempt}/3 bekleniyor…',{attempt:retryCount}):'';
  }

  function cancelRetry() {clearTimeout(retryTimer);retryTimer=null;retryUUID=null;retryCount=0;}
  function scheduleRetry() {
    if(retryTimer||!retryUUID||!profile(retryUUID)?.auto||state.active||disposed||document.hidden||retryCount>=3) return;
    if(!['connection_lost','piano_unreachable','connect_failed'].includes(state.diagnostic?.code)) return;
    retryCount++;
    retryTimer=setTimeout(()=> {
      retryTimer=null;
      if(!live||disposed||state.active||document.hidden) {render();return;}
      run('connect',{uuid:retryUUID});
    },[1000,3000,7000][retryCount-1]);
  }

  function applyStatus(next) {
    localDiagnostic=null;state=next;
    noteCount=next.note_count||0;lastNote=next.last_note;pedal=next.pedal?.pressed;
    if(!preferences.migrated) {
      const uuid=next.remembered_device;
      if(typeof uuid==='string'&&uuidPattern.test(uuid)&&!profile(uuid)) {
        preferences.devices[uuid]={name:'CLP-835',originalName:'CLP-835',channel:1,auto:false};
        preferences.defaultUUID=uuid;selected=uuid;
      }
      preferences.migrated=true;save();
    }
    if(state.connected) {
      if(!profile(state.uuid)) {
        preferences.devices[state.uuid]={name:state.device,originalName:state.device,channel:recommendedChannel(state.device),auto:false};
        if(!preferences.defaultUUID) preferences.defaultUUID=state.uuid;
        save();
      }
      if(!connected) {input.connect('bluetooth',state.device);connected=true;selected=state.uuid;}
      retryUUID=state.uuid;retryCount=0;clearTimeout(retryTimer);retryTimer=null;
    } else if(connected) {input.disconnect('bluetooth');connected=false;}
    scheduleRetry();render();emitStatus();
    if(!initialStatus) {
      initialStatus=true;
      const uuid=preferences.defaultUUID;
      if(profile(uuid)?.auto&&!state.active&&!document.hidden) connectDevice(uuid);
    }
  }

  function receive(event) {
    if(event.event==='output_error') {window.dispatchEvent(new CustomEvent('rach3-output-error',{detail:event}));return;}
    if(!['snapshot','status','note_on','note_off','pedal','control_change','midi_message'].includes(event.event)) return;
    live=true;
    if(event.event==='snapshot') {
      input.disconnect('bluetooth');connected=false;applyStatus(event.status);
      for(const note of event.held) input.receive(note);
    } else if(event.event==='status') applyStatus(event.status);
    else {
      input.receive(event);
      if(event.event==='note_on'&&event.velocity>0) {noteCount++;lastNote=event;}
      else if(event.event==='pedal'&&event.pedal==='sustain') pedal=event.pressed;
      render();
    }
  }

  function offline(detail='') {
    cancelRetry();localDiagnostic={code:'service_offline',detail};live=false;connected=false;
    input.disconnect('bluetooth');emitStatus();render();
  }
  function openStream() {
    if(native) native.postMessage({command:'subscribe'}).then(receive).catch(error=>offline(error.message));
    else {stream=new EventSource('/api/bluetooth/events');stream.onmessage=event=>receive(JSON.parse(event.data));stream.onerror=()=>offline();}
  }
  if(native) window.addEventListener('rach3-native-event',event=>receive(event.detail));

  async function command(action,values={}) {
    if(native) {
      const result=await native.postMessage({command:action,...values});
      if(result?.error) throw new Error(result.error);
      return result;
    }
    const response=await fetch(`/api/bluetooth/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json','X-Rach3':'1'},body:JSON.stringify(values),
    });
    const result=await response.json();
    if(!response.ok||result.error) throw new Error(result.error||'İşlem tamamlanamadı');
    return result;
  }
  async function run(action,values={}) {
    if(pending) return;
    pending=true;localDiagnostic=null;render();
    try {await command(action,values);}
    catch(error) {localDiagnostic={code:'command_failed',detail:error.message};}
    finally {pending=false;render();}
  }
  function connectDevice(uuid) {
    cancelRetry();retryUUID=uuid;selected=uuid;run('connect',{uuid});
  }
  scan.addEventListener('click',()=>{cancelRetry();run(state.phase==='scanning'?'disconnect':'scan');});
  button.addEventListener('click',()=>{cancelRetry();if(state.active) run('disconnect');else render();});
  panel.addEventListener('toggle',()=> {
    if(panel.open&&live&&!pending&&!state.active&&!state.diagnostic&&!localDiagnostic) run('scan');
    else if(!panel.open&&state.browsing&&['scanning','idle'].includes(state.phase)) run('disconnect');
  });
  function updateProfile(change) {
    const device=profile(selected);if(!device) return;
    Object.assign(device,change);save();render();emitStatus();
  }
  name.addEventListener('change',()=>{const value=name.value.trim();if(value) updateProfile({name:value});else {renderedSettings='';render();}});
  channel.addEventListener('change',()=> {
    if(state.connected&&state.uuid===selected) window.dispatchEvent(new Event('rach3-output-settings-change'));
    updateProfile({channel:Number(channel.value)});
  });
  automatic.addEventListener('change',()=>{if(!automatic.checked) cancelRetry();updateProfile({auto:automatic.checked});});
  preferred.addEventListener('change',()=>{preferences.defaultUUID=preferred.checked?selected:null;save();render();});
  forget.addEventListener('click',()=> {
    if(state.active&&state.uuid===selected) return;
    if(retryUUID===selected) cancelRetry();
    delete preferences.devices[selected];if(preferences.defaultUUID===selected) preferences.defaultUUID=null;
    selected=null;save();render();
  });
  test.addEventListener('click',()=> {
    testPending=true;render();
    window.dispatchEvent(new CustomEvent('rach3-bluetooth-test',{detail:{complete:error=> {
      testPending=false;if(error) localDiagnostic={code:'command_failed',detail:error.message};render();
    }}}));
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden) {cancelRetry();if(state.browsing&&state.active) run('disconnect');}});
  window.addEventListener('pagehide',()=> {
    disposed=true;cancelRetry();
    if(native) native.postMessage({command:'unsubscribe'}).catch(()=>{});else stream?.close();
    offline();
  });
  window.addEventListener('pageshow',event=>{if(event.persisted) {disposed=false;openStream();}});
  window.addEventListener('rach3-language-change',render);
  openStream();render();
}
