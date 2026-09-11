import { useState } from 'react';
import { Setup } from './Setup';
import { Battle } from './Battle';
import { Rules } from './Rules';
import { Workshop } from './Workshop';
import { Tournaments } from './Tournaments';
import { Admin } from './Admin';
import type { BattleSetupData } from './config';
import type { ReplayFile } from '../replay/replay';

type View = 'setup' | 'rules' | 'workshop' | 'tournament' | 'admin';

const NAV: { id: View; label: string; title: string }[] = [
  { id: 'setup', label: '⚔ 本地对战', title: '本地布阵对战（免登录，引擎全程本地跑）' },
  { id: 'workshop', label: '🛠 坦克工坊', title: '创建你的坦克：名称 + 密钥 + 大脑策略' },
  { id: 'tournament', label: '🏟 赛事中心', title: '天梯赛 / 吃鸡赛：报名 · 组队 · 挑战 · 实时排名' },
  { id: 'admin', label: '⚙ 系统管理', title: 'MySQL 数据源 · 数据浏览 · SQL 控制台' },
  { id: 'rules', label: '📖 游戏规则', title: '游戏规则 · RULES' },
];

export default function App() {
  const [view, setView] = useState<View>('setup');
  const [data, setData] = useState<BattleSetupData | null>(null);
  const [replay, setReplay] = useState<ReplayFile | null>(null);
  /** 对战结束退出后回到哪个页面（本地布阵 / 赛事中心） */
  const [battleBack, setBattleBack] = useState<View>('setup');

  const startLocal = (d: BattleSetupData) => {
    setBattleBack('setup');
    setData(d);
  };
  const backToSetup = () => {
    setData(null);
    setReplay(null);
    setView(battleBack === 'tournament' ? 'tournament' : 'setup');
  };

  if (data) {
    return (
      <Battle
        setup={data}
        replay={replay ?? undefined}
        onExit={backToSetup}
        exitLabel={battleBack === 'tournament' ? '⇤ 返回赛事中心' : undefined}
      />
    );
  }
  return (
    <div className="app-root">
      <div className="tf-bg" />
      <header className="app-nav">
        <div className="brand">
          <span className="logo" />
          <h1>
            TANK<em>FORGE</em>
          </h1>
        </div>
        <nav className="nav-row">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`btn small nav-btn ${view === n.id ? 'primary' : ''}`}
              title={n.title}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </header>
      {view === 'setup' && (
        <Setup
          onStart={startLocal}
          onReplay={(d, r) => {
            setBattleBack('setup');
            setReplay(r);
            setData(d);
          }}
        />
      )}
      {view === 'rules' && <Rules onBack={() => setView('setup')} />}
      {view === 'workshop' && <Workshop onOpenRules={() => setView('rules')} />}
      {view === 'tournament' && (
        <Tournaments
          onLaunch={(setup) => {
            setBattleBack('tournament');
            setData(setup);
          }}
        />
      )}
      {view === 'admin' && <Admin />}
    </div>
  );
}
