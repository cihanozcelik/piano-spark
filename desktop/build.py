"""Build a self-contained Apple Silicon app and a per-user installer disk image."""
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
APP = DIST / 'Piano Spark.app'
RELEASE = json.loads((ROOT/'desktop/release.json').read_text())


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, cwd=ROOT)


def bundle_engine(resources):
    engine = resources/'Engine'
    runtime = ROOT/'build/lesson-python/cpython-3.12.12-macos-aarch64-none'
    packages = ROOT/'transcription/separation/.venv/lib/python3.12/site-packages'
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', 'tests', '.DS_Store')
    shutil.copytree(runtime,engine/'python',symlinks=True,ignore=ignore)
    shutil.copytree(packages,engine/'site-packages',symlinks=True,ignore=ignore)
    for name in ['worker.py','notation.py','notation_source.py','score_writer.py','score_import.py','pdf_recognizer.py']:
        shutil.copy2(ROOT/'lesson-engine'/name,engine/name)
    shutil.copytree(ROOT/'build/omr/.venv/lib/python3.12/site-packages',engine/'omr-site-packages',symlinks=True,ignore=ignore)
    shutil.copy2(ROOT/'lesson-engine/omr-requirements.lock.txt',engine/'omr-requirements.lock.txt')
    shutil.copytree(ROOT/'transcription/separation/models',engine/'models/separation',
                    ignore=shutil.ignore_patterns('*.aria2'))
    shutil.copy2(ROOT/'transcription/rubato/models/rubato.ckpt',engine/'models/rubato.ckpt')
    shutil.copy2(ROOT/'transcription/separation/requirements.lock.txt',engine/'requirements.lock.txt')
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
    installer = stage/'Piano Spark Installer.app'
    macos = installer/'Contents/MacOS'; macos.mkdir(parents=True)
    resources = installer/'Contents/Resources'; resources.mkdir()
    run('cp','-cR',APP,resources/'Piano Spark.app')
    plist = dict(CFBundleExecutable='PianoManInstaller',CFBundleIdentifier='com.pianoman.installer',
                 CFBundleName='Piano Spark Installer',CFBundlePackageType='APPL',CFBundleVersion=str(RELEASE['build']),
                 CFBundleShortVersionString=RELEASE['version'],LSMinimumSystemVersion='14.0',
                 NSHighResolutionCapable=True,NSPrincipalClass='NSApplication')
    with (installer/'Contents/Info.plist').open('wb') as stream: plistlib.dump(plist,stream)
    run('xcrun','clang','-arch','arm64','-fobjc-arc','-fblocks','-Wall','-Wextra','-Werror',
        '-mmacosx-version-min=14.0',ROOT/'desktop/Installer.m',ROOT/'desktop/Localization.m','-framework','AppKit',
        '-o',macos/'PianoManInstaller')
    run('codesign','--force','--sign','-','--timestamp=none',installer)
    run('codesign','--verify','--deep','--strict',installer)
    image = DIST/'PianoSpark-Setup.dmg'
    if image.exists(): image.unlink()
    run('hdiutil','create','-volname','Piano Spark Setup','-srcfolder',stage,'-format','UDZO',image)
    shutil.rmtree(stage)
    print(f'Installer: {image}\nSize: {image.stat().st_size/1000000:.1f} MB')


def write_ui(resources):
    # Flatten our known ES modules into one offline document. Tone's bundled
    # dependency and embedded song already live in piano.html, including license.
    scripts = []
    for name in ['workspace-state.js', 'sheet-music.js', 'piano-input.js', 'piano-output.js', 'practice-clock.js', 'staff-notation.js', 'bluetooth-connection/bluetooth-diagnostics.js', 'bluetooth-connection/bluetooth.js', 'create-lesson.js', 'app-shell.js', 'player.js']:
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
    html = html.replace('<!-- pianoman-notation-runtime -->', '')
    resources.mkdir(parents=True, exist_ok=True)
    licenses = resources/'Licenses/Verovio'
    licenses.mkdir(parents=True,exist_ok=True)
    for name in ['COPYING','COPYING.LESSER','README.md','package.json','package-lock.json']:
        shutil.copy2(ROOT/'assets/notation'/name,licenses/name)
    pending = resources / 'index.pending'
    pending.write_text(html)
    pending.replace(resources / 'index.html')


def compile_native(destination, objects_dir, capture=False):
    objects_dir.mkdir(parents=True, exist_ok=True)
    # Compile the existing BLE implementation into the same executable under a
    # private helper entry point. Lesson jobs use the bundled portable runtime.
    flags = ['-fobjc-arc', '-fblocks', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
             '-mmacosx-version-min=14.0', '-F', str(SPARKLE)]
    if capture: flags.append('-DPIANO_CAPTURE')
    binaries = []
    for arch in ['arm64']:
        objects = []
        for source, extra, name in [
            ('desktop/main.m', [], 'desktop'),
            ('desktop/Localization.m', [], 'localization'),
            ('desktop/LessonService.m', [], 'lessons'),
            ('desktop/UpdateController.m', [], 'updates'),
            ('bluetooth-connection/main.m', ['-Dmain=PianoBluetoothMain'], 'bluetooth'),
            ('bluetooth-connection/BLEMIDI.m', [], 'decoder'),
            ('bluetooth-connection/BLEMIDIOutput.m', [], 'midi-output'),
        ]:
            obj = objects_dir / f'{name}-{arch}.o'
            run('xcrun', 'clang', '-arch', arch, *flags, *extra, '-c', ROOT / source, '-o', obj)
            objects.append(obj)
        binary = objects_dir / f'PianoMan-{arch}'
        run('xcrun', 'clang', '-arch', arch, '-mmacosx-version-min=14.0', *objects,
            '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'Foundation',
            '-framework', 'CoreBluetooth', '-framework', 'UniformTypeIdentifiers',
            '-framework', 'Security', '-F', SPARKLE, '-framework', 'Sparkle',
            '-Wl,-rpath,@executable_path/../Frameworks', '-o', binary)
        binaries.append(binary)
    run('xcrun', 'lipo', '-create', *binaries, '-output', destination)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--app-only',action='store_true')
    parser.add_argument('--installer-only',action='store_true')
    parser.add_argument('--reuse-engine',action='store_true',help='Reuse this Mac’s unchanged bundled engine with APFS clones')
    parser.add_argument('--capture-assets',type=Path,help='Export actual app screenshots with an isolated development-only capture build')
    args=parser.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(exist_ok=True)
    if args.capture_assets:
        destination=args.capture_assets.resolve(); destination.mkdir(parents=True,exist_ok=True)
        capture_root=BUILD/'capture'
        capture_app=capture_root/APP.name
        if capture_root.exists(): shutil.rmtree(capture_root)
        capture_root.mkdir()
        try:
            run('cp','-cR',APP,capture_app)
            info_path=capture_app/'Contents/Info.plist'
            info=plistlib.loads(info_path.read_bytes())
            info['CFBundleIdentifier']='com.pianoman.capture'
            info_path.write_bytes(plistlib.dumps(info))
            compile_native(capture_app/'Contents/MacOS/PianoMan',capture_root/'objects',capture=True)
            run('codesign','--force','--sign','-','--timestamp=none',capture_app)
            run(capture_app/'Contents/MacOS/PianoMan',destination)
        finally:
            shutil.rmtree(capture_root)
        return
    if args.installer_only:
        build_installer(); return
    prepare_sparkle()
    cached_engine = BUILD/'reused-engine'
    if args.reuse_engine:
        if cached_engine.exists(): raise RuntimeError('A previous build left build/desktop/reused-engine; recover it before rebuilding')
        run('cp','-cR',APP/'Contents/Resources/Engine',cached_engine)
    if APP.exists():
        shutil.rmtree(APP)
    resources = APP / 'Contents/Resources'
    executable = APP / 'Contents/MacOS'
    resources.mkdir(parents=True)
    executable.mkdir()
    with (ROOT/'desktop/Info.plist').open('rb') as stream: app_info=plistlib.load(stream)
    app_info.update(LSMinimumSystemVersion='14.0',CFBundleVersion=str(RELEASE['build']),CFBundleShortVersionString=RELEASE['version'],
        SUFeedURL=RELEASE['feedURL'],
        SUPublicEDKey=RELEASE['publicKey'],SUEnableAutomaticChecks=True,SUAutomaticallyUpdate=True,
        SUScheduledCheckInterval=3600,SUVerifyUpdateBeforeExtraction=True,SURequireSignedFeed=True,
        SUEnableSystemProfiling=False)
    with (APP/'Contents/Info.plist').open('wb') as stream: plistlib.dump(app_info,stream)

    write_ui(resources)
    shutil.copytree(ROOT / 'assets/bravura', resources / 'assets/bravura')
    if args.reuse_engine:
        cached_engine.rename(resources/'Engine')
        for name in ['worker.py','notation.py','notation_source.py','score_writer.py','score_import.py','pdf_recognizer.py']:
            shutil.copy2(ROOT/'lesson-engine'/name,resources/'Engine'/name)
    else:
        bundle_engine(resources)
    shutil.copy2(ROOT/'desktop/release.json',resources/'release.json')
    frameworks = APP/'Contents/Frameworks'
    frameworks.mkdir()
    shutil.copytree(SPARKLE/'Sparkle.framework',frameworks/'Sparkle.framework',symlinks=True)

    compile_native(executable / 'PianoMan', BUILD)
    iconset = BUILD / 'PianoMan.iconset'
    iconset.mkdir(exist_ok=True)
    run('xcrun', 'swift', ROOT / 'desktop/Icon.swift', iconset)
    run('iconutil', '-c', 'icns', iconset, '-o', resources / 'PianoMan.icns')
    run('codesign', '--force', '--sign', '-', '--timestamp=none', APP)
    run('codesign', '--verify', '--deep', '--strict', APP)
    archive = DIST / 'PianoMan-macOS.zip'
    if archive.exists():
        archive.unlink()
    print(f'Application: {APP}')
    if not args.app_only: build_installer()


if __name__ == '__main__':
    main()
