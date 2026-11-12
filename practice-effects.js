// Transient feedback only: accepted attacks and completed attempts come from the
// practice owners. This class never advances, grades or saves an exercise.
export class PracticeEffects {
  constructor({layer,celebration,combo,getKey,settings,mistakeText}) {
    Object.assign(this,{layer,celebration,combo,getKey,settings,mistakeText});
    this.hitCount=0;
    this.accepted=new Map();this.rejected=new Map();this.reason='';
    this.animations=new Set();this.sources=new Set();
    this.lastMistake=-Infinity;this.audio=null;this.gain=null;
    this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.motion.addEventListener('change',()=>this.clearVisuals());
  }

  // Called from Start or the sound toggle, never from incoming MIDI. Audio is
  // optional: unavailable/suspended audio must not interrupt piano practice.
  unlock() {
    if(!this.settings().sound) return;
    try {
      if(!this.audio) {
        const Audio=window.AudioContext||window.webkitAudioContext;
        if(!Audio) return;
        this.audio=new Audio();this.gain=this.audio.createGain();
        this.gain.connect(this.audio.destination);

      }
      this.gain.gain.value=this.settings().volume;
      this.audio.resume().catch(()=>{});
    } catch { /* Optional feedback must never block transport. */ }
  }

  configure() {
    const settings=this.settings();
    if(!settings.visual) this.clearVisuals();
    if(!settings.sound||!settings.volume) this.silence();
    if(this.gain) this.gain.gain.setTargetAtTime(settings.sound?settings.volume:0,this.audio.currentTime,.02);
  }

  reset(input) {
    this.clear();this.seed(input);
  }

  seed(input) {
    this.reason='';this.lastMistake=-Infinity;this.hitCount=0;this.combo.hidden=true;
    // Seeking/resuming seeds the clock with old attacks. Those are not new hits.
    this.accepted=new Map([...input.attacks].map(([pitch,attack])=>[pitch,attack.serial]));
    this.rejected=new Map(this.accepted);
  }

  observe(clock,input,reason='') {
    let mistake=Boolean(reason&&!this.reason);
    const wrongKeys=[];
    this.reason=reason;
    for(const [pitch,serial] of clock.unexpectedAttacks) {
      if(serial>(this.rejected.get(pitch)||0)) {
        this.rejected.set(pitch,serial);
        if(input.attacks.get(pitch)?.serial===serial) {mistake=true;wrongKeys.push(pitch);}
      }
    }
    if(mistake) this.mistake(wrongKeys,wrongKeys.length?'wrong':reason);
    for(const [pitch,serial] of clock.usedAttacks) {
      if(serial<=(this.accepted.get(pitch)||0)) continue;
      this.accepted.set(pitch,serial);
      if(input.attacks.get(pitch)?.serial!==serial||clock.unexpectedAttacks.get(pitch)===serial) continue;
      if(mistake) continue;
      this.hitCount++;
      this.keyPulse(pitch,false);
      if(this.settings().visual&&this.hitCount>=2) {
        this.combo.hidden=false;
        this.combo.querySelector('strong').textContent=this.hitCount;
        this.combo.dataset.level=this.hitCount>=10?'hot':this.hitCount>=5?'warm':'start';
        if(!this.motion.matches) {
          for(const animation of this.combo.getAnimations()) animation.cancel();
          this.animate(this.combo,[{scale:'1.18'},{scale:'1'}],{duration:220});
        }
      }
    }
  }

  animate(element,frames,options,remove=false) {
    const animation=element.animate(frames,options);
    this.animations.add(animation);
    const ended=()=>{this.animations.delete(animation);if(remove) element.remove();};
    animation.finished.then(ended,ended);
  }

  burst(x,y,count,colors,wide) {
    if(this.motion.matches||!this.settings().visual) return;
    // A large chord must not create an unbounded particle/animation backlog.
    count=Math.min(count,64-this.layer.childElementCount);
    for(let i=0;i<count;i++) {
      const particle=document.createElement('i');particle.className='practice-spark';
      const angle=wide?Math.PI*2*i/count:Math.PI+Math.PI*(i+.5)/count;
      const distance=wide?65+Math.random()*100:35+Math.random()*45;
      const dx=Math.cos(angle)*distance,dy=Math.sin(angle)*distance;
      Object.assign(particle.style,{left:x+'px',top:y+'px',background:colors[i%colors.length],
        width:(wide?7:5)+'px',height:(wide?10:5)+'px'});
      this.layer.append(particle);
      this.animate(particle,[
        {transform:'translate(-50%,-50%) scale(.5)',opacity:0},
        {offset:.15,opacity:1},
        {transform:`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${i*43}deg) scale(.2)`,opacity:0},
      ],{duration:wide?650:360,easing:'cubic-bezier(.12,.65,.35,1)'},true);
    }
  }

  keyPulse(pitch,wrong) {
    if(!this.settings().visual||document.hidden) return;
    const key=this.getKey(pitch);
    if(!key) return;
    const bounds=key.getBoundingClientRect(),area=this.layer.getBoundingClientRect();
    const x=bounds.left+bounds.width/2-area.left,y=bounds.top-area.top;
    this.pulse(x,y,wrong?'#ff8e9b':'#a4efcd',wrong?'×':'✓');
    this.burst(x,y,wrong?9:7,wrong?['#ff8e9b','#ffd0b2']:['#a4efcd','#e4fff2'],false);
  }

  pulse(x,y,color,mark='') {
    if(!this.settings().visual||document.hidden||this.layer.childElementCount>=64) return;
    const ring=document.createElement('span');ring.className='practice-hit';ring.textContent=mark;
    Object.assign(ring.style,{left:x+'px',top:y+'px',color});this.layer.append(ring);
    this.animate(ring,this.motion.matches?[{opacity:1},{opacity:0}]:[
      {transform:'translate(-50%,-65%) scale(.55)',opacity:1},
      {offset:.3,transform:'translate(-50%,-85%) scale(1.15)',opacity:1},
      {transform:'translate(-50%,-125%) scale(1.4)',opacity:0},
    ],{duration:650,easing:'ease-out'},true);
  }

  mistake(pitches,reason) {
    this.hitCount=0;this.combo.hidden=true;
    for(const pitch of pitches) this.keyPulse(pitch,true);
    const now=performance.now();
    if(now-this.lastMistake<450) return;
    this.lastMistake=now;
    const text=this.mistakeText(reason||'wrong');
    this.finish('mistake',text.title,text.detail);
  }

  finish(kind,title,detail) {
    // Completion replaces a possible error tick; it has its own distinct cue.
    this.silence();this.sound(kind);
    if(!this.settings().visual||document.hidden) return;
    clearTimeout(this.hideTimer);
    for(const animation of this.celebration.getAnimations()) animation.cancel();
    this.celebration.dataset.kind=kind;
    this.celebration.querySelector('[data-celebration-icon]').textContent=
      kind==='mistake'?'×':kind==='retry'?'↻':kind==='section'||kind==='complete'?'✦':'✓';
    this.celebration.querySelector('strong').textContent=title;
    this.celebration.querySelector('small').textContent=detail;
    this.celebration.hidden=false;
    if(!this.motion.matches) {
      this.animate(this.celebration,[{opacity:0,translate:'0 7px',scale:'.94'},
        {opacity:1,translate:'0 0',scale:'1'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
      if(kind!=='retry'&&kind!=='mistake') {
        const area=this.layer.getBoundingClientRect(),badge=this.celebration.getBoundingClientRect();
        this.burst(badge.left+badge.width/2-area.left,badge.top+badge.height/2-area.top,
          kind==='complete'?40:kind==='section'?32:18,
          kind==='section'||kind==='complete'?['#f2d28b','#a4efcd','#b9d6ff']:['#a4efcd','#e4fff2'],true);
      }
    }
    this.hideTimer=setTimeout(()=>{this.celebration.hidden=true;},kind==='section'||kind==='complete'?2600:kind==='mistake'?1000:1800);
  }

  sound(kind) {
    if(!this.settings().sound||!this.settings().volume||this.audio?.state!=='running'||document.hidden) return;
    if(this.sources.size>8) return;
    const now=this.audio.currentTime;
    const notes={mistake:[220,165],pass:[784,988],retry:[330,294],section:[659,831,988],complete:[523,659,784,1046],end:[784,988]}[kind]||[];
    notes.forEach((frequency,index)=> {
      const source=this.audio.createOscillator();source.type=kind==='mistake'||kind==='retry'?'triangle':'sine';source.frequency.value=frequency;
      this.envelope(source,source,now+index*.11,kind==='mistake'?.12:.26,kind==='mistake'||kind==='retry'?.24:.38);
    });
  }

  envelope(source,output,start,duration,level) {
    const gain=this.audio.createGain();
    gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(level,start+.008);
    gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    output.connect(gain);gain.connect(this.gain);
    const entry={source,output,gain};this.sources.add(entry);
    source.onended=()=>{source.disconnect();if(output!==source) output.disconnect();gain.disconnect();this.sources.delete(entry);};
    source.start(start);source.stop(start+duration+.015);
  }

  silence() {
    for(const entry of this.sources) {
      entry.gain.gain.cancelScheduledValues(this.audio.currentTime);
      entry.gain.gain.setValueAtTime(0,this.audio.currentTime);
      try {entry.source.stop();} catch { /* Already ended. */ }
    }
    this.sources.clear();
  }

  clearVisuals() {
    clearTimeout(this.hideTimer);this.celebration.hidden=true;this.combo.hidden=true;
    for(const animation of this.animations) animation.cancel();
    this.animations.clear();this.layer.replaceChildren();
  }

  clear() {this.clearVisuals();this.silence();}
}
