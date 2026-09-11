# -*- coding: utf-8 -*-
"""依赖引导：当前解释器缺依赖时，自动定位装有依赖的 Python 并重执行，避免"用错解释器"问题。"""
import importlib.util
import os
import subprocess
import sys

# 常见的全功能 Python 位置（按优先级）
_CANDIDATES = [
    os.path.expanduser("~/miniforge3/bin/python3"),
    os.path.expanduser("~/anaconda3/bin/python3"),
    os.path.expanduser("~/miniconda3/bin/python3"),
]


def _has(mod: str) -> bool:
    try:
        importlib.import_module(mod)
        return True
    except ImportError:
        return False


def ensure_deps(modules):
    missing = [m for m in modules if not _has(m)]
    if not missing:
        return
    # 在候选解释器里找装齐依赖的，找到就替换自身进程
    for cand in _CANDIDATES:
        if not os.path.exists(cand) or os.path.realpath(cand) == os.path.realpath(sys.executable):
            continue
        probe = "import " + ", ".join(modules)
        try:
            r = subprocess.run([cand, "-c", probe], capture_output=True, timeout=30)
        except Exception:  # noqa: BLE001
            continue
        if r.returncode == 0:
            print(f"[依赖重定向] 当前解释器缺 {missing}，改用 {cand} 重新执行", file=sys.stderr)
            os.execv(cand, [cand] + sys.argv)
            return  # execv 不返回，保险起见
    print(
        f"✗ 当前解释器 {sys.executable} 缺少依赖：{missing}\n"
        f"  解决：{cand_hint()} -m pip install " + " ".join(modules),
        file=sys.stderr,
    )
    sys.exit(1)


def cand_hint() -> str:
    for c in _CANDIDATES:
        if os.path.exists(c):
            return c
    return "python3"
