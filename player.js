import { WorkspaceState } from './workspace-state.js';
import { lessonCommand } from './create-lesson.js';
import { SheetMusic } from './sheet-music.js';
import { startBluetooth } from './bluetooth.js';
import { PianoInput } from './piano-input.js';
import { PianoOutput } from './piano-output.js';
import { PracticeClock } from './practice-clock.js';
import { PracticeSession } from './practice-session.js';
import { PracticeEffects } from './practice-effects.js';
import { HandReach } from './hand-reach.js';
import { StaffNotation } from './staff-notation.js';
import { startAppShell } from './app-shell.js';
  (async () => {
    'use strict';
    await window.PianoI18n.ready;
    const t=(source,params)=>window.PianoI18n.t(source,params);
    const message=source=>window.PianoI18n.message(source);
    let errorSource='', metadataDescription='';
    const element = id => document.getElementById(id);
    const ui = Object.fromEntries(['play','rewind','speed','track','volume','volume-control','seek','elapsed','duration','notation','staff','zoom','range','loop','roll','keyboard','stage','viewport','error','file-badge','file-title','file-description','current-notes','midi-file','legend-left','legend-right','mode','lesson-panel','lesson-feedback'].map(id => [id, element(id)]));
    ui['audio-output']=element('audio-output');
    ui['audio-output-status']=element('audio-output-status');
    for(const id of ['practice-settings','practice-strategy','practice-target','practice-timing','practice-rules','practice-reset','practice-availability','practice-progress','practice-line','practice-previous','practice-next','practice-profile','profile-name','profile-add','profile-delete','profile-reach','profile-measure','profile-clear-reach','profile-measure-status','sheet-learning','sheet-learning-label','sheet-learning-meter']) ui[id]=element(id);
    for(const id of ['practice-symbol','practice-title','practice-grade','practice-position-label','practice-stage-detail','practice-streak','practice-streak-count','practice-meter','practice-result']) ui[id]=element(id);
    for(const id of ['practice-effects','practice-sounds','practice-effect-volume','practice-effects-layer','practice-celebration']) ui[id]=element(id);
    const workspaceState=new WorkspaceState();
    workspaceState.onError=showError;
    workspaceState.restoreControls(ui);
    let currentReference=null,currentKey='',changingLesson=false,lastCheckpoint=0;
    const rubatoSong = JSON.parse(element('rubato-song-data').textContent);
    const expression = { pedal:element('pedal-indicator'), pedalStatus:element('pedal-status'), roll:element('pedal-roll'), velocity:element('velocity-readout'), hint:element('expression-hint') };
    let pedalIntervals=[], hasPedal=false;
    const pedalContext=expression.roll.getContext('2d');
    let pedalWidth;
    let song = rubatoSong;
    const ctx = ui.roll.getContext('2d');
    const sharp = new Set([1,3,6,8,10]);
    const letterNames = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
    const solfegeNames = ['Do','Do♯','Re','Re♯','Mi','Fa','Fa♯','Sol','Sol♯','La','La♯','Si'];
    const englishSolfegeNames=solfegeNames.map(name=>name==='Si'?'Ti':name);
    const colors = ['#75a7ff','#efab91'];
    const state = { tracks:[], selectedTracks:[], notes:[], practiceNotes:[], duration:0, position:-2, speed:Number(ui.speed.value), running:false, anchor:0, anchorPosition:0, next:0, epoch:0, source:'builtin', mode:ui.mode.value };
    const input = new PianoInput(), practice = new PracticeClock();
    let training=null, trainingContexts={}, scoreRows={status:'loading',segments:[],signature:''};
    // Presentation receipts survive the next count-in; grading remains in the
    // clock/session. Context changes discard receipts, never earned progress.
    let lastPracticeResult=null, practicePaused=false;
    const setText=(id,text)=>{if(ui[id].textContent!==text) ui[id].textContent=text;};
    const stageName=stage=>stage.firstRow===stage.lastRow?t('Satır {row}',{row:stage.firstRow}):
      t('Satırlar {first}–{last}',{first:stage.firstRow,last:stage.lastRow});
    const mistakeName=reason=>t({wrong:'Yanlış nota',timing:'Geç basma',release:'Tuş süresi hatası'}[reason]);
    const pianoOutput=new PianoOutput(message=>{pause();showError(message);});
    pianoOutput.onStatus=()=>updatePlayButton();
    const staff = new StaffNotation();
    const sheet=new SheetMusic({onViewChange:()=>checkpoint(),onMeasureSelect:index=>listenFrom(index),onSegmentsChange:info=> {
      scoreRows=info;
      if(changingLesson) return;
      if(guided()) {pause();configureTraining();}
      updatePlayButton();draw();
    }});
    workspaceState.capture=()=>checkpoint();
    practice.speed=state.speed;
    // Native/Bluetooth adapters feed this interface; they never own lesson time.
    window.rach3Input = Object.freeze({
      receive: (event, source='bluetooth') => input.receive(event, source),
      connect: (source='bluetooth', label='Bluetooth piyano') => input.connect(source, label),
      disconnect: (source='bluetooth') => input.disconnect(source),
      reset: (source='bluetooth') => input.reset(source),
    });
    window.dispatchEvent(new Event('rach3-input-ready'));
    let audio, master, wave, compressor, timer, raf, width, height;
    let activePractice=true;
    let keys=[], keyMap=new Map(), voices=new Set();
    const nowSeconds=()=>performance.now()/1000;
    const practicing=()=>state.mode==='practice';
    const guided=()=>practicing()&&ui['practice-strategy'].value!=='whole';
    const pianoListening=()=>!practicing()&&ui['audio-output'].value==='piano';
    const selectedInput=()=>input.snapshot('bluetooth');
    const effects=new PracticeEffects({layer:ui['practice-effects-layer'],celebration:ui['practice-celebration'],
      symbol:ui['practice-symbol'],getKey:pitch=>keyMap.get(pitch)?.element,
      settings:()=>({visual:ui['practice-effects'].checked,sound:ui['practice-sounds'].checked,
        volume:Number(ui['practice-effect-volume'].value)/100})});
    const canStart=()=> (!practicing()||selectedInput().connected)&&(!guided()||(training?.active&&!training.done));
    const trainingRange=()=>guided()&&training?.active?(training.current||training.stages.at(-1)):null;
    const displayNotes=()=>trainingRange()?.notes||(practicing()?state.practiceNotes:state.notes);

    // Profiles keep a player's hand span and practice progress apart. The
    // default profile has no span and keeps every existing progress context.
    let profiles=normalizeProfiles(workspaceState.data.profiles), measuring=null;
    function normalizeProfiles(saved) {
      const list=(Array.isArray(saved?.list)?saved.list:[])
        .filter(profile=>profile&&typeof profile.id==='string'&&typeof profile.name==='string')
        .map(profile=>({id:profile.id,name:profile.name.slice(0,40),reach:HandReach.valid(profile.reach)?{left:profile.reach.left,right:profile.reach.right}:null}));
      if(!list.some(profile=>profile.id==='default')) list.unshift({id:'default',name:'',reach:null});
      return {active:list.some(profile=>profile.id===saved?.active)?saved.active:'default',list};
    }
    const activeProfile=()=>profiles.list.find(profile=>profile.id===profiles.active);
    // Practice targets only; listening and the lesson itself keep every note.
    function adaptNotes() { state.practiceNotes=HandReach.adapt(state.notes,activeProfile().reach); }
    function spanLabel(span) {
      return span<12?t('{count} yarım ses',{count:span}):span===12?t('1 oktav'):t('1 oktav + {count} yarım ses',{count:span-12});
    }
    function renderProfiles() {
      const select=ui['practice-profile'];
      select.replaceChildren(...profiles.list.map(profile=>new Option(profile.id==='default'?t('Varsayılan'):profile.name,profile.id)));
      select.value=profiles.active;
      const reach=activeProfile().reach;
      const text=reach?t('El açıklığı: sağ {right} · sol {left}. Uzanamadığın akor notaları soluk görünür ve isteğe bağlıdır.',
        {right:spanLabel(reach.right),left:spanLabel(reach.left)}):t('El açıklığı ölçülmedi; akorlardaki tüm notalar çalınır.');
      if(ui['profile-reach'].textContent!==text) ui['profile-reach'].textContent=text;
      ui['profile-delete'].disabled=profiles.active==='default';
      ui['profile-clear-reach'].disabled=!reach||!!measuring;
      ui['profile-measure'].textContent=measuring?t('Ölçümü iptal et'):t('El açıklığını ölç');
      ui['profile-measure-status'].hidden=!measuring;
    }
    function applyProfile(change) {
      stopMeasure(); pause(); change();
      workspaceState.update('profiles',profiles);
      adaptNotes(); configureTraining(); renderProfiles(); draw(); checkpoint();
    }
    // One hand at a time: hold the widest comfortable pair of keys for three seconds.
    function startMeasure() {
      pause();
      measuring={hand:1,keys:'',since:0,result:{},release:false,timer:setInterval(stepMeasure,100)};
      renderProfiles(); stepMeasure();
    }
    function stopMeasure() {
      if(!measuring) return;
      clearInterval(measuring.timer); measuring=null; renderProfiles();
    }
    function stepMeasure() {
      const snapshot=selectedInput(), held=[...snapshot.held].sort((a,b)=>a-b), now=performance.now();
      const hand=t(measuring.hand===1?'Sağ el':'Sol el');
      let text;
      if(!snapshot.connected) text=t('Ölçüm için piyanoyu bağla.');
      else if(measuring.release) {
        if(held.length) text=t('Sağ el kaydedildi. Tuşları bırak, sonra sol elle aynısını yap.');
        else { measuring.release=false; return stepMeasure(); }
      } else {
        const span=HandReach.measure(held);
        if(span===null) {
          measuring.keys='';
          text=held.length<2?t('{hand}: başparmak ve serçe parmakla rahatça uzanabildiğin en uzak iki tuşa bas ve 3 saniye tut.',{hand}):
            t('Bu tuşlar tek elin açıklığı olarak ölçülemiyor; yeniden dene.');
        } else {
          const keys=held.join(',');
          if(keys!==measuring.keys) {measuring.keys=keys;measuring.since=now;}
          const remaining=3-(now-measuring.since)/1000;
          if(remaining>0) text=t('{hand}: {span} · tutmaya devam et ({seconds} sn)',{hand,span:spanLabel(span),seconds:Math.ceil(remaining)});
          else {
            measuring.result[measuring.hand===1?'right':'left']=span;
            if(measuring.hand===1) {
              measuring.hand=0; measuring.keys=''; measuring.release=true;
              text=t('Sağ el kaydedildi. Tuşları bırak, sonra sol elle aynısını yap.');
            } else {
              const reach={right:measuring.result.right,left:span};
              applyProfile(()=>{activeProfile().reach=reach;});
              return;
            }
          }
        }
      }
      if(ui['profile-measure-status'].textContent!==text) ui['profile-measure-status'].textContent=text;
    }

    function checkpoint() {
      if(!currentKey||changingLesson) return;
      if(training) trainingContexts[training.key]=training.progress();
      workspaceState.saveLesson(currentKey,{position:Math.max(-2,Math.min(state.duration,position())),
        track:ui.track.value,sheet:sheet.viewState(),
        practice:{version:1,contexts:trainingContexts},
        horizontal:activePractice?ui.viewport.scrollLeft:workspaceState.lesson(currentKey).horizontal||0});
    }

    function configureTraining() {
      effects.reset(selectedInput());
      lastPracticeResult=null;practicePaused=false;
      training=null;
      practice.setTiming(ui['practice-timing'].value);
      if(guided()&&scoreRows.status==='ready') {
        training=new PracticeSession();
        training.configure({segments:scoreRows.segments,signature:scoreRows.signature,notes:state.practiceNotes,
          profile:profiles.active==='default'?'':profiles.active,
          strategy:ui['practice-strategy'].value,target:Number(ui['practice-target'].value),
          track:ui.track.value,speed:state.speed,timing:practice.timing,saved:trainingContexts});
      }
      practice.speed=state.speed;
      if(training?.active) {
        const stage=training.current||training.stages.at(-1);
        state.position=training.done?stage.end:stage.start-1.5*state.speed;
        practice.load(stage.notes,state.position,nowSeconds(),selectedInput());
        sheet.follow(stage.start,false,true);
      } else practice.load(state.practiceNotes,state.position,nowSeconds(),selectedInput());
      updatePlayButton();
    }

    // Jump through the plan without awarding or removing mastery. A running
    // session restarts the chosen section with the usual release and count-in.
    function selectStage(offset) {
      if(!guided()||!training?.active) return;
      const index=training.stage+offset;
      if(index<0||index>=training.stages.length) return;
      const running=state.running||state.starting;
      pause();training.select(index);
      lastPracticeResult=null;practicePaused=false;
      const stage=training.current;
      state.position=stage.start-1.5*state.speed;
      practice.load(stage.notes,state.position,nowSeconds(),selectedInput());
      sheet.follow(stage.start,false,true);
      updatePlayButton();draw();checkpoint();
      if(running) play();
    }

    // The animation loop and MIDI timestamps share one completion boundary.
    // Interruptions never award an unfinished pass.
    function advancePractice(now,snapshot) {
      if(!guided()) {practice.advance(now,snapshot);return;}
      if(!training?.active||training.done||!snapshot.connected) return;
      if(training.phase==='release') {
        practice.resume(now);
        if(snapshot.held.size) return;
        practice.load(training.current.notes,training.current.start-1.5*state.speed,now,snapshot);
        effects.seed(snapshot);
        training.started();
        sheet.follow(training.current.start,true,true);
      }
      if(training.phase!=='playing'&&training.phase!=='countdown') return;
      const end=training.current.end+practice.releaseSeconds*state.speed;
      practice.advance(now,snapshot,end);
      training.observe(now,snapshot,practice);
      if(practice.time>=end&&snapshot.held.size===0&&!practice.status.blocked) {
        const stage=training.current, target=training.target;
        const result=training.finish();
        if(result) lastPracticeResult={...result,section:stage,target};
        checkpoint();
        if(training.done) {
          pause();
          if(result) effects.finish('complete',t('Bravo! {count}/{target}',{count:target,target}),t('Tüm bölümler tamamlandı.'));
          return;
        }
        training.begin(snapshot);
        // Prepare the next pass immediately, but preserve the physical keys.
        practice.load(training.current.notes,training.current.start-1.5*state.speed,now,snapshot);
        effects.seed(snapshot);
        state.position=practice.time;
        sheet.follow(training.current.start,true,true);
        if(result) {
          const count=result.advanced?target:result.streak;
          effects.finish(result.advanced?'section':result.clean?'pass':'retry',
            result.advanced?t('Bravo! {count}/{target}',{count,target}):result.clean?
              t('Başarılı tur! {count}/{target}',{count,target}):t('Bu tur sayılmadı'),
            result.advanced?t('Sırada: {section}',{section:stageName(training.current)}):result.clean?
              t('Bir hatasız tekrar daha.'):t('{reason} · Aynı bölümü yeniden dene.',{reason:mistakeName(result.reason)}));
        }
      }
    }

    function updateTrainingStatus() {
      ui['practice-settings'].hidden=!practicing();
      const mastery=guided()?training?.mastery():null;
      ui['sheet-learning'].hidden=!mastery;
      let overall='';
      if(mastery) {
        overall=t('Çalışma planı %{percent}',{percent:mastery.percent})+' · '+
          t('Öğrenilen satır {learned}/{total}',{learned:mastery.learned,total:mastery.total});
        if(ui['sheet-learning-label'].textContent!==overall) ui['sheet-learning-label'].textContent=overall;
        if(ui['sheet-learning-meter'].value!==mastery.percent) ui['sheet-learning-meter'].value=mastery.percent;
        if(ui['sheet-learning-meter'].getAttribute('aria-label')!==overall) ui['sheet-learning-meter'].setAttribute('aria-label',overall);
      }
      const timing=PracticeClock.timingProfile(ui['practice-timing'].value);
      const rules=timing.enabled?
        t('Erken basma: {early} ms · Geç basma: {late} ms · Bırakma: ±{release} ms. Basma şiddeti ve pedal zorunlu değildir.',
          {early:Math.round(timing.early*1000),late:Math.round(timing.late*1000),release:Math.round(timing.release*1000)}):
        t('Zamanlama kapalı: doğru notaları sırayla çal; bekleme ve basılı tutma süresi değerlendirilmez. Yanlış notalar seriyi sıfırlar. Basma şiddeti ve pedal zorunlu değildir.');
      if(ui['practice-rules'].textContent!==rules) ui['practice-rules'].textContent=rules;
      for(const option of ui['practice-strategy'].options) {
        option.disabled=option.value!=='whole'&&scoreRows.status!=='ready';
      }
      ui['practice-target'].disabled=ui['practice-strategy'].value==='whole';
      ui['practice-reset'].disabled=!training?.active;
      ui.loop.disabled=guided();
      const unavailable=scoreRows.status==='loading'?t('Satır çalışması için partisyon hazırlanıyor…'):
        scoreRows.status!=='ready'?t('Satır çalışması için açılabilen bir partisyon gerekli.'):
        guided()&&!training?.active?t('Seçili partide çalışılacak nota yok.'):'';
      ui['practice-availability'].textContent=unavailable;
      ui['practice-availability'].hidden=!unavailable;
      ui['practice-line'].hidden=!guided();
      ui['practice-previous'].disabled=!training?.active||training.stage<=0;
      ui['practice-next'].disabled=!training?.active||training.stage>=training.stages.length-1;
      ui['practice-position-label'].hidden=guided();
      ui['practice-streak'].hidden=!training?.active;
      ui['practice-meter'].hidden=guided()&&!training?.active;
      if(training?.active) {
        const stage=training.current||training.stages.at(-1);
        setText('practice-progress',training.done?t('Çalışma tamamlandı'):stageName(stage));
        setText('practice-stage-detail',training.done?
          t('Tüm {total} bölüm tamamlandı',{total:training.stages.length}):
          t('Bölüm {current}/{total} · Öğrenilen {learned}',{current:training.stage+1,total:training.stages.length,learned:training.cleared.size}));
        const count=training.done?training.target:training.streak;
        setText('practice-streak-count',count+' / '+training.target);
        ui['practice-meter'].max=training.target;ui['practice-meter'].value=count;
        ui['practice-meter'].setAttribute('aria-label',t('Temiz tekrar {count}/{target}',{count,target:training.target}));
      } else if(guided()) {
        setText('practice-progress',unavailable);setText('practice-stage-detail','');
      } else {
        setText('practice-stage-detail',formatTime(position())+' / '+formatTime(state.duration));
        ui['practice-meter'].max=Math.max(1,state.duration);
        ui['practice-meter'].value=Math.max(0,Math.min(state.duration,position()));
        ui['practice-meter'].setAttribute('aria-label',t('Parçada konum'));
      }
      let resultText='';
      if(lastPracticeResult) {
        const result=lastPracticeResult,section=stageName(result.section);
        resultText=result.done?t('✓ Çalışma planı tamamlandı. Tüm bölümleri öğrendin.'):
          result.advanced?t('✓ {section} tamamlandı. Sonraki bölüme geçtin.',{section}):
          result.clean?t('✓ Son tekrar başarılı · {section} · {count}/{target}',{section,count:result.streak,target:result.target}):
          t('× Son tekrar sayılmadı · {section} · {reason}',{section,reason:mistakeName(result.reason)});
        ui['practice-result'].dataset.tone=result.clean?'success':'error';
      }
      setText('practice-result',resultText);ui['practice-result'].hidden=!resultText;
    }

    function showError(source) { delete ui.error.dataset.persistenceMessage; errorSource=source; ui.error.textContent=message(source); ui.error.hidden=!source; }
    function noteName(midi, mode=ui.notation.value) { return (mode==='letters'?letterNames:(window.PianoI18n.language==='en'?englishSolfegeNames:solfegeNames))[midi%12] + (Math.floor(midi/12)-1); }
    function noteHand(note) { return note.hand===0||note.hand===1 ? note.hand : (note.midi<60?0:1); }
    function formatTime(value) { const seconds=Math.floor(Math.max(0,value)); return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'); }
    function lowerBound(notes, time) {
      let low=0, high=notes.length;
      while(low<high) { const middle=(low+high)>>>1; if(notes[middle].time<time) low=middle+1; else high=middle; }
      return low;
    }

    async function prepareAudio() {
      if(!audio) {
        const Audio=window.AudioContext||window.webkitAudioContext;
        if(!Audio) throw new Error('Bu tarayıcı Web Audio sesini desteklemiyor. Güncel Safari, Chrome veya Firefox ile aç.');
        audio=new Audio();
        master=audio.createGain();
        master.gain.value=Number(ui.volume.value)/100*0.55;
        compressor=audio.createDynamicsCompressor();
        compressor.threshold.value=-15; compressor.knee.value=12; compressor.ratio.value=5;
        master.connect(compressor); compressor.connect(audio.destination);
        const real=new Float32Array(12), imaginary=new Float32Array([0,1,.32,.15,.065,.04,.025,.012,.009,.005,.003,.002]);
        wave=audio.createPeriodicWave(real,imaginary);
        audio.addEventListener('statechange',()=> { if(audio.state==='suspended'&&state.running&&!pianoListening()) pause(); });
      }
      await audio.resume();
      if(audio.state!=='running') throw new Error('Ses başlatılamadı. Oynat düğmesine tekrar bas.');
    }

    function voice(note, when, remaining, offset=0) {
      const frequency=440*Math.pow(2,(note.midi-69)/12);
      const decay=Math.max(.7,2.8-(note.midi-48)*.025)/state.speed;
      const level=.24*Math.pow(note.velocity,1.3)*Math.exp(-offset/Math.max(.7,2.8-(note.midi-48)*.025));
      // Sustain removes key-release damping; the string still decays naturally.
      // Retire inaudible voices even when a predicted pedal stays down for minutes.
      if(level<=.00001) return;
      const oscillator=audio.createOscillator(), gain=audio.createGain(), filter=audio.createBiquadFilter();
      const sounding=Math.min(Math.max(.025,remaining),decay*Math.log(level/.00001));
      const release=when+sounding;
      oscillator.setPeriodicWave(wave); oscillator.frequency.value=frequency;
      filter.type='lowpass'; filter.Q.value=.4;
      filter.frequency.setValueAtTime(Math.min(11500,(frequency*7+1100)*(.65+.7*note.velocity)),when);
      filter.frequency.exponentialRampToValueAtTime(Math.max(700,frequency*2.2),release+.2);
      gain.gain.setValueAtTime(0,when);
      gain.gain.linearRampToValueAtTime(level,when+.008);
      gain.gain.exponentialRampToValueAtTime(Math.max(.00001,level*Math.exp(-sounding/decay)),release);
      gain.gain.exponentialRampToValueAtTime(.00001,release+.25);
      oscillator.connect(filter); filter.connect(gain); gain.connect(master);
      const entry={oscillator,gain,filter}; voices.add(entry);
      oscillator.onended=()=> { oscillator.disconnect(); gain.disconnect(); filter.disconnect(); voices.delete(entry); };
      oscillator.start(when); oscillator.stop(release+.28);
    }

    function silence() {
      if(!audio) return;
      for(const entry of voices) {
        entry.gain.gain.cancelScheduledValues(audio.currentTime);
        entry.gain.gain.setValueAtTime(0,audio.currentTime);
        entry.oscillator.stop(audio.currentTime);
      }
      voices.clear();
    }

    function position() {
      if(practicing()) return practice.time;
      return state.running ? state.anchorPosition+Math.max(0,nowSeconds()-state.anchor)*state.speed : state.position;
    }
    function updatePlayButton() {
      sheet.setSelectable(!practicing());
      ui.play.disabled=!canStart();
      ui.play.textContent=state.starting?t("Vazgeç"):state.running?t("Duraklat"):(practicing()?t("Başlat"):t("Dinle"));
      ui.play.setAttribute('aria-label',ui.play.textContent);
      ui['volume-control'].hidden=practicing()||pianoListening();
      ui['audio-output-status'].textContent=ui['audio-output'].value==='piano'?
        (!pianoOutput.connected?t("Piyanodan dinlemek için piyanoyu bağla."):
         !pianoOutput.capable?t("MIDI gönderimi hazır değil; yeniden bağlan."):t("Ses bağlı piyanodan gelir; ses düzeyini piyanodan ayarla.")):
        t("Ses uygulamanın sentezleyicisinden gelir.");
    }
    function pause() {
      effects.clear();
      if(practicing()&&(state.running||state.starting)) practicePaused=true;
      state.epoch++;
      state.starting=false;
      if(state.running&&practicing()&&!guided()) advancePractice(nowSeconds(),selectedInput());
      state.position=position(); state.running=false;
      if(training&&!training.done) training.interrupt();
      clearInterval(timer); cancelAnimationFrame(raf); silence(); pianoOutput.stop();
      updatePlayButton(); draw(); checkpoint();
    }
    async function play() {
      if(state.running||state.starting||!activePractice) return;
      stopMeasure();
      if(!canStart()) return;
      pianoOutput.stop();
      const epoch=++state.epoch;
      if(!guided()&&state.position>=state.duration) {
        state.position=-2;
        practice.seek(-2,nowSeconds(),selectedInput());
      }
      state.starting=true;updatePlayButton();
      if(practicing()) {effects.reset(selectedInput());effects.unlock();}
      let anchor=nowSeconds();
      try {
        if(pianoListening()) {
          const start=await pianoOutput.start(state.selectedTracks,state.position,state.speed,state.duration);
          anchor=nowSeconds()+(start-Date.now())/1000;
        } else if(!practicing()) { await prepareAudio();anchor=nowSeconds(); }
      } catch(error) {
        if(epoch===state.epoch) {state.starting=false;updatePlayButton();showError(error.message);}
        return;
      }
      if(epoch!==state.epoch||document.hidden||!activePractice) return;
      state.starting=false;showError('');
      state.anchorPosition=state.position; state.anchor=anchor; state.running=true;
      if(practicing()) {
        practicePaused=false;
        if(guided()) training.begin(selectedInput());
        practice.speed=state.speed; practice.resume(nowSeconds());
        showError(''); updatePlayButton(); frame(); return;
      }
      if(pianoListening()) {updatePlayButton();frame();return;}
      state.next=lowerBound(state.notes,state.position);
      for(let i=0;i<state.next;i++) {
        const note=state.notes[i];
        if(note.soundEnd>state.position) voice(note,audio.currentTime,(note.soundEnd-state.position)/state.speed,state.position-note.time);
      }
      updatePlayButton(); schedule(); timer=setInterval(schedule,25); frame();
    }
    function schedule() {
      if(!state.running) return;
      const now=position(), horizon=now+.14*state.speed;
      while(state.next<state.notes.length&&state.notes[state.next].time<=horizon) {
        const note=state.notes[state.next++];
        const when=audio.currentTime+(note.time-now)/state.speed;
        if(note.soundEnd<=now) continue;
        voice(note,Math.max(audio.currentTime,when),(note.soundEnd-Math.max(now,note.time))/state.speed,Math.max(0,now-note.time));
      }
    }
    function frame() {
      if(practicing()) {
        const snapshot=selectedInput();
        if(!snapshot.connected) {pause();return;}
        advancePractice(nowSeconds(),snapshot);
        if(!state.running) return;
      }
      const time=position();
      if(!guided()&&time>=state.duration+.4) {
        const wasPractice=practicing();
        const repeat=ui.loop.checked;
        pause(); state.position=repeat?-2:state.duration;
        practice.seek(state.position,nowSeconds(),selectedInput()); draw();
        if(repeat) play();
        if(wasPractice) effects.finish('end',t('Tur tamamlandı'),t('Parçanın sonuna geldin'));
        return;
      }
      draw();
      if(performance.now()-lastCheckpoint>1000) {checkpoint();lastCheckpoint=performance.now();}
      if(state.running) raf=requestAnimationFrame(frame);
    }
    function seek(time) {
      // Inspecting the timeline never skips a stage or earns a repetition.
      // Guided play always resumes a whole attempt at the earned stage.
      const running=state.running;
      pause(); state.position=Math.max(-2,Math.min(state.duration,time));
      practice.seek(state.position,nowSeconds(),selectedInput()); draw();
      sheet.follow(state.position,true,true); checkpoint();
      if(running) play();
    }

    // Listening only: start from the beginning of a measure chosen on the score.
    // seek() stops every sounding note first, so the old position never overlaps.
    function listenFrom(index) {
      const measure=sheet.notation?.measures[index];
      if(practicing()||!measure||changingLesson) return;
      seek(measure.start);
      if(!state.running&&!state.starting) play();
    }

    function rebuildKeys() {
      let first=21,last=108;
      if(ui.range.value==='fit'&&state.notes.length) {
        let low=108,high=21;
        for(const note of state.notes) { low=Math.min(low,note.midi); high=Math.max(high,note.midi); }
        first=Math.max(21,Math.floor((low-2)/12)*12);
        last=Math.min(108,Math.ceil((high+3)/12)*12);
        while(last-first<36) { first=Math.max(21,first-12); last=Math.min(108,last+12); }
      }
      let whiteCount=0;
      for(let midi=first;midi<=last;midi++) if(!sharp.has(midi%12)) whiteCount++;
      const whiteWidth=width/whiteCount;
      ui.keyboard.replaceChildren(); keys=[]; keyMap=new Map();
      let whites=0;
      for(let midi=first;midi<=last;midi++) {
        const black=sharp.has(midi%12), keyWidth=black?whiteWidth*.62:whiteWidth;
        const x=black?whites*whiteWidth-keyWidth/2:whites++*whiteWidth;
        const keyElement=document.createElement('div');
        keyElement.className='key'+(black?' black':'');
        keyElement.style.left=(x/width*100)+'%'; keyElement.style.width=(keyWidth/width*100)+'%';
        keyElement.style.setProperty('--active',colors[midi<60?0:1]);
        keyElement.setAttribute('role','img');
        const label=document.createElement('span');
        if(ui.notation.value!=='none'&&(!black||whiteWidth>31)&&(whiteWidth>20||midi%12===0)) label.textContent=noteName(midi);
        keyElement.append(label);
        ui.keyboard.append(keyElement);
        const key={midi,black,x,width:keyWidth,element:keyElement}; keys.push(key); keyMap.set(midi,key);
      }
    }

    function updateLessonStatus() {
      updateTrainingStatus();
      ui['lesson-panel'].hidden=!practicing();
      if(!practicing()) return;
      const snapshot=selectedInput(), status=practice.status;
      const names=notes=>[...notes].sort((a,b)=>a-b).map(midi=>noteName(midi,ui.notation.value==='none'?'solfege':ui.notation.value)).join(' · ');
      let title='',detail='',tone='neutral',symbol='○',grade='';
      if(training?.done) {
        title=t('Çalışma tamamlandı');detail=t('Tüm bölümleri öğrendin. Önceki bölümlere dönüp tekrar çalabilirsin.');
        tone='success';symbol='✓';
      } else if(!snapshot.connected) {
        title=t('Piyano bağlı değil');detail=t('Devam etmek için piyanonu bağla. İlerlemen korunuyor.');symbol='!';
      } else if(guided()&&!training?.active) {
        title=t('Çalışma hazırlanıyor');detail=ui['practice-availability'].textContent;
      } else if(!state.running) {
        const complete=!guided()&&practice.time>=state.duration;
        title=t(complete?'Parçanın sonuna geldin':practicePaused?'Duraklatıldı':'Çalmaya hazır');
        detail=t(complete?'Yeniden çalışmak için Başlat’a bas.':
          practicePaused&&guided()?'Başlat’a basınca bu bölümün başından devam edeceksin.':
          practicePaused?'Başlat’a basınca kaldığın yerden devam edeceksin.':'Başlat’a bas. Çizgiye gelen notaları piyanonda çal.');
        if(complete) {tone='success';symbol='✓';}
        else if(practicePaused) symbol='Ⅱ';
      } else if(training?.phase==='release') {
        title=t('Yeni tekrara hazırlan');detail=t('Tüm tuşları bırak.');tone='waiting';symbol='↻';
      } else if(status.extra.length||status.repeat.length) {
        const instructions=[];
        if(status.extra.length) instructions.push(t('Bırak: ')+names(status.extra));
        if(status.repeat.length) instructions.push(t('Yeniden bas: ')+names(status.repeat));
        if(status.missing.length) instructions.push(t('Bas: ')+names(status.missing));
        title=t(status.extra.length?'Fazla tuş basılı':'Notaya yeniden bas');detail=instructions.join(' / ');
        tone=status.extra.length?'error':'waiting';symbol=status.extra.length?'×':'↻';
      } else if(training?.phase==='countdown'||(!guided()&&practice.time<0)) {
        const start=training?.current?.start||0;
        title=t('Hazırlan: {seconds}',{seconds:Math.max(1,Math.ceil((start-practice.time)/state.speed))});
        detail=t('İlk notaları çizgide karşıla.');tone='waiting';symbol='…';
      } else if(status.missing.length) {
        title=t('Bu notaları çal');detail=t('Bas: ')+names(status.missing);tone='waiting';symbol='→';
      } else if(practice.expected.size) {
        title=t('Doğru — devam et');
        detail=practice.timing.enabled?t('Basılı tut: ')+names(practice.expected.keys()):t('Bu notalar doğru. Sıradaki notaları bekle.');
        tone='success';symbol='✓';
      } else {
        title=t('Sıradaki notayı bekle');detail=t('Notalar çizgiye geldiğinde çal.');symbol='…';
      }
      if(guided()&&training?.active&&!training.done) {
        grade=training.reason?t('{reason} · Bu tekrar sayılmayacak. Seri sıfırlandı; bölümü bitirip yeniden dene.',{reason:mistakeName(training.reason)}):
          !state.running&&practicePaused?t('Yarım kalan tekrar sayılmadı. Öğrenilen bölümler korunuyor.'):
          training.cleared.has(training.stage)?t('Bu bölüm öğrenildi; yeniden çalışıyorsun.'):
          state.running?t('Bu tekrar henüz tamamlanmadı. Hatasız bitirince sayaç artacak.'):
          t('Bölümü geçmek için {target} kez art arda hatasız çal.',{target:training.target});
      } else if(!guided()) grade=t('Serbest çalışma: doğru tuşları bekler; tekrar puanı tutulmaz.');
      setText('practice-title',title);setText('lesson-feedback',detail);setText('practice-symbol',symbol);
      setText('practice-grade',grade);ui['practice-grade'].hidden=!grade;
      ui['practice-grade'].dataset.failed=String(Boolean(training?.reason));
      ui['lesson-panel'].dataset.tone=tone;
    }

    function updateExpression(time, current) {
      const pressed=state.selectedTracks.some(track=>pedalValue(track.pedals,time)>=.5);
      const pedalText=hasPedal?(pressed?t("BASILI"):t("BIRAKILMIŞ")):t("VERİ YOK");
      if(expression.pedalStatus.textContent!==pedalText) expression.pedalStatus.textContent=pedalText;
      expression.pedal.classList.toggle('pressed',pressed);
      let notes=current, upcoming=false;
      if(!notes.length) {
        const candidates=displayNotes(),index=lowerBound(candidates,time);
        const first=candidates[index];
        if(first&&first.time<=time+6) {
          notes=[]; upcoming=true;
          for(let i=index;i<candidates.length&&candidates[i].time<=first.time+.03;i++) notes.push(candidates[i]);
        }
      }
      const values=notes.map(note=>noteName(note.midi,ui.notation.value==='none'?'solfege':ui.notation.value)+' '+Math.round(note.velocity*127));
      const velocityText=(upcoming?t("Sıradaki şiddet"):t("Şiddet"))+' (1–127): '+(values.join(' · ')||'—');
      if(expression.velocity.textContent!==velocityText) expression.velocity.textContent=velocityText;
      const hint=practicing()?t("Çalışta şiddet ve pedal isteğe bağlı"):t("Şiddet ve pedal duyulan sese uygulanır");
      if(expression.hint.textContent!==hint) expression.hint.textContent=hint;
    }

    function rebuildPedalTimeline() {
      pedalIntervals=[]; hasPedal=state.selectedTracks.some(track=>track.pedals.length);
      const times=[...new Set([0,state.duration,...state.selectedTracks.flatMap(track=>track.pedals.map(event=>event.time))])].sort((a,b)=>a-b);
      let start=null;
      for(const time of times) {
        const pressed=time<state.duration && state.selectedTracks.some(track=>pedalValue(track.pedals,time)>=.5);
        if(pressed && start===null) start=Math.max(0,time);
        if(!pressed && start!==null) {
          if(time>start) pedalIntervals.push({time:start,end:Math.min(time,state.duration)});
          start=null;
        }
      }
    }

    function drawPedal(time) {
      const context=pedalContext,pixels=height/6;
      context.clearRect(0,0,pedalWidth,height);
      context.fillStyle='#211d2a'; context.fillRect(0,0,pedalWidth,height);
      for(let second=Math.ceil(time);second<=time+6;second++) {
        if(second<0) continue;
        const y=height-(second-time)*pixels;
        context.strokeStyle=second%5===0?'#9d83ba55':'#9d83ba28'; context.lineWidth=.5;
        context.beginPath(); context.moveTo(0,y); context.lineTo(pedalWidth,y); context.stroke();
      }
      for(const interval of pedalIntervals) {
        if(interval.end<=time || interval.time>time+6) continue;
        const top=Math.max(0,height-(interval.end-time)*pixels);
        const bottom=Math.min(height,height-(interval.time-time)*pixels);
        const pressed=interval.time<=time && interval.end>time;
        context.fillStyle=pressed?'#d2b4ff':'#ab87dc';
        context.shadowColor='#bd93f5'; context.shadowBlur=pressed?12:0;
        context.fillRect(14,top,pedalWidth-28,Math.max(0,bottom-top));
        context.shadowBlur=0;
        context.fillStyle='#f1e4ff88'; context.fillRect(14,bottom-2,pedalWidth-28,2);
      }
      context.fillStyle='#211d2ae6'; context.fillRect(0,0,pedalWidth,24);
      context.font='9px -apple-system,BlinkMacSystemFont,sans-serif'; context.textAlign='center';
      context.fillStyle='#d6c0f1'; context.fillText(hasPedal?'SUSTAIN':t("VERİ YOK"),pedalWidth/2,15);
    }

    function resize() {
      if(!activePractice) return;
      const rect=ui.roll.getBoundingClientRect(); width=rect.width; height=rect.height;
      const ratio=Math.min(2,window.devicePixelRatio||1);
      ui.roll.width=Math.round(width*ratio); ui.roll.height=Math.round(height*ratio);
      pedalWidth=expression.roll.clientWidth;
      expression.roll.width=Math.round(pedalWidth*ratio); expression.roll.height=Math.round(height*ratio);
      pedalContext.setTransform(ratio,0,0,ratio,0,0);
      ctx.setTransform(ratio,0,0,ratio,0,0); rebuildKeys(); draw();
    }
    function roundedRect(x,y,w,h,radius) {
      const r=Math.min(radius,w/2,h/2);
      ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
    }
    function draw() {
      if(!activePractice) return;
      const mastery=guided()?training?.mastery():null;
      sheet.setMastery(mastery||null);
      const time=position(), pixels=height/6, active=new Map(), current=[];
      ctx.clearRect(0,0,width,height);
      ctx.fillStyle='#151618'; ctx.fillRect(0,0,width,height);
      for(const key of keys) {
        if(key.black) { ctx.fillStyle='#10111388'; ctx.fillRect(key.x,0,key.width,height); }
        else { ctx.strokeStyle=key.midi%12===0?'#383a3e':'#282a2e'; ctx.lineWidth=key.midi%12===0?1:.5; ctx.beginPath(); ctx.moveTo(key.x+.5,0); ctx.lineTo(key.x+.5,height); ctx.stroke(); }
      }
      ctx.font='10px -apple-system,BlinkMacSystemFont,sans-serif'; ctx.textAlign='left';
      for(let second=Math.ceil(time);second<=time+6;second++) {
        if(second<0) continue;
        const y=height-(second-time)*pixels;
        ctx.strokeStyle=second%5===0?'#55585e77':'#41444a66'; ctx.lineWidth=.5;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke();
        ctx.fillStyle='#92969e66'; ctx.fillText(formatTime(second),7,y-5);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(0,0,width,height); ctx.clip();
      const shownNotes=displayNotes(),endIndex=lowerBound(shownNotes,time+6.1);
      for(let i=0;i<endIndex;i++) {
        const note=shownNotes[i]; if(note.end<time) continue;
        const key=keyMap.get(note.midi); if(!key) continue;
        const bottom=height-(note.time-time)*pixels;
        const top=Math.max(-12,height-(note.end-time)*pixels);
        const barHeight=Math.max(5,bottom-top-1.5), inset=Math.max(1,key.width*.09), barWidth=key.width-inset*2;
        const isActive=note.time<=time&&note.end>time;
        if(isActive) current.push(note);
        const hand=noteHand(note), color=colors[hand];
        // Optional notes stay visible but quiet: played or skipped, both pass.
        if(note.optional) ctx.globalAlpha=.28;
        else if(isActive) { if(!practicing()) active.set(note.midi,hand); ctx.shadowColor=color; ctx.shadowBlur=16; }
        ctx.fillStyle=color; roundedRect(key.x+inset,top,barWidth,barHeight,3); ctx.fill();
        ctx.shadowBlur=0;
        ctx.fillStyle='#ffffff33'; ctx.fillRect(key.x+inset+1,top+3,2,Math.max(0,barHeight-6));
        if(barWidth>4&&barHeight>10) {
          const meterY=Math.max(2,top+4), meterWidth=barWidth-4;
          ctx.fillStyle='#16223844'; ctx.fillRect(key.x+inset+2,meterY,meterWidth,3);
          ctx.fillStyle='#162238cc'; ctx.fillRect(key.x+inset+2,meterY,meterWidth*note.velocity,3);
        }
        if(ui.staff.checked) {
          const badgeBottom=Math.min(height-4,bottom-3);
          staff.draw(ctx,note.midi,key.x+key.width/2,badgeBottom,barWidth,ui.notation.value==='none'?'':noteName(note.midi));
        } else if(ui.notation.value!=='none'&&barWidth>22&&barHeight>19) {
          ctx.fillStyle='#191b20'; ctx.font='600 '+Math.min(11,barWidth/3.5)+'px -apple-system,BlinkMacSystemFont,sans-serif'; ctx.textAlign='center';
          ctx.fillText(noteName(note.midi),key.x+key.width/2,Math.min(bottom-7,Math.max(13,top+17))); ctx.textAlign='left';
        }
        ctx.globalAlpha=1;

      }
      ctx.restore();
      const held=selectedInput().held;
      const livePractice=practicing()&&state.running;
      for(const midi of held) active.set(midi,midi<60?0:1);
      for(const key of keys) {
        const wrong=livePractice&&practice.status.extra.includes(key.midi);
        const repeat=livePractice&&practice.status.repeat.includes(key.midi);
        const correct=livePractice&&held.has(key.midi)&&!wrong&&!repeat;
        key.element.classList.toggle('active',active.has(key.midi));
        key.element.classList.toggle('expected',practicing()&&(practice.timing.enabled?practice.expected:practice.pending).has(key.midi));
        key.element.classList.toggle('wrong',wrong);
        key.element.classList.toggle('repeat',repeat);
        key.element.classList.toggle('correct',correct);
        key.element.setAttribute('aria-label',noteName(key.midi,'solfege')+(held.has(key.midi)?t(" · basılı"):'')+
          (wrong?t(' · bırak'):repeat?t(' · yeniden bas'):correct?t(' · doğru'):''));
        if(active.has(key.midi)) key.element.style.setProperty('--active',colors[active.get(key.midi)]);
      }
      for(const [midi,hand] of active) {
        const key=keyMap.get(midi); if(!key) continue;
        const glow=ctx.createRadialGradient(key.x+key.width/2,height,0,key.x+key.width/2,height,key.width*1.8);
        glow.addColorStop(0,colors[hand]+'66'); glow.addColorStop(1,'transparent');
        ctx.fillStyle=glow; ctx.fillRect(key.x-key.width,height-key.width*1.8,key.width*3,key.width*1.8);
      }
      if(time<0) {
        ctx.font='11px -apple-system,BlinkMacSystemFont,sans-serif'; ctx.fillStyle='#a4a7ae'; ctx.textAlign='right';
        ctx.fillText(state.running?t("Hazır… ")+Math.ceil(-time):t("Notayı çizgide karşıla"),width-15,23); ctx.textAlign='left';
      }
      const visibleTime=Math.max(0,Math.min(state.duration,time));
      ui.seek.value=String(visibleTime); ui.elapsed.textContent=formatTime(visibleTime);
      ui.seek.setAttribute('aria-valuetext',formatTime(visibleTime)+' / '+formatTime(state.duration));
      ui['current-notes'].textContent=active.size?[...active.keys()].sort((a,b)=>a-b).map(midi=>noteName(midi,ui.notation.value==='none'?'solfege':ui.notation.value)).join(' · '):'';
      updateLessonStatus();
      if(practicing()&&state.running) effects.observe(practice,selectedInput(),training?.reason||'');
      updateExpression(time,current);
      drawPedal(time);
      const stage=guided()?training?.current:null;
      sheet.follow(stage&&state.running?Math.max(stage.start,Math.min(stage.end-.00001,time)):time,state.running);
    }

    function applyTracks() {
      const running=state.running, time=position(); pause();
      const selected=ui.track.value;
      state.selectedTracks=state.tracks.filter(track=>selected==='all'||String(track.id)===selected);
      state.notes=state.selectedTracks.flatMap(track=>track.notes).sort((a,b)=>a.time-b.time||a.midi-b.midi);
      adaptNotes();
      rebuildPedalTimeline();
      state.position=Math.min(time,state.duration);
      configureTraining(); rebuildKeys(); draw(); checkpoint();
      if(running) play();
    }
    function load(tracks,duration,source,title,description,reference,notationLesson=null) {
      checkpoint(); changingLesson=true; pause();
      currentReference=reference; currentKey=reference.kind+':'+reference.id;
      const saved=workspaceState.lesson(currentKey);
      training=null;
      trainingContexts=saved.practice?.version===1?{...saved.practice.contexts}:{};
      state.tracks=tracks.map(track=> {
        const pedals=[...(track.pedals||[])].sort((a,b)=>a.time-b.time);
        const notes=track.notes.map(note=>({...note,soundEnd:pedals.length?pedalRelease(pedals,note.end,duration):(note.soundEnd??note.end)}));
        return {...track,pedals,notes};
      });
      state.duration=duration; state.position=Number.isFinite(saved.position)?Math.max(-2,Math.min(duration,saved.position)):-2; state.source=source;
      sheet.load(notationLesson,saved.sheet);
      practice.seek(state.position,nowSeconds(),selectedInput());
      ui.track.replaceChildren(new Option(source==='builtin'?t("İki el birlikte"):t("Tüm melodik kanallar"),'all'));
      for(const track of tracks) ui.track.add(new Option(source==='builtin'?(track.id===0?t("Sol el"):t("Sağ el")):track.name,String(track.id)));
      if([...ui.track.options].some(option=>option.value===saved.track)) ui.track.value=saved.track;
      ui.track.disabled=tracks.length===1;
      ui['file-badge'].textContent=source==='builtin'?t("DERS HAZIR"):t("MIDI AÇILDI");
      element('download-midi').disabled=source!=='builtin';
      ui['legend-left'].textContent=source==='builtin'?t("Sol el"):t("Do4 altı");
      ui['legend-right'].textContent=source==='builtin'?t("Sağ el"):t("Do4 ve üstü");
      ui['file-title'].textContent=title; metadataDescription=description; renderLessonLabels();
      ui.seek.max=String(duration); ui.duration.textContent=formatTime(duration);
      showError(''); applyTracks(); updatePlayButton();
      changingLesson=false; workspaceState.update('current',reference);
      zoomStage();
      requestAnimationFrame(()=> {
        if(currentReference!==reference) return;
        if(activePractice) ui.viewport.scrollLeft=saved.horizontal||0;
        else workspaceState.saveLesson(currentKey,{horizontal:saved.horizontal||0});
        checkpoint();workspaceState.flush();
      });
    }
    function renderLessonLabels() {
      for(const option of ui.track.options) {
        if(option.value==='all') option.textContent=t(state.source==='builtin'?'İki el birlikte':'Tüm melodik kanallar');
        else if(state.source==='builtin') option.textContent=t(Number(option.value)===0?'Sol el':'Sağ el');
      }
      ui['file-badge'].textContent=t(state.source==='builtin'?'DERS HAZIR':'MIDI AÇILDI');
      ui['legend-left'].textContent=t(state.source==='builtin'?'Sol el':'Do4 altı');
      ui['legend-right'].textContent=t(state.source==='builtin'?'Sağ el':'Do4 ve üstü');
      ui['file-description'].textContent=metadataDescription.split(' · ').map(message).join(' · ');
    }
    window.addEventListener('rach3-language-change',()=> {
      renderLessonLabels();updatePlayButton();showError(errorSource);rebuildKeys();draw();
    });
    function loadSong(lesson=rubatoSong) {
      song=lesson;
      const detail=song.description?' · '+song.description:'';
      const reference=lesson===rubatoSong?{kind:'builtin',id:'rubato'}:{kind:'library',id:lesson.id};
      load(song.tracks,song.duration,'builtin',song.title.replace(/ · Piano Tutorial$/, ''),song.noteCount+' nota · '+formatTime(song.duration)+detail,reference,lesson);
    }
    function downloadMidi() {
      const midi=new Midi(); midi.name=song.title; midi.header.setTempo(60);
      for(const part of song.tracks) {
        const track=midi.addTrack(); track.name=part.id===0?'Left hand':'Right hand'; track.channel=part.id; track.instrument.number=0;
        for(const note of part.notes) track.addNote({midi:note.midi,time:note.time,duration:note.end-note.time,velocity:note.velocity});
        for(const event of part.pedals||[]) track.addCC({number:64,time:event.time,value:event.value});
      }
      const url=URL.createObjectURL(new Blob([midi.toArray()],{type:'audio/midi'}));
      const link=document.createElement('a'); link.href=url; link.download=song.midiFilename||'a-small-measure-of-peace-video.mid';
      document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
    }

    function pedalIndex(events,time) {
      let low=0,high=events.length;
      while(low<high) { const mid=(low+high)>>>1; if(events[mid].time<=time) low=mid+1; else high=mid; }
      return low;
    }
    function pedalValue(events,time) {
      const index=pedalIndex(events,time);
      return index===0?0:events[index-1].value;
    }
    function pedalRelease(events,end,duration) {
      const low=pedalIndex(events,end);
      if(low===0||events[low-1].value<.5) return end;
      for(let i=low;i<events.length;i++) if(events[i].value<.5) return Math.max(end,events[i].time);
      return Math.max(end,duration);
    }
    function importFile(file) {
      if(file) window.dispatchEvent(new CustomEvent('rach3-import-document',{detail:{file}}));
    }

    input.addEventListener('beforechange',event=> {
      if(event.detail.source==='bluetooth'&&state.running&&practicing()) {
        advancePractice(event.detail.at,selectedInput());
      }
    });
    input.addEventListener('change',event=> {
      if(event.detail.source==='bluetooth') {
        const snapshot=selectedInput();
        practice.reconcile(snapshot);
        if(practicing()&&state.running) {
          if(!snapshot.connected) {pause();return;}
          if(guided()) {
            training.observe(event.detail.at,snapshot,practice);
            advancePractice(event.detail.at,snapshot);
          }
        }
        updatePlayButton();draw();
      }
    });
    ui.mode.addEventListener('change',()=> {
      pause(); state.mode=ui.mode.value;
      configureTraining();draw();checkpoint();
    });
    for(const id of ['practice-strategy','practice-target','practice-timing']) ui[id].addEventListener('change',()=> {
      pause();configureTraining();draw();checkpoint();
    });
    ui['practice-reset'].addEventListener('click',()=> {
      pause();
      if(training) delete trainingContexts[training.key];
      configureTraining();draw();checkpoint();
    });
    ui['practice-profile'].addEventListener('change',()=>applyProfile(()=>{profiles.active=ui['practice-profile'].value;}));
    function addProfile() {
      const name=ui['profile-name'].value.trim().slice(0,40);
      if(!name) return;
      const id='p'+Date.now().toString(36);
      ui['profile-name'].value='';
      applyProfile(()=>{profiles.list.push({id,name,reach:null});profiles.active=id;});
    }
    ui['profile-add'].addEventListener('click',addProfile);
    ui['profile-name'].addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addProfile();}});
    ui['profile-delete'].addEventListener('click',()=> {
      if(profiles.active==='default') return;
      applyProfile(()=>{profiles.list=profiles.list.filter(profile=>profile.id!==profiles.active);profiles.active='default';});
    });
    ui['profile-clear-reach'].addEventListener('click',()=>applyProfile(()=>{activeProfile().reach=null;}));
    ui['profile-measure'].addEventListener('click',()=>measuring?stopMeasure():startMeasure());
    window.addEventListener('rach3-language-change',()=>renderProfiles());
    renderProfiles();
    ui['practice-previous'].addEventListener('click',()=>selectStage(-1));
    ui['practice-next'].addEventListener('click',()=>selectStage(1));
    ui.play.addEventListener('click',()=> { if(state.running||state.starting) pause(); else play(); });
    window.addEventListener('rach3-output-settings-change',pause);
    window.addEventListener('rach3-bluetooth-test',async event=> {
      pause();
      try {
        const started=pianoOutput.start([{notes:[{time:0,end:.35,soundEnd:.35,midi:60,velocity:.45}],pedals:[]}],0,1,.35);
        const session=pianoOutput.session;
        await started;
        setTimeout(()=>{if(pianoOutput.session===session) pianoOutput.stop();event.detail.complete(null);},900);
      } catch(error) {event.detail.complete(error);}
    });
    ui['audio-output'].addEventListener('change',()=>{pause();updatePlayButton();showError('');});
    ui.rewind.addEventListener('click',()=>seek(-2));
    ui.seek.addEventListener('input',()=>seek(Number(ui.seek.value)));
    ui.speed.addEventListener('change',()=> {
      const running=state.running;pause();state.speed=Number(ui.speed.value);configureTraining();draw();checkpoint();
      if(running) play();
    });
    ui.volume.addEventListener('input',()=> { if(master) master.gain.setTargetAtTime(Number(ui.volume.value)/100*.55,audio.currentTime,.015); });
    ui.track.addEventListener('change',applyTracks);
    ui.viewport.addEventListener('scroll',()=>checkpoint(),{passive:true});
    workspaceState.rememberControls(ui,['mode','speed','volume','range','notation','staff','zoom','loop','audio-output','practice-strategy','practice-target','practice-timing','practice-effects','practice-sounds','practice-effect-volume']);
    for(const id of ['practice-effects','practice-sounds','practice-effect-volume']) ui[id].addEventListener('input',()=> {
      effects.configure();
      if(practicing()&&state.running) effects.unlock();
    });
    ui.range.addEventListener('change',()=> { rebuildKeys(); draw(); });
    ui.notation.addEventListener('change',()=> { rebuildKeys(); draw(); });
    ui.staff.addEventListener('change',draw);
    const zoomStage=()=> { if(activePractice) ui.stage.style.minWidth=Math.max(700,ui.viewport.clientWidth)*Number(ui.zoom.value)+'px'; };
    ui.zoom.addEventListener('change',zoomStage);
    new ResizeObserver(zoomStage).observe(ui.viewport);
    element('open-file').addEventListener('click',()=>ui['midi-file'].click());
    ui['midi-file'].addEventListener('change',async()=> { await importFile(ui['midi-file'].files[0]); ui['midi-file'].value=''; });
    element('load-rubato').addEventListener('click',()=>loadSong(rubatoSong));
    element('download-midi').addEventListener('click',downloadMidi);
    document.addEventListener('keydown',event=> {
      if(!activePractice||event.defaultPrevented||event.target.isContentEditable||event.target.closest('input,textarea,select,button,a,summary')||event.altKey||event.ctrlKey||event.metaKey) return;
      if(event.code==='Space') { event.preventDefault(); if(state.running||state.starting) pause(); else play(); }
      if(event.code==='ArrowLeft'||event.code==='ArrowRight') { event.preventDefault(); seek(position()+(event.code==='ArrowLeft'?-5:5)); }
    });
    document.addEventListener('visibilitychange',()=> { if(document.hidden) pause(); });
    window.addEventListener('pagehide',pause);
    window.addEventListener('blur',pause);
    window.addEventListener('pagehide',pause);
    let dragDepth=0;
    document.addEventListener('dragenter',event=> { if(activePractice&&event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; ui.stage.classList.add('dragging'); } });
    document.addEventListener('dragover',event=> { if(activePractice&&event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect='copy'; } });
    document.addEventListener('dragleave',()=> { if(activePractice) { dragDepth=Math.max(0,dragDepth-1); if(!dragDepth) ui.stage.classList.remove('dragging'); } });
    document.addEventListener('drop',event=> {
      if(!activePractice||!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); dragDepth=0; ui.stage.classList.remove('dragging'); importFile(event.dataTransfer.files[0]);
    });
    // Loading the song draws immediately, so measure and build the keyboard first.
    resize();
    const resume=workspaceState.data.current;
    try {
      if(resume?.kind==='library') {
        const lesson=await lessonCommand('lesson-load',{id:resume.id});
        if(!currentReference) loadSong(lesson);
      } else loadSong(rubatoSong);
    } catch(error) {
      // A lesson made for another version of rach3 isn't here; start quietly with the example.
      const elsewhere=error.message===message('Bu ders burada yok.');
      if(!currentReference) {loadSong(rubatoSong);if(!elsewhere) showError('Son ders açılamadı: '+error.message);}
    }
    staff.prepare().then(draw).catch(()=>showError('Nota sembolleri yüklenemedi. Uygulamayı yeniden aç.'));
    new ResizeObserver(resize).observe(ui.roll);
    startBluetooth(window.rach3Input,workspaceState);
    startAppShell({
      workspaceState,
      onLesson:loadSong,
      onLessonDeleted:id=> {
        if(currentReference?.kind==='library'&&currentReference.id===id) {
          pause();currentKey='';currentReference=null;loadSong(rubatoSong);
        }
      },
      onTabWillChange: next=> {
        if(next!=='practice') {
          pause(); dragDepth=0; ui.stage.classList.remove('dragging');
        }
      },
      onTabChange: next=> {
        activePractice=next==='practice';
        if(activePractice) {
          const horizontal=workspaceState.lesson(currentKey).horizontal||0;
          zoomStage(); resize(); ui.viewport.scrollLeft=horizontal;
        }
      },
    });
  })();
