export async function lessonCommand(command,fields={}) {
  const native=window.webkit?.messageHandlers?.pianoman;
    if (native) return native.postMessage({ command, ...fields });
    const response = await fetch('/api/lessons/command', {
      method:'POST', headers:{'Content-Type':'application/json','X-PianoMan':'1'},
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
    'lesson-document','document-name','document-tempo'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const video = ui['source-preview'];
  let source = 'video';
  let selectedVideo = null,selectedDocument=null;
  let videoURL = '';
  let videoReady = false;
  let youtubeURL = '';
  const native = window.webkit?.messageHandlers?.pianoman;
  const available = Boolean(native) || location.protocol === 'http:';
  const draft=workspaceState.data.create;
  let busy = false, cancelled = false, loadedResult = draft.completedJob||'';
  function saveDraft() {
    workspaceState.update('create',{source,title:ui['lesson-title'].value,url:ui['youtube-url'].value,
      youtubeURL,separate:ui['separate-vocals'].checked,tempo:ui['document-tempo'].value,completedJob:loadedResult});
  }


  function updateControls() {
    ui['create-lesson'].disabled = !available || busy || (source==='video'?!videoReady:source==='document'?!selectedDocument:!youtubeURL);
    for (const id of ['source-video','source-youtube','source-document','choose-document','document-tempo','choose-video','remove-video','remove-youtube','youtube-url','lesson-title','separate-vocals']) ui[id].disabled=busy;
    ui['cancel-lesson'].hidden=!busy;
  }

  async function openLesson(id) {
    try { onLesson(await lessonCommand('lesson-load',{id})); }
    catch(error) { announce(error.message,'error'); }
  }

  async function refreshLessons() {
    if (!available) return;
    const lessons=await lessonCommand('lesson-list');
    for(const container of [ui['saved-lessons'],ui['saved-lessons-menu']]) {
      container.replaceChildren();
      for(const lesson of lessons) {
        const row=document.createElement('div');row.className='lesson-row';
        const button=document.createElement('button'); button.type='button';
        button.textContent=lesson.title+' · '+lesson.noteCount+' nota';
        button.dataset.closePopover='';
        button.addEventListener('click',()=>openLesson(lesson.id)); row.append(button);
        const remove=document.createElement('button');remove.type='button';remove.className='lesson-delete';
        remove.textContent='Sil';remove.setAttribute('aria-label',lesson.title+' dersini sil');row.append(remove);
        remove.addEventListener('click',()=> {
          remove.hidden=true;
          const confirm=document.createElement('button'),cancel=document.createElement('button');
          confirm.type=cancel.type='button';confirm.textContent='Dersi sil';cancel.textContent='Vazgeç';
          row.append(confirm,cancel);
          cancel.onclick=()=>{confirm.remove();cancel.remove();remove.hidden=false;};
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
    if(!lessons.length) ui['saved-lessons'].textContent='Oluşturduğun dersler burada saklanır.';
  }

  async function jobState(event) {
    document.documentElement.dataset.lessonPhase=event.phase;
    const wasBusy=busy;
    const terminal=['idle','complete','cancelled','error'];
    busy=!terminal.includes(event.phase);
    ui['lesson-progress'].hidden=event.phase==='idle';
    ui['lesson-progress'].value=event.progress||0;
    announce(event.message,event.phase==='error'?'error':event.phase==='complete'?'ready':'idle');
    updateControls();
    if(busy&&!wasBusy) { video.pause(); onShowCreate(); }
    if(event.phase==='complete'&&event.id!==loadedResult) {
      loadedResult=event.id; saveDraft();
      await refreshLessons(); await openLesson(event.id);
    }
  }

  function announce(message, state = 'idle') {
    ui['create-status'].textContent = message;
    ui['create-status'].dataset.state = state;
  }

  function showSource(next) {
    source = next;
    video.pause();
    ui['source-video'].setAttribute('aria-pressed', String(next === 'video'));
    ui['source-youtube'].setAttribute('aria-pressed', String(next === 'youtube'));
    ui['source-document'].setAttribute('aria-pressed',String(next==='document'));
    ui['document-source'].hidden=next!=='document';
    ui['separate-vocals'].closest('label').hidden=next==='document';
    ui['video-source'].hidden = next !== 'video';
    ui['youtube-source'].hidden = next !== 'youtube';
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
    ui['video-detail'].textContent = 'Video açılıyor…';
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
    const seconds = Math.floor(video.duration);
    const duration = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    const size = selectedVideo.size / (1024 * 1024);
    const sizeText = size < 1 ? Math.max(1, Math.ceil(selectedVideo.size / 1024)) + ' KB' : size.toLocaleString('tr-TR', {maximumFractionDigits: 1}) + ' MB';
    ui['video-detail'].textContent = duration + ' · ' + sizeText;
    if (source === 'video') announce('Video seçildi.', 'ready');
    updateControls();
  });
  video.addEventListener('error', videoFailed);

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
  window.addEventListener('pianoman-import-document',event=>chooseDocument(event.detail.file));
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
    ui['youtube-title'].textContent = 'YouTube videosu';
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

  window.addEventListener('pianoman-tab-change', event => {
    if (event.detail.tab !== 'create') video.pause();
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
  window.addEventListener('pianoman-native-event',event=> {
    if(event.detail.event==='lesson-progress') jobState(event.detail).catch(error=>announce(error.message,'error'));
  });
  ui['lesson-title'].value=draft.title||'';
  ui['youtube-url'].value=draft.url||'';
  ui['document-tempo'].value=draft.tempo||'60';
  if(typeof draft.separate==='boolean') ui['separate-vocals'].checked=draft.separate;
  youtubeURL=draft.youtubeURL||'';
  if(youtubeURL) {
    ui['youtube-title'].textContent='YouTube videosu'; ui['youtube-link'].textContent=youtubeURL;
    ui['youtube-preview'].hidden=false;
  }
  for(const id of ['lesson-title','separate-vocals','document-tempo']) ui[id].addEventListener('input',saveDraft);
  showSource(['youtube','document'].includes(draft.source)?draft.source:'video');
  if(available) {
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
  } else announce('Ders oluşturmak için PianoMan masaüstü uygulamasını aç.');
}
