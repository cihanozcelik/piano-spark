#!/bin/zsh
set -eu
cd -- "${0:A:h}"
exec open dist/rach3.app
