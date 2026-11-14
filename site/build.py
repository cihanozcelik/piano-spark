"""Build the public rach3 website from published release metadata only."""
import argparse
import html
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'cihanozcelik/rach3'
STATIC_FILES = (
    'analytics.js',
    'style.css',
    'assets/customize.jpg',
    'assets/tr/customize.jpg',
    'assets/ai-find.jpg',
    'assets/tr/ai-find.jpg',
    'assets/customize-original.jpg',
    'assets/tr/customize-original.jpg',
    'assets/metronome.jpg',
    'assets/tr/metronome.jpg',
    'assets/sleepy-cat.jpg',
    'assets/tr/sleepy-cat.jpg',
    'assets/practice.png',
    'assets/tr/practice.png',
    'assets/keyboard-hero.jpg',
    'assets/rach3-hero.png',
    'assets/piano-at-home.jpg',
    'assets/tr/piano-at-home.jpg',
    'assets/learner-morning.jpg',
    'assets/tr/learner-morning.jpg',
    'assets/learner-family.jpg',
    'assets/tr/learner-family.jpg',
    'assets/rach3-wordmark-on-dark.png',
    'assets/social-card.jpg',
    'assets/tr/social-card.jpg',
    'assets/rach3-app-icon.png',
    'assets/favicon.png',
    'assets/apple-touch-icon.png',
)


# The first release built as a universal app (Apple Silicon and Intel). Older
# published releases keep their Apple Silicon only wording, so the site never
# promises Intel support before an Intel-capable DMG is actually published.
UNIVERSAL_SINCE = (0, 9, 0)
CHIP_HELP = ('One download works on both. Not sure which Mac you have? Choose Apple menu '
             '→ About This Mac: “Chip” means Apple Silicon, “Processor” means Intel.')
WINDOWS_HELP = ('Windows may say it protected your PC, because the beta is not yet signed with a '
                'publisher certificate. Choose More info → Run anyway.')
MAC_SETUP = ('rach3-Setup.dmg',)
WINDOWS_SETUP = ('rach3-win-Setup.exe',)

APPLE_LOGO = ('<svg class="platform-logo" viewBox="0 0 814 1000" aria-hidden="true"><path d="M788.1 340.9c-5.8 4.5-108.2 '
              '62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 '
              '123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 '
              '126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5'
              'c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 '
              '135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>')
WINDOWS_LOGO = ('<svg class="platform-logo" viewBox="0 0 88 88" aria-hidden="true"><path d="M0 12.4 35.7 7.5v34.5H0zM40 6.9 87.3 0'
                'v41.6H40zM0 46.1h35.7v34.5L0 75.7zM40 46.6h47.3V88L40 81.3z"/></svg>')


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


def platform_card(logo, name, requirement, asset, button, kind, help_text, release_tag):
    """One platform in the download section: Mac and Windows side by side, alike."""
    if asset is None:
        action = '<button class="button" type="button" disabled>Coming soon</button>'
        size = ''
    else:
        url = html.escape(asset['browser_download_url'], quote=True)
        version = html.escape(release_tag, quote=True)
        action = (f'<a class="button" href="{url}" data-download-platform="{name.lower()}" '
                  f'data-release-version="{version}">{button} <span aria-hidden="true">↓</span></a>')
        size = f'<p class="platform-size">{asset["size"]/1e6:.1f} MB · {kind}</p>'
    return (f'<article class="platform-card">{logo}<h3>{name}</h3><p class="platform-requirement">{requirement}</p>'
            f'{action}{size}<p class="platform-help">{html.escape(help_text)}</p></article>')


def download_context(release_path):
    release = json.loads(release_path.read_text()) if release_path else None
    if release and (release['draft'] or release['prerelease']):
        raise RuntimeError('The website requires a published stable release')
    tag = release['tag_name'] if release else None
    version = tuple(int(part) for part in tag.removeprefix('v').split('.')[:3]) if tag else UNIVERSAL_SINCE
    universal = version >= UNIVERSAL_SINCE
    mac = release_asset(release, MAC_SETUP) if release else None
    windows = release_asset(release, WINDOWS_SETUP) if release else None
    chips = 'Apple Silicon and Intel' if universal else 'Apple Silicon'
    mac_help = CHIP_HELP if universal else 'For Macs with Apple Silicon (M1 and later).'
    cards = (platform_card(APPLE_LOGO, 'Mac', f'macOS 14 or later · {chips}', mac, 'Download for Mac', 'DMG installer', mac_help, tag)
             + platform_card(WINDOWS_LOGO, 'Windows', 'Windows 10 or 11 · 64-bit', windows, 'Download for Windows', 'Installer', WINDOWS_HELP, tag))
    if tag:
        notes_url = html.escape(f'https://github.com/{REPOSITORY}/releases/tag/{tag}', quote=True)
        label = (f'{html.escape(tag)} · Public beta · <a class="release-link" href="{notes_url}">Release notes '
                 '<span aria-hidden="true">↗</span></a>')
    else:
        label = 'The first public build is being prepared. No account will be required.'
    return {
        '__PLATFORM_LINE__': ('For Mac and Windows.' if universal
                              else 'For Apple Silicon Macs and Windows.'),
        '__MAC_TITLE__': 'Mac or Windows.',
        '__MAC_TEXT__': ('macOS 14 or later' + (' on Apple Silicon or Intel' if universal else ' on Apple Silicon')
                         + ', or Windows 10 or 11 (64-bit).'
                         + (' On Intel Macs, removing vocals from a video takes longer.' if universal else '')),
        '__PLATFORM_DOWNLOADS__': cards,
        '__RELEASE_LABEL__': label,
    }


# The English page lives at the site root, the Turkish one in tr/. Each links to the
# other; a small script in the page picks one for first-time visitors.
LANGUAGES = {
    'en': {'__LANG__': 'en', '__OTHER_LANG__': 'tr', '__OTHER_NAME__': 'Türkçe', '__OTHER_PAGE__': 'tr/'},
    'tr': {'__LANG__': 'tr', '__OTHER_LANG__': 'en', '__OTHER_NAME__': 'English', '__OTHER_PAGE__': '../'},
}
# Screenshots of the app (and photos showing it) in each language
LOCALIZED_ASSETS = ('assets/customize.jpg', 'assets/ai-find.jpg', 'assets/customize-original.jpg',
                    'assets/metronome.jpg', 'assets/sleepy-cat.jpg', 'assets/practice.png',
                    'assets/piano-at-home.jpg', 'assets/learner-morning.jpg', 'assets/learner-family.jpg')


def translate(english, template):
    """The Turkish page: every English text in site/tr.json swapped for its translation."""
    table = json.loads((ROOT/'site/tr.json').read_text())
    missing = [text for text in table['page'] if text not in template]
    if missing:
        raise RuntimeError('site/tr.json translates text that is no longer on the page: ' + missing[0][:80])
    page = english
    texts = {**table['page'], **table['release']}
    for text in sorted(texts, key=len, reverse=True):
        page = page.replace(text, texts[text])
    for name in LOCALIZED_ASSETS:
        page = page.replace(f'"{name}"', f'"{name.replace("assets/", "assets/tr/")}"')
    return page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-info', type=Path, help='GitHub API response for the latest published release')
    parser.add_argument('--appcast', type=Path, help='Already signed public update feed')
    args = parser.parse_args()
    replacements = download_context(args.release_info)
    measurement_id = json.loads((ROOT/'site/analytics.json').read_text())['measurement_id']
    if not isinstance(measurement_id, str) or (measurement_id and not re.fullmatch(r'G-[A-Z0-9]+', measurement_id)):
        raise RuntimeError('site/analytics.json requires a GA4 measurement ID (G-...) or an empty string to disable analytics')
    replacements['__ANALYTICS__'] = (f'<script defer src="analytics.js" data-measurement-id="{measurement_id}"></script>'
                                     if measurement_id else '')
    template = (ROOT/'site/index.html').read_text()
    pages = {}
    for language, names in LANGUAGES.items():
        source = template
        for placeholder, value in {**replacements, **names}.items():
            source = source.replace(placeholder, value)
        if re.search(r'__[A-Z_]+__', source):
            raise RuntimeError('The website contains an unresolved template placeholder')
        pages[language] = source
    pages['tr'] = translate(pages['tr'], template)

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
        for language in pages:
            # The Turkish page sits one folder down and shares the same files.
            up = '../' if language == 'tr' else ''
            pages[language] = (pages[language].replace(f'"{name}"', f'"{up}{versioned.as_posix()}"')
                               .replace(f'rach3.com/{name}"', f'rach3.com/{versioned.as_posix()}"'))
    (output/'index.html').write_text(pages['en'])
    (output/'tr').mkdir()
    (output/'tr/index.html').write_text(pages['tr'])
    (output/'.nojekyll').write_text('')
    if args.appcast:
        shutil.copy2(args.appcast, output/'appcast.xml')
    print(output)


if __name__ == '__main__':
    main()
