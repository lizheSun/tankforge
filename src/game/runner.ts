import { DECISION_PERIOD, DECISION_TIMEOUT_SANCTION_TICKS, DT_MS, MAX_DECIDE_MS, MAX_SANCTIONS } from './constants';
import {
  applyActions,
  buildCtx,
  createMatch,
  forceDestroy,
  step,
  viewEnemies,
  type EngineMatch,
  type MatchConfig,
} from './engine';
import type { Action, Ctx, Team } from './types';

/** 1v1 兼容 driver（red/blue 各一个，整侧共用） */
export interface SideDriver {
  team: Team;
  name: string;
  decide(ctx: Ctx): Action[] | Promise<Action[]>;
  kind: 'bot' | 'script';
}

/** 团战 driver：绑定单个坦克 spawn id，每个成员独立实例（独立 Worker / 独立记忆） */
export interface RunnerDriver {
  id: string;
  name: string;
  decide(ctx: Ctx): Action[] | Promise<Action[]>;
  kind: 'bot' | 'script';
}

export type DriverStatus = { crash: string | null; lastError: string | null; framesNoResponse: number };

export type MatchRunnerOpts =
  | { config: MatchConfig; drivers: RunnerDriver[]; decisionTimeoutMs?: number }
  | { config: MatchConfig; red: SideDriver; blue: SideDriver; decisionTimeoutMs?: number };

/** 决策超时哨兵（区别于脚本抛异常导致的 crash） */
const DECISION_TIMEOUT = Symbol('decision-timeout');

type DecisionOutcome =
  | { kind: 'ok'; actions: Action[] }
  | { kind: 'timeout' }
  | { kind: 'error'; err: unknown };

/** 决策执行失败计数 */
export class MatchRunner {
  m: EngineMatch;
  private drvById = new Map<string, RunnerDriver>();
  status: Record<string, DriverStatus>;
  private applyTick: Map<string, number> = new Map(); // 已应用决策帧 tick
  /** 单次决策超时（默认 MAX_DECIDE_MS；测试可调小加速失联路径） */
  private decisionTimeoutMs: number;

  constructor(opts: MatchRunnerOpts) {
    this.m = createMatch(opts.config);
    this.decisionTimeoutMs = opts.decisionTimeoutMs ?? MAX_DECIDE_MS;
    if ('drivers' in opts) {
      for (const d of opts.drivers) this.drvById.set(d.id, d);
    } else {
      // legacy 1v1：team 侧 driver 驱动该队所有 spawn
      const map = new Map<Team, SideDriver>([
        ['red', opts.red],
        ['blue', opts.blue],
      ]);
      for (const s of opts.config.spawns) {
        const sd = map.get(s.team)!;
        this.drvById.set(s.id, { id: s.id, name: sd.name, decide: sd.decide, kind: sd.kind });
      }
    }
    // 校验：每个 spawn 必须命中 driver（避免静默不决策）
    for (const s of opts.config.spawns) {
      if (!this.drvById.has(s.id)) throw new Error(`spawn ${s.id} 缺少对应 driver`);
    }
    this.status = {};
    for (const t of this.m.tanks.values()) {
      this.status[t.id] = { crash: null, lastError: null, framesNoResponse: 0 };
    }
  }

  /** 决策帧：并行请求所有存活坦克的决策，结果统一按坦克迭代顺序结算（与到达顺序无关，保证确定性） */
  private async runDecisionFrame(): Promise<void> {
    const outcomes = new Map<string, Promise<DecisionOutcome>>();
    for (const t of this.m.tanks.values()) {
      if (!t.alive) continue;
      const driver = this.drvById.get(t.id);
      const st = this.status[t.id];
      if (!driver || st.crash) {
        // 无 driver / 崩溃方保持当前意图（失联，等结束）
        continue;
      }
      let res: Action[] | Promise<Action[]>;
      let ctx;
      try {
        ctx = buildCtx(this.m, t);
        res = driver.decide(ctx);
      } catch (err) {
        outcomes.set(t.id, Promise.resolve({ kind: 'error', err }));
        continue;
      }
      if (!(res instanceof Promise)) {
        outcomes.set(t.id, Promise.resolve({ kind: 'ok', actions: res }));
        continue;
      }
      // 超时守护：决策 Promise 挂起/死循环时该帧 NOOP，不拖垮引擎；
      // 迟到的返回因 race 已结算不会被应用。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(DECISION_TIMEOUT), this.decisionTimeoutMs);
      });
      const oc: Promise<DecisionOutcome> = Promise.race([res, timeoutP])
        .finally(() => clearTimeout(timer))
        .then(
          (actions) => ({ kind: 'ok', actions }) as DecisionOutcome,
          (err) => (err === DECISION_TIMEOUT ? { kind: 'timeout' } : { kind: 'error', err }) as DecisionOutcome,
        );
      outcomes.set(t.id, oc);
    }
    await Promise.all(outcomes.values()); // 全部 settle（outcome 构造不会抛出）
    // 按坦克迭代顺序统一应用（确定性：与 Worker 响应到达顺序无关）
    for (const t of this.m.tanks.values()) {
      if (!t.alive) continue;
      const oc = outcomes.get(t.id);
      const st = this.status[t.id];
      if (!oc || !st) continue;
      const done = await oc; // 已 settle，立即返回
      if (done.kind === 'timeout') {
        st.lastError = 'TIMEOUT';
        st.framesNoResponse += DECISION_PERIOD;
        if (st.framesNoResponse >= DECISION_TIMEOUT_SANCTION_TICKS) {
          st.framesNoResponse = 0;
          t.sanctions++; // 连续无响应 → 计 1 次非法意图（累计 100 判失联）
        }
        continue;
      }
      if (done.kind === 'error') {
        st.lastError = String((done.err as { message?: string } | null)?.message ?? done.err);
        if (!st.crash) {
          st.crash = 'decide 抛异常';
          forceDestroy(this.m, t.id, '策略代码崩溃');
        }
        continue;
      }
      st.framesNoResponse = 0;
      if (this.m.over) continue;
      const frame = this.m.tick;
      if ((this.applyTick.get(t.id) ?? -1) < frame) {
        this.applyTick.set(t.id, frame);
        try {
          const errs = applyActions(this.m, t.id, done.actions);
          if (errs.length) st.lastError = errs.join(',');
        } catch (err) {
          // decide 返回了不可迭代/非法结构：与同步路径同罪，判崩溃
          st.lastError = String(err instanceof Error ? err.message : err);
          if (!st.crash) {
            st.crash = 'decide 返回非法数据';
            forceDestroy(this.m, t.id, '策略代码崩溃');
          }
        }
      }
    }
  }

  /** 推进 n 个物理 tick（阻塞 async；对 script driver 会等待决策返回） */
  async stepN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (this.m.over) break;
      if (this.m.tick % DECISION_PERIOD === 0) {
        await this.runDecisionFrame();
      }
      step(this.m);
    }
    this.checkSanctions();
  }

  private checkSanctions() {
    for (const t of this.m.tanks.values()) {
      if (!t.alive) continue;
      if (t.sanctions >= MAX_SANCTIONS) {
        forceDestroy(this.m, t.id, `非法意图累计 ${t.sanctions} 次`);
      }
    }
  }

  async tickOnce(): Promise<void> {
    await this.stepN(1);
  }

  /** 全速跑完对局（headless，测试用） */
  async runToEnd(maxTicks = 60 * 180): Promise<void> {
    while (!this.m.over && this.m.tick < maxTicks) await this.stepN(DECISION_PERIOD);
  }

  ms(): number {
    return this.m.ms;
  }
  getDT(): number {
    return DT_MS;
  }
  visibleEnemiesFor(tankId: string) {
    const t = this.m.tanks.get(tankId);
    if (!t) return [];
    return viewEnemies(this.m, t);
  }
}
