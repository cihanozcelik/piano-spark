// Verovio engraves MusicXML; the player remains the only playback clock.
export class SheetMusic {
  constructor({onViewChange=()=>{},onSegmentsChange=()=>{}}={}) {
    this.onViewChange=onViewChange;
    this.onSegmentsChange=onSegmentsChange;
    this.segments=[]; this.segmentSignature='';
    this.statusSource=''; this.progressSource='';
    window.addEventListener('pianoman-language-change',()=>this.renderLanguage());
    this.viewport=document.getElementById('sheet-viewport');
    this.paper=document.getElementById('sheet-paper');
    this.status=document.getElementById('sheet-status');
    this.loading=document.getElementById('sheet-loading');
    this.loadingText=document.getElementById('sheet-loading-text');
    this.progress=document.getElementById('sheet-progress');
    this.pageLabel=document.getElementById('sheet-page');
    this.previous=document.getElementById('sheet-previous');
    this.next=document.getElementById('sheet-next');
    this.generation=0; this.page=0; this.currentMeasure=-1; this.seconds=-2; this.running=false;
    this.resizeObserver=new ResizeObserver(()=>{this.measureGeometry();this.paintPosition();});
    this.resizeObserver.observe(this.paper);
    this.previous.addEventListener('click',()=>this.showPage(this.page-1));
    this.next.addEventListener('click',()=>this.showPage(this.page+1));
    this.viewport.addEventListener('scroll',()=>{if(!this.restoring) this.onViewChange();},{passive:true});
    window.addEventListener('pagehide',()=>this.cancelEngraving?.());

  }

  renderLanguage() {
    this.loadingText.textContent=window.PianoI18n.message(this.progressSource);
    const translated=window.PianoI18n.message(this.statusSource);
    this.status.textContent=translated!==this.statusSource?translated:this.statusSource.split(' · ').map(text=>window.PianoI18n.message(text)).join(' · ');
    this.renderMastery();
  }

  setProgress(message,value=null,max=1) {
    this.progressSource=this.statusSource=message;this.renderLanguage();
    this.loading.hidden=false; this.progress.hidden=false;
    this.viewport.setAttribute('aria-busy','true');
    this.progress.max=max;
    if(value===null) this.progress.removeAttribute('value');
    else this.progress.value=value;
  }

  async engrave(xml,generation) {
    this.runtimeSource ||= window.PianoNotationRuntime!==undefined?
      Promise.resolve(window.PianoNotationRuntime):fetch('/assets/notation/verovio-toolkit-wasm.js').then(response=> {
        if(!response.ok) throw new Error('Nota yazım motoru yüklenemedi.');
        return response.text();
      }).catch(error=>{this.runtimeSource=null;throw error;});
    const source=await this.runtimeSource;
    if(generation!==this.generation) return null;
    const url=URL.createObjectURL(new Blob([source,'\n(',engraveSheetWorker.toString(),')();'],{type:'text/javascript'}));
    return new Promise((resolve,reject)=> {
      let worker;
      const release=()=>{worker?.terminate();URL.revokeObjectURL(url);this.cancelEngraving=null;};
      const fail=error=>{release();reject(error);};
      try {worker=new Worker(url);} catch(error) {fail(error);return;}
      this.cancelEngraving=()=>fail(new DOMException('Ders değiştirildi.','AbortError'));
      worker.onerror=event=>fail(new Error(event.message||'Nota yazım motoru durdu.'));
      worker.onmessage=({data})=> {
        if(data.type==='progress') this.setProgress(data.message,data.value,data.max);
        else if(data.type==='error') fail(new Error(data.message));
        else if(data.type==='complete') {release();resolve(data.result);}
      };
      worker.postMessage({xml});
    });
  }

  viewState() {
    if(this.restoring) return this.savedView;
    return {page:this.page,top:this.viewport.scrollTop,left:this.viewport.scrollLeft};
  }

  async load(lesson,savedView={}) {
    this.savedView=savedView; this.restoring=true;
    const generation=++this.generation;
    this.cancelEngraving?.();
    this.notation=null; this.currentMeasure=-1; this.page=0;
    this.mastery=null; this.paper.classList.remove('has-mastery');
    this.geometry=null; this.cursor=null; this.pages=new Map();
    this.previous.disabled=this.next.disabled=true; this.pageLabel.textContent='';
    this.paper.replaceChildren(); this.paper.hidden=true; this.viewport.scrollTop=0;
    this.publishSegments({status:'loading',segments:[],signature:''});
    if(!lesson?.notation) {
      const message=lesson?.notationError?'Partisyon oluşturulamadı: '+lesson.notationError:
        'Bu kaynakta partisyon verisi bulunmuyor.';
      this.setProgress(message); this.progress.hidden=true;
      this.viewport.setAttribute('aria-busy','false');
      this.publishSegments({status:lesson?.notationError?'error':'unavailable',segments:[],signature:''});
      return;
    }
    this.setProgress('Nota yazım motoru hazırlanıyor…');
    try {
      const result=await this.engrave(lesson.notation.musicxml,generation);
      if(generation!==this.generation || !result) return;
      this.notation=lesson.notation;
      const mei=new DOMParser().parseFromString(result.mei,'application/xml');
      this.measureIDs=[...mei.getElementsByTagName('measure')].map(node=>node.getAttribute('xml:id'));
      this.pageForMeasure=result.pageForMeasure;
      this.pageCount=result.pages.length;
      this.pages=new Map(result.pages.map((svg,index)=>[index+1,svg]));
      const segmentState=this.prepareSegments(result.pages);
      this.prepareTimeline(result.timeline);
      this.statusSource=lesson.provenance?.sourceKind==='pdf'?
        'PDF okuma (deneme) · '+(lesson.provenance.warnings||['Nota ve ritim hataları olabilir']).join(' · '):
        lesson.provenance?.sourceKind==='midi'?'MIDI’den oluşturulan partisyon':
        'Otomatik partisyon · ritim, pedal ve nüans tahmini';
      this.renderLanguage();
      this.loading.hidden=true; this.viewport.setAttribute('aria-busy','false');
      this.paper.hidden=false;
      this.showPage(Math.max(1,Math.min(this.pageCount,savedView.page||1)));
      this.follow(this.seconds,this.running,!savedView.page);
      this.publishSegments(segmentState);
      requestAnimationFrame(()=> {
        if(generation!==this.generation) return;
        if(savedView.page) {
          this.viewport.scrollTop=savedView.top||0;
          this.viewport.scrollLeft=savedView.left||0;
        }
        this.restoring=false;
      });
    } catch(error) {
      if(generation!==this.generation) return;
      this.notation=null; this.geometry=null; this.paper.hidden=true;
      this.previous.disabled=this.next.disabled=true;
      this.setProgress('Partisyon açılamadı: '+error.message); this.progress.hidden=true;
      this.viewport.setAttribute('aria-busy','false');
      this.publishSegments({status:'error',segments:[],signature:''});
    }
  }

  publishSegments(state) {
    this.segments=state.segments; this.segmentSignature=state.signature;
    this.onSegmentsChange(state);
  }

  prepareSegments(pages) {
    const unavailable={status:'unavailable',segments:[],signature:''};
    const measures=this.notation.measures;
    const indices=new Map(this.measureIDs.map((id,index)=>[id,index]));
    if(!measures.length || this.measureIDs.length!==measures.length ||
      indices.size!==measures.length || this.measureIDs.some(id=>!id)) return unavailable;
    const segments=[];
    let nextMeasure=0;
    for(let page=0;page<pages.length;page++) {
      const svg=new DOMParser().parseFromString(pages[page],'image/svg+xml');
      if(svg.querySelector('parsererror')) return unavailable;
      for(const system of svg.querySelectorAll('.system')) {
        const row=[...system.querySelectorAll('.measure')].map(node=>indices.get(node.id));
        if(!row.length) continue;
        // Every measure must occur once, in score order, across all pages.
        for(const index of row) {
          if(index!==nextMeasure) return unavailable;
          nextMeasure++;
        }
        const firstMeasure=row[0],lastMeasure=row.at(-1);
        const start=measures[firstMeasure].start,end=measures[lastMeasure].end;
        if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start) return unavailable;
        segments.push({id:'m'+firstMeasure+'-'+lastMeasure,index:segments.length,
          page:page+1,firstMeasure,lastMeasure,start,end});
      }
    }
    if(nextMeasure!==measures.length) return unavailable;
    // XML IDs generated by Verovio are deliberately excluded from identity.
    // Fixed engraving dimensions make these ranges independent of window size.
    let hash=2166136261;
    for(const source of [this.notation.musicxml,JSON.stringify(segments)]) {
      for(let i=0;i<source.length;i++) hash=Math.imul(hash^source.charCodeAt(i),16777619);
    }
    return {status:'ready',segments,signature:'rows-v1-'+(hash>>>0).toString(16)};
  }

  prepareTimeline(entries) {
    const measures=this.notation.measures;
    const secondsAt=quarter=> {
      let index=0;
      while(index+1<measures.length && measures[index+1].quarter<=quarter) index++;
      const measure=measures[index], local=quarter-measure.quarter;
      const anchors=measure.anchors;
      let at=0;
      while(at+2<anchors.length && anchors[at+1][0]<=local) at++;
      const [q0,t0]=anchors[at], [q1,t1]=anchors[at+1];
      return t0+(t1-t0)*Math.max(0,Math.min(1,(local-q0)/(q1-q0)));
    };
    const active=new Set();
    this.timeline=entries.map(entry=> {
      for(const id of entry.off||[]) active.delete(id);
      for(const id of entry.on||[]) active.add(id);
      return {time:secondsAt(entry.qstamp), quarter:entry.qstamp,
        on:[...(entry.on||[]),...(entry.restsOn||[])], active:[...active]};
    });
    this.highlighted=new Set();
  }

  showPage(page) {
    if(!this.notation || page<1 || page>this.pageCount) return;
    this.paper.innerHTML=this.pages.get(page); this.page=page;
    this.cursor=document.createElement('div'); this.cursor.className='sheet-playhead';
    this.cursor.setAttribute('aria-hidden','true'); this.paper.append(this.cursor);
    this.highlighted=new Set();
    this.viewport.scrollTop=0;
    this.pageLabel.textContent=page+' / '+this.pageCount;
    this.previous.disabled=page===1; this.next.disabled=page===this.pageCount;
    this.measureGeometry(); this.paintPosition();
    if(!this.restoring) this.onViewChange();
  }

  setMastery(mastery) {
    if(this.mastery===mastery) return;
    this.mastery=mastery;
    this.paper.classList.toggle('has-mastery',!!mastery);
    this.measureGeometry();
    this.paintPosition();
  }

  renderMastery() {
    this.masteryLayer?.remove();
    if(!this.mastery||!this.notation||!this.elements) return;
    const t=(source,params)=>window.PianoI18n.t(source,params);
    const paper=this.paper.getBoundingClientRect();
    const layer=document.createElement('div');layer.className='sheet-mastery-layer';
    for(const row of this.mastery.rows) {
      if(row.page!==this.page) continue;
      const system=this.elements.get(this.measureIDs[row.firstMeasure])?.closest('.system');
      if(!system) continue;
      const bounds=system.getBoundingClientRect();
      const badge=document.createElement('div');badge.className='sheet-row-mastery';
      badge.dataset.status=row.status;badge.classList.toggle('is-current',row.active);
      badge.style.top=(bounds.top-paper.top)+'px';
      const label=t('Satır {row}',{row:row.row});
      const status=t({waiting:'Bekliyor',learning:'Çalışılıyor',learned:'Öğrenildi',empty:'Nota yok'}[row.status]);
      const details=row.status==='empty'?label+' · '+status:label+' · '+t('Satır öğrenimi %{percent}',{percent:row.percent})+' · '+status+' · '+
        t('Temiz tekrar {count}/{target}',{count:row.passes,target:row.target});
      badge.setAttribute('role','group');badge.setAttribute('aria-label',details);badge.title=details;
      for(const [tag,text] of [['span',label],['strong',row.percent===null?'—':t('%{percent}',{percent:row.percent})],['small',(row.status==='learned'?'✓ ':'')+status]]) {
        const node=document.createElement(tag);node.textContent=text;badge.append(node);
      }
      const meter=document.createElement('progress');meter.max=100;meter.value=row.percent||0;meter.hidden=row.percent===null;
      meter.setAttribute('aria-label',label);badge.append(meter);layer.append(badge);
      const rail=document.createElement('div');rail.className='sheet-row-mastery-rail';
      rail.dataset.status=row.status;rail.classList.toggle('is-current',row.active);
      rail.style.top=(bounds.top-paper.top)+'px';rail.style.height=bounds.height+'px';
      rail.setAttribute('aria-hidden','true');layer.append(rail);
    }
    this.masteryLayer=layer;this.paper.append(layer);
  }

  measureGeometry() {
    if(!this.notation || !this.page) return;
    const paper=this.paper.getBoundingClientRect();
    this.elements=new Map([...this.paper.querySelectorAll('[id]')].map(element=>[element.id,element]));
    this.geometry=new Map();
    for(let index=0;index<this.measureIDs.length;index++) {
      const element=this.elements.get(this.measureIDs[index]);
      if(!element) continue;
      const rect=element.getBoundingClientRect();
      const staves=[...element.querySelectorAll('.staff')].map(staff=>staff.getBoundingClientRect());
      const top=(staves.length?Math.min(...staves.map(box=>box.top)):rect.top)-paper.top;
      const bottom=(staves.length?Math.max(...staves.map(box=>box.bottom)):rect.bottom)-paper.top;
      const measure=this.notation.measures[index], anchors=[];
      for(const entry of this.timeline) {
        if(entry.quarter<measure.quarter || entry.quarter>=measure.quarter+measure.length) continue;
        const heads=entry.on.map(id=>this.elements.get(id)).filter(node=>node && element.contains(node))
          .map(node=>(node.querySelector('.notehead')||node).getBoundingClientRect());
        if(heads.length) anchors.push({time:entry.time,x:Math.min(...heads.map(box=>box.left+box.width/2))-paper.left});
      }
      if(!anchors.length || anchors[0].time>measure.start) anchors.unshift({time:measure.start,x:rect.left-paper.left+8});
      anchors.push({time:measure.end,x:rect.right-paper.left-2});
      this.geometry.set(index,{top:top-7,height:bottom-top+14,anchors,element});
    }
    this.renderMastery();
  }

  paintPosition() {
    if(!this.geometry || !this.cursor) return;
    let lo=0,hi=this.timeline.length;
    while(lo<hi) {const mid=(lo+hi)>>>1;if(this.timeline[mid].time<=this.seconds) lo=mid+1;else hi=mid;}
    const active=new Set(lo?this.timeline[lo-1].active:[]);
    for(const id of this.highlighted) if(!active.has(id)) this.elements.get(id)?.classList.remove('sheet-note-active');
    for(const id of active) if(!this.highlighted.has(id)) this.elements.get(id)?.classList.add('sheet-note-active');
    this.highlighted=active;
    const geometry=this.geometry.get(this.currentMeasure);
    this.cursor.hidden=!geometry || this.seconds<0 || this.seconds>this.notation.measures.at(-1).end;
    if(this.cursor.hidden) return;
    const anchors=geometry.anchors;
    let at=0;
    while(at+2<anchors.length && anchors[at+1].time<=this.seconds) at++;
    const first=anchors[at],last=anchors[at+1];
    const ratio=last.time===first.time?1:Math.max(0,Math.min(1,(this.seconds-first.time)/(last.time-first.time)));
    const x=first.x+(last.x-first.x)*ratio;
    this.cursor.style.transform='translate('+x+'px,'+geometry.top+'px)';
    this.cursor.style.height=geometry.height+'px';
  }

  follow(seconds,running,force=false) {
    const resumed=running&&!this.running;
    this.seconds=seconds; this.running=running;
    if(!this.notation) return;
    const measures=this.notation.measures;
    let lo=0,hi=measures.length;
    while(lo<hi) {const mid=(lo+hi)>>>1;if(measures[mid].start<=seconds) lo=mid+1;else hi=mid;}
    const index=Math.max(0,lo-1),changed=index!==this.currentMeasure;
    this.currentMeasure=index;
    if((running && (changed||resumed)) || force) {
      const id=this.measureIDs[index];
      const page=this.pageForMeasure[id];
      if(page!==this.page) this.showPage(page);
      const measure=this.elements.get(id);
      if(measure) {
        const system=measure.closest('.system')||measure;
        const target=system.getBoundingClientRect(),view=this.viewport.getBoundingClientRect();
        if(target.top<view.top+18 || target.bottom>view.bottom-18)
          this.viewport.scrollTo({top:this.viewport.scrollTop+target.top-view.top-24,behavior:force?'instant':'smooth'});
      }
    }
    this.paintPosition();
  }
}

// This function runs in a dedicated Worker alongside the locally bundled WASM.
// Each progress event marks completed work; engraving never owns the player clock.
function engraveSheetWorker() {
  self.onmessage=async({data})=> {
    let toolkit;
    const progress=(message,value,max)=>self.postMessage({type:'progress',message,value,max});
    try {
      const library=await self.PianoNotationReady;
      progress('Ölçüler ve sesler yerleştiriliyor…',null,1);
      toolkit=new library.toolkit();
      toolkit.setOptions({inputFrom:'musicxml',pageWidth:2100,pageHeight:2970,
        scale:40,pageMarginTop:75,pageMarginBottom:75,pageMarginLeft:75,pageMarginRight:75,
        header:'none',footer:'auto',breaks:'auto',adjustPageHeight:false,
        font:'Leipzig',mnumInterval:1,pedalStyle:'line',svgViewBox:true});
      if(!toolkit.loadData(data.xml)) throw new Error('Nota verisi okunamadı.');
      const count=toolkit.getPageCount();
      progress('Nota zamanları eşleniyor…',2,count+3);
      const mei=toolkit.getMEI();
      const timeline=toolkit.renderToTimemap({includeMeasures:true,includeRests:true});
      const pageForMeasure={};
      for(const match of mei.matchAll(/<measure\b[^>]*\bxml:id="([^"]+)"/g))
        pageForMeasure[match[1]]=toolkit.getPageWithElement(match[1]);
      const pages=[];
      for(let page=1;page<=count;page++) {
        pages.push(toolkit.renderToSVG(page));
        progress('Nota sayfaları çiziliyor · '+page+' / '+count,page+3,count+3);
      }
      self.postMessage({type:'complete',result:{mei,timeline,pageForMeasure,pages}});
    } catch(error) {
      self.postMessage({type:'error',message:error.message||String(error)});
    } finally {toolkit?.destroy();}
  };
}
