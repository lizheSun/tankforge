#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自我进化训练（self-play league）：

  起点阶段（自动）：若起点模型不存在，先用 master 训练一个「毕业生」
  循环阶段：每轮把「上一轮的自己」导出为陪练模型，在陪练池中继续训练 ——
      每局对手按 seed 确定性轮换：5 局自己（上一版）/ 3 局 master / 2 局 veteran
      （混合陪练防「只打自己」的灾难性遗忘与循环克制，参考 AlphaStar 联赛机制）

用法：
    python3 scripts/rl/selfplay.py --rounds 10 --steps 300000
    # 每轮 30 万步 ≈ 280 局；10 轮 = 300 万步。中途可 Ctrl-C，用 --base 续跑

产物：tank-ppo-sp0.zip（起点）→ tank-ppo-sp1.zip … tank-ppo-sp{N}.zip（最终最强）
判据：看每轮结束自动打印的 vs rookie/veteran/master 胜率走势；
      master 胜率连着 2~3 轮不涨就该早停（边际收益递减）。
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from _bootstrap import ensure_deps

ensure_deps(["numpy", "gymnasium", "stable_baselines3"])

from export_sb3 import export  # noqa: E402


def train(*extra):
    cmd = [sys.executable, os.path.join(HERE, "train_ppo.py"), *map(str, extra)]
    print("\n" + "=" * 62)
    print(">>", " ".join(cmd))
    print("=" * 62, flush=True)
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=10, help="自我进化轮数（默认 10）")
    ap.add_argument("--steps", type=int, default=300_000, help="每轮训练步数（默认 30 万；1 局=1080 步）")
    ap.add_argument("--envs", type=int, default=8)
    ap.add_argument("--device", type=str, default="auto")
    ap.add_argument("--lr", type=float, default=1.5e-4,
                    help="每轮学习率（默认 1.5e-4 微调步长，防止冲掉已学技能）")
    ap.add_argument("--base", type=str, default="tank-ppo-sp0",
                    help="起点模型名（默认 tank-ppo-sp0；不存在则自动先用 master 训一个）")
    ap.add_argument("--seed-steps", type=int, default=1_000_000,
                    help="起点训练步数（仅当起点 .zip 不存在时使用）")
    args = ap.parse_args()

    opponent_json = os.path.join(HERE, "sp-opponent.json")  # 每轮覆盖：始终是「上一轮的自己」
    league = f"league:{opponent_json}"

    # ---- 0) 起点阶段：先打到能赢 master ----
    if not os.path.exists(args.base + ".zip"):
        print(f"[起点] {args.base}.zip 不存在 → 先用 master 训练起点（{args.seed_steps} 步）")
        train("--steps", args.seed_steps, "--envs", args.envs,
              "--opponent", "master", "--save", args.base, "--device", args.device)

    # ---- 1) 自我进化循环 ----
    prev = args.base
    for r in range(1, args.rounds + 1):
        cur = f"tank-ppo-sp{r}"
        # 把上一轮的自己导出为陪练模型（bridge 侧用 makeModelBrain 跑，v2 带目击记忆）
        export(prev + ".zip", opponent_json)
        print(f"\n[round {r}/{args.rounds}] 陪练池 = 5×{prev} + 3×master + 2×veteran")
        # 从上一轮继续训练（不是从零），学习率用微调步长
        train("--steps", args.steps, "--envs", args.envs,
              "--opponent", league, "--resume", prev + ".zip", "--save", cur,
              "--lr", args.lr, "--device", args.device)
        prev = cur

    print("\n" + "=" * 62)
    print(f"✓ 自我进化完成：共 {args.rounds} 轮，最终模型 {prev}.zip")
    print(f"  python3 {os.path.join(HERE, 'export_sb3.py')} {prev}.zip -o my-tank.json")
    print("  → 坦克工坊 → 🧠 模型策略（RL）→ 上传 my-tank.json → 创建坦克参战")
    print("=" * 62)


if __name__ == "__main__":
    main()
