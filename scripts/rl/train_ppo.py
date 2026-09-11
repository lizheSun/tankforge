#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PPO 正式训练：真实引擎桥接环境 → SB3 PPO → tank-ppo.zip
训完后导出参战：
    python3 scripts/rl/export_sb3.py tank-ppo.zip -o my-tank.json
    → 坦克工坊 → 🧠 模型策略（RL）→ 上传 my-tank.json

用法：
    pip install stable-baselines3 gymnasium numpy
    python3 scripts/rl/train_ppo.py --steps 2000000 --envs 8 --opponent veteran
参数：
    --steps   总训练步数（默认 200 万；每步=一个决策帧≈83ms 游戏时间）
    --envs    并行环境数（每个环境一个 Node 桥进程）
    --opponent 陪练：rookie / veteran / master / evolve-best（用进化最优当陪练）
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _bootstrap import ensure_deps

ensure_deps(["numpy", "gymnasium", "stable_baselines3"])

from gym_tankforge import TankForgeEnv  # noqa: E402


def make_env(rank: int, opponent: str):
    def _init():
        # 不传固定 seed：每局对局种子随机（出生/噪声/陪练轨迹每局不同，训练更泛化）
        return TankForgeEnv(opponent=opponent)

    return _init


def evaluate(model, opponent: str, n: int = 10) -> float:
    env = TankForgeEnv(opponent=opponent)
    try:
        wins = 0
        for i in range(n):
            obs, _ = env.reset(seed=90_000 + i)
            done = False
            while not done:
                action, _ = model.predict(obs, deterministic=True)
                obs, _, done, _, info = env.step(action)
            if info.get("winner") == "red":
                wins += 1
        return wins / n
    finally:
        env.close()  # 异常路径也要关闭，否则 Node 桥子进程泄漏


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=2_000_000)
    ap.add_argument("--envs", type=int, default=8)
    ap.add_argument("--opponent", type=str, default="veteran")
    ap.add_argument("--save", type=str, default="tank-ppo")
    ap.add_argument("--resume", type=str, default=None,
                    help="从已保存模型继续训练（如 tank-ppo.zip），无需从头再练")
    ap.add_argument("--device", type=str, default="auto", choices=["auto", "cpu", "mps", "cuda"],
                    help="训练设备：auto(默认) / cpu / mps(Apple GPU) / cuda")
    ap.add_argument("--lr", type=float, default=None,
                    help="学习率覆盖（默认不覆盖：新建=3e-4，续训=沿用模型原值）。"
                         "进阶微调建议减半，如 --lr 1.5e-4，防止把已学技能冲掉")
    args = ap.parse_args()

    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import SubprocVecEnv

    env = SubprocVecEnv([make_env(i, args.opponent) for i in range(max(1, args.envs))])
    if args.resume:
        model = PPO.load(args.resume, env=env, device=args.device, verbose=1)
        if args.lr is not None:
            model.learning_rate = args.lr
            print(f"  学习率已覆盖为 {args.lr}")
        print(f"✓ 已从 {args.resume} 继续训练")
    else:
        model = PPO(
            "MlpPolicy",
            env,
            n_steps=2048,
            batch_size=1024,
            learning_rate=args.lr if args.lr is not None else 3e-4,
            gamma=0.99,
            gae_lambda=0.95,
            ent_coef=0.01,          # 鼓励探索，防止过早僵化
            clip_range=0.2,
            device=args.device,     # Apple Silicon 可试 --device mps
            verbose=1,
        )
    model.learn(total_timesteps=args.steps)
    model.save(args.save)
    env.close()
    print(f"\n✓ 训练完成，已保存 {args.save}.zip")

    # 评估各对手胜率
    for opp in ("rookie", "veteran", "master"):
        try:
            wr = evaluate(model, opp)
            print(f"  vs {opp:8s} 胜率 {wr:.0%}")
        except Exception as e:  # noqa: BLE001
            print(f"  vs {opp} 评估失败：{e}")

    print("\n下一步：")
    print(f"  python3 {os.path.join(HERE, 'export_sb3.py')} {args.save}.zip -o my-tank.json")
    print("  → 坦克工坊 → 🧠 模型策略（RL）→ 上传 my-tank.json → 创建坦克参战")


if __name__ == "__main__":
    main()
