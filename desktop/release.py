"""Prepare signed updates locally; --publish is the explicit GitHub write boundary."""
import argparse
import base64
from datetime import datetime, timezone
from email.utils import format_datetime
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from sparkle import prepare, SPARKLE, ROOT

CONFIG = json.loads((ROOT/'desktop/release.json').read_text())
REPO = CONFIG['repository']
DIST = ROOT/'dist'
APP = DIST/'Piano Spark.app'
TAG = 'v'+CONFIG['version']
ARCHIVE = DIST/f'PianoSpark-{CONFIG["version"]}.tar.xz'
BASE = ROOT/'build/previous-release'
BASE_APP = BASE/'Piano Spark.app'
NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
ET.register_namespace('sparkle', NS)


def command(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def api(path, payload=None, method=None):
    args = ['gh','api',path]
    if method: args += ['--method',method]
    if payload is not None: args += ['--input','-']
    result = command(*args, input=json.dumps(payload) if payload is not None else None, text=True, capture_output=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def sign(path, verify=None):
    args = [SPARKLE/'bin/sign_update']
    secret = os.environ.get('SPARKLE_PRIVATE_KEY')
    if secret: args += ['--ed-key-file','-']
    else: args += ['--account','com.pianoman.desktop']
    args += ['--verify'] if verify is not None else ['-p']
    args += [path]
    if verify: args += [verify]
    return command(*args, input=secret, text=True, capture_output=True).stdout.strip()


def verify_archive(path, signature):
    command("xcrun", "swift", ROOT/"desktop/VerifyUpdate.swift", CONFIG["publicKey"], signature, path)


def prepare_delta(previous_app):
    with (previous_app/'Contents/Info.plist').open('rb') as stream: old = plistlib.load(stream)
    with (APP/'Contents/Info.plist').open('rb') as stream: new = plistlib.load(stream)
    if old['CFBundleIdentifier'] != new['CFBundleIdentifier'] or old.get('SUPublicEDKey') != CONFIG['publicKey']:
        raise RuntimeError('Delta base must be a PianoMan release with the same update signing key')
    old_build = old['CFBundleVersion']
    if int(old_build) >= CONFIG['build']:
        raise RuntimeError('Delta base must have an older build number')
    command('codesign','--verify','--deep','--strict',previous_app)
    patch = DIST/f'PianoSpark-{old_build}-{CONFIG["build"]}.delta'
    patch.unlink(missing_ok=True)
    command(SPARKLE/'bin/BinaryDelta','create','--version','4',previous_app,APP,patch)
    # Validate the actual deliverable: Sparkle checks its target tree hash while
    # applying, and codesign verifies the resulting bundle and nested executables.
    with tempfile.TemporaryDirectory(prefix='pianoman-patched-',dir=ROOT/'build') as directory:
        patched = Path(directory)/'Piano Spark.app'
        command(SPARKLE/'bin/BinaryDelta','apply',previous_app,patched,patch)
        command('codesign','--verify','--deep','--strict',patched)
    signature = sign(patch)
    verify_archive(patch,signature)
    print(f'Verified delta {old_build} → {CONFIG["build"]}: {patch.stat().st_size/1024:.1f} KiB',flush=True)
    return {'fromBuild':old_build,'file':patch.name,'size':patch.stat().st_size,'signature':signature}


def prepare_archive(previous_app=None):
    prepare()
    with (APP/'Contents/Info.plist').open('rb') as stream: info=plistlib.load(stream)
    if (info['CFBundleVersion'], info['CFBundleShortVersionString'], info['SUPublicEDKey']) != (str(CONFIG['build']), CONFIG['version'], CONFIG['publicKey']):
        raise RuntimeError('Build PianoMan from the current release.json before packaging')
    command('codesign','--verify','--deep','--strict',APP)
    deltas = [prepare_delta(previous_app)] if previous_app else []
    pending = ARCHIVE.with_suffix('.pending.tar.xz')
    try:
        command('tar','--no-xattrs','--options','xz:threads=4','-cJf',pending,'-C',DIST,APP.name)
        if pending.stat().st_size >= 2*1024**3:
            raise RuntimeError('Update exceeds the GitHub Releases per-asset 2 GiB limit')
        pending.replace(ARCHIVE)
    finally:
        pending.unlink(missing_ok=True)
    signature=sign(ARCHIVE)
    verify_archive(ARCHIVE,signature)
    metadata={'version':CONFIG['version'],'build':CONFIG['build'],'signature':signature,'size':ARCHIVE.stat().st_size,'deltas':deltas}
    (DIST/'update-signature.json').write_text(json.dumps(metadata,indent=2)+'\n')
    (DIST/'release-notes.txt').write_text('\n'.join(CONFIG['notes'])+'\n')
    print(f'Signed update: {ARCHIVE} ({ARCHIVE.stat().st_size/1024**2:.1f} MiB)')


def make_feed(asset_url, metadata, delta_assets, previous_items):
    root=ET.Element('rss',{'version':'2.0'})
    channel=ET.SubElement(root,'channel')
    ET.SubElement(channel,'title').text='Piano Spark'
    item=ET.SubElement(channel,'item')
    for name,value in [('title','Piano Spark '+CONFIG['version']),('pubDate',format_datetime(datetime.now(timezone.utc))),
                       ('description','\n'.join(CONFIG['notes'])),(f'{{{NS}}}version',str(CONFIG['build'])),
                       (f'{{{NS}}}shortVersionString',CONFIG['version']),(f'{{{NS}}}minimumSystemVersion','14.0.0')]:
        ET.SubElement(item,name).text=value
    ET.SubElement(item,'enclosure',{'url':asset_url,'length':str(metadata['size']),'type':'application/octet-stream',
                                  f'{{{NS}}}edSignature':metadata['signature']})
    if delta_assets:
        deltas = ET.SubElement(item,f'{{{NS}}}deltas')
        for patch,url in delta_assets:
            ET.SubElement(deltas,'enclosure',{'url':url,'length':str(patch['size']),'type':'application/octet-stream',
                f'{{{NS}}}edSignature':patch['signature'],f'{{{NS}}}deltaFrom':str(patch['fromBuild'])})
    # Preserve the patch chain, including asset IDs and signatures of old releases.
    for previous in previous_items: channel.append(previous)
    feed=DIST/'appcast.xml'
    ET.ElementTree(root).write(feed,encoding='utf-8',xml_declaration=True)
    sign(feed)
    sign(feed,'')
    return feed


def publish():
    metadata=json.loads((DIST/'update-signature.json').read_text())
    if metadata['version'] != CONFIG['version'] or metadata['build'] != CONFIG['build'] or metadata['size'] != ARCHIVE.stat().st_size:
        raise RuntimeError('Signed archive metadata does not match this release')
    verify_archive(ARCHIVE,metadata['signature'])
    visibility=api(f'repos/{REPO}')['private']
    if visibility != CONFIG['private']: raise RuntimeError('Repository visibility differs from release configuration')
    # Refuse untagged/unpushed publications and mismatched workflow runs.
    if command('git','status','--porcelain',text=True,capture_output=True).stdout.strip():
        raise RuntimeError('Commit the release sources before publishing')
    head=command('git','rev-parse','HEAD',text=True,capture_output=True).stdout.strip()
    tagged=command('git','rev-list','-n','1',TAG,text=True,capture_output=True).stdout.strip()
    remote=command('git','ls-remote','origin',f'refs/tags/{TAG}',f'refs/tags/{TAG}^{{}}',text=True,capture_output=True).stdout
    if head != tagged or head not in remote: raise RuntimeError('Push the current commit and release tag before publishing')
    previous=api(f'repos/{REPO}/releases')
    if any(r['tag_name']==TAG for r in previous): raise RuntimeError('This release already exists; use a new version instead of replacing signed artifacts')
    for release in previous:
        if release['draft'] or release['prerelease']: continue
        asset=next((a for a in release['assets'] if a['name']=='release.json'),None)
        if asset:
            result=command('gh','api',asset['url'],'-H','Accept: application/octet-stream',text=True,capture_output=True)
            if int(json.loads(result.stdout)['build']) >= CONFIG['build']: raise RuntimeError('Build number must increase')
        break
    refs=api(f'repos/{REPO}/git/matching-refs/heads/updates')
    previous_items=[]
    if refs:
        old_feed=DIST/'previous-appcast.xml'
        response=command('gh','api',f'repos/{REPO}/contents/appcast.xml?ref=updates',
                         '-H','Accept: application/vnd.github.raw+json',capture_output=True)
        old_feed.write_bytes(response.stdout)
        try:
            sign(old_feed,'')
            previous_items=ET.parse(old_feed).getroot().findall('channel/item')
        finally:
            old_feed.unlink(missing_ok=True)
    published_builds={item.findtext(f'{{{NS}}}version') for item in previous_items}
    patches=[patch for patch in metadata.get('deltas',[]) if str(patch['fromBuild']) in published_builds]
    if published_builds and str(max(map(int,published_builds))) not in {str(p['fromBuild']) for p in patches}:
        raise RuntimeError('A verified delta from the latest published build is required; bootstrap its exact app first')
    for patch in patches:
        path=DIST/patch['file']
        if path.stat().st_size != patch['size'] or patch['size'] >= metadata['size']:
            raise RuntimeError('Delta size must match its signed metadata and be smaller than the full archive')
        verify_archive(path,patch['signature'])
    command('gh','release','create',TAG,'--repo',REPO,'--verify-tag','--draft','--title',f'Piano Spark {CONFIG["version"]}',
            '--notes-file',DIST/'release-notes.txt',ARCHIVE,ROOT/'desktop/release.json',DIST/'update-signature.json',
            *(DIST/patch['file'] for patch in patches))
    # The by-tag endpoint excludes drafts; the authenticated list includes them.
    release=next(item for item in api(f'repos/{REPO}/releases') if item['tag_name']==TAG)
    asset=next(a for a in release['assets'] if a['name']==ARCHIVE.name)
    # GitHub's Content-Disposition gives Sparkle the actual archive filename.
    delta_assets=[(patch,next(a['url'] for a in release['assets'] if a['name']==patch['file'])) for patch in patches]
    feed=make_feed(asset['url'],metadata,delta_assets,previous_items)
    command('gh','release','upload',TAG,feed,'--repo',REPO)
    # Publish the archive before moving the feed; clients never receive a dangling link.
    api(f'repos/{REPO}/releases/{release["id"]}',{'draft':False},'PATCH')
    account=api('users/'+REPO.split('/')[0])
    author={'name':account['login'],'email':f"{account['id']}+{account['login']}@users.noreply.github.com"}
    if not refs:
        tree=api(f'repos/{REPO}/git/trees',{'tree':[{'path':'appcast.xml','mode':'100644','type':'blob','content':feed.read_text()}]})
        commit=api(f'repos/{REPO}/git/commits',{'message':f'Publish {TAG} update feed','tree':tree['sha'],'author':author,'committer':author})
        api(f'repos/{REPO}/git/refs',{'ref':'refs/heads/updates','sha':commit['sha']})
    else:
        current=api(f'repos/{REPO}/contents/appcast.xml?ref=updates')
        api(f'repos/{REPO}/contents/appcast.xml',{'message':f'Publish {TAG} update feed','branch':'updates','author':author,'committer':author,
            'sha':current['sha'],'content':base64.b64encode(feed.read_bytes()).decode()},'PUT')
    command('gh','workflow','run','pages.yml','--repo',REPO,'--ref','main')
    print(f'Published {TAG}: https://github.com/{REPO}/releases/tag/{TAG}')


def bootstrap():
    """Retain the exact signed previous app for deltas and reuse its engine."""
    prepare()
    release=api(f'repos/{REPO}/releases/latest')
    with tempfile.TemporaryDirectory(prefix='pianoman-engine-') as directory:
        folder=Path(directory)
        command('gh','release','download',release['tag_name'],'--repo',REPO,'--pattern','PianoSpark-*.tar.xz','--pattern','update-signature.json','--dir',folder)
        archive=next(folder.glob('PianoSpark-*.tar.xz'))
        metadata=json.loads((folder/'update-signature.json').read_text())
        verify_archive(archive,metadata['signature'])
        command('tar','-xJf',archive,'-C',folder,'Piano Spark.app')
        command('codesign','--verify','--deep','--strict',folder/'Piano Spark.app')
        with (folder/'Piano Spark.app/Contents/Info.plist').open('rb') as stream: old=plistlib.load(stream)
        if old['CFBundleVersion'] != str(metadata['build']) or int(old['CFBundleVersion']) >= CONFIG['build']:
            raise RuntimeError('The previous release must match its metadata and be older than this build')
        if BASE.exists(): shutil.rmtree(BASE)
        BASE.mkdir(parents=True)
        shutil.move(folder/'Piano Spark.app',BASE_APP)
        # APFS clones avoid keeping a second physical copy of unchanged models.
        engine=APP/'Contents/Resources/Engine'
        if engine.exists(): shutil.rmtree(engine)
        engine.parent.mkdir(parents=True,exist_ok=True)
        command('cp','-cR',BASE_APP/'Contents/Resources/Engine',engine)
    command('python3',ROOT/'desktop/build.py','--app-only','--reuse-engine')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish',action='store_true',help='Publish an already prepared, signed archive and update feed')
    parser.add_argument('--bootstrap-engine',action='store_true',help='CI: fetch previous signed engine and rebuild app')
    parser.add_argument('--previous-app',type=Path,help='Exact older signed application used to generate and verify a delta')
    args=parser.parse_args()
    if args.bootstrap_engine: bootstrap()
    elif args.publish: publish()
    else: prepare_archive(args.previous_app or (BASE_APP if BASE_APP.exists() else None))
