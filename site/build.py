"""Build the public Piano Spark website from published release metadata only."""
import argparse
import html
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
)


def download_context(release_path):
    if release_path is None:
        return {
            '__DOWNLOAD_CTA__': '<button class="button button-primary download-link" type="button" disabled>Download coming soon</button>',
            '__DOWNLOAD_CTA_COMPACT__': '<button class="button button-small download-link" type="button" disabled>Coming soon</button>',
            '__RELEASE_LABEL__': 'First release coming soon',
            '__DOWNLOAD_DETAILS__': 'The first public build is being prepared. No account will be required.',
            '__RELEASE_NOTES_LINK__': '',
        }

    release = json.loads(release_path.read_text())
    if release['draft'] or release['prerelease']:
        raise RuntimeError('The website requires a published stable release')
    tag = release['tag_name']
    version = tag.removeprefix('v')
    names = (f'PianoSpark-{version}.tar.xz', f'PianoMan-{version}.tar.xz')
    asset = next((asset for name in names for asset in release['assets']
                  if asset['name'] == name and asset['state'] == 'uploaded' and asset['size'] > 0), None)
    if asset is None:
        raise RuntimeError('Published release has no complete downloadable Mac application archive')

    url = asset['browser_download_url']
    parsed = urlsplit(url)
    expected_path = f'/{REPOSITORY}/releases/download/{tag}/{asset["name"]}'
    if (parsed.scheme != 'https' or parsed.netloc != 'github.com'
            or unquote(parsed.path) != expected_path or parsed.query or parsed.fragment):
        raise RuntimeError('Download must point directly to this repository’s published binary asset')
    escaped_url = html.escape(url, quote=True)
    notes_url = html.escape(f'https://github.com/{REPOSITORY}/releases/tag/{tag}', quote=True)
    size = asset['size'] / 1024**3
    return {
        '__DOWNLOAD_CTA__': f'<a class="button button-primary download-link" href="{escaped_url}">Download for Mac <span aria-hidden="true">↓</span></a>',
        '__DOWNLOAD_CTA_COMPACT__': f'<a class="button button-small download-link" href="{escaped_url}">Download</a>',
        '__RELEASE_LABEL__': html.escape(tag),
        '__DOWNLOAD_DETAILS__': f'macOS 14 or later · Apple Silicon · {size:.1f} GiB initial download',
        '__RELEASE_NOTES_LINK__': f'<a class="release-link" href="{notes_url}">Release notes <span aria-hidden="true">↗</span></a>',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-info', type=Path, help='GitHub API response for the latest published release')
    parser.add_argument('--appcast', type=Path, help='Already signed public update feed')
    args = parser.parse_args()
    replacements = download_context(args.release_info)
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
    (output/'index.html').write_text(source)
    for name in STATIC_FILES:
        target = output/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/'site'/name, target)
    (output/'.nojekyll').write_text('')
    if args.appcast:
        shutil.copy2(args.appcast, output/'appcast.xml')
    print(output)


if __name__ == '__main__':
    main()
