"""Build the public Rach3 website from published release metadata only."""
import argparse
import html
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'cihanozcelik/piano-spark'
STATIC_FILES = (
    'style.css',
    'assets/practice.png',
    'assets/create-lesson.png',
    'assets/keyboard-hero.jpg',
    'assets/rach3-wordmark.png',
    'assets/rach3-app-icon.png',
    'assets/rach3-logo.png',
    'assets/favicon.png',
    'assets/apple-touch-icon.png',
)


# The first release built as a universal app (Apple Silicon and Intel). Older
# published releases keep their Apple Silicon only wording, so the site never
# promises Intel support before an Intel-capable DMG is actually published.
UNIVERSAL_SINCE = (0, 9, 0)
CHIP_HELP = ('One download works on both. Not sure which Mac you have? Choose Apple menu '
             '→ About This Mac: “Chip” means Apple Silicon, “Processor” means Intel.')


def compatibility(universal):
    if not universal:
        return {
            '__PLATFORM_LINE__': 'Made for Mac. Played on your piano.',
            '__MAC_TITLE__': 'Apple Silicon.<br>macOS 14 or later.',
            '__MAC_TEXT__': 'Open the DMG, drag Rach3 to Applications, then open it from there. No separate Python installation or background service to manage.',
            '__CHIP_SUPPORT__': '<ul class="chip-list" aria-label="Supported Macs"><li><strong>Apple Silicon</strong><span>M1 and later</span></li></ul>',
            '__CHIP_SUMMARY__': 'Apple Silicon',
        }
    return {
        '__PLATFORM_LINE__': 'For Apple Silicon and Intel Macs. Played on your piano.',
        '__MAC_TITLE__': 'Apple Silicon or Intel.<br>macOS 14 or later.',
        '__MAC_TEXT__': 'One download for both kinds of Mac. Open the DMG, drag Rach3 to Applications, then open it from there. No separate Python installation or background service to manage. On Intel, removing vocals from a video takes longer.',
        '__CHIP_SUPPORT__': ('<ul class="chip-list" aria-label="Supported Macs"><li><strong>Apple Silicon</strong><span>M1 and later</span></li>'
                             '<li><strong>Intel</strong><span>macOS 14 or later</span></li></ul>'
                             f'<p class="chip-help">{html.escape(CHIP_HELP)}</p>'),
        '__CHIP_SUMMARY__': 'Apple Silicon and Intel',
    }


# Releases before the Rach3 rename used the Piano Spark file names.
MAC_SETUP = ('Rach3-Setup.dmg', 'PianoSpark-Setup.dmg')
WINDOWS_SETUP = ('Rach3-win-Setup.exe', 'PianoSpark-win-Setup.exe')
WINDOWS_HELP = ('Windows may say it protected your PC, because the beta is not yet signed with a '
                'publisher certificate. Choose More info → Run anyway.')


def release_asset(release, names):
    """A published binary asset of this release (the first of names it has),
    refusing links that point anywhere else."""
    uploaded = {asset['name']: asset for asset in release['assets'] if asset['state'] == 'uploaded' and asset['size'] > 0}
    asset = next((uploaded[name] for name in names if name in uploaded), None)
    if asset is None:
        return None
    parsed = urlsplit(asset['browser_download_url'])
    expected_path = f'/{REPOSITORY}/releases/download/{release["tag_name"]}/{asset["name"]}'
    if (parsed.scheme != 'https' or parsed.netloc != 'github.com'
            or unquote(parsed.path) != expected_path or parsed.query or parsed.fragment):
        raise RuntimeError('Download must point directly to this repository’s published binary asset')
    return asset


def windows_download(release):
    asset = release_asset(release, WINDOWS_SETUP)
    if asset is None:
        return ''
    url = html.escape(asset['browser_download_url'], quote=True)
    return (f'<div class="windows-download"><a class="text-link" href="{url}">Download for Windows (beta) '
            f'<span aria-hidden="true">↓</span></a><p>Windows 10 or 11 · 64-bit · {asset["size"]/1e6:.1f} MB installer. '
            f'{html.escape(WINDOWS_HELP)}</p></div>')


def download_context(release_path):
    if release_path is None:
        return {
            **compatibility(True),
            '__DOWNLOAD_CTA__': '<button class="button button-primary download-link" type="button" disabled>Download coming soon</button>',
            '__DOWNLOAD_CTA_COMPACT__': '<button class="button button-small download-link" type="button" disabled>Coming soon</button>',
            '__RELEASE_LABEL__': 'First release coming soon',
            '__DOWNLOAD_DETAILS__': 'The first public build is being prepared. No account will be required.',
            '__RELEASE_NOTES_LINK__': '',
            '__WINDOWS_DOWNLOAD__': '',
        }

    release = json.loads(release_path.read_text())
    if release['draft'] or release['prerelease']:
        raise RuntimeError('The website requires a published stable release')
    tag = release['tag_name']
    version = tag.removeprefix('v')
    universal = tuple(int(part) for part in version.split('.')[:3]) >= UNIVERSAL_SINCE
    asset = release_asset(release, MAC_SETUP)
    if asset is None:
        return download_context(None)

    url = asset['browser_download_url']
    escaped_url = html.escape(url, quote=True)
    notes_url = html.escape(f'https://github.com/{REPOSITORY}/releases/tag/{tag}', quote=True)
    size = asset['size'] / 1e6
    chips = compatibility(universal)
    return {
        **chips,
        '__DOWNLOAD_CTA__': f'<a class="button button-primary download-link" href="{escaped_url}">Download for Mac <span aria-hidden="true">↓</span></a>',
        '__DOWNLOAD_CTA_COMPACT__': f'<a class="button button-small download-link" href="{escaped_url}">Download</a>',
        '__RELEASE_LABEL__': html.escape(tag)+' · Public beta',
        '__DOWNLOAD_DETAILS__': f'macOS 14 or later · {chips["__CHIP_SUMMARY__"]} · {size:.1f} MB · DMG installer',
        '__RELEASE_NOTES_LINK__': f'<a class="release-link" href="{notes_url}">Release notes <span aria-hidden="true">↗</span></a>',
        '__WINDOWS_DOWNLOAD__': windows_download(release),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-info', type=Path, help='GitHub API response for the latest published release')
    parser.add_argument('--appcast', type=Path, help='Already signed public update feed')
    args = parser.parse_args()
    replacements = download_context(args.release_info)
    replacements.pop('__CHIP_SUMMARY__', None)
    source = (ROOT/'site/index.html').read_text()
    for placeholder, value in replacements.items():
        source = source.replace(placeholder, value)
    if re.search(r'__[A-Z_]+__', source):
        raise RuntimeError('The website contains an unresolved template placeholder')

    # Rebuild a dedicated output directory; stale credentials, diagnostics and
    # files from other build tasks can never enter the Pages upload artifact.
    output = ROOT/'build/site'
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for name in STATIC_FILES:
        asset = ROOT/'site'/name
        digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:12]
        relative = Path(name)
        versioned = relative.with_name(f'{relative.stem}-{digest}{relative.suffix}')
        target = output/versioned
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset, target)
        source = source.replace(name, versioned.as_posix())
    (output/'index.html').write_text(source)
    (output/'.nojekyll').write_text('')
    if args.appcast:
        shutil.copy2(args.appcast, output/'appcast.xml')
    print(output)


if __name__ == '__main__':
    main()
