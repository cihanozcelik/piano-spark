#!/bin/bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
bundle="$project_dir/build/rach3 Bluetooth.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$project_dir/Info.plist" "$bundle/Contents/Info.plist"
pending="$bundle/Contents/MacOS/.rach3-bluetooth-$$"
trap 'rm -f -- "$pending"' EXIT
xcrun clang -fobjc-arc -fblocks -std=gnu11 -Wall -Wextra -Werror \
  -mmacosx-version-min=13.0 -framework Foundation -framework CoreBluetooth \
  "$project_dir/main.m" "$project_dir/BLEMIDI.m" "$project_dir/BLEMIDIOutput.m" -o "$pending"
mv -f -- "$pending" "$bundle/Contents/MacOS/rach3-bluetooth"
codesign --force --sign - --timestamp=none "$bundle"
