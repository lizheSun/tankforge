#!/usr/bin/env python3
"""
TANKFORGE 策略导出：把 stable-baselines3 训练好的策略导出为 tankforge-model JSON
（导出后在「坦克工坊 → 🧠 模型策略（RL）」上传即可参战）

用法：
    pip install stable-baselines3 numpy
    python export_sb3.py path/to/your_sb3_model.zip -o my-tank.json

对齐要求（训练你的环境时必须遵守，否则导出的模型会"看不懂"战场）：
  - 观测空间 Box(shape=(24,), dtype=float32)，顺序与 src/game/modelBrain.ts buildObs 一致：
      [0] hp/maxHp                     [1] cooldown/fireInterval
      [2] sin(heading)  [3] cos(heading)
      [4] sin(turret)   [5] cos(turret)
      [6] 敌可见(0/1)
      [7] 敌dx/600  [8] 敌dy/400  [9] dist/viewRadius(截断2)
      [10] sin(敌heading)  [11] cos(敌heading)
      [12] 敌vx/240  [13] 敌vy/240  [14] 敌hp/190
      [15] (敌方位-炮塔)/180
      [16] timeLeft/90000  [17] x/1200  [18] y/800  [19] 1.0(bias)
      [20] 有过目击(0/1)
      [21] (上次目击敌x − self.x)/600   [22] (上次目击敌y − self.y)/400
      [23] 记忆年龄 min(1, 距目击ms/90000)；从未目击 = 1
    （敌不可见时 6=0、7..15=0、9=2；[20..23] 由平台记忆维护，训练环境自动提供）
  - 也兼容导出旧的 20 维 v1 模型（自动识别并标记 version 1）
  - 动作空间 Discrete(18)：idx = 转向(3) × 油门(3) × 开火(2)
      steer    = [-1, 0, 1][idx % 3]
      throttle = [1, 0.4, -0.6][(idx // 3) % 3]
      fire     = idx // 9 == 1
    （炮塔不用学：平台自动带提前量瞄准最近可见敌）
  - policy 必须是 MlpPolicy（全连接网络），激活 tanh（SB3 默认）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bootstrap import ensure_deps

ensure_deps(["numpy", "stable_baselines3"])

import numpy as np  # noqa: E402


def export(sb3_path: str, out_path: str) -> None:
    from stable_baselines3 import PPO, A2C, DQN, SAC, TD3  # noqa: F401

    # 依次尝试常见算法
    model = None
    for cls in (PPO, A2C, DQN):
        try:
            model = cls.load(sb3_path)
            break
        except Exception:
            continue
    if model is None:
        raise SystemExit(f"无法加载 {sb3_path}（支持 PPO/A2C/DQN + MlpPolicy）")

    pol = model.policy
    seq = pol.mlp_extractor.policy_net  # shared_net 或分开的 policy 头
    layers = []

    def push_linear(layer, act: bool):
        w = layer.weight.detach().cpu().numpy()  # [out, in]
        b = layer.bias.detach().cpu().numpy()
        layers.append(
            {
                "out": int(w.shape[0]),
                "w": [float(x) for x in w.reshape(-1)],
                "b": [float(x) for x in b],
                # act 仅记录用，正式结构见下
                "_act": act,
            }
        )

    for m in seq:
        if hasattr(m, "weight") and m.weight is not None:
            push_linear(m, act=True)
    head = pol.action_net  # 最后的离散头
    push_linear(head, act=False)

    # 清洗：去掉临时 _act 字段；确保 tanh
    clean = [
        {"out": L["out"], "w": L["w"], "b": L["b"]} for L in layers
    ]
    params = sum(len(L["w"]) + len(L["b"]) for L in clean)
    # 首层输入维度决定模型版本：24 维 → v2（带目击记忆），20 维 → v1（无记忆）
    first_in = len(clean[0]["w"]) // clean[0]["out"]
    if first_in == 24:
        version = 2
    elif first_in == 20:
        version = 1
    else:
        raise SystemExit(f"首层输入维度 {first_in} 既不是 24(v2) 也不是 20(v1)——请用 gym_tankforge.TankForgeEnv 训练")
    doc = {
        "format": "tankforge-model",
        "version": version,
        "activation": "tanh",
        "layers": clean,
        "notes": f"exported from {sb3_path}, params={params}, obs_dim={first_in}",
    }
    # 校验输入/输出维度
    ins = first_in
    for i, L in enumerate(clean):
        if len(L["w"]) != ins * L["out"]:
            raise SystemExit(f"第 {i + 1} 层输入维度不符（{ins}）——请确认 obs 空间维度")
        ins = L["out"]
    if ins != 18:
        raise SystemExit(f"输出维度 {ins} != 18——请确认 action 空间为 Discrete(18)")

    with open(out_path, "w") as f:
        json.dump(doc, f)
    print(f"✓ 已导出 {params} 参数 → {out_path}")
    print("  上传：坦克工坊 → 🧠 模型策略（RL）→ 上传该 JSON → 创建坦克参战")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sb3_model", help="stable-baselines3 模型文件 (.zip)")
    ap.add_argument("-o", "--out", default="my-tank.json")
    a = ap.parse_args()
    export(a.sb3_model, a.out)
