"""One app-owned lesson job. JSON events on stdout, diagnostics on stderr."""
import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

EVENTS = sys.stdout
sys.stdout = sys.stderr


def emit(phase, message, progress, **extra):
    print(json.dumps(dict(event='lesson-progress', phase=phase, message=message,
                          progress=progress, **extra), ensure_ascii=False), file=EVENTS, flush=True)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def watch_parent(pid):
    while True:
        time.sleep(1)
        if os.getppid() != pid:
            os.killpg(os.getpgrp(), signal.SIGKILL)


def transcribe(audio_path, models, work):
    import torch
    from rubato import Rubato, protocol
    from rubato.audio import load_audio
    from rubato.convert import read_score
    from rubato.convert.midi import score_notes
    from rubato.convert._perf import perf_events

    emit('notes', 'Piyano notaları çıkarılıyor…', .57)
    model = Rubato.load(str(models/'rubato.ckpt'), device='cpu')
    samples = load_audio(audio_path)
    starts = list(range(0, len(samples), 20*16000))
    if len(starts)>1 and len(samples)-starts[-1]<10*16000:
        starts.pop()
    protocol.W40H20 = dict(chunk_size=40.0, hop_size=40.0,
                          max_generation_timestamp=40.0, merge_start_offset=0.0)
    inputs = [(str(i),samples[start:start+40*16000]) for i,start in enumerate(starts)]
    from notation import rhythm_window
    notes, repairs, rhythm = [], [], []
    with torch.inference_mode():
        for result in model.transcribe(inputs,mode='score',slots=8,enc_batch=2,recover='off'):
            i = int(result['key'])
            start = starts[i]/16000
            boundary = starts[i+1]/16000 if i+1<len(starts) else len(samples)/16000
            score = read_score(result['text'])
            repairs.append(dict(window=i,repairs=score.repairs))
            rhythm.append(rhythm_window(score,start,boundary,raw_text=result['text']))
            for onset,end,pitch,staff in score_notes(score):
                if start+onset<boundary and 21<=pitch<=108 and end>onset:
                    notes.append(dict(midi=pitch,time=start+onset,end=start+end,
                                      hand=0 if staff=='PL' else 1))
            emit('notes', f'Nota bölümleri hazırlanıyor: {len(repairs)}/{len(starts)}',
                 .57+.22*len(repairs)/len(starts))
    if not notes:
        raise ValueError('Bu kayıttan çalınabilir piyano notası çıkarılamadı.')
    emit('expression', 'Basma şiddeti ve pedal tahmin ediliyor…', .81)
    protocol.W40H20 = dict(chunk_size=40.0,hop_size=20.0,
                          max_generation_timestamp=20.0,merge_start_offset=0.0)
    with torch.inference_mode():
        result = list(model.transcribe([str(audio_path)],mode='midi',slots=8,enc_batch=2,recover='off'))[0]
    performance = perf_events(result['text'])
    attacks = [(tick/1000,pitch,velocity) for tick,kind,pitch,velocity in performance
               if kind=='on' and velocity>0]
    candidates = sorted((abs(note['time']-attack[0]),i,j)
                        for i,note in enumerate(notes) for j,attack in enumerate(attacks)
                        if note['midi']==attack[1] and abs(note['time']-attack[0])<=.15)
    matched, used = {}, set()
    for difference,i,j in candidates:
        if i not in matched and j not in used:
            matched[i] = j; used.add(j)
    offset = min(note['time'] for note in notes)
    for i,note in enumerate(notes):
        note['time'] -= offset; note['end'] -= offset; note['soundEnd'] = note['end']
        note['velocity'] = attacks[matched[i]][2]/127 if i in matched else 80/127
        note['velocityEstimated'] = i in matched
    pedals = [dict(time=max(0,tick/1000-offset),value=1 if kind=='ped_on' else 0)
              for tick,kind,pitch,velocity in performance if kind in ('ped_on','ped_off')]
    notes.sort(key=lambda note:(note['time'],note['midi']))
    return notes,pedals,dict(sourceOffsetSeconds=offset,matchedVelocities=len(matched),
                             defaultVelocities=len(notes)-len(matched),scoreParserRepairs=repairs),rhythm


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--parent', type=int)
    args = parser.parse_args()
    if os.getpgrp()!=os.getpid():
        os.setsid()
    if args.parent:
        threading.Thread(target=watch_parent,args=(args.parent,),daemon=True).start()
    request = json.loads((args.job/'request.json').read_text())
    job_id = request['id']
    cache = args.job/'cache'
    for key in ('XDG_CACHE_HOME','MPLCONFIGDIR','NUMBA_CACHE_DIR','TORCH_HOME'):
        os.environ[key] = str(cache/key.lower())
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    started = time.monotonic()
    try:
        from tools_manager import prepare
        args.models = prepare(request, args.tools, emit)
        if request.get('kind') in ('midi','pdf'):
            from score_import import import_score
            source=args.job/request['input']
            lesson=import_score(source,request,args.job,Path(__file__).resolve().parent,emit)
            emit('saving','Ders kaydediliyor…',.98)
            args.library.mkdir(parents=True,exist_ok=True)
            assets=args.library/(job_id+'.assets');assets.mkdir(exist_ok=True)
            shutil.copy2(source,assets/('source.'+request['kind']))
            pending=args.library/(job_id+'.pending')
            pending.write_text(json.dumps(lesson,ensure_ascii=False,separators=(',',':')))
            pending.replace(args.library/(job_id+'.json'))
            emit('complete','Ders hazır',1,id=job_id,noteCount=lesson['noteCount'],title=lesson['title'])
            return 0
        import torch
        import imageio_ffmpeg
        import torch_compat
        torch_compat.install()
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        if torch.backends.mps.is_available():
            torch.mps.set_per_process_memory_fraction(.20)
        ffmpeg = Path(imageio_ffmpeg.get_ffmpeg_exe())
        tools_dir = args.job/'bin'; tools_dir.mkdir(exist_ok=True)
        (tools_dir/'ffmpeg').symlink_to(ffmpeg)
        os.environ['PATH'] = str(tools_dir)+':/usr/bin:/bin'
        source = args.job/request.get('input','input.mp4')
        if request.get('url'):
            emit('download','Video indiriliyor…',.02)
            import yt_dlp
            def download_progress(status):
                total=status.get('total_bytes') or status.get('total_bytes_estimate')
                if total:
                    emit('download','Video indiriliyor…',.02+.08*min(1,status.get('downloaded_bytes',0)/total))
            with yt_dlp.YoutubeDL(dict(format='bestaudio/best',outtmpl=str(args.job/'download.%(ext)s'),
                                      noplaylist=True,quiet=True,ffmpeg_location=str(tools_dir),
                                      cachedir=str(cache/'youtube'),progress_hooks=[download_progress])) as downloader:
                info = downloader.extract_info(request['url'],download=True)
                source = Path(downloader.prepare_filename(info))
                if not request.get('title'): request['title'] = info.get('title','Yeni ders')
        emit('audio','Videonun sesi hazırlanıyor…',.12)
        wav = args.job/'source.wav'
        subprocess.run([str(ffmpeg),'-nostdin','-hide_banner','-loglevel','error','-y','-i',str(source),
                        '-vn','-ar','44100','-ac','2','-c:a','pcm_s16le',str(wav)],check=True)
        audio_sha = digest(wav)
        target = wav
        if request.get('separate',True):
            emit('separation','Vokal ve eşlik ayrılıyor…',.20)
            from audio_separator.separator import Separator
            local_models=args.job/'models'; local_models.mkdir()
            for asset in (args.models/'separation').iterdir():
                if asset.is_file() and not asset.name.endswith('.aria2'):
                    (local_models/asset.name).symlink_to(asset.resolve())
            separator=Separator(model_file_dir=str(local_models),output_dir=str(args.job),
                                output_format='WAV',use_soundfile=True,normalization_threshold=1.0,
                                mdxc_params={'batch_size':1,'overlap':4})
            separator.load_model(model_filename='vocals_mel_band_roformer.ckpt')
            separator.separate(str(wav),{'Vocals':'vocals','Instrumental':'instrumental','Other':'instrumental'})
            target=args.job/'instrumental.wav'
            del separator; gc.collect()
            if torch.backends.mps.is_available(): torch.mps.empty_cache()
        notes,pedals,provenance,rhythm=transcribe(target,args.models,args.job)
        duration=max([note['end'] for note in notes]+[event['time'] for event in pedals])
        description='Sesten otomatik · Rubato · '+('Vokal ayrıldı' if request.get('separate',True) else 'Ham ses')
        if provenance['defaultVelocities']:
            description+=f' · {provenance["defaultVelocities"]} notada şiddet varsayılan'
        description+=' · Şiddet ve pedal model tahminidir'
        lesson=dict(id=job_id,title=request.get('title') or source.stem,
                    description=description,noteCount=len(notes),duration=duration,
                    midiFilename='pianoman-'+job_id+'.mid',
                    tracks=[dict(id=hand,name='Sol el' if hand==0 else 'Sağ el',
                                 notes=[note for note in notes if note['hand']==hand],pedals=pedals)
                            for hand in (0,1)],
                    provenance=dict(**provenance,model='Rubato v1 score + MIDI',
                                    separation=request.get('separate',True),audioSha256=audio_sha,
                                    visualDataUsed=False,durationCorrectionApplied=False,
                                    elapsedSeconds=time.monotonic()-started))
        emit('notation','Partisyon hazırlanıyor…',.96)
        from notation import build_notation
        try:
            lesson['notation']=build_notation(lesson,rhythm,provenance['sourceOffsetSeconds'])
        except Exception as error:
            lesson['notationError']=str(error)
        emit('saving','Ders kaydediliyor…',.98)
        args.library.mkdir(parents=True,exist_ok=True)
        pending=args.library/(job_id+'.pending')
        pending.write_text(json.dumps(lesson,ensure_ascii=False,separators=(',',':')))
        pending.replace(args.library/(job_id+'.json'))
        emit('complete','Ders hazır',1,id=job_id,noteCount=len(notes),title=lesson['title'])
    except BaseException as error:
        import traceback
        traceback.print_exc()
        emit('error',str(error),0)
        return 1
    finally:
        shutil.rmtree(args.job,ignore_errors=True)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
