// One persistence owner; feature owners supply their state, never DOM snapshots.
export class WorkspaceState {
  constructor() {
    this.key='rach3.workspace.v1';
    this.data={version:1,controls:{},layout:{},lessons:{},tab:'practice',create:{}};
    this.dirty=false;
    window.addEventListener('rach3-language-change',()=> {
      const error=document.getElementById('error');
      if(error.dataset.persistenceMessage&&!error.hidden) error.textContent=window.PianoI18n.message(error.dataset.persistenceMessage);
    });
    this.onError=message=> {
      const error=document.getElementById('error');
      error.dataset.persistenceMessage=message;
      error.textContent=window.PianoI18n.message(message); error.hidden=false;
    };
    try {
      const saved=JSON.parse(localStorage.getItem(this.key));
      if(saved?.version===1) this.data={...this.data,...saved};
    } catch { this.onError('Kayıtlı çalışma durumu okunamadı.'); }
    this.capture=()=>{};
    const flush=()=>{this.capture();this.flush();};
    window.addEventListener('pagehide',flush);
    window.addEventListener('rach3-save-state',flush);
    document.addEventListener('visibilitychange',()=>{if(document.hidden) flush();});
  }

  update(section,value) {
    this.data[section]=value; this.dirty=true;
    clearTimeout(this.pending);
    this.pending=setTimeout(()=>this.flush(),150);
  }

  lesson(key) { return this.data.lessons[key]||{}; }

  saveLesson(key,value) {
    this.data.lessons[key]={...this.lesson(key),...value};
    this.update('lessons',this.data.lessons);
  }

  flush() {
    clearTimeout(this.pending);
    if(!this.dirty) return;
    try { localStorage.setItem(this.key,JSON.stringify(this.data)); this.dirty=false; }
    catch { this.onError('Çalışma durumu kaydedilemedi. Yerel depolamayı kontrol et.'); }
  }

  restoreControls(elements) {
    for(const [id,value] of Object.entries(this.data.controls)) {
      const control=elements[id];
      if(!control) continue;
      if(control.type==='checkbox') control.checked=value===true;
      else if(control.tagName==='SELECT') {
        if([...control.options].some(option=>option.value===value)) control.value=value;
      } else if(control.type==='range'&&Number.isFinite(Number(value))) {
        control.value=String(Math.max(Number(control.min),Math.min(Number(control.max),Number(value))));
      }
    }
  }

  rememberControls(elements,ids) {
    const save=()=>this.update('controls',Object.fromEntries(ids.map(id=>[
      id,elements[id].type==='checkbox'?elements[id].checked:elements[id].value,
    ])));
    for(const id of ids) {
      elements[id].addEventListener('input',save);
      elements[id].addEventListener('change',()=>{save();this.flush();});
    }
  }

}
