"""Refresh the immutable tool catalogs from the pinned development environments.

Run with the separation Python. This fetches package metadata, never models.
The committed catalogs are the runtime contract; end users never resolve versions.
Apple Silicon reads lesson-engine/tools.json, Intel Macs read tools-x86_64.json
and Windows reads tools-win_amd64.json. The Intel environments come from
desktop/prepare_intel_lock.py and the Windows ones from windows/prepare_lock.py.
Pass target names (arm64, x86_64, win_amd64) to refresh only those catalogs.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from importlib.metadata import distributions
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

from packaging.requirements import Requirement
from packaging.tags import cpython_tags, compatible_tags, mac_platforms
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT/'lesson-engine'
TARGETS = {
    'arm64': dict(catalog='tools.json', sites={
        'audio': ROOT/'transcription/separation/.venv/lib/python3.12/site-packages',
        'pdf': ROOT/'build/omr/.venv/lib/python3.12/site-packages'}),
    'x86_64': dict(catalog='tools-x86_64.json', sites={
        'audio': ROOT/'build/lock-x86_64/audio/.venv/lib/python3.12/site-packages',
        'pdf': ROOT/'build/lock-x86_64/pdf/.venv/lib/python3.12/site-packages'}),
    # Windows wheels are installed for their metadata only; they never run here.
    'win_amd64': dict(catalog='tools-win_amd64.json', sites={
        'audio': ROOT/'build/lock-win/audio/site',
        'pdf': ROOT/'build/lock-win/pdf/site'}),
}
MARKERS = {
    'arm64': dict(sys_platform='darwin', platform_system='Darwin', platform_machine='arm64', os_name='posix'),
    'x86_64': dict(sys_platform='darwin', platform_system='Darwin', platform_machine='x86_64', os_name='posix'),
    'win_amd64': dict(sys_platform='win32', platform_system='Windows', platform_machine='AMD64', os_name='nt'),
}
VENDORED = {'rubato-transcription', 'diffq'}


def lock(arch):
    sites=TARGETS[arch]['sites']
    env=dict(python_version='3.12', python_full_version='3.12.12', implementation_name='cpython',
             implementation_version='3.12.12', extra='', **MARKERS[arch])
    platforms=['win_amd64'] if arch=='win_amd64' else list(mac_platforms((14, 0), arch))
    tags=list(cpython_tags((3,12),platforms=platforms))+list(compatible_tags((3,12),'cp312',platforms))
    rank={tag:i for i,tag in enumerate(tags)}
    # The vendored distributions are not in the Windows folders; read them here.
    extra=[str(ENGINE/'vendor')] if arch=='win_amd64' else []
    envs={key:{canonicalize_name(d.metadata['Name']):d for d in distributions(path=[str(path),*extra])}
          for key,path in sites.items()}
    selected={}
    def closure(name_env, roots):
        result=set()
        def visit(name):
            name=canonicalize_name(name)
            dist=envs[name_env][name]
            key=f'{name}-{dist.version}'
            if key in result:return
            result.add(key)
            selected[key]=(name,dist)
            for raw in dist.requires or []:
                req=Requirement(raw)
                if not req.marker or req.marker.evaluate(env):visit(req.name)
        for name in roots:visit(name)
        return sorted(result)
    groups={
        'notation':closure('audio',['music21','mido']),
        'transcription':closure('audio',['rubato-transcription','soundfile','scipy','imageio-ffmpeg']),
        'youtube':closure('audio',['yt-dlp']),
        # audio-separator imports audioread but no longer declares it, and
        # librosa 1.0 dropped it, so it must be a root of this closure.
        'separation':closure('audio',['audio-separator','onnxruntime','audioread']),
        'pdf':closure('pdf',['homr','pypdfium2']),
    }
    def package(item):
        key,(name,dist)=item
        if name in VENDORED:
            # Rubato is pure Python and shared. Windows needs no vendored
            # diffq: audio-separator depends on the diffq-fixed wheel there.
            if arch=='win_amd64':return key,None
            vendor=ENGINE/'vendor'
            for file in dist.files or []:
                if '..' in file.parts or file.suffix=='.pyc' or file.name in ('direct_url.json','RECORD','INSTALLER','REQUESTED','uv_build.json'):continue
                src=Path(dist.locate_file(file))
                if not src.is_file():continue
                dst=vendor/file
                if arch=='arm64':
                    dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
                elif file.suffix=='.so':
                    # Vendored native code is shared by both runtimes: one universal binary.
                    subprocess.run(['xcrun','lipo','-create',str(dst),str(src),'-output',str(dst)],check=True)
                elif file.suffix=='.py' and src.read_bytes()!=dst.read_bytes():
                    raise RuntimeError(f'Vendored source differs between architectures: {file}')
            return key,None
        data=json.load(urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{dist.version}/json',timeout=30))
        choices=[]
        for wheel in data['urls']:
            if wheel['packagetype']!='bdist_wheel':continue
            compatible=parse_wheel_filename(wheel['filename'])[3]&rank.keys()
            if compatible:choices.append((min(rank[t] for t in compatible),wheel))
        if not choices:raise RuntimeError(f'No {arch} Python 3.12 wheel: {key}')
        wheel=min(choices,key=lambda p:p[0])[1]
        return key,dict(kind='wheel',name=wheel['filename'],url=wheel['url'],
                        sha256=wheel['digests']['sha256'],size=wheel['size'])
    with ThreadPoolExecutor(max_workers=8) as pool:artifacts=dict(pool.map(package,selected.items()))
    artifacts={k:v for k,v in artifacts.items() if v}
    groups={k:[i for i in v if i in artifacts] for k,v in groups.items()}
    # Model entries are separately reviewed: URLs, sizes, hashes and install paths.
    models=json.loads((ENGINE/'tool-models.json').read_text())
    for key,value in models['artifacts'].items():artifacts[key]=value
    for group,ids in models['groups'].items():groups[group]+=ids
    catalog=dict(schema=1,artifacts=dict(sorted(artifacts.items())),groups=groups)
    (ENGINE/TARGETS[arch]['catalog']).write_text(json.dumps(catalog,indent=2)+'\n')
    print(arch,{key:round(sum(artifacts[i]['size'] for i in ids)/1e6,1) for key,ids in groups.items()})


def main():
    selected=sys.argv[1:] or list(TARGETS)
    for arch in selected:lock(arch)
    for binary in (ENGINE/'vendor').rglob('*.so') if 'x86_64' in selected else ():
        subprocess.run(['xcrun','strip','-S',str(binary)],check=True)
        architectures=subprocess.run(['xcrun','lipo','-archs',str(binary)],check=True,capture_output=True,text=True).stdout.split()
        if sorted(architectures)!=['arm64','x86_64']:raise RuntimeError(f'{binary} is not universal: {architectures}')
    # TLS trust is available before the first package download.
    shutil.copy2(TARGETS['arm64']['sites']['audio']/'certifi/cacert.pem',ENGINE/'cacert.pem')


if __name__=='__main__':main()
