// The player owns lesson time; the connected native BLE owner schedules output.
export class PianoOutput {
  constructor(onError) {
    this.onError=onError;this.connected=false;this.capable=false;this.session=null;
    this.queue=Promise.resolve();this.heartbeat=null;this.pinging=false;
    window.addEventListener('pianoman-bluetooth-status',({detail})=> {
      this.connected=detail.connected;
      // Existing Objective-C senders box a C comparison as NSNumber(0/1).
      // Accept that wire representation as well as JSON booleans during a live connection.
      this.capable=detail.output_capable===true||detail.output_capable===1;
      if(this.session&&!this.connected) this.fail('Piyano bağlantısı kesildi; çalma durduruldu.');
      this.onStatus?.();
    });
    window.addEventListener('pianoman-output-error',({detail})=> {
      if(this.session) this.fail(detail.message);
    });
  }

  command(request) {
    const perform=async()=> {
      const native=window.webkit?.messageHandlers?.pianoman;
      if(native) return native.postMessage(request);
      const response=await fetch('/api/bluetooth/output',{
        method:'POST',headers:{'Content-Type':'application/json','X-PianoMan':'1'},
        body:JSON.stringify(request),keepalive:request.command!=='output-start',
      });
      const result=await response.json();
      if(!response.ok||result.error) throw new Error(result.error||'Piyano MIDI gönderimi başarısız.');
      return result;
    };
    const result=this.queue.then(perform);
    this.queue=result.catch(()=>{});
    return result;
  }

  async start(tracks,position,speed,duration) {
    if(!this.connected) throw new Error('CLP’den dinlemek için önce piyanoyu bağla.');
    if(!this.capable) throw new Error('Piyano bağlantısında MIDI gönderimi hazır değil; yeniden bağlan.');
    const events=[],pedals=tracks.flatMap(track=>track.pedals||[]);
    const pedalTimes=[...new Set([position,...pedals.filter(event=>event.time>position).map(event=>event.time)])].sort((a,b)=>a-b);
    let previous=-1;
    for(const time of pedalTimes) {
      const values=tracks.map(track=> {
        let value=0;for(const event of track.pedals||[]) {if(event.time>time) break;value=event.value;}
        return value;
      });
      const value=Math.round(Math.max(0,...values)*127);
      if(value===previous) continue;previous=value;
      for(let channel=0;channel<2;channel++) events.push([(time-position)/speed,0xB0|channel,64,value]);
    }
    for(const track of tracks) for(const note of track.notes) {
      if(note.soundEnd<=position) continue;
      const channel=note.hand===0||note.hand===1?note.hand:(note.midi<60?0:1);
      const at=Math.max(0,(note.time-position)/speed);
      // Seeking into a sustained note rearticulates it once, then releases its key.
      const end=Math.max(at+.001,(note.end-position)/speed);
      events.push([at,0x90|channel,note.midi,Math.max(1,Math.min(127,Math.round(note.velocity*127)))]);
      events.push([end,0x80|channel,note.midi,0]);
    }
    const priority=event=>(event[1]&0xF0)===0xB0?0:(event[1]&0xF0)===0x80?1:2;
    events.sort((a,b)=>a[0]-b[0]||priority(a)-priority(b));
    const session=crypto.randomUUID();this.session=session;
    try {
      const reply=await this.command({command:'output-start',session,events,
        duration:Math.max(0,(duration+.4-position)/speed,events.at(-1)?.[0]||0)});
      if(this.session===session) {
        this.heartbeat=setInterval(async()=> {
          if(this.pinging||this.session!==session) return;
          this.pinging=true;
          try {await this.command({command:'output-heartbeat',session});}
          catch(error) {if(this.session===session) this.fail(error.message);}
          finally {this.pinging=false;}
        },500);
      }
      return reply.start_unix_ms;
    } catch(error) {
      if(this.session===session) this.stop();
      throw error;
    }
  }

  stop() {
    const session=this.session;this.session=null;
    clearInterval(this.heartbeat);this.heartbeat=null;
    if(session) this.command({command:'output-stop',session}).catch(error=> {
      if(this.connected) this.onError(error.message);
    });
  }

  fail(message) { this.stop();this.onError(message); }
}
