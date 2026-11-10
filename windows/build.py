"""Build the Windows app folder: the C# shell, the same offline page as the Mac app,
and the Windows lesson engine. Runs on Windows (GitHub's windows-latest runner).

    python windows/build.py              -> dist/windows/Rach3
    python windows/build.py --package    -> also the Velopack installer and update package
                                            in dist/windows/releases, installed and checked,
                                            plus a real signed patch update between test versions
    python windows/build.py --capture D  -> a development build that saves screenshots
                                            to D and creates a test lesson, then exits
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'windows'), str(ROOT/'desktop')]
from engine import prepare_runtime, stage_engine  # noqa: E402

RELEASE = json.loads((ROOT/'desktop/release.json').read_text(encoding='utf-8'))
PROJECT = ROOT/'windows/Rach3/Rach3.csproj'
DIST = ROOT/'dist/windows/Rach3'
RELEASES = ROOT/'dist/windows/releases'
PACKAGE_ID = 'rach3'
SETUP = f'{PACKAGE_ID}-win-Setup.exe'
# ChatGPT features (With AI) run Codex, Apache-2.0, from github.com/openai/codex.
# The same version the Mac release bundles (.github/workflows/release.yml).
CODEX_VERSION = '0.167.0'
CODEX_TRIPLE = 'x86_64-pc-windows-msvc'
CODEX_FILES = ('bin/codex.exe', 'bin/codex-code-mode-host.exe', 'codex-path/rg.exe', 'codex-package.json',
               'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe')


def mac_build():
    spec = importlib.util.spec_from_file_location('mac_build', ROOT/'desktop/build.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def native_strings():
    """The Mac app's Turkish→English native strings, shared by the Windows shell."""
    source = (ROOT/'desktop/Localization.m').read_text(encoding='utf-8')
    block = source[source.index('english = @{'):source.index('};', source.index('english = @{'))]
    unescape = lambda text: text.replace('\\"', '"').replace('\\\\', '\\')
    pairs = {unescape(tr): unescape(en) for tr, en in
             re.findall(r'@"((?:[^"\\]|\\.)*)":@"((?:[^"\\]|\\.)*)"', block)}
    if len(pairs) < 80: raise RuntimeError(f'Only {len(pairs)} strings found in Localization.m')
    return pairs


def page_strings():
    """The page's Turkish source strings and English translations."""
    pairs = {}
    for name in ('i18n.js', 'i18n-messages.js'):
        text = (ROOT/name).read_text(encoding='utf-8')
        pairs.update(re.findall(r'^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",?\s*$', text, re.M))
    return pairs


def platform_text():
    from wording import TEXT, mentions_mac
    missing = [source for source, english in page_strings().items()
               if (mentions_mac(source) or mentions_mac(english)) and source not in TEXT]
    if missing: raise RuntimeError('Add Windows wording for: ' + '; '.join(missing))
    leftover = [value for pair in TEXT.values() for value in pair if mentions_mac(value)]
    if leftover: raise RuntimeError(f'Windows wording still mentions the Mac: {leftover}')
    return {source: list(pair) for source, pair in TEXT.items()}


def write_resources(resources):
    """The page as the Mac app serves it: the Source folder, which the person may change
    with ChatGPT, and the Customize panel. Windows adds its own wording at load time."""
    if resources.exists(): shutil.rmtree(resources)
    resources.mkdir(parents=True)
    mac_build().write_source(resources)
    (resources/'platform-text.json').write_text(json.dumps(platform_text(), ensure_ascii=False), encoding='utf-8')
    (resources/'strings.json').write_text(json.dumps(native_strings(), ensure_ascii=False, indent=1), encoding='utf-8')
    shutil.copy2(ROOT/'desktop/release.json', resources/'release.json')


def compile_shell(output, capture):
    if output.exists(): shutil.rmtree(output)
    subprocess.run(['dotnet', 'build', str(PROJECT), '-c', 'Release', '-nologo', '-o', str(output),
                    f'-p:PianoVersion={RELEASE["version"]}', f'-p:PianoCapture={"true" if capture else "false"}'],
                   check=True)
    for leftover in output.glob('*.pdb'): leftover.unlink()


def codex_vendor():
    """Codex's native Windows package: RACH3_CODEX_VENDOR (an unpacked npm vendor folder),
    else @openai/codex-<version>-win32-x64 from npm, which checks the registry's integrity hash."""
    if os.environ.get('RACH3_CODEX_VENDOR'):
        vendor = Path(os.environ['RACH3_CODEX_VENDOR'])/CODEX_TRIPLE
    else:
        import tarfile
        cache = ROOT/'build/windows'/f'codex-{CODEX_VERSION}'
        vendor = cache/'package/vendor'/CODEX_TRIPLE
        if not (vendor/'bin/codex.exe').is_file():
            if cache.exists(): shutil.rmtree(cache)
            cache.mkdir(parents=True)
            npm = shutil.which('npm')
            if not npm: raise RuntimeError('npm is needed to fetch Codex for the With AI tab')
            subprocess.run([npm, 'pack', '--silent', f'@openai/codex@{CODEX_VERSION}-win32-x64'], cwd=cache, check=True)
            with tarfile.open(cache/f'openai-codex-{CODEX_VERSION}-win32-x64.tgz') as archive:
                archive.extractall(cache, filter='data')
    missing = [name for name in CODEX_FILES if not (vendor/name).is_file()]
    if missing: raise RuntimeError(f'Codex package is missing {missing} in {vendor}')
    return vendor


def bundle_codex(app):
    """Codex in the app folder, as in the Mac app's Resources/Codex. Without it the
    With AI tab is not offered, so a build without Codex is an error."""
    vendor = codex_vendor()
    codex = app/'Codex'
    if codex.exists(): shutil.rmtree(codex)
    for name in CODEX_FILES:
        (codex/name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(vendor/name, codex/name)
    for name in ('LICENSE', 'NOTICE'):
        shutil.copy2(ROOT/f'desktop/customize/CODEX-{name}', codex/name)
    size = sum(path.stat().st_size for path in codex.rglob('*') if path.is_file())
    print(f'Codex {CODEX_VERSION}: {size/1e6:.0f} MB')


def build(destination, capture=False):
    work = ROOT/'build/windows'/('capture' if capture else 'release')
    compile_shell(work/'shell', capture)
    if destination.exists(): shutil.rmtree(destination)
    shutil.copytree(work/'shell', destination)
    write_resources(destination/'Resources')
    bundle_codex(destination)
    stage_engine(destination/'Engine', prepare_runtime())
    size = sum(path.stat().st_size for path in destination.rglob('*') if path.is_file())
    print(f'Windows app: {destination} ({size/1e6:.0f} MB)')
    return destination


def capture(directory, midi):
    app = build(ROOT/'build/windows/capture/Rach3', capture=True)
    directory.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([str(app/'Rach3.exe'), '--capture', str(directory), '--self-test-midi', str(midi),
                             '--self-test-pdf', str(ROOT/'assets/example-lessons/bach-prelude/score.pdf')],
                            timeout=1200)
    for name in ('capture-error.txt', 'page-errors.txt', 'self-test.json', 'chatgpt-self-test.json'):
        path = directory/name
        if path.exists() and path.read_text(encoding='utf-8').strip():
            print(f'{name}:\n{path.read_text(encoding="utf-8")}')
    missing = [name for name in ('practice.png', 'create-lesson.png', 'with-ai.png', 'lesson-created.png')
               if not (directory/name).is_file() or (directory/name).stat().st_size < 10000]
    if result.returncode or missing:
        raise RuntimeError(f'Windows capture failed (exit {result.returncode}, missing {missing})')
    print(f'Windows screenshots and bridge self-test passed: {directory}')


def vpk_pack(app, version, output, package_id=PACKAGE_ID, title='rach3', notes=None, delta=False):
    """With delta, output must already hold the previous full package and its feed;
    Velopack then also writes a patch from that version to this one."""
    if not delta and output.exists(): shutil.rmtree(output)
    args = ['vpk', 'pack', '--packId', package_id, '--packVersion', version, '--packDir', str(app),
            '--mainExe', 'Rach3.exe', '--packTitle', title, '--packAuthors', 'rach3',
            '--icon', str(ROOT/'windows/Rach3/Rach3.ico'), '--delta', 'BestSpeed' if delta else 'None',
            '--noPortable', '--outputDir', str(output)]
    if notes: args += ['--releaseNotes', str(notes)]
    subprocess.run(args, check=True)
    feed = json.loads((output/'releases.win.json').read_text(encoding='utf-8-sig'))
    made = {asset['Type']: asset for asset in feed['Assets'] if asset['Version'] == version}
    expected = {'Full', 'Delta'} if delta else {'Full'}
    if (set(made) != expected or not all((output/asset['FileName']).is_file() for asset in made.values())
            or not (output/f'{package_id}-win-Setup.exe').is_file()):
        raise RuntimeError(f'Unexpected Velopack output: {sorted(p.name for p in output.iterdir())}')
    return output


def version_key(text):
    return tuple(int(part) for part in text.split('.'))


def previous_release():
    """The latest published Windows package, which this release's patch starts from. Its
    feed signature is checked with the release key before anything is built on it."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    import base64
    import hashlib
    if RELEASES.exists(): shutil.rmtree(RELEASES)
    RELEASES.mkdir(parents=True)
    args = ['vpk', 'download', 'github', '--repoUrl', f'https://github.com/{RELEASE["repository"]}', '--outputDir', str(RELEASES)]
    if os.environ.get('GH_TOKEN'): args += ['--token', os.environ['GH_TOKEN']]
    subprocess.run(args, check=True)
    # vpk download fetches only the latest full package; its feed comes signed from the release.
    names = sorted(RELEASES.glob(f'{PACKAGE_ID}-*-full.nupkg'))
    versions = [name.name[len(PACKAGE_ID)+1:-len('-full.nupkg')] for name in names]
    if len(names) != 1 or version_key(versions[0]) >= version_key(RELEASE['version']):
        # Nothing published yet, or a dry run of the version that is already published.
        print(f'No older Windows release to patch from ({[n.name for n in names]}); this release has the full package only.')
        shutil.rmtree(RELEASES)
        return False
    package, previous = names[0], versions[0]
    with tempfile.TemporaryDirectory(prefix='piano-previous-') as folder:
        subprocess.run(['gh', 'release', 'download', f'v{previous}', '--repo', RELEASE['repository'],
                        '--pattern', 'releases.win.json', '--pattern', 'releases.win.json.sig', '--dir', folder], check=True)
        feed = Path(folder, 'releases.win.json').read_bytes()
        signature = base64.b64decode(Path(folder, 'releases.win.json.sig').read_text().strip())
    Ed25519PublicKey.from_public_bytes(base64.b64decode(RELEASE['publicKey'])).verify(signature, feed)
    signed = json.loads(feed.decode('utf-8-sig'))['Assets']
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    if not any(asset['FileName'] == package.name and asset['SHA256'].lower() == digest for asset in signed):
        raise RuntimeError('The previous Windows package does not match its signed feed')
    # Velopack builds the patch from the releases listed in the output folder's feed.
    (RELEASES/'releases.win.json').write_bytes(feed)
    print(f'Patching from the signed {previous} package')
    return True


def package():
    """Velopack installer, full package and, when an older Windows release exists, a patch
    from it. Clients accept them only through the Ed25519-signed releases.win.json."""
    app = build(DIST)
    notes = ROOT/'build/windows/release-notes.md'
    notes.write_text('\n'.join(RELEASE['notes'])+'\n', encoding='utf-8')
    vpk_pack(app, RELEASE['version'], RELEASES, notes=notes, delta=previous_release())
    for path in sorted(RELEASES.iterdir()): print(f'{path.name}: {path.stat().st_size/1e6:.1f} MB')


def running(image='Rach3.exe'):
    tasks = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {image}', '/FO', 'CSV', '/NH'],
                           capture_output=True, text=True).stdout
    return image.lower() in tasks.lower()


def install_check():
    """Install with the real Setup.exe, open the installed app and create a lesson
    with its installed engine, as a new Windows user would."""
    subprocess.run([str(RELEASES/SETUP), '--silent'], check=True, timeout=900)
    root = Path(os.environ['LOCALAPPDATA'])/PACKAGE_ID
    app = root/'current'/'Rach3.exe'
    engine = root/'current'/'Engine'
    if not app.is_file() or not (engine/'python/python.exe').is_file():
        raise RuntimeError(f'Setup did not install the app: {sorted(p.name for p in root.iterdir())}')
    time.sleep(5)
    if not running(): subprocess.Popen([str(app)])
    time.sleep(30)
    webview = Path(os.environ['LOCALAPPDATA'])/'Rach3'/'WebView'
    if not running() or not webview.is_dir():
        raise RuntimeError('The installed app did not stay open with its web view')
    subprocess.run(['taskkill', '/IM', 'Rach3.exe', '/F'], capture_output=True)
    from verify_engine import lesson
    with tempfile.TemporaryDirectory(prefix='piano-installed-') as folder:
        work = Path(folder)
        count = lesson(engine, work/'Tools', work/'Library', 'installed-midi',
                       ROOT/'assets/example-lessons/bach-prelude/score.mid', 'midi')['noteCount']
    if count != 549: raise RuntimeError(f'The installed engine made a different MIDI lesson: {count} notes')
    print(f'Installed app opens and its engine creates lessons ({app})')


def update_check():
    """A real Velopack update of an installed app: version 0.0.1 is installed, 0.0.2 (with a
    changed file) is offered as a patch, with a feed signed by a temporary test key. A wrong
    key must be refused. The right key must update through the patch alone: the full 0.0.2
    package is withheld, so a broken patch cannot pass by falling back to it."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    import base64
    package_id = 'Rach3UpdateTest'
    work = ROOT/'build/windows/update-test'
    if work.exists(): shutil.rmtree(work)
    app = build(work/'app', capture=True)
    changed = work/'app-changed'
    shutil.copytree(app, changed)
    (changed/'Resources/update-check.txt').write_text('0.0.2\n', encoding='utf-8')
    feed_dir = work/'feed'
    vpk_pack(app, '0.0.1', feed_dir, package_id, 'rach3 Update Test')
    setup = work/'setup-0.0.1.exe'
    shutil.copy2(feed_dir/f'{package_id}-win-Setup.exe', setup)
    vpk_pack(changed, '0.0.2', feed_dir, package_id, 'rach3 Update Test', delta=True)
    key = Ed25519PrivateKey.generate()
    public = lambda k: base64.b64encode(k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    feed = feed_dir/'releases.win.json'
    (feed_dir/'releases.win.json.sig').write_text(base64.b64encode(key.sign(feed.read_bytes())).decode())
    full = next(asset['FileName'] for asset in json.loads(feed.read_text(encoding='utf-8-sig'))['Assets']
                if asset['Version'] == '0.0.2' and asset['Type'] == 'Full')
    shutil.move(feed_dir/full, work/full)

    subprocess.run([str(setup), '--silent'], check=True, timeout=900)
    time.sleep(5)
    subprocess.run(['taskkill', '/IM', 'Rach3.exe', '/F'], capture_output=True)
    current = Path(os.environ['LOCALAPPDATA'])/package_id/'current'
    installed = current/'Rach3.exe'

    def ask(public_key, name):
        result = work/f'{name}.json'
        result.unlink(missing_ok=True)
        subprocess.run([str(installed), '--self-test-update', str(feed_dir), public_key, str(result)], check=True, timeout=600)
        report = json.loads(result.read_text(encoding='utf-8-sig'))
        print(f'{name}: {report}', flush=True)
        if report.get('error'): raise RuntimeError(f'Update check failed: {report["error"]}')
        return report

    refused = ask(public(Ed25519PrivateKey.generate()), 'wrong-key')
    if refused.get('current') != '0.0.1' or refused.get('available') != '0.0.2' or 'rejected' not in refused:
        raise RuntimeError('An update signed with another key was not refused')
    try:
        accepted = ask(public(key), 'right-key')
    except RuntimeError:
        for log in [work/'right-key.json.log', *current.parent.rglob('*.log'), *Path(os.environ['TEMP']).glob('*elopack*.log')]:
            if not log.is_file(): continue
            print(f'--- {log}\n{log.read_text(encoding="utf-8", errors="replace")[-6000:]}', flush=True)
        raise
    # The full 0.0.2 package is withheld, so success here means the patch was applied.
    if accepted.get('applying') != '0.0.2' or accepted.get('deltas') != 1:
        raise RuntimeError('A correctly signed patch was not downloaded and verified')
    deadline = time.monotonic() + 300
    time.sleep(5)
    while running('Update.exe') and time.monotonic() < deadline: time.sleep(2)
    time.sleep(3)
    after = ask(public(key), 'after-update')
    if after.get('current') != '0.0.2' or after.get('available') is not None:
        raise RuntimeError('The installed app is not the updated version')
    if (current/'Resources/update-check.txt').read_text(encoding='utf-8').strip() != '0.0.2':
        raise RuntimeError('The patched app does not contain the changed file')
    print('Signed patch installed: 0.0.1 -> 0.0.2 without the full package; a wrong signature is refused')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--capture', type=Path, help='Save screenshots here and run the bridge self-test')
    parser.add_argument('--midi', type=Path, default=ROOT/'assets/example-lessons/bach-prelude/score.mid')
    parser.add_argument('--package', action='store_true', help='Create, install and check the Velopack installer')
    args = parser.parse_args()
    if args.capture: capture(args.capture.resolve(), args.midi.resolve())
    elif args.package: package(); install_check(); update_check()
    else: build(DIST)


if __name__ == '__main__':
    main()
