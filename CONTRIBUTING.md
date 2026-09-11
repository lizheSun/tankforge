# 贡献指南 / Contributing

感谢你愿意参与 TANKFORGE！无论是提交 Bug、改进文档、新增内置 AI，还是优化渲染效果，都欢迎。

## 环境要求

| 依赖 | 版本 | 是否必须 |
|---|---|---|
| Node.js | ≥ 20 | 必须 |
| Python | ≥ 3.10 | 仅 RL 训练需要 |
| MySQL | 8.x | 仅赛事 / 后端模块需要 |

## 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 启动前端（本地对战功能完整可用，无需后端）
npm run dev            # http://localhost:5173

# 3.（可选）启动后端：赛事 / 排行榜 / 数据持久化
npm run server         # http://localhost:8787（tsx watch 热重载）
#   启动后在「⚙ 系统管理」页配置 MySQL 连接并初始化数据表
```

前端 `vite.config.ts` 已把 `/api` 代理到 `http://localhost:8787`，两会话同时跑即可联调。

## 代码结构速览

```
src/game/      确定性战斗内核（引擎/地图/弹道/Bot/模型大脑）—— 改动最需谨慎的目录
src/sandbox/   前端沙箱（Web Worker）
src/replay/    回放录制与重演
src/render/    Canvas 渲染
src/pack/      策略包（.zip）导入导出
src/ui/        React 界面
server/        可选后端（Express + MySQL）
scripts/rl/    RL 训练管线（进化 / PPO / 自我对弈 / 导出）
scripts/*.ts   冒烟、压力、回放一致性检查
```

## 提交前检查（必跑）

```bash
npm run build          # 类型检查 + 生产构建
npm run smoke          # 冒烟对战（内置 Bot headless 对局）
npm run replay:check   # 回放确定性校验
```

**改了 `src/game/` 或 `src/sandbox/` 的，必须额外跑：**

```bash
npm run m1             # 压力测试批量对局
npm run m1:strict      # 严格模式（偏差即失败）
npm run m3             # 团战场景
```

## 开发约定

1. **确定性是铁律**：引擎路径（`src/game/`）内**禁止**使用 `Date.now()` / `Math.random()` / 非确定性排序。一切随机必须走 `ctx.rng()` 或种子化 RNG——否则回放会漂移、前后端会分歧。
2. **意图模式**：策略/模型永远不能直接修改战场状态，只能提交意图由引擎裁决。新增能力时请遵守这条边界。
3. **观测/动作契约变更 = 破坏性改动**：修改 `buildObs` 维度或动作空间必须同步 `scripts/rl/gym_tankforge.py`、`scripts/rl/export_sb3.py` 与文档，并提升模型 `version`；旧版本模型必须保持可用（向后兼容）。
4. **界面文案使用中文**，风格保持现有科技感（暗色 + 霓虹强调色）。
5. **不引入重型依赖**：前端保持轻量，RL 依赖单独隔离在 `scripts/rl/`。

## 提交规范

提交信息使用简明的 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 风格前缀：

```
feat: 新增雷达扫描能力点
fix: 修正团战出生点重叠
docs: 补充回放指纹说明
perf: 优化渲染批次合并
refactor: 拆分引擎事件派发
```

## Pull Request 流程

1. Fork 本仓库并从 `main` 切出分支（`feat/xxx`、`fix/xxx`）
2. 完成改动并跑完上表检查
3. 提交 PR，描述：**做了什么 / 为什么 / 怎么验证的**（附命令或截图）
4. 涉及玩法数值平衡的改动，请附压力测试数据（`npm run m1`）

## 报告问题

提 Issue 时请带上：复现步骤、期望行为、实际行为、浏览器/Node 版本；涉及对局的请附种子（Seed）与双方策略，便于精确复现。

## 行为准则

- 友善、专业、就事论事
- 尊重不同水平的贡献者（本项目定位就是"从新手到研究者"的梯度平台）
- 不提交任何来自他人且无授权的代码
