"""Build a self-contained universal (Apple Silicon and Intel) app and a drag-to-Applications disk image."""
import argparse
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
from sparkle import prepare as prepare_sparkle, SPARKLE

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build/desktop'
DIST = ROOT / 'dist'
APP = DIST / 'rach3.app'
RELEASE = json.loads((ROOT/'desktop/release.json').read_text())


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, cwd=ROOT)


def bundle_engine(resources):
    engine = resources/'Engine'
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', 'tests', '.DS_Store')
    # LessonService.m picks the runtime matching the running slice of the app.
    for arch, folder in [('aarch64','python'), ('x86_64','python-x86_64')]:
        runtime = ROOT/f'build/lesson-python/cpython-3.12.12-macos-{arch}-none'
        shutil.copytree(runtime,engine/folder,symlinks=True,ignore=ignore)
    for name in ['worker.py','notation.py','notation_source.py','score_writer.py','score_import.py','midi_score.py',
                 'pdf_recognizer.py','tools_manager.py','torch_compat.py','tools.json','tools-x86_64.json',
                 'cacert.pem']:
        shutil.copy2(ROOT/'lesson-engine'/name,engine/name)
    for name in ['vendor','model-config']:
        shutil.copytree(ROOT/'lesson-engine'/name,engine/name,ignore=ignore)
    # Sign every native dependency in the portable runtime, before sealing the app.
    magic = {b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'}
    for path in engine.rglob('*'):
        if path.is_symlink() or not path.is_file(): continue
        with path.open('rb') as stream: native = stream.read(4) in magic
        if native:
            subprocess.run(['codesign','--force','--sign','-','--timestamp=none',str(path)],
                           check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)


def build_installer():
    stage = BUILD/'installer-image'
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir(parents=True)
    run('cp','-cR',APP,stage/APP.name)
    (stage/'Applications').symlink_to('/Applications',target_is_directory=True)
    run('codesign','--verify','--deep','--strict',stage/APP.name)
    image = DIST/'rach3-Setup.dmg'
    if image.exists(): image.unlink()
    run('hdiutil','create','-volname','rach3','-srcfolder',stage,'-format','UDZO',image)
    shutil.rmtree(stage)
    print(f'Installer: {image}\nSize: {image.stat().st_size/1000000:.1f} MB')


# The interface as the page sees it: one flat folder. The app serves it from the
# bundle (the original design) or from a copy the person changed with ChatGPT.
SOURCE = {
    'piano.html': 'piano.html', 'i18n.js': 'i18n.js', 'i18n-messages.js': 'i18n-messages.js', 'desktop.js': 'desktop.js',
    'player.js': 'player.js', 'workspace-state.js': 'workspace-state.js', 'sheet-music.js': 'sheet-music.js',
    'piano-input.js': 'piano-input.js', 'piano-output.js': 'piano-output.js', 'practice-clock.js': 'practice-clock.js',
    'practice-session.js': 'practice-session.js', 'hand-reach.js': 'hand-reach.js', 'staff-notation.js': 'staff-notation.js',
    'create-lesson.js': 'create-lesson.js', 'lesson-chat.js': 'lesson-chat.js', 'app-shell.js': 'app-shell.js',
    'bluetooth.js': 'bluetooth-connection/bluetooth.js', 'bluetooth-diagnostics.js': 'bluetooth-connection/bluetooth-diagnostics.js',
    'assets/bravura/Bravura.woff2': 'assets/bravura/Bravura.woff2',
    'assets/brand/rach3-wordmark-on-dark.png': 'assets/brand/rach3-wordmark-on-dark.png',
    'assets/notation/verovio-toolkit-wasm.js': 'assets/notation/verovio-toolkit-wasm.js',
    'AGENTS.md': 'desktop/customize/AGENTS.md',
}
CODEX_TRIPLES = {'arm64': 'aarch64-apple-darwin', 'x86_64': 'x86_64-apple-darwin'}


def write_source(resources):
    source = resources/'Source'
    for target, origin in SOURCE.items():
        (source/target).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/origin, source/target)
    customize = resources/'Customize'
    customize.mkdir(exist_ok=True)
    for name in ('core.js', 'panel.js', 'page-errors.js'): shutil.copy2(ROOT/'desktop/customize'/name, customize/name)
    licenses = resources/'Licenses/Verovio'
    licenses.mkdir(parents=True,exist_ok=True)
    for name in ['COPYING','COPYING.LESSER','README.md','package.json','package-lock.json']:
        shutil.copy2(ROOT/'assets/notation'/name,licenses/name)


def codex_vendor(triple):
    """Codex's native package for one Mac architecture (Apache-2.0, github.com/openai/codex)."""
    import os
    folder = os.environ.get('RACH3_CODEX_VENDOR')
    candidates = [Path(folder)/triple] if folder else []
    npm = subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip() if shutil.which('npm') else ''
    if npm:
        package = 'codex-darwin-arm64' if triple.startswith('aarch64') else 'codex-darwin-x64'
        candidates.append(Path(npm)/f'@openai/codex/node_modules/@openai/{package}/vendor'/triple)
    return next((path for path in candidates if (path/'bin/codex').exists()), None)


def bundle_codex(resources):
    vendors = {arch: codex_vendor(triple) for arch, triple in CODEX_TRIPLES.items()}
    found = {arch: path for arch, path in vendors.items() if path}
    if not found:
        print('Codex not found: the app is built without ChatGPT changes. Install @openai/codex or set RACH3_CODEX_VENDOR.')
        return
    codex = resources/'Codex'
    (codex/'bin').mkdir(parents=True)
    (codex/'codex-path').mkdir()
    # One universal file per tool when both architectures are present.
    for relative in ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg']:
        parts = [path/relative for path in found.values() if (path/relative).exists()]
        if len(parts) > 1: run('xcrun', 'lipo', '-create', *parts, '-output', codex/relative)
        elif parts: shutil.copy2(parts[0], codex/relative)
    if len(found) < 2: print(f'Codex bundled for {", ".join(found)} only.')
    for name in ['LICENSE', 'NOTICE']:
        shutil.copy2(ROOT/f'desktop/customize/CODEX-{name}', codex/name)


def write_ui(resources):
    # Windows still loads one flattened page; the Mac serves the SOURCE folder.
    # Flatten our known ES modules into one offline document. Tone's bundled
    # dependency and embedded song already live in piano.html, including license.
    scripts = []
    for name in ['workspace-state.js', 'sheet-music.js', 'piano-input.js', 'piano-output.js', 'practice-clock.js', 'practice-session.js', 'hand-reach.js', 'staff-notation.js', 'bluetooth-connection/bluetooth-diagnostics.js', 'bluetooth-connection/bluetooth.js', 'lesson-chat.js', 'create-lesson.js', 'app-shell.js', 'player.js']:
        code = (ROOT / name).read_text()
        code = re.sub(r'^import .*?;\s*$', '', code, flags=re.MULTILINE)
        code = re.sub(r'^export (?=(?:async )?(?:class |function ))', '', code, flags=re.MULTILINE)
        if re.search(r'^(?:import|export)\s', code, flags=re.MULTILINE):
            raise RuntimeError(f'Unbundled module syntax in {name}')
        scripts.append(code)
    compiled = '\n'.join(scripts).replace('</script', '<\\/script')
    html = (ROOT / 'piano.html').read_text()
    module_tag = '<script type="module" src="/player.js"></script>'
    if module_tag not in html:
        raise RuntimeError('Player entry point changed; update the desktop packager')
    notation = json.dumps((ROOT/'assets/notation/verovio-toolkit-wasm.js').read_text()).replace('</', '<\\/')
    # Inline scripts execute immediately: prepare notation before starting the player.
    html = html.replace(module_tag, '<script>window.PianoNotationRuntime='+notation+';</script><script>\n' + compiled + '\n</script>')
    for script in ['i18n.js','i18n-messages.js']:
        html = html.replace(f'<script src="/{script}"></script>', '<script>\n'+(ROOT/script).read_text().replace('</script','<\\/script')+'\n</script>')
    html = html.replace('<script src="/desktop.js"></script>',
        '<script>\n' + (ROOT / 'desktop.js').read_text() + '\n</script>')
    html = html.replace('<!-- rach3-notation-runtime -->', '')
    resources.mkdir(parents=True, exist_ok=True)
    licenses = resources/'Licenses/Verovio'
    licenses.mkdir(parents=True,exist_ok=True)
    for name in ['COPYING','COPYING.LESSER','README.md','package.json','package-lock.json']:
        shutil.copy2(ROOT/'assets/notation'/name,licenses/name)
    pending = resources / 'index.pending'
    pending.write_text(html)
    pending.replace(resources / 'index.html')


ELECTRON = ROOT/'node_modules/electron/dist/Electron.app'
# The same Electron for Intel Macs, unpacked here, makes the app universal (see electron_shell).
ELECTRON_INTEL = ROOT/'build/electron/darwin-x64/Electron.app'
MACH_O = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}


def is_native(path):
    if path.is_symlink() or not path.is_file(): return False
    with path.open('rb') as stream: return stream.read(4) in MACH_O


def electron_shell(app):
    """rach3's window is Electron (electron/main.js), the same on Mac and Windows. This lays
    the Electron runtime out as rach3.app: named rach3, and universal when the Intel build of
    the same Electron version is present."""
    if not ELECTRON.exists(): raise RuntimeError('Electron is missing: run npm ci, then node node_modules/electron/install.js')
    run('cp', '-cR', ELECTRON, app)
    if ELECTRON_INTEL.exists():
        if (ELECTRON_INTEL.parent/'version').read_text().strip() != (ELECTRON.parent/'version').read_text().strip():
            raise RuntimeError('The Intel Electron is a different version')
        for other in ELECTRON_INTEL.rglob('*'):
            mine = app/other.relative_to(ELECTRON_INTEL)
            if other.is_symlink() or other.is_dir(): continue
            if not mine.exists(): shutil.copy2(other, mine)      # each architecture's own V8 snapshot
            elif is_native(other): run('xcrun', 'lipo', '-create', mine, other, '-output', mine)
    else:
        print('Intel Electron not found: this build runs on Apple Silicon only.')
    contents = app/'Contents'
    (contents/'Resources/default_app.asar').unlink()
    (contents/'Resources/electron.icns').unlink()
    # Electron looks for its helper programs by the app's name (CFBundleName), letter for letter.
    frameworks = contents/'Frameworks'
    for helper in sorted(frameworks.glob('Electron Helper*.app')):
        name = helper.stem.replace('Electron', 'rach3', 1)
        (helper/'Contents/MacOS'/helper.stem).rename(helper/'Contents/MacOS'/name)
        info_path = helper/'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleExecutable=name, CFBundleName=name, CFBundleDisplayName=name,
                    CFBundleIdentifier=info['CFBundleIdentifier'].replace('com.github.Electron', 'com.rach3.app'))
        info_path.write_bytes(plistlib.dumps(info))
        helper.rename(frameworks/f'{name}.app')
    (contents/'MacOS/Electron').rename(contents/'MacOS/Rach3')


def write_shell(resources):
    """The shell's own code, next to the files it serves."""
    code = resources/'app'
    (code/'electron').mkdir(parents=True)
    for source in sorted((ROOT/'electron').glob('*.js')): shutil.copy2(source, code/'electron'/source.name)
    (code/'package.json').write_text(json.dumps({'name': 'rach3', 'version': RELEASE['version'], 'main': 'electron/main.js'}))
    # The shell's words: the Turkish to English table of desktop/Localization.m.
    strings = subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./electron/localization').nativeStrings()))"],
                             cwd=ROOT, check=True, capture_output=True, text=True).stdout
    (resources/'strings.json').write_text(strings)


def compile_updates(destination):
    """Sparkle stays the Mac's update system: desktop/UpdateController.m, unchanged, as an
    addon the shell loads (electron/native/updates.m)."""
    headers = Path(subprocess.run(['node', '-p', 'process.execPath'], check=True, capture_output=True, text=True).stdout.strip()).resolve().parents[1]/'include/node'
    if not (headers/'node_api.h').exists(): raise RuntimeError(f'Node headers not found in {headers}')
    run('xcrun', 'clang', '-arch', 'arm64', '-arch', 'x86_64', '-fobjc-arc', '-fblocks', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
        '-mmacosx-version-min=14.0', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers, '-F', SPARKLE,
        ROOT/'electron/native/updates.m', ROOT/'desktop/UpdateController.m', ROOT/'desktop/Localization.m',
        '-framework', 'AppKit', '-framework', 'Sparkle', '-Wl,-rpath,@loader_path/../Frameworks', '-o', destination)


def sign(app):
    """Ad-hoc signatures, inside out: every program and framework, then the app."""
    frameworks = app/'Contents/Frameworks'
    for path in sorted(frameworks.rglob('*')):
        if path.suffix in ('.dylib', '.node') and is_native(path): run('codesign', '--force', '--sign', '-', '--timestamp=none', path)
    for bundle in [*sorted(frameworks.glob('*.framework')), *sorted(frameworks.glob('*.app'))]:
        run('codesign', '--force', '--deep', '--sign', '-', '--timestamp=none', bundle)
    run('codesign', '--force', '--sign', '-', '--timestamp=none', app/'Contents/Resources/updates.node')
    run('codesign', '--force', '--sign', '-', '--timestamp=none', app)
    run('codesign', '--verify', '--deep', '--strict', app)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--app-only',action='store_true')
    parser.add_argument('--installer-only',action='store_true')
    parser.add_argument('--capture-assets',type=Path,help='Export screenshots drawn by the built app itself')
    parser.add_argument('--capture-language',choices=('en','tr'),default='en',help='Language of the exported screenshots')
    args=parser.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(exist_ok=True)
    if args.capture_assets:
        destination=args.capture_assets.resolve(); destination.mkdir(parents=True,exist_ok=True)
        # The real app draws its own screenshots: its capture mode uses a throwaway data folder.
        run(APP/'Contents/MacOS/Rach3','--capture',destination,args.capture_language)
        return
    if args.installer_only:
        build_installer(); return
    prepare_sparkle()
    if APP.exists():
        shutil.rmtree(APP)
    electron_shell(APP)
    resources = APP / 'Contents/Resources'
    info_path = APP/'Contents/Info.plist'
    app_info = plistlib.loads(info_path.read_bytes())
    with (ROOT/'desktop/Info.plist').open('rb') as stream: own = plistlib.load(stream)
    for key in ('ElectronAsarIntegrity', 'LSApplicationCategoryType', 'NSAudioCaptureUsageDescription', 'NSBluetoothPeripheralUsageDescription',
                'NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSAppTransportSecurity'):
        app_info.pop(key, None)
    # Electron's own application class stays; everything that names the app is rach3's.
    app_info.update({key: value for key, value in own.items() if key != 'NSPrincipalClass'})
    app_info.update(LSMinimumSystemVersion='14.0',CFBundleVersion=str(RELEASE['build']),CFBundleShortVersionString=RELEASE['version'],
        SUFeedURL=RELEASE['feedURL'],
        SUPublicEDKey=RELEASE['publicKey'],SUEnableAutomaticChecks=True,SUAutomaticallyUpdate=True,
        SUScheduledCheckInterval=3600,SUVerifyUpdateBeforeExtraction=True,SURequireSignedFeed=True,
        SUEnableSystemProfiling=False)
    info_path.write_bytes(plistlib.dumps(app_info))

    write_source(resources)
    write_shell(resources)
    run('/bin/bash', ROOT/'bluetooth-connection/build.sh', APP/'Contents/Helpers/rach3 Bluetooth.app')
    bundle_codex(resources)
    bundle_engine(resources)
    shutil.copy2(ROOT/'desktop/release.json',resources/'release.json')
    frameworks = APP/'Contents/Frameworks'
    shutil.copytree(SPARKLE/'Sparkle.framework',frameworks/'Sparkle.framework',symlinks=True)
    compile_updates(resources/'updates.node')

    iconset = BUILD / 'Rach3.iconset'
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 128, 256, 512):   # desktop/AppIcon.png comes from brand/make.py
        for scale in (1, 2):
            name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
            run('sips', '-z', size*scale, size*scale, ROOT/'desktop/AppIcon.png', '--out', iconset/name)
    run('iconutil', '-c', 'icns', iconset, '-o', resources / 'Rach3.icns')
    sign(APP)
    archive = DIST / 'rach3-macOS.zip'
    if archive.exists():
        archive.unlink()
    print(f'Application: {APP}')
    if not args.app_only: build_installer()


if __name__ == '__main__':
    main()
