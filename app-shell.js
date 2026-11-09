import { startLessonCreation } from './create-lesson.js';

// The shell owns navigation. The player owns lesson time; Bluetooth stays mounted.
export function startAppShell({ onTabWillChange, onTabChange, onLesson, onLessonDeleted, workspaceState }) {
  const app = document.getElementById('piano-app');
  const tabs = [...app.querySelectorAll('[role="tab"][data-tab]')];
  const popovers = [...app.querySelectorAll('details[data-popover]')];
  let active = 'practice';
  startWorkspaceLayout(workspaceState);

  function closePopovers(except) {
    for (const popover of popovers) if (popover !== except) popover.open = false;
  }

  function selectTab(tab) {
    const next = tab.dataset.tab;
    if (next === active) return;
    onTabWillChange(next);
    closePopovers();
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
    active = next;
    app.dataset.activeTab = next;
    workspaceState.update('tab',next);
    onTabChange(next);
    window.dispatchEvent(new CustomEvent('rach3-tab-change', { detail: { tab: next } }));
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let target;
      if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') target = tabs[(index + tabs.length - 1) % tabs.length];
      else if (event.key === 'Home') target = tabs[0];
      else if (event.key === 'End') target = tabs[tabs.length - 1];
      else return;
      event.preventDefault(); event.stopPropagation();
      target.focus(); selectTab(target);
    });
  }

  for (const popover of popovers) {
    const summary = popover.querySelector('summary');
    summary.setAttribute('aria-expanded', 'false');
    popover.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(popover.open));
      if (popover.open) closePopovers(popover);
    });
    popover.addEventListener('click', event => {
      if (event.target.closest('[data-close-popover]')) popover.open = false;
    });
  }
  document.addEventListener('pointerdown', event => {
    for (const popover of popovers) if (!popover.contains(event.target)) popover.open = false;
  });
  // A misplaced file should never navigate away from the application. The
  // player and video drop target own importing, and handle only their own input.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = popovers.find(popover => popover.open);
    if (open) { open.open = false; open.querySelector('summary').focus(); event.preventDefault(); }
  });
  app.dataset.activeTab = active;
  selectTab(tabs.find(tab=>tab.dataset.tab===workspaceState.data.tab)||tabs[0]);
  startLessonCreation({
    workspaceState,onLessonDeleted,
    onLesson:lesson=> { onLesson(lesson); selectTab(tabs.find(tab=>tab.dataset.tab==='practice')); },
    onShowCreate:()=>selectTab(tabs.find(tab=>tab.dataset.tab==='create')),
  });
}

// The workspace owns both split sizes; rendering only observes its dimensions.
function startWorkspaceLayout(workspaceState) {
  const { t } = window.PianoI18n;
  const workspace=document.querySelector('.workspace');
  const sheet=document.getElementById('sheet-viewport');
  const viewport=document.getElementById('viewport');
  const keyboard=document.getElementById('keyboard');
  const timeline=workspace.querySelector('.timeline');
  const expand=document.getElementById('sheet-expand');
  const handles={sheet:document.getElementById('sheet-resizer'),keyboard:document.getElementById('keyboard-resizer')};
  const saved=workspaceState.data.layout;
  const sizes={sheet:Number.isFinite(saved.sheet)?saved.sheet:Math.min(390,innerHeight*.35),
    keyboard:Number.isFinite(saved.keyboard)?saved.keyboard:innerHeight<=720?100:126};
  let drag=null,expanded=saved.expanded===true,rendered={...sizes};
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function limits() {
    const timelineHeight=timeline.getBoundingClientRect().height;
    const horizontalBar=viewport.offsetHeight-viewport.clientHeight;
    const available=workspace.clientHeight-timelineHeight-horizontalBar-22;
    return {available,sheetMin:Math.min(80,Math.max(0,available-144)),keyMin:64,rollMin:80};
  }
  function apply() {
    if(!workspace.clientHeight) return;
    const {available,sheetMin,keyMin,rollMin}=limits();
    rendered.keyboard=clamp(sizes.keyboard,keyMin,Math.max(keyMin,available-sheetMin-rollMin));
    const sheetMax=Math.max(sheetMin,available-rendered.keyboard-rollMin);
    rendered.sheet=expanded?sheetMax:clamp(sizes.sheet,sheetMin,sheetMax);
    workspace.style.setProperty('--sheet-height',rendered.sheet+'px');
    workspace.style.setProperty('--keyboard-height',rendered.keyboard+'px');
    for(const [name,handle] of Object.entries(handles)) {
      const min=name==='sheet'?sheetMin:keyMin;
      const max=name==='sheet'?sheetMax:Math.max(keyMin,available-rendered.sheet-rollMin);
      handle.setAttribute('aria-valuemin',String(Math.round(min)));
      handle.setAttribute('aria-valuemax',String(Math.round(max)));
      handle.setAttribute('aria-valuenow',String(Math.round(rendered[name])));
      handle.setAttribute('aria-valuetext',t('{count} piksel',{count:Math.round(rendered[name])}));
    }
    expand.textContent=t(expanded?'Küçült':'Büyüt');
    expand.setAttribute('aria-expanded',String(expanded));
  }
  function save() { workspaceState.update('layout',{...sizes,expanded}); workspaceState.flush(); }
  function change(name,value) {
    if(expanded) sizes.sheet=rendered.sheet;
    expanded=false;
    const {available,sheetMin,keyMin,rollMin}=limits();
    sizes[name]=name==='sheet'?clamp(value,sheetMin,available-rendered.keyboard-rollMin):
      clamp(value,keyMin,available-rendered.sheet-rollMin);
    apply(); workspaceState.update('layout',{...sizes,expanded});
  }
  function finish(event) {
    if(!drag || (event.pointerId!==undefined && event.pointerId!==drag.pointer)) return;
    const {handle,pointer}=drag; drag=null;
    handle.classList.remove('resizing'); document.body.classList.remove('resizing-workspace');
    if(handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    save();
  }
  for(const [name,handle] of Object.entries(handles)) {
    handle.addEventListener('pointerdown',event=> {
      if(event.button!==0 || drag) return;
      event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
      drag={name,handle,pointer:event.pointerId,y:event.clientY,size:(name==='sheet'?sheet:keyboard).getBoundingClientRect().height};
      handle.classList.add('resizing'); document.body.classList.add('resizing-workspace');
    });
    handle.addEventListener('pointermove',event=> {
      if(!drag || event.pointerId!==drag.pointer) return;
      change(name,drag.size+(event.clientY-drag.y)*(name==='sheet'?1:-1));
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(type,finish);
    handle.addEventListener('keydown',event=> {
      let value;
      if(event.key==='ArrowUp'||event.key==='ArrowDown')
        value=rendered[name]+(event.key==='ArrowDown'?1:-1)*(name==='sheet'?1:-1)*(event.shiftKey?40:12);
      else if(event.key==='Home') value=Number(handle.getAttribute('aria-valuemin'));
      else if(event.key==='End') value=Number(handle.getAttribute('aria-valuemax'));
      else return;
      event.preventDefault(); event.stopPropagation(); change(name,value); save();
    });
    handle.addEventListener('dblclick',()=>{change(name,name==='sheet'?Math.min(390,innerHeight*.35):126);save();});
  }
  window.addEventListener('blur',finish);
  expand.addEventListener('click',()=> {
    expanded=!expanded;
    apply();save();
  });
  window.addEventListener('rach3-language-change',apply);
  const layoutObserver=new ResizeObserver(apply);
  layoutObserver.observe(workspace);
  layoutObserver.observe(timeline);
  apply();
}
