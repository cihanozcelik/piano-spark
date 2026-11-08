"""Small shims that let the Intel tool set run on PyTorch 2.2.

PyTorch stopped publishing Intel macOS wheels after 2.2.2, while audio-separator
imports ``torch.nn.attention`` (added in 2.3) only to choose SDPA kernels. On the
CPU, which is the only device used on Intel, PyTorch 2.2 has no kernel choice to
make, so the shim is a no-op context manager. Newer PyTorch is left untouched.
"""
import contextlib
import enum
import sys
import types


def install():
    import torch
    import torch.compiler
    import torch.nn
    if not hasattr(torch.compiler, 'is_compiling'):
        # Added in 2.3. The lesson engine never uses torch.compile.
        torch.compiler.is_compiling = lambda: False
    try:
        import torch.nn.attention  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    class SDPBackend(enum.IntEnum):
        ERROR = -1
        MATH = 0
        FLASH_ATTENTION = 1
        EFFICIENT_ATTENTION = 2
        CUDNN_ATTENTION = 3

    @contextlib.contextmanager
    def sdpa_kernel(backends, set_priority=False):
        yield

    module = types.ModuleType('torch.nn.attention')
    module.SDPBackend, module.sdpa_kernel = SDPBackend, sdpa_kernel
    module.__all__ = ['SDPBackend', 'sdpa_kernel']
    sys.modules['torch.nn.attention'] = module
    torch.nn.attention = module
