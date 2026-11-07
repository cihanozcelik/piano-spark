"""Refresh the immutable tool catalog from the two pinned development environments.

Run with the separation Python. This fetches package metadata, never models.
The committed catalog is the runtime contract; end users never resolve versions.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from importlib.metadata import distributions
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

from packaging.requirements import Requirement
from packaging.tags import cpython_tags, compatible_tags, mac_platforms
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT/'lesson-engine'
SITES = {
    'audio': ROOT/'transcription/separation/.venv/lib/python3.12/site-packages',
    'pdf': ROOT/'build/omr/.venv/lib/python3.12/site-packages',
}
VENDORED = {'rubato-transcription', 'diffq'}
ENV = dict(python_version='3.12', python_full_version='3.12.12', sys_platform='darwin',
           platform_system='Darwin', platform_machine='arm64', implementation_name='cpython',
           implementation_version='3.12.12', os_name='posix', extra='')


def main():
    platforms=list(mac_platforms((14, 0), 'arm64'))
    tags=list(cpython_tags((3,12),platforms=platforms))+list(compatible_tags((3,12),'cp312',platforms))
    rank={tag:i for i,tag in enumerate(tags)}
    envs={key:{canonicalize_name(d.metadata['Name']):d for d in distributions(path=[str(path)])}
          for key,path in SITES.items()}
    selected={}
    def closure(env, roots):
        result=set()
        def visit(name):
            name=canonicalize_name(name)
            dist=envs[env][name]
            key=f'{name}-{dist.version}'
            if key in result:return
            result.add(key)
            selected[key]=(name,dist)
            for raw in dist.requires or []:
                req=Requirement(raw)
                if not req.marker or req.marker.evaluate(ENV):visit(req.name)
        for name in roots:visit(name)
        return sorted(result)
    groups={
        'notation':closure('audio',['music21','mido']),
        'transcription':closure('audio',['rubato-transcription','soundfile','scipy','imageio-ffmpeg']),
        'youtube':closure('audio',['yt-dlp']),
        'separation':closure('audio',['audio-separator','onnxruntime']),
        'pdf':closure('pdf',['homr','pypdfium2']),
    }
    def package(item):
        key,(name,dist)=item
        if name in VENDORED:
            vendor=ENGINE/'vendor'
            for file in dist.files or []:
                if '..' in file.parts or file.suffix=='.pyc' or file.name in ('direct_url.json','RECORD','INSTALLER','REQUESTED','uv_build.json'):continue
                src=Path(dist.locate_file(file))
                if not src.is_file():continue
                dst=vendor/file;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
            return key,None
        data=json.load(urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{dist.version}/json',timeout=30))
        choices=[]
        for wheel in data['urls']:
            if wheel['packagetype']!='bdist_wheel':continue
            compatible=parse_wheel_filename(wheel['filename'])[3]&rank.keys()
            if compatible:choices.append((min(rank[t] for t in compatible),wheel))
        if not choices:raise RuntimeError(f'No macOS 14 ARM64 Python 3.12 wheel: {key}')
        wheel=min(choices,key=lambda p:p[0])[1]
        return key,dict(kind='wheel',name=wheel['filename'],url=wheel['url'],
                        sha256=wheel['digests']['sha256'],size=wheel['size'])
    with ThreadPoolExecutor(max_workers=8) as pool:artifacts=dict(pool.map(package,selected.items()))
    for binary in (ENGINE/'vendor').rglob('*.so'):
        subprocess.run(['xcrun','strip','-S',str(binary)],check=True)
    artifacts={k:v for k,v in artifacts.items() if v}
    groups={k:[i for i in v if i in artifacts] for k,v in groups.items()}
    # Model entries are separately reviewed: URLs, sizes, hashes and install paths.
    models=json.loads((ENGINE/'tool-models.json').read_text())
    for key,value in models['artifacts'].items():artifacts[key]=value
    for group,ids in models['groups'].items():groups[group]+=ids
    catalog=dict(schema=1,artifacts=dict(sorted(artifacts.items())),groups=groups)
    (ENGINE/'tools.json').write_text(json.dumps(catalog,indent=2)+'\n')
    # TLS trust is available before the first package download.
    shutil.copy2(SITES['audio']/'certifi/cacert.pem',ENGINE/'cacert.pem')
    print({key:round(sum(artifacts[i]['size'] for i in ids)/1e6,1) for key,ids in groups.items()})


if __name__=='__main__':main()
