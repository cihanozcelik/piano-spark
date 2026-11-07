import { WorkspaceState } from './workspace-state.js';
import { lessonCommand } from './create-lesson.js';
import { SheetMusic } from './sheet-music.js';
import { startBluetooth } from './bluetooth.js';
import { PianoInput } from './piano-input.js';
import { PianoOutput } from './piano-output.js';
import { PracticeClock } from './practice-clock.js';
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
    const state = { tracks:[], selectedTracks:[], notes:[], duration:0, position:-2, speed:Number(ui.speed.value), running:false, anchor:0, anchorPosition:0, next:0, epoch:0, source:'builtin', mode:ui.mode.value };
    const input = new PianoInput(), practice = new PracticeClock();
    const pianoOutput=new PianoOutput(message=>{pause();showError(message);});
    pianoOutput.onStatus=()=>updatePlayButton();
    const staff = new StaffNotation();
    const sheet=new SheetMusic({onViewChange:()=>checkpoint()});
    workspaceState.capture=()=>checkpoint();
    practice.speed=state.speed;
    // Native/Bluetooth adapters feed this interface; they never own lesson time.
    window.pianomanInput = Object.freeze({
      receive: (event, source='bluetooth') => input.receive(event, source),
      connect: (source='bluetooth', label='Bluetooth piyano') => input.connect(source, label),
      disconnect: (source='bluetooth') => input.disconnect(source),
      reset: (source='bluetooth') => input.reset(source),
    });
    window.dispatchEvent(new Event('pianoman-input-ready'));
    let audio, master, wave, compressor, timer, raf, width, height;
    let activePractice=true;
    let keys=[], keyMap=new Map(), voices=new Set();
    const nowSeconds=()=>performance.now()/1000;
    const practicing=()=>state.mode==='practice';
    const pianoListening=()=>!practicing()&&ui['audio-output'].value==='piano';
    const selectedInput=()=>input.snapshot('bluetooth');

    function checkpoint() {
      if(!currentKey||changingLesson) return;
      workspaceState.saveLesson(currentKey,{position:Math.max(-2,Math.min(state.duration,position())),
        track:ui.track.value,sheet:sheet.viewState(),
        horizontal:activePractice?ui.viewport.scrollLeft:workspaceState.lesson(currentKey).horizontal||0});
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
      ui.play.textContent=state.starting?t("Vazgeç"):state.running?t("Duraklat"):(practicing()?t("Başlat"):t("Dinle"));
      ui.play.setAttribute('aria-label',ui.play.textContent);
      ui['volume-control'].hidden=practicing()||pianoListening();
      ui['audio-output-status'].textContent=ui['audio-output'].value==='piano'?
        (!pianoOutput.connected?t("Piyanodan dinlemek için piyanoyu bağla."):
         !pianoOutput.capable?t("MIDI gönderimi hazır değil; yeniden bağlan."):t("Ses bağlı piyanodan gelir; ses düzeyini piyanodan ayarla.")):
        t("Ses uygulamanın sentezleyicisinden gelir.");
    }
    function pause() {
      state.epoch++;
      state.starting=false;
      if(state.running&&practicing()) practice.advance(nowSeconds(),selectedInput());
      state.position=position(); state.running=false;
      clearInterval(timer); cancelAnimationFrame(raf); silence(); pianoOutput.stop();
      updatePlayButton(); draw(); checkpoint();
    }
    async function play() {
      if(state.running||state.starting||!activePractice) return;
      pianoOutput.stop();
      const epoch=++state.epoch;
      if(state.position>=state.duration) {
        state.position=-2;
        practice.seek(-2,nowSeconds(),selectedInput());
      }
      state.starting=true;updatePlayButton();
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
      if(practicing()) practice.advance(nowSeconds(),selectedInput());
      const time=position();
      if(time>=state.duration+.4) {
        const repeat=ui.loop.checked;
        pause(); state.position=repeat?-2:state.duration;
        practice.seek(state.position,nowSeconds(),selectedInput()); draw();
        if(repeat) play();
        return;
      }
      draw();
      if(performance.now()-lastCheckpoint>1000) {checkpoint();lastCheckpoint=performance.now();}
      if(state.running) raf=requestAnimationFrame(frame);
    }
    function seek(time) {
      const running=state.running;
      pause(); state.position=Math.max(-2,Math.min(state.duration,time));
      practice.seek(state.position,nowSeconds(),selectedInput()); draw();
      sheet.follow(state.position,true,true); checkpoint();
      if(running) play();
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
      ui['lesson-panel'].hidden=!practicing();
      const snapshot=selectedInput(), status=practice.status;
      const names=notes=>notes.sort((a,b)=>a-b).map(midi=>noteName(midi,ui.notation.value==='none'?'solfege':ui.notation.value)).join(' · ');
      let text;
      if(!snapshot.connected) text=t("Piyanoyu bağla");
      else if(!state.running) text=practice.time>=state.duration?t("Tamamlandı"):t("Hazır");
      else {
        const instructions=[];
        if(status.missing.length) instructions.push(t("Bas: ")+names(status.missing));
        if(status.extra.length) instructions.push(t("Bırak: ")+names(status.extra));
        if(status.repeat.length) instructions.push(t("Yeniden bas: ")+names(status.repeat));
        text=instructions.length?t("Bekliyorum — ")+instructions.join(' / '):
          practice.expected.size?t("Basılı tut: ")+names([...practice.expected.keys()]):t("Sıradaki notayı bekle");
      }
      if(ui['lesson-feedback'].textContent!==text) ui['lesson-feedback'].textContent=text;
      ui['lesson-feedback'].classList.toggle('waiting',state.running&&status.blocked);
    }

    function updateExpression(time, current) {
      const pressed=state.selectedTracks.some(track=>pedalValue(track.pedals,time)>=.5);
      const pedalText=hasPedal?(pressed?t("BASILI"):t("BIRAKILMIŞ")):t("VERİ YOK");
      if(expression.pedalStatus.textContent!==pedalText) expression.pedalStatus.textContent=pedalText;
      expression.pedal.classList.toggle('pressed',pressed);
      let notes=current, upcoming=false;
      if(!notes.length) {
        const index=lowerBound(state.notes,time);
        const first=state.notes[index];
        if(first&&first.time<=time+6) {
          notes=[]; upcoming=true;
          for(let i=index;i<state.notes.length&&state.notes[i].time<=first.time+.03;i++) notes.push(state.notes[i]);
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
      const endIndex=lowerBound(state.notes,time+6.1);
      for(let i=0;i<endIndex;i++) {
        const note=state.notes[i]; if(note.end<time) continue;
        const key=keyMap.get(note.midi); if(!key) continue;
        const bottom=height-(note.time-time)*pixels;
        const top=Math.max(-12,height-(note.end-time)*pixels);
        const barHeight=Math.max(5,bottom-top-1.5), inset=Math.max(1,key.width*.09), barWidth=key.width-inset*2;
        const isActive=note.time<=time&&note.end>time;
        if(isActive) current.push(note);
        const hand=noteHand(note), color=colors[hand];
        if(isActive) { if(!practicing()) active.set(note.midi,hand); ctx.shadowColor=color; ctx.shadowBlur=16; }
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
      }
      ctx.restore();
      const held=selectedInput().held;
      for(const midi of held) active.set(midi,midi<60?0:1);
      for(const key of keys) {
        key.element.classList.toggle('active',active.has(key.midi));
        key.element.classList.toggle('expected',practicing()&&practice.expected.has(key.midi));
        key.element.classList.toggle('wrong',practicing()&&practice.status.extra.includes(key.midi));
        key.element.setAttribute('aria-label',noteName(key.midi,'solfege')+(held.has(key.midi)?t(" · basılı"):''));
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
      updateExpression(time,current);
      drawPedal(time);
      sheet.follow(time,state.running);
    }

    function applyTracks() {
      const running=state.running, time=position(); pause();
      const selected=ui.track.value;
      state.selectedTracks=state.tracks.filter(track=>selected==='all'||String(track.id)===selected);
      state.notes=state.selectedTracks.flatMap(track=>track.notes).sort((a,b)=>a.time-b.time||a.midi-b.midi);
      rebuildPedalTimeline();
      state.position=Math.min(time,state.duration);
      practice.load(state.notes,state.position,nowSeconds(),selectedInput()); rebuildKeys(); draw(); checkpoint();
      if(running) play();
    }
    function load(tracks,duration,source,title,description,reference,notationLesson=null) {
      checkpoint(); changingLesson=true; pause();
      currentReference=reference; currentKey=reference.kind+':'+reference.id;
      const saved=workspaceState.lesson(currentKey);
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
    window.addEventListener('pianoman-language-change',()=> {
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
      if(file) window.dispatchEvent(new CustomEvent('pianoman-import-document',{detail:{file}}));
    }

    input.addEventListener('beforechange',event=> {
      if(event.detail.source==='bluetooth'&&state.running&&practicing()) {
        practice.advance(event.detail.at,selectedInput());
      }
    });
    input.addEventListener('change',event=> {
      if(event.detail.source==='bluetooth') {
        practice.reconcile(selectedInput()); draw();
      }
    });
    ui.mode.addEventListener('change',()=> {
      pause(); state.mode=ui.mode.value;
      practice.seek(state.position,nowSeconds(),selectedInput()); updatePlayButton(); draw();
    });
    ui.play.addEventListener('click',()=> { if(state.running||state.starting) pause(); else play(); });
    window.addEventListener('pianoman-output-settings-change',pause);
    window.addEventListener('pianoman-bluetooth-test',async event=> {
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
    ui.speed.addEventListener('change',()=> { const running=state.running; pause(); state.speed=Number(ui.speed.value); practice.speed=state.speed; if(running) play(); });
    ui.volume.addEventListener('input',()=> { if(master) master.gain.setTargetAtTime(Number(ui.volume.value)/100*.55,audio.currentTime,.015); });
    ui.track.addEventListener('change',applyTracks);
    ui.viewport.addEventListener('scroll',()=>checkpoint(),{passive:true});
    workspaceState.rememberControls(ui,['mode','speed','volume','range','notation','staff','zoom','loop','audio-output']);
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
      if(!currentReference) {loadSong(rubatoSong);showError('Son ders açılamadı: '+error.message);}
    }
    staff.prepare().then(draw).catch(()=>showError('Nota sembolleri yüklenemedi. Uygulamayı yeniden aç.'));
    new ResizeObserver(resize).observe(ui.roll);
    startBluetooth(window.pianomanInput,workspaceState);
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
