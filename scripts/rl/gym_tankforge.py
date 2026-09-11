# -*- coding: utf-8 -*-
"""
TankForge Gymnasium 环境：子进程驱动真实 TS 引擎（scripts/rl/bridge.ts）
观测 24 维 / 动作 18 离散 —— 与线上模型坦克完全一致，训练即实战。

观测（v2，与 src/game/modelBrain.ts buildObs 严格一致）：
  [0..19] 同 v1（hp/冷却/朝向/炮塔/敌可见与相对位姿/时间/位置/bias）
  [20] 是否有过目击  [21][22] 上次目击点相对当前位置（x/600, y/400）
  [23] 记忆年龄（0=刚目击 .. 1=很久/从未）

依赖：pip install gymnasium numpy
"""
import json
import os
import random
import subprocess

import gymnasium as gym
import numpy as np
from gymnasium import spaces

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIDGE = os.path.join(ROOT, "scripts", "rl", "bridge.ts")


class TankForgeEnv(gym.Env):
    """参数与 bridge.ts 对齐：
    opponent: rookie / veteran / master / evolve-best（用进化产物当陪练）
    preset_idx: RL 车的 Build 预设（默认 3=游侠，带辅助瞄具）
    duration_ms: 默认 90_000（与线上天梯/服务端一致，观测 o[16] 才不会偏移）
    """

    metadata = {"render_modes": []}

    def __init__(self, opponent="veteran", map_id="crossroads", preset_idx=3, duration_ms=90_000, seed=None):
        super().__init__()
        self.observation_space = spaces.Box(low=-3.0, high=3.0, shape=(24,), dtype=np.float32)
        self.action_space = spaces.Discrete(18)
        self._opponent = opponent
        self._map_id = map_id
        self._preset_idx = preset_idx
        self._duration_ms = duration_ms
        self._seed = seed
        self._proc = None

    # ---- 子进程管理 ----
    def _ensure(self):
        if self._proc is None:
            self._proc = subprocess.Popen(
                ["npx", "tsx", BRIDGE],
                cwd=ROOT,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                bufsize=1,
            )

    def _send(self, obj):
        self._ensure()
        self._proc.stdin.write(json.dumps(obj) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("训练桥已退出（检查 bridge.ts 日志）")
        return json.loads(line)

    # ---- Gymnasium API ----
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        # 未显式给种子时每局随机（训练多样性：出生/噪声/陪练轨迹每局不同）
        if seed is not None:
            s = int(seed)
        elif self._seed is not None:
            s = int(self._seed)
        else:
            s = random.randrange(1, 2**31)
        # 注意：字段名用 camelCase，与 bridge.ts 的 Req 完全一致
        # （历史 bug：曾发 map_id/preset_idx/duration_ms，桥不认识、静默走默认值）
        r = self._send({
            "op": "reset",
            "seed": s,
            "opponent": self._opponent,
            "mapId": self._map_id,
            "presetIdx": self._preset_idx,
            "durationMs": self._duration_ms,
        })
        if "error" in r:
            raise RuntimeError(f"reset 失败：{r['error']}")
        return np.array(r["obs"], dtype=np.float32), r["info"]

    def step(self, action):
        r = self._send({"op": "step", "action": int(action)})
        if "error" in r:
            raise RuntimeError(f"step 失败：{r['error']}")
        return (
            np.array(r["obs"], dtype=np.float32),
            float(r["reward"]),
            bool(r["done"]),
            False,
            r["info"],
        )

    def close(self):
        if self._proc is not None:
            try:
                self._send({"op": "close"})
            except Exception:
                pass
            self._proc.terminate()
            self._proc = None
