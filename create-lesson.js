import { startLessonChat } from './lesson-chat.js';
const t=(source,params)=>window.PianoI18n.t(source,params);
const translated=source=>window.PianoI18n.message(source);
export async function lessonCommand(command,fields={}) {
  const native=window.webkit?.messageHandlers?.rach3;
    if (native) return native.postMessage({ command, ...fields });
    const response = await fetch('/api/lessons/command', {
      method:'POST', headers:{'Content-Type':'application/json','X-Rach3':'1'},
      body:JSON.stringify({command,...fields}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ders servisine ulaşılamadı');
    return result;
}

export function startLessonCreation({ onLesson, onShowCreate, onLessonDeleted, workspaceState }) {
  const ids = ['source-video', 'source-youtube', 'video-source', 'youtube-source',
    'choose-video', 'lesson-video', 'video-drop', 'video-preview', 'source-preview',
    'video-name', 'video-detail', 'remove-video', 'youtube-form', 'youtube-url',
    'youtube-preview', 'youtube-title', 'youtube-link', 'remove-youtube', 'create-status',
    'create-lesson', 'cancel-lesson', 'lesson-progress', 'lesson-title', 'separate-vocals',
    'saved-lessons', 'saved-lessons-menu','source-document','document-source','choose-document',
    'lesson-document','document-name','document-tempo','lesson-tools','lesson-tools-title',
    'lesson-tools-detail','lesson-tools-size','separation-tools','separation-tools-detail',
    'separation-tools-size','retry-tools','tool-transfer','tool-stage','tool-percent',
    'tool-progress','tool-bytes','tool-speed','source-ai','ai-source','create-intro','create-panel'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const video = ui['source-preview'];
  let source = 'ai';
  let selectedVideo = null,selectedDocument=null;
  let videoURL = '';
  let videoReady = false;
  let youtubeURL = '';
  const native = window.webkit?.messageHandlers?.rach3;
  const available = Boolean(native) || location.protocol === 'http:';
  const draft=workspaceState.data.create;
  let statusSource='';
  let toolsCatalog=null, transfer=null, lastPhase='idle';
  const bytes=value=> {
    const unit=value>=1e9?'GB':value>=1e6?'MB':'KB';
    const amount=value/(unit==='GB'?1e9:unit==='MB'?1e6:1e3);
    return amount.toLocaleString(window.PianoI18n.language==='tr'?'tr-TR':'en-US',
      {maximumFractionDigits:1})+' '+unit;
  };
  function toolPlan() {
    if(!toolsCatalog) return null;
    const pdf=source==='document'&&/\.pdf$/i.test(selectedDocument?.name||'');
    const base=['notation',...(source==='document'?(pdf?['pdf']:[]):['transcription']),
      ...(source==='youtube'?['youtube']:[])];
    const keys=new Set(base.flatMap(group=>toolsCatalog.groups[group]));
    const separation=source!=='document'&&ui['separate-vocals'].checked
      ?toolsCatalog.groups.separation.filter(key=>!keys.has(key)):[];
    const summary=ids=> {
      const missing=[...ids].map(key=>toolsCatalog.artifacts[key]).filter(a=>!a.ready);
      return {ready:!missing.length,remaining:missing.reduce((total,a)=>total+a.size-a.received,0)};
    };
    return {base:summary(keys),separation:summary(separation),showSeparation:source!=='document'&&ui['separate-vocals'].checked,
      title:pdf?'PDF nota okuyucu':source==='document'?'MIDI ve partisyon':'Videodan piyano notaları'};
  }
  function renderTools() {
    const plan=toolPlan();
    ui['lesson-tools'].hidden=!plan||(source==='document'&&!selectedDocument);
    ui['separation-tools'].hidden=!plan||!plan.showSeparation;
    if(!plan) return;
    ui['lesson-tools-title'].textContent=t(plan.title);
    for(const [prefix,state] of [['lesson',plan.base],['separation',plan.separation]]) {
      const card=ui[prefix+'-tools'];
      card.dataset.ready=String(state.ready);
      card.querySelector('.tool-icon').textContent=state.ready?'✓':'↓';
      ui[prefix+'-tools-size'].textContent=state.ready?t('Hazır'):bytes(state.remaining);
      ui[prefix+'-tools-detail'].textContent=t(state.ready?'Bu Mac’te hazır. Yeniden indirilmez.':
        state.remaining?'İlk kullanımda indirilir. Bu Mac’te saklanır.':'İndirme tamamlandı. Kullanım öncesi hazırlanacak.');
    }
    const amount=plan.base.remaining+plan.separation.remaining;
    ui['create-lesson'].textContent=t(busy?'Ders hazırlanıyor…':amount?'İndir ve ders oluştur · {size}':'Ders oluştur',{size:bytes(amount)});
  }
  async function refreshTools() {
    try {
      toolsCatalog=await lessonCommand('lesson-tools'); ui['retry-tools'].hidden=true;
    } catch(error) {
      toolsCatalog=null; ui['retry-tools'].hidden=false; announce(error.message,'error');
    }
    updateControls();
  }
  function renderTransfer() {
    ui['tool-transfer'].hidden=!transfer;
    if(!transfer) return;
    const downloading=transfer.stage==='tools-download';
    ui['tool-stage'].textContent=t(downloading?'Ders araçları indiriliyor…':transfer.stage==='tools-verify'?'İndirme doğrulanıyor…':'Ders araçları hazırlanıyor…');
    ui['tool-percent'].textContent=Math.floor(100*transfer.received/Math.max(1,transfer.total))+'%';
    if(downloading) ui['tool-progress'].value=transfer.received/Math.max(1,transfer.total);
    else ui['tool-progress'].removeAttribute('value');
    ui['tool-bytes'].textContent=bytes(transfer.received)+' / '+bytes(transfer.total);
    ui['tool-speed'].textContent=downloading&&transfer.speed>0?bytes(transfer.speed)+'/s':t('Hazırlanıyor…');
  }
  const libraryLabels=new Map();
  function label(node,source,params={},attribute='textContent') {
    if(!libraryLabels.has(node)) libraryLabels.set(node,new Map());
    libraryLabels.get(node).set(attribute,{source,params});
    if(attribute==='textContent') node.textContent=t(source,params);
    else node.setAttribute(attribute,t(source,params));
  }
  let busy = false, cancelled = false, loadedResult = draft.completedJob||'';
  function saveDraft() {
    workspaceState.update('create',{source,title:ui['lesson-title'].value,url:ui['youtube-url'].value,
      youtubeURL,separate:ui['separate-vocals'].checked,tempo:ui['document-tempo'].value,completedJob:loadedResult});
  }


  function updateControls() {
    ui['create-lesson'].disabled = !available || !toolsCatalog || busy || (source==='video'?!videoReady:source==='document'?!selectedDocument:!youtubeURL);
    for (const id of ['source-ai','source-video','source-youtube','source-document','choose-document','document-tempo','choose-video','remove-video','remove-youtube','youtube-url','lesson-title','separate-vocals']) ui[id].disabled=busy;
    ui['cancel-lesson'].hidden=!busy;
    renderTools();
  }

  async function openLesson(id) {
    try { onLesson(await lessonCommand('lesson-load',{id})); }
    catch(error) { announce(error.message,'error'); }
  }

  async function refreshLessons() {
    if (!available) return;
    const lessons=await lessonCommand('lesson-list');
    libraryLabels.clear();
    for(const container of [ui['saved-lessons'],ui['saved-lessons-menu']]) {
      container.replaceChildren();
      for(const lesson of lessons) {
        const row=document.createElement('div');row.className='lesson-row';
        const button=document.createElement('button'); button.type='button';
        label(button,'{title} · {count} nota',{title:lesson.title,count:lesson.noteCount});
        button.dataset.closePopover='';
        button.addEventListener('click',()=>openLesson(lesson.id)); row.append(button);
        const remove=document.createElement('button');remove.type='button';remove.className='lesson-delete';
        label(remove,'Sil');label(remove,'{title} dersini sil',{title:lesson.title},'aria-label');row.append(remove);
        remove.addEventListener('click',()=> {
          remove.hidden=true;
          const confirm=document.createElement('button'),cancel=document.createElement('button');
          confirm.type=cancel.type='button';label(confirm,'Dersi sil');label(cancel,'Vazgeç');
          row.append(confirm,cancel);
          cancel.onclick=()=>{libraryLabels.delete(confirm);libraryLabels.delete(cancel);confirm.remove();cancel.remove();remove.hidden=false;};
          confirm.onclick=async()=> {
            confirm.disabled=cancel.disabled=true;
            try {
              await lessonCommand('lesson-delete',{id:lesson.id});onLessonDeleted(lesson.id);
              delete workspaceState.data.lessons['library:'+lesson.id];
              workspaceState.update('lessons',workspaceState.data.lessons);workspaceState.flush();
              await refreshLessons();
            } catch(error) {announce(error.message,'error');confirm.disabled=cancel.disabled=false;}
          };
        });
        container.append(row);
      }
    }
    if(!lessons.length) label(ui['saved-lessons'],'Oluşturduğun dersler burada saklanır.');
  }

  async function jobState(event) {
    document.documentElement.dataset.lessonPhase=event.phase;
    const wasBusy=busy;
    const terminal=['idle','complete','cancelled','error'];
    busy=!terminal.includes(event.phase);
    transfer=event.toolDownload||null;
    renderTransfer();
    ui['lesson-progress'].hidden=event.phase==='idle'||Boolean(transfer);
    ui['lesson-progress'].value=event.progress||0;
    announce(event.message,event.phase==='error'?'error':event.phase==='complete'?'ready':'idle');
    updateControls();
    if(lastPhase!==event.phase&&terminal.includes(event.phase)) refreshTools();
    lastPhase=event.phase;
    if(busy&&!wasBusy) { video.pause(); onShowCreate(); }
    if(event.phase==='complete'&&event.id!==loadedResult) {
      loadedResult=event.id; saveDraft();
      await refreshLessons(); await openLesson(event.id);
    }
  }

  function announce(message, state = 'idle') {
    statusSource=message;
    ui['create-status'].textContent = translated(message);
    ui['create-status'].dataset.state = state;
  }

  function showSource(next) {
    source = next;
    video.pause();
    ui['create-panel'].dataset.source=next;
    ui['source-ai'].setAttribute('aria-pressed',String(next==='ai'));
    ui['ai-source'].hidden=next!=='ai';
    const intro=next==='ai'?'Çalışmak istediğin parçayı söyle; birlikte bulup derse çevirelim.':'Çalışmak istediğin videoyu ekle.';
    ui['create-intro'].dataset.i18n=intro; ui['create-intro'].textContent=t(intro);
    ui['source-video'].setAttribute('aria-pressed', String(next === 'video'));
    ui['source-youtube'].setAttribute('aria-pressed', String(next === 'youtube'));
    ui['source-document'].setAttribute('aria-pressed',String(next==='document'));
    ui['document-source'].hidden=next!=='document';
    ui['separate-vocals'].closest('label').hidden=next==='document';
    ui['video-source'].hidden = next !== 'video';
    ui['youtube-source'].hidden = next !== 'youtube';
    if(next==='ai') { announce(''); updateControls(); chat?.focus(); return; }
    if (next === 'youtube') announce(youtubeURL ? 'Bağlantı seçildi.' : '', youtubeURL ? 'ready' : 'idle');
    else if(next==='document') announce(selectedDocument?'Dosya seçildi.':'MIDI veya nota PDF’si seç.');
    else announce(selectedVideo ? (videoReady ? 'Video seçildi.' : 'Video açılıyor…') : '', videoReady ? 'ready' : 'idle');
    updateControls();
  }

  function releaseVideoURL() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = '';
    videoReady = false;
  }

  function clearVideo() {
    releaseVideoURL();
    selectedVideo = null;
    ui['lesson-video'].value = '';
    ui['video-preview'].hidden = true;
    ui['video-name'].textContent = '';
    ui['video-detail'].textContent = '';
    updateControls();
  }

  function openVideo(file) {
    if(busy) return;
    const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|ogg|avi|mkv)$/i.test(file.name);
    if (!isVideo) {
      ui['lesson-video'].value = '';
      announce('Bir video dosyası seç. MIDI dosyalarını Çalış sekmesinden açabilirsin.', 'error');
      return;
    }
    releaseVideoURL();
    selectedVideo = file;
    ui['lesson-title'].value=file.name.replace(/\.[^.]+$/,'');
    ui['video-name'].textContent = file.name;
    ui['video-detail'].textContent = t('Video açılıyor…');
    ui['video-preview'].hidden = false;
    videoURL = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.src = videoURL;
    video.load();
    if (source === 'video') announce('Video açılıyor…');
    updateControls();
  }

  function videoFailed() {
    if (!videoURL || (video.currentSrc && video.currentSrc !== videoURL)) return;
    clearVideo();
    if (source === 'video') announce('Bu video açılamadı. H.264 biçiminde bir MP4 veya bu cihazda oynatılabilen başka bir video seç.', 'error');
  }

  video.addEventListener('loadedmetadata', () => {
    if (!selectedVideo || video.currentSrc !== videoURL) return;
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      videoFailed();
      return;
    }
    videoReady = true;
    renderVideoDetails();
    if (source === 'video') announce('Video seçildi.', 'ready');
    updateControls();
  });
  function renderVideoDetails() {
    const seconds = Math.floor(video.duration);
    const duration = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    const size = selectedVideo.size / (1024 * 1024);
    const sizeText = size < 1 ? Math.max(1, Math.ceil(selectedVideo.size / 1024)) + ' KB' : size.toLocaleString(window.PianoI18n.language==='tr'?'tr-TR':'en-US', {maximumFractionDigits: 1}) + ' MB';
    ui['video-detail'].textContent = duration + ' · ' + sizeText;
  }
  video.addEventListener('error', videoFailed);

  ui['source-ai'].addEventListener('click',()=>{showSource('ai');saveDraft();});
  ui['source-video'].addEventListener('click', () => {showSource('video');saveDraft();});
  ui['source-youtube'].addEventListener('click', () => {showSource('youtube');saveDraft();});
  ui['source-document'].addEventListener('click',()=>{showSource('document');saveDraft();});
  ui['choose-document'].addEventListener('click',()=>ui['lesson-document'].click());
  function chooseDocument(file) {
    if(busy||!file) return;
    if(!/\.(mid|midi|pdf)$/i.test(file.name)) {announce('MIDI veya PDF dosyası seç.','error');return;}
    selectedDocument=file;ui['document-name'].textContent=file.name;
    ui['lesson-title'].value=file.name.replace(/\.[^.]+$/,'');showSource('document');onShowCreate();saveDraft();
  }
  ui['lesson-document'].addEventListener('change',()=>{chooseDocument(ui['lesson-document'].files[0]);ui['lesson-document'].value='';});
  window.addEventListener('rach3-import-document',event=>chooseDocument(event.detail.file));
  ui['choose-video'].addEventListener('click', () => ui['lesson-video'].click());
  ui['lesson-video'].addEventListener('change', () => {
    const file = ui['lesson-video'].files[0];
    if (file) openVideo(file);
  });
  ui['remove-video'].addEventListener('click', () => {
    clearVideo();
    announce('Video kaldırıldı.');
    updateControls();
    ui['choose-video'].focus();
  });
  for (const type of ['dragenter', 'dragover']) {
    ui['video-drop'].addEventListener(type, event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      ui['video-drop'].classList.add('dragging');
    });
  }
  ui['video-drop'].addEventListener('dragleave', event => {
    if (!ui['video-drop'].contains(event.relatedTarget)) ui['video-drop'].classList.remove('dragging');
  });
  ui['video-drop'].addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    ui['video-drop'].classList.remove('dragging');
    const file = event.dataTransfer.files[0];
    if (file) openVideo(file);
  });

  function canonicalYouTubeURL(value) {
    const text = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : 'https://' + text);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
    let id = '';
    if (url.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || '';
    else if (hosts.includes(url.hostname)) {
      if (/^\/watch\/?$/.test(url.pathname)) id = url.searchParams.get('v') || '';
      else id = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? 'https://www.youtube.com/watch?v=' + id : '';
  }

  ui['youtube-form'].addEventListener('submit', event => {
    event.preventDefault();
    let canonical = '';
    try { canonical = canonicalYouTubeURL(ui['youtube-url'].value); } catch { /* Incomplete or malformed URL. */ }
    if (!canonical) {
      ui['youtube-url'].setAttribute('aria-invalid', 'true');
      announce('Geçerli bir YouTube video bağlantısı gir. HTTPS bağlantısı kullan.', 'error');
      ui['youtube-url'].focus();
      return;
    }
    youtubeURL = canonical;
    ui['youtube-url'].removeAttribute('aria-invalid');
    ui['youtube-url'].value = canonical;
    ui['youtube-title'].textContent = t('YouTube videosu');
    ui['youtube-link'].textContent = canonical;
    ui['youtube-preview'].hidden = false;
    announce('Bağlantı seçildi.', 'ready');
    updateControls(); saveDraft();
  });
  ui['youtube-url'].addEventListener('input', () => {
    youtubeURL = ''; updateControls(); saveDraft();
    ui['youtube-url'].removeAttribute('aria-invalid');
    if (source === 'youtube') announce('');
  });
  ui['remove-youtube'].addEventListener('click', () => {
    youtubeURL = '';
    ui['youtube-url'].value = '';
    ui['youtube-url'].removeAttribute('aria-invalid');
    ui['youtube-preview'].hidden = true;
    ui['youtube-title'].textContent = '';
    ui['youtube-link'].textContent = '';
    announce('Bağlantı kaldırıldı.'); saveDraft();
    updateControls();
    ui['youtube-url'].focus();
  });

  window.addEventListener('rach3-tab-change', event => {
    if (event.detail.tab !== 'create') video.pause();
  });
  window.addEventListener('rach3-language-change',()=> {
    renderTools(); renderTransfer();
    ui['create-status'].textContent=translated(statusSource);
    if(youtubeURL) ui['youtube-title'].textContent=t('YouTube videosu');
    if(selectedVideo) {
      if(videoReady) renderVideoDetails();
      else ui['video-detail'].textContent=t('Video açılıyor…');
    }
    for(const [node,attributes] of libraryLabels) {
      if(!node.isConnected) continue;
      for(const [attribute,{source,params}] of attributes) {
        if(attribute==='textContent') node.textContent=t(source,params);
        else node.setAttribute(attribute,t(source,params));
      }
    }
  });
  window.addEventListener('pagehide', releaseVideoURL);
  window.addEventListener('pageshow', event => {
    if (event.persisted && selectedVideo) openVideo(selectedVideo);
  });
  ui['create-lesson'].addEventListener('click',async()=> {
    if(busy||!available) return;
    busy=true; cancelled=false; updateControls(); video.pause();
    try {
      const file=source==='video'?selectedVideo:source==='document'?selectedDocument:null;
      const kind=source==='document'?(/\.pdf$/i.test(file.name)?'pdf':'midi'):'video';
      const job=await lessonCommand('lesson-begin',{name:file?.name||'YouTube',kind,tempo:Number(ui['document-tempo'].value),
        title:ui['lesson-title'].value.trim(),size:file?.size||0,
        url:source==='youtube'?youtubeURL:'',separate:ui['separate-vocals'].checked});
      if(file) {
        const step=1024*1024;
        for(let offset=0;offset<file.size;offset+=step) {
          if(cancelled) return;
          const data=await new Promise((resolve,reject)=> {
            const reader=new FileReader(); reader.onload=()=>resolve(reader.result.split(',')[1]);
            reader.onerror=()=>reject(reader.error); reader.readAsDataURL(file.slice(offset,offset+step));
          });
          if(cancelled) return;
          await lessonCommand('lesson-chunk',{id:job.id,data});
          ui['lesson-progress'].hidden=false; ui['lesson-progress'].value=.1*Math.min(1,(offset+step)/file.size);
        }
      }
      if(!cancelled) await lessonCommand('lesson-start',{id:job.id});
    } catch(error) {
      if(!cancelled) { await lessonCommand('lesson-cancel').catch(()=>{}); announce(error.message,'error'); }
      busy=false; updateControls();
    }
  });
  ui['cancel-lesson'].addEventListener('click',async()=> {
    cancelled=true; ui['cancel-lesson'].disabled=true;
    try { await lessonCommand('lesson-cancel'); } catch(error) { announce(error.message,'error'); }
    finally { ui['cancel-lesson'].disabled=false; }
  });
  window.addEventListener('rach3-native-event',event=> {
    if(event.detail.event==='lesson-progress') jobState(event.detail).catch(error=>announce(error.message,'error'));
  });
  ui['lesson-title'].value=draft.title||'';
  ui['youtube-url'].value=draft.url||'';
  ui['document-tempo'].value=draft.tempo||'60';
  if(typeof draft.separate==='boolean') ui['separate-vocals'].checked=draft.separate;
  youtubeURL=draft.youtubeURL||'';
  if(youtubeURL) {
    ui['youtube-title'].textContent=t('YouTube videosu'); ui['youtube-link'].textContent=youtubeURL;
    ui['youtube-preview'].hidden=false;
  }
  for(const id of ['lesson-title','separate-vocals','document-tempo']) ui[id].addEventListener('input',saveDraft);
  ui['separate-vocals'].addEventListener('change',renderTools);
  ui['retry-tools'].addEventListener('click',refreshTools);
  // The Mac app marks the page when it carries Codex; elsewhere the tab is not offered.
  const chat=native&&document.documentElement.dataset.lessonChat==='1'?startLessonChat({container:ui['ai-source'],command:lessonCommand,openLesson}):null;
  ui['source-ai'].hidden=!chat;
  const sources=chat?['ai','video','youtube','document']:['video','youtube','document'];
  showSource(sources.includes(draft.source)?draft.source:sources[0]);
  if(available) {
    refreshTools();
    refreshLessons().catch(error=>announce(error.message,'error'));
    let stopped=false;
    async function pollState() {
      try { await jobState(await lessonCommand('lesson-state')); }
      catch(error) { announce(error.message,'error'); }
      if(!native&&!stopped) setTimeout(pollState,700);
    }
    window.addEventListener('pagehide',()=>{stopped=true;});
    window.addEventListener('pageshow',event=>{if(event.persisted){stopped=false;pollState();}});
    pollState();
  } else announce('Ders oluşturmak için rach3 masaüstü uygulamasını aç.');
}
