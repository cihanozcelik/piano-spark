"""Build only the public product website; never copy app/source/credentials into Pages."""
import argparse
import html
import json
from pathlib import Path
import shutil

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--release-info',type=Path)
parser.add_argument('--appcast',type=Path)
args=parser.parse_args()
output=root/'build/site'
output.mkdir(parents=True,exist_ok=True)
url='https://github.com/cihanozcelik/piano-spark/releases/latest'
label='İlk sürüm hazırlanıyor'
if args.release_info:
    release=json.loads(args.release_info.read_text())
    asset=next(a for a in release['assets'] if a['name'].startswith('PianoMan-') and a['name'].endswith('.tar.xz'))
    url=asset['browser_download_url']
    label=release['tag_name']
source=(root/'site/index.html').read_text().replace('__DOWNLOAD_URL__',html.escape(url,quote=True)).replace('__RELEASE_LABEL__',html.escape(label))
(output/'index.html').write_text(source)
shutil.copy2(root/'site/style.css',output/'style.css')
(output/'.nojekyll').write_text('')
if args.appcast: shutil.copy2(args.appcast,output/'appcast.xml')
else: (output/'appcast.xml').unlink(missing_ok=True)
print(output)
