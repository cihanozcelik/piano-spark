"""Build the Windows app folder: the C# shell, the same offline page as the Mac app,
and the Windows lesson engine. Runs on Windows (GitHub's windows-latest runner).

    python windows/build.py              -> dist/windows/Piano Spark
    python windows/build.py --capture D  -> a development build that saves screenshots
                                            to D and creates a test lesson, then exits
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'windows'), str(ROOT/'desktop')]
from engine import prepare_runtime, stage_engine  # noqa: E402

RELEASE = json.loads((ROOT/'desktop/release.json').read_text(encoding='utf-8'))
PROJECT = ROOT/'windows/PianoSpark/PianoSpark.csproj'
DIST = ROOT/'dist/windows/Piano Spark'


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
    if resources.exists(): shutil.rmtree(resources)
    mac_build().write_ui(resources)
    page = resources/'index.html'
    html = page.read_text(encoding='utf-8')
    script = '<script>window.PianoPlatformText=' + json.dumps(platform_text(), ensure_ascii=False).replace('</', '<\\/') + ';</script>'
    if html.count('<head>') != 1: raise RuntimeError('The page head changed; update windows/build.py')
    page.write_text(html.replace('<head>', '<head>'+script, 1), encoding='utf-8')
    # The page loads its music font next to itself, as in the Mac app.
    shutil.copytree(ROOT/'assets/bravura', resources/'assets/bravura')
    (resources/'strings.json').write_text(json.dumps(native_strings(), ensure_ascii=False, indent=1), encoding='utf-8')
    shutil.copy2(ROOT/'desktop/release.json', resources/'release.json')


def compile_shell(output, capture):
    if output.exists(): shutil.rmtree(output)
    subprocess.run(['dotnet', 'build', str(PROJECT), '-c', 'Release', '-nologo', '-o', str(output),
                    f'-p:PianoVersion={RELEASE["version"]}', f'-p:PianoCapture={"true" if capture else "false"}'],
                   check=True)
    for leftover in output.glob('*.pdb'): leftover.unlink()


def build(destination, capture=False):
    work = ROOT/'build/windows'/('capture' if capture else 'release')
    compile_shell(work/'shell', capture)
    if destination.exists(): shutil.rmtree(destination)
    shutil.copytree(work/'shell', destination)
    write_resources(destination/'Resources')
    stage_engine(destination/'Engine', prepare_runtime())
    size = sum(path.stat().st_size for path in destination.rglob('*') if path.is_file())
    print(f'Windows app: {destination} ({size/1e6:.0f} MB)')
    return destination


def capture(directory, midi):
    app = build(ROOT/'build/windows/capture/Piano Spark', capture=True)
    directory.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([str(app/'PianoSpark.exe'), '--capture', str(directory), '--self-test-midi', str(midi)],
                            timeout=1200)
    for name in ('capture-error.txt', 'page-errors.txt', 'self-test.json'):
        path = directory/name
        if path.exists() and path.read_text(encoding='utf-8').strip():
            print(f'{name}:\n{path.read_text(encoding="utf-8")}')
    missing = [name for name in ('practice.png', 'create-lesson.png', 'lesson-created.png')
               if not (directory/name).is_file() or (directory/name).stat().st_size < 10000]
    if result.returncode or missing:
        raise RuntimeError(f'Windows capture failed (exit {result.returncode}, missing {missing})')
    print(f'Windows screenshots and bridge self-test passed: {directory}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--capture', type=Path, help='Save screenshots here and run the bridge self-test')
    parser.add_argument('--midi', type=Path, default=ROOT/'assets/example-lessons/bach-prelude/score.mid')
    args = parser.parse_args()
    if args.capture: capture(args.capture.resolve(), args.midi.resolve())
    else: build(DIST)


if __name__ == '__main__':
    main()
