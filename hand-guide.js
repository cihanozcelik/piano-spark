import { FingeringPlanner } from './fingering-planner.js';
import { PianoHands } from './piano-hands.js';

// One lifecycle owner: source notes -> cancellable plan -> shared-clock renderer.
// The guide never feeds MIDI, schedules audio, or grades a player's fingers.
export class HandGuide {
  constructor({container,keys,caption,status,progress,enabled,handSize,onChange}) {
    Object.assign(this,{container,keys,caption,status,progress,enabled,handSize,onChange});
    this.active=true;
    this.notes=[];
    this.plan=null;
    this.shownNotes=null;
    this.revision=0;
    this.disposed=false;
    this.view=null;
    this.preparation=null;
    this.rendererFailed=false;
    this.layout={first:21,last:108};
    this.report={code:'loading'};
    this.planner=new FingeringPlanner({onProgress:value=> {
      this.progress.value=value.progress;
      this.report={code:'planning',percent:Math.round(value.progress*100)};
      this.translate();
    }});
    this.refreshVisibility();
  }

  clear() {
    ++this.revision;
    this.planner.cancel();
    this.notes=[];
    this.plan=null;
    this.shownNotes=null;
    this.report={code:'loading'};
    this.refreshVisibility();
  }

  load(notes) {
    this.clear();
    this.notes=notes;
    if(this.enabled) this.prepare();
  }

  async prepare() {
    const revision=++this.revision;
    this.plan=null;
    this.shownNotes=null;
    if(this.rendererFailed&&this.view) {
      this.view.dispose();this.view=null;this.preparation=null;this.rendererFailed=false;
    }
    this.report={code:'planning',percent:0};
    this.progress.value=0;
    this.refreshVisibility();
    try {
      if(!this.view) {
        this.view=new PianoHands({container:this.container,
          onStatus:report=> {
            if(!this.plan) return;
            this.report=report;
            this.translate();
          },onError:error=> {
            if(this.disposed) return;
            this.rendererFailed=true;
            ++this.revision;
            this.planner.cancel();
            this.report={code:'error',message:error.message};
            this.plan=null;
            this.refreshVisibility();
          }});
        this.view.setLayout(this.layout);
        this.preparation=this.view.prepare();
      }
      const [plan]=await Promise.all([
        this.planner.plan(this.notes,{handSize:this.handSize}),this.preparation,
      ]);
      if(this.disposed||revision!==this.revision) return;
      this.plan=plan;
      this.report={code:'ready'};
      this.refreshVisibility();
      this.onChange();
    } catch(error) {
      if(this.disposed||revision!==this.revision||error.name==='AbortError') return;
      this.planner.cancel();
      this.report={code:'error',message:error.message};
      this.refreshVisibility();
    }
  }

  translate() {
    const t=(source,params)=>window.PianoI18n.t(source,params);
    const report=this.report;
    let text;
    if(report.code==='planning') text=t('Parmaklar hesaplanıyor… %{percent}',{percent:report.percent});
    else if(report.code==='loading') text=t('3D eller hazırlanıyor…');
    else if(report.code==='error'||report.code==='unavailable') text=t('Parmak rehberi açılamadı: {reason}',{reason:report.message||report.reason||''});
    else if(report.code==='unresolved') text=t('Bu bölüm için güvenilir parmak önerisi bulunamadı.');
    else if(report.code==='unreachable') text=t('3D el pozu tuşlarla tam örtüşmüyor.');
    else {
      text=t('Önerilen parmaklar · 1 başparmak, 5 serçe');
      if(this.plan?.unresolved.length) text+=' · '+t('{count} bölüm çözülemedi',{count:this.plan.unresolved.length});
    }
    this.status.textContent=text;
    this.status.title=text;
    this.progress.hidden=report.code!=='planning';
  }

  refreshVisibility() {
    const visible=this.enabled&&this.active;
    const ready=visible&&!!this.plan;
    this.container.hidden=!ready;
    this.keys.hidden=ready;
    this.caption.hidden=!visible;
    this.view?.setVisible(ready);
    this.translate();
  }

  setEnabled(enabled) {
    this.enabled=enabled;
    if(!enabled) {
      ++this.revision;
      this.planner.cancel();
    } else if(!this.plan&&this.notes.length) this.prepare();
    this.refreshVisibility();
  }

  setHandSize(handSize) {
    this.handSize=handSize;
    this.plan=null;
    if(this.enabled&&this.notes.length) this.prepare();
  }

  setActive(active) { this.active=active;this.refreshVisibility(); }
  setLayout(layout) { this.layout=layout;this.view?.setLayout(layout); }
  resize() { this.view?.resize(); }

  update(time,notes,state) {
    if(!this.enabled||!this.active||!this.plan||this.disposed) return;
    if(this.shownNotes!==notes) {
      this.shownNotes=notes;
      this.view.load(notes,this.plan);
    }
    this.view.update(time,state);
  }

  dispose() {
    this.disposed=true;
    ++this.revision;
    this.planner.dispose();
    this.view?.dispose();
  }
}
