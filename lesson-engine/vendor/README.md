# Small source dependencies

Rubato transcription 0.3.0 is vendored from nctamer/rubato-transcription revision
325d90df334f7fe7e8e2c8c90a297c927e635dcc (AGPL-3.0). All Python sources and the
upstream license are included. The model is downloaded separately.

Diffq 0.2.4 is from https://pypi.org/project/diffq/0.2.4/ (MIT). Its upstream
release has no CPython 3.12 macOS ARM64 wheel. The included bitpack extension was
built from that pinned source with CPython 3.12, Cython and Apple clang for arm64;
Python and Cython sources and its license are included. Local debug symbols are
stripped with `xcrun strip -S`. The app packager ad-hoc signs the extension.

`desktop/lock_tools.py` copies these distributions from the pinned development
environment while excluding bytecode, local install metadata and script paths.
No package resolver, compiler or system installation is needed on recipient Macs.
All other Python packages are fetched as hash-pinned upstream wheels on demand.
