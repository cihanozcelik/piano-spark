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
APP = DIST/'rach3.app'
TAG = 'v'+CONFIG['version']
ARCHIVE = DIST/f'rach3-{CONFIG["version"]}.zip'
BASE = ROOT/'build/update-baseline'
BASE_APP = BASE/'rach3.app'
NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
WINDOWS = DIST/'windows/releases'
WINDOWS_FEED = WINDOWS/'releases.win.json'
# The most a delta may weigh when the next build changes only its number and one file.
NEXT_DELTA_LIMIT = 1024**2
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
    else: args += ['--account','com.rach3.app']  # local keychain item for the Sparkle key
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
        raise RuntimeError('Delta base must be a rach3 release with the same update signing key')
    old_build = old['CFBundleVersion']
    if int(old_build) >= CONFIG['build']:
        raise RuntimeError('Delta base must have an older build number')
    command('codesign','--verify','--deep','--strict',previous_app)
    patch = DIST/f'rach3-{old_build}-{CONFIG["build"]}.delta'
    patch.unlink(missing_ok=True)
    command(SPARKLE/'bin/BinaryDelta','create','--version','4',previous_app,APP,patch)
    # Validate the actual deliverable: Sparkle checks its target tree hash while
    # applying, and codesign verifies the resulting bundle and nested executables.
    with tempfile.TemporaryDirectory(prefix='rach3-patched-',dir=ROOT/'build') as directory:
        patched = Path(directory)/'rach3.app'
        command(SPARKLE/'bin/BinaryDelta','apply',previous_app,patched,patch)
        command('codesign','--verify','--deep','--strict',patched)
    signature = sign(patch)
    verify_archive(patch,signature)
    print(f'Verified delta {old_build} → {CONFIG["build"]}: {patch.stat().st_size/1024:.1f} KiB',flush=True)
    return {'fromBuild':old_build,'file':patch.name,'size':patch.stat().st_size,'signature':signature}


def check_next_delta():
    """The download people get from this release to the next one must stay small. The next
    build is made here as a release makes it (a later build number, one changed file, signed
    again) and its delta from this app is measured, applied and verified."""
    with tempfile.TemporaryDirectory(prefix='rach3-next-',dir=ROOT/'build') as directory:
        following = Path(directory)/'next/rach3.app'
        following.parent.mkdir()
        command('cp','-cR',APP,following)
        info_path = following/'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info['CFBundleVersion'] = str(CONFIG['build']+1)
        info_path.write_bytes(plistlib.dumps(info))
        release = following/'Contents/Resources/release.json'
        release.write_text(json.dumps({**CONFIG,'build':CONFIG['build']+1},indent=2,ensure_ascii=False)+'\n')
        command('codesign','--force','--sign','-','--timestamp=none',following)
        command('codesign','--verify','--deep','--strict',following)
        patch = Path(directory)/'next.delta'
        command(SPARKLE/'bin/BinaryDelta','create','--version','4',APP,following,patch)
        patched = Path(directory)/'patched/rach3.app'
        patched.parent.mkdir()
        command(SPARKLE/'bin/BinaryDelta','apply',APP,patched,patch)
        command('codesign','--verify','--deep','--strict',patched)
        size = patch.stat().st_size
    print(f'Delta from this build to the next: {size/1024:.1f} KiB',flush=True)
    if size > NEXT_DELTA_LIMIT:
        raise RuntimeError(f'The delta to the next build is {size/1024**2:.1f} MiB: updates would no longer be small downloads')


def prepare_archive(previous_app=None):
    prepare()
    with (APP/'Contents/Info.plist').open('rb') as stream: info=plistlib.load(stream)
    if (info['CFBundleVersion'], info['CFBundleShortVersionString'], info['SUPublicEDKey']) != (str(CONFIG['build']), CONFIG['version'], CONFIG['publicKey']):
        raise RuntimeError('Build rach3 from the current release.json before packaging')
    command('codesign','--verify','--deep','--strict',APP)
    check_next_delta()
    deltas = [prepare_delta(previous_app)] if previous_app else []
    if not deltas: print('No earlier app to patch from: this release has the full update only.',flush=True)
    pending = ARCHIVE.with_suffix('.pending.zip')
    try:
        command('ditto','-c','-k','--sequesterRsrc','--keepParent',APP,pending)
        if pending.stat().st_size >= 2*1024**3:
            raise RuntimeError('Update exceeds the GitHub Releases per-asset 2 GiB limit')
        pending.replace(ARCHIVE)
    finally:
        pending.unlink(missing_ok=True)
    for patch in deltas:
        if patch['size'] >= ARCHIVE.stat().st_size:
            raise RuntimeError(f'The delta from build {patch["fromBuild"]} is not smaller than the full update')
    signature=sign(ARCHIVE)
    verify_archive(ARCHIVE,signature)
    metadata={'version':CONFIG['version'],'build':CONFIG['build'],'signature':signature,'size':ARCHIVE.stat().st_size,'deltas':deltas}
    (DIST/'update-signature.json').write_text(json.dumps(metadata,indent=2)+'\n')
    (DIST/'release-notes.txt').write_text('\n'.join(CONFIG['notes'])+'\n')
    print(f'Signed update: {ARCHIVE} ({ARCHIVE.stat().st_size/1024**2:.1f} MiB)')
    for patch in deltas: print(f'Signed delta from build {patch["fromBuild"]}: {patch["size"]/1024**2:.1f} MiB',flush=True)


def make_feed(asset_url, metadata, delta_assets, previous_items):
    root=ET.Element('rss',{'version':'2.0'})
    channel=ET.SubElement(root,'channel')
    ET.SubElement(channel,'title').text='rach3'
    item=ET.SubElement(channel,'item')
    for name,value in [('title','rach3 '+CONFIG['version']),('pubDate',format_datetime(datetime.now(timezone.utc))),
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


def windows_files():
    """The Velopack installer, full package and optional patch from the previous release,
    with the feed signed by the same Ed25519 release key; the Windows app refuses update
    files that are not listed in a feed with a valid signature."""
    import hashlib
    feed=json.loads(WINDOWS_FEED.read_text(encoding='utf-8-sig'))
    version=tuple(int(part) for part in CONFIG['version'].split('.'))
    current=[asset for asset in feed['Assets'] if asset['Version']==CONFIG['version']]
    kinds=sorted(asset['Type'] for asset in current)
    if kinds not in (['Full'],['Delta','Full']):
        raise RuntimeError(f'Windows feed must list this full release and at most one patch: {kinds}')
    if any(tuple(int(part) for part in asset['Version'].split('.')) > version for asset in feed['Assets']):
        raise RuntimeError('Windows feed lists a newer version than this release')
    packages=[]
    for asset in current:
        package=WINDOWS/asset['FileName']
        if package.stat().st_size != asset['Size'] or hashlib.sha256(package.read_bytes()).hexdigest().lower() != asset['SHA256'].lower():
            raise RuntimeError(f'Windows package {package.name} does not match its feed')
        packages.append(package)
    setup=WINDOWS/'rach3-win-Setup.exe'
    if not setup.is_file(): raise RuntimeError('Build the Windows installer before publishing')
    signature=sign(WINDOWS_FEED)
    verify_archive(WINDOWS_FEED,signature)
    sig=WINDOWS/'releases.win.json.sig'
    sig.write_text(signature+'\n')
    extra=[WINDOWS/name for name in ('assets.win.json','RELEASES') if (WINDOWS/name).is_file()]
    return [setup,*packages,WINDOWS_FEED,sig,*extra]


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
    for patch in patches:
        path=DIST/patch['file']
        if path.stat().st_size != patch['size'] or patch['size'] >= metadata['size']:
            raise RuntimeError('Delta size must match its signed metadata and be smaller than the full archive')
        verify_archive(path,patch['signature'])
    installer = DIST/'rach3-Setup.dmg'
    if not installer.is_file() or installer.stat().st_size >= 2*1024**3:
        raise RuntimeError('Build the small DMG installer before publishing')
    command('hdiutil','verify',installer)
    windows=windows_files()
    command('gh','release','create',TAG,'--repo',REPO,'--verify-tag','--draft','--title',f'rach3 {CONFIG["version"]}',
            '--notes-file',DIST/'release-notes.txt',ARCHIVE,installer,ROOT/'desktop/release.json',DIST/'update-signature.json',
            *(DIST/patch['file'] for patch in patches),*windows)
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


def baseline():
    """Fetch the signed app of the latest release, which this release's delta starts from."""
    prepare()
    release=api(f'repos/{REPO}/releases/latest')
    if release['tag_name'] == TAG:
        print('This version is already the latest release; a dry run of it has nothing to patch from.',flush=True)
        return
    asset=next((a for a in release['assets'] if a['name'].startswith('rach3-') and a['name'].endswith('.zip')),None)
    if not asset: raise RuntimeError(f'{release["tag_name"]} has no signed app to patch from')
    with tempfile.TemporaryDirectory(prefix='rach3-baseline-') as directory:
        folder=Path(directory)
        command('gh','release','download',release['tag_name'],'--repo',REPO,'--pattern',asset['name'],
                '--pattern','update-signature.json','--dir',folder)
        archive=folder/asset['name']
        metadata=json.loads((folder/'update-signature.json').read_text())
        verify_archive(archive,metadata['signature'])
        command('ditto','-x','-k',archive,folder)
        app=folder/'rach3.app'
        command('codesign','--verify','--deep','--strict',app)
        with (app/'Contents/Info.plist').open('rb') as stream: old=plistlib.load(stream)
        if old['CFBundleVersion'] != str(metadata['build']) or int(old['CFBundleVersion']) >= CONFIG['build']:
            raise RuntimeError('Baseline must match the signed release and be older than this build')
        if BASE.exists(): shutil.rmtree(BASE)
        BASE.mkdir(parents=True)
        shutil.move(app,BASE_APP)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish',action='store_true',help='Publish an already prepared, signed archive and update feed')
    parser.add_argument('--baseline',action='store_true',help='Fetch the signed previous application that the delta starts from')
    parser.add_argument('--previous-app',type=Path,help='Exact older signed application used to generate and verify a delta')
    args=parser.parse_args()
    if args.baseline: baseline()
    elif args.publish: publish()
    else: prepare_archive(args.previous_app or (BASE_APP if BASE_APP.exists() else None))
