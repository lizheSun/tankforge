/**
 * 游戏规则说明页：内容与引擎实现严格对齐（数值来自 src/game/constants.ts 等）。
 * 面向新玩家：通俗、直接、无遗漏。
 */
export function Rules({ onBack }: { onBack: () => void }) {
  return (
    <div className="rules">
      <div className="tf-bg" />
      <header className="setup-head">
        <div className="brand">
          <span className="logo" />
          <h1>
            TANK<em>FORGE</em>
          </h1>
          <span className="ver">游戏规则 · RULES</span>
        </div>
        <div className="quick-row">
          <button className="btn small" onClick={onBack}>
            ⇤ 返回布阵
          </button>
        </div>
      </header>

      <div className="rules-body">
        {/* ---------- 0. 这是什么 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 这是个什么游戏</h2>
          <p>
            你不亲手开坦克。<b>你写"坦克大脑"（策略代码）</b>，坦克照着你的代码自己打。
            双方各出一队坦克（1v1 ~ 5v5），在战场上自动交战，看谁的策略更强。
          </p>
          <p>一局分三步：</p>
          <ol>
            <li>
              <b>布阵</b>：选地图、规模、时长、种子；给每方选"大脑"（内置 AI / 你写的代码 / 上传的策略包），并用
              <b> 12 点能力点（CP）</b>组装坦克属性。
            </li>
            <li>
              <b>交战</b>：引擎全自动模拟，双方坦克每 83 毫秒决策一次（移动 / 转向 / 瞄准 / 开火 / 通信）。
            </li>
            <li>
              <b>结算</b>：一方全灭或时间到，按规则裁定胜负，展示每辆坦克的战绩；可导出回放复盘。
            </li>
          </ol>
        </section>

        {/* ---------- 1. 时间与节奏 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 时间与节奏</h2>
          <ul>
            <li>引擎以 <b>60 tick/秒</b> 推进物理（移动、炮弹、碰撞都按 tick 算）。</li>
            <li>
              每 <b>5 tick（约 83ms）</b>是一个"决策帧"：所有存活坦克的大脑被调用一次，返回一组意图。
            </li>
            <li>
              大脑单次决策限时 <b>100ms</b>：超时本帧不行动（NOOP），连续 30 tick 无响应记 1 次违规（见"违规与失联"）。
            </li>
            <li>单局时长可选 <b>60s / 120s / 180s</b>，剩余 30s 时全场广播提醒。</li>
          </ul>
        </section>

        {/* ---------- 2. 战场与地图 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 战场与地图</h2>
          <ul>
            <li>
              战场固定 <b>1200 × 800 像素</b>，由 25px 的方格瓦片拼成（48 × 32 格），四周有实心边界墙。
            </li>
            <li>
              三张官方地图（全部<b>左右、上下镜像对称</b>，双方出生环境完全公平）：
              <ul>
                <li>十字路口（crossroads）：经典对称战场。</li>
                <li>废墟演兵场（arena_ruins）：中路可破坏墙 + 立柱 + 草丛，讲究侦察与破墙。</li>
                <li>开阔竞技场（open_field）：掩体少，拼瞄准与走位。</li>
              </ul>
            </li>
            <li>瓦片类型：</li>
          </ul>
          <table className="rule-table">
            <thead>
              <tr>
                <th>瓦片</th>
                <th>挡坦克</th>
                <th>挡炮弹</th>
                <th>挡视线</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>EMPTY 空地</td>
                <td>否</td>
                <td>否</td>
                <td>否</td>
                <td>正常通行</td>
              </tr>
              <tr>
                <td>SOLID 实心墙</td>
                <td>是</td>
                <td>是</td>
                <td>是</td>
                <td>不可破坏</td>
              </tr>
              <tr>
                <td>BREAKABLE 薄墙</td>
                <td>是</td>
                <td>是</td>
                <td>是</td>
                <td>
                  有 <b>50 耐久</b>，被炮弹打掉耐久后碎成"残骸"
                </td>
              </tr>
              <tr>
                <td>RUIN 残骸</td>
                <td>否</td>
                <td>否</td>
                <td>否</td>
                <td>薄墙被打碎后的状态，可通行、可透视</td>
              </tr>
              <tr>
                <td>GRASS 草丛</td>
                <td>否</td>
                <td>否</td>
                <td>否</td>
                <td>隐蔽用（见"视野与隐蔽"）</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ---------- 3. 视野与隐蔽 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 视野与隐蔽（你能看见什么）</h2>
          <ul>
            <li>
              每辆坦克有<b>视野半径</b>（基础 320px，可用 CP 加到 440px）。敌人只有进入视野半径、且中间
              <b>没有被墙挡住视线</b>，才算"可见"。
            </li>
            <li>
              <b>草丛隐蔽</b>：躲在草丛里的坦克默认<b>不可见</b>（哪怕在视野内、没墙挡）。但以下情况会"暴露"：
              <ul>
                <li>开火后暴露 <b>500ms</b>；</li>
                <li>被炮弹命中后暴露 <b>500ms</b>。</li>
              </ul>
            </li>
            <li>
              目标从"不可见 → 可见 / 可见 → 不可见"时，你的大脑会收到 <code>SCAN_ACQUIRED</code> /{' '}
              <code>SCAN_LOST</code> 事件。
            </li>
          </ul>
        </section>

        {/* ---------- 4. 坦克属性与 Build ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 坦克属性与组装（Build）</h2>
          <p>
            每辆坦克有 <b>12 点能力点（CP）</b>。<b>普通模块：升 1 级 = 花 1 CP</b>，想升几级就买几级，也可以不买（不买就保持基础值，剩余点数不退也不累积）。例：装甲买 4 级 = 花 4 CP，HP 从 100 → 160。
          </p>
          <table className="rule-table">
            <thead>
              <tr>
                <th>模块</th>
                <th>基础值</th>
                <th>每级加成（1 级 = 1 CP）</th>
                <th>最高级</th>
                <th>满级效果</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>装甲（HP）</td>
                <td>100</td>
                <td>+15</td>
                <td>6 级</td>
                <td>190 HP</td>
              </tr>
              <tr>
                <td>引擎（移速）</td>
                <td>120 px/s</td>
                <td>+20</td>
                <td>4 级</td>
                <td>200 px/s</td>
              </tr>
              <tr>
                <td>履带（车体转速）</td>
                <td>90°/s</td>
                <td>+20</td>
                <td>3 级</td>
                <td>150°/s</td>
              </tr>
              <tr>
                <td>装填（射速）</td>
                <td>800ms</td>
                <td>−60ms</td>
                <td>4 级</td>
                <td>560ms（下限 200ms）</td>
              </tr>
              <tr>
                <td>伤害</td>
                <td>12/发</td>
                <td>+3</td>
                <td>4 级</td>
                <td>24/发</td>
              </tr>
              <tr>
                <td>炮塔（回转）</td>
                <td>150°/s</td>
                <td>+30</td>
                <td>3 级</td>
                <td>240°/s</td>
              </tr>
              <tr>
                <td>弹速</td>
                <td>480 px/s</td>
                <td>+90</td>
                <td>2 级</td>
                <td>660 px/s</td>
              </tr>
              <tr>
                <td>视野</td>
                <td>320 px</td>
                <td>+40</td>
                <td>3 级</td>
                <td>440 px</td>
              </tr>
              <tr>
                <td>战术（通信带宽）</td>
                <td>1 条/决策帧</td>
                <td>+1</td>
                <td>2 级</td>
                <td>3 条/决策帧</td>
              </tr>
            </tbody>
          </table>
          <p>
            <b>瞄具</b>不按级数收费，是两个打包价（二选一，互斥）：
          </p>
          <ul>
            <li>
              辅助瞄具（assist）：<b>1 CP</b>
            </li>
            <li>
              自动瞄具（auto）：<b>3 CP</b>（含辅助瞄具的全部能力，详见"瞄准三档"）
            </li>
          </ul>
          <p className="tf-hint">官方预设 Build：默认原型（0CP）/ 玻璃炮 / 重装甲 / 游侠 / 神枪手(auto)，也可以在编辑器里自定义。</p>
        </section>

        {/* ---------- 5. 瞄准三档 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 瞄准三档（决定你的"眼睛"准不准）</h2>
          <table className="rule-table">
            <thead>
              <tr>
                <th>档位</th>
                <th>花费</th>
                <th>敌方位置</th>
                <th>敌方速度</th>
                <th>自动瞄准</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>manual 手瞄</td>
                <td>0 CP（默认）</td>
                <td>带 ±6° 噪声</td>
                <td>不提供</td>
                <td>无，自己算提前量</td>
              </tr>
              <tr>
                <td>assist 辅助</td>
                <td>1 CP</td>
                <td>精确</td>
                <td>提供</td>
                <td>无，自己算提前量</td>
              </tr>
              <tr>
                <td>auto 自动</td>
                <td>3 CP</td>
                <td>精确</td>
                <td>提供</td>
                <td>
                  有：发 <code>turretAuto</code> 意图后，<b>引擎接管炮塔</b>，自动对最近可见敌做弹道提前量伺服
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ---------- 6. 移动与开火 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 移动与开火</h2>
          <ul>
            <li>
              移动：油门（throttle，−1 倒车 ~ +1 全速）+ 转向（steer/steerTo）。车速按<b>车体朝向</b>走，撞墙会被挡住。
            </li>
            <li>坦克之间不会互相穿过：碰撞时互相推开。</li>
            <li>
              开火：炮弹从炮口沿<b>炮塔朝向</b>以你的弹速飞行，命中判定半径 = 坦克 16px + 炮弹 4px = 20px；
              炮弹最长飞行 <b>3 秒</b>。
            </li>
            <li>
              每次开火进入<b>装填冷却</b>（= 你的装填时间），冷却没好之前开不了下一发。
            </li>
            <li>
              <b>没有友军伤害</b>：炮弹直接穿过队友（但会打坏薄墙、打到敌人）。
            </li>
            <li>命中伤害 = 你的伤害值；HP 归零即被击毁，当场移出战斗。</li>
          </ul>
        </section>

        {/* ---------- 7. 团战与通信 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 团战与队友通信（2v2 ~ 5v5）</h2>
          <ul>
            <li>
              每辆车挂一个<b>独立的大脑实例</b>（独立代码运行环境、独立状态），同一队的每辆车都可以跑同一个大脑，也可以各跑各的。
            </li>
            <li>
              编队两种模式：<b>全员同基准</b>（整队克隆你配置的基准）或 <b>bot 混编</b>（仅内置策略，按
              MASTER/VETERAN/ROOKIE 轮换挂载）。
            </li>
            <li>双方各自在己方半场对称布阵出生。</li>
            <li>
              <b>队友数据链</b>（免费、全队开通）：队友的位置/HP 全图可见（无视墙），数据丰富度随战术档提升（1
              档位置+HP，2 档起含朝向）；敌方依然要靠自己的视野。
            </li>
            <li>
              <b>队内通信</b>：大脑可发 <code>comm</code> 意图给队友发消息——
              <ul>
                <li>单条 ≤ 64 字符，每决策帧最多发"通信档"条数（1~3 条）；</li>
                <li>队友在<b>下一个决策帧</b>的收件箱里收到；</li>
                <li>敌方永远收不到。</li>
              </ul>
            </li>
          </ul>
        </section>

        {/* ---------- 8. 胜负判定 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 胜负判定</h2>
          <ul>
            <li>
              <b>击毁胜利</b>：把对方<b>全部坦克</b>击毁，立即获胜。
            </li>
            <li>
              <b>时间到</b>：按顺序逐项比较，先分出高下即赢——
              <ol>
                <li>存活坦克数多者胜；</li>
                <li>再比剩余 HP 总量（按各自最大 HP 的百分比合计）；</li>
                <li>再比队伍累计造成伤害；</li>
                <li>全部相同 → 平局。</li>
              </ol>
            </li>
            <li>
              <b>失联 / 崩溃</b>：累计 100 次违规的坦克、或代码抛异常的坦克，直接判"失联"摧毁（等同被击毁）；
              若因此全队清零，对方直接获胜。
            </li>
          </ul>
        </section>

        {/* ---------- 9. 策略脚本 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 坦克大脑怎么写（策略脚本）</h2>
          <p>
            写一个 JavaScript 函数 <code>decide(ctx)</code>：引擎每 83ms 调用一次，它返回一组"意图"，坦克就照做。
            每次被调用只需要想清楚四件事：<b>看见谁了 → 往哪走 → 炮口指哪 → 开不开火</b>。
          </p>

          <h3>第 1 步 · 发现敌人：读 ctx.view.enemies</h3>
          <ul>
            <li>
              引擎已经替你过滤好了：<code>ctx.view.enemies</code> 里只有<b>你现在真看得见</b>的敌人（在你的视野内、
              中间没墙挡、不在草丛里躲着）。
            </li>
            <li>一个都看不见时它就是<b>空数组</b>——这时通常朝地图中心巡逻，制造接敌机会。</li>
            <li>
              每个敌人自带：位置 <code>pos</code>、距离 <code>dist</code>、朝向 <code>heading</code>、血量{' '}
              <code>hp</code>；辅助/自动瞄具还会附上敌人速度 <code>vel</code>（打移动目标算提前量用）。
            </li>
          </ul>

          <h3>第 2 步 · 移动：算方向 + 转向 + 油门</h3>
          <ul>
            <li>
              先算"敌人在我哪个方向"（世界角度，0°=正右、90°=正下）：
              <code>{`atan2(敌.y - 我.y, 敌.x - 我.x) * 180 / Math.PI`}</code>
            </li>
            <li>
              <code>{`{t:'steer', v}`}</code> 让车体转向（−1 左满舵 ~ +1 右满舵）；<code>{`{t:'throttle', v}`}</code>{' '}
              前进（1=全速前进、−1=倒车）。朝敌人冲 = 转向它 + 全速；想拉开距离就反着来。
            </li>
          </ul>

          <h3>第 3 步 · 瞄准：炮塔独立转向</h3>
          <ul>
            <li>
              <code>{`{t:'turretTo', deg}`}</code> 把炮塔转到世界角度 <code>deg</code>——炮塔和车体是<b>独立</b>的，
              一边跑位一边转炮口完全没问题。
            </li>
            <li>
              auto 瞄具最省事：发一次 <code>{`{t:'turretAuto'}`}</code>，引擎自动带提前量咬住最近的可见敌人。
            </li>
            <li>
              manual/assist 想打中移动目标，要自己用敌人的 <code>vel</code> 算提前量（进阶玩法，新手先直瞄）。
            </li>
          </ul>

          <h3>第 4 步 · 开火：对准了再打</h3>
          <ul>
            <li>
              <code>{`{t:'fire'}`}</code> 沿炮塔当前朝向发射一发；装填没好会先挂起，装填完成自动射出。
            </li>
            <li>
              常用套路：炮口与目标方向的夹角小于约 10°、且 <code>ctx.self.cooldownMs &lt;= 0</code>{' '}
              时才发 fire，不浪费炮弹。
            </li>
          </ul>

          <h3>完整示例（可直接抄进代码编辑器改）</h3>
          <pre className="rule-code">{`function decide(ctx) {
  const me = ctx.self;
  // ① 找最近的可见敌人
  const e = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
  // ② 没看见人：朝地图中心巡逻，炮口也指过去
  if (!e) {
    const c = Math.atan2(400 - me.pos.y, 600 - me.pos.x) * 180 / Math.PI;
    return [
      { t: 'throttle', v: 0.5 },
      { t: 'steer', v: clamp(c - me.heading, -1, 1) / 60 },
      { t: 'turretTo', deg: c },
    ];
  }
  // ③ 敌人在哪个方向（世界角度）
  const aim = Math.atan2(e.pos.y - me.pos.y, e.pos.x - me.pos.x) * 180 / Math.PI;
  const acts = [
    { t: 'throttle', v: 1 },                                 // 全速冲向敌人
    { t: 'steer', v: clamp(aim - me.heading, -1, 1) / 60 },   // 车体转向敌人
    { t: 'turretTo', deg: aim },                              // 炮口同步指向敌人
  ];
  // ④ 够准 + 装填好了 → 开火
  if (Math.abs(wrap(aim - me.turret)) < 10 && me.cooldownMs <= 0) acts.push({ t: 'fire' });
  return acts;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wrap(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }`}</pre>
          <p className="tf-hint">
            脚本跑在独立的 Worker 沙箱里（每辆车一个，互不干扰）。ctx 是只读快照，除敌我信息外还有：自己的状态与属性、
            队友、收件箱、事件、地图尺寸、剩余时间、随机数函数。
          </p>
          <p>可以下发的意图（一次可发多条，按顺序消费）：</p>
          <table className="rule-table">
            <thead>
              <tr>
                <th>意图</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>{`{ t:'throttle', v }`}</code>
                </td>
                <td>油门 −1 ~ +1（前进为正）</td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'steer', v }`}</code>
                </td>
                <td>转向 −1 ~ +1（左正右负）</td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'steerTo', deg }`}</code>
                </td>
                <td>车体转向指定世界角度（引擎自动伺服）</td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'turretTo', deg }`}</code>
                </td>
                <td>炮塔转向指定世界角度</td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'turretAuto' }`}</code>
                </td>
                <td>
                  交出炮塔控制权给引擎（<b>仅 auto 瞄具</b>，其他档发这个 = 违规）
                </td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'fire' }`}</code>
                </td>
                <td>开火（装填没好会挂起，装填完成即发射）</td>
              </tr>
              <tr>
                <td>
                  <code>{`{ t:'comm', msg, to? }`}</code>
                </td>
                <td>给队友发消息（≤64 字符，受带宽限制）</td>
              </tr>
            </tbody>
          </table>
          <p>
            大脑还能收到<b>事件</b>（当帧打包在 ctx.events 里）：被击中、命中敌人、自己开火、目标出现/丢失、撞墙/撞车、
            薄墙被打碎、队友/敌人被击毁、开局/结束、剩余 30s 警告。
          </p>
          <p className="tf-hint">
            也可以直接上传策略包（.zip：清单 + 大脑代码 + 自带 Build），或使用三个内置 AI：ROOKIE-7（手瞄莽夫）、
            VETERAN-5（辅助环绕）、MASTER-1（自动压制）。
          </p>
        </section>

        {/* ---------- 10. 违规与失联 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 违规与失联（犯规会怎样）</h2>
          <p>
            每次违规记 1 次 <b>sanction</b>，累计 <b>100 次</b>判"失联"（直接被摧毁）。计违规的行为：
          </p>
          <ul>
            <li>
              非 auto 瞄具却发 <code>turretAuto</code>（发之前先读自己的瞄具档位）
            </li>
            <li>发空消息 / 超过 64 字符的 comm</li>
            <li>comm 超过本帧带宽配额</li>
            <li>决策超 100ms：本帧不行动；连续 30 tick 无响应记 1 次（死循环脚本会这样慢慢攒到失联）</li>
            <li>代码抛异常：不等攒次数，<b>当场判负摧毁</b></li>
          </ul>
          <p>以下行为不算违规（引擎静默容错）：</p>
          <ul>
            <li>油门/转向数值越界 → 自动压回 [−1, 1]；角度随便给，自动归一化</li>
            <li>装填没好就发 fire → 挂起等待，装填好自动发射</li>
            <li>超时后迟到的返回 → 本帧已按不行动处理，迟到结果丢弃</li>
          </ul>
        </section>

        {/* ---------- 11. 回放与确定性 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 回放与确定性</h2>
          <ul>
            <li>
              引擎完全确定性：<b>同一种子 + 同一份配置 = 逐 tick 完全复现</b>的对局（内置随机数也是确定性的）。
            </li>
            <li>每局可导出回放文件（.tfreplay.json），随时载入重演；重演时会和存档指纹比对，不一致会提示"指纹漂移"。</li>
            <li>结算战绩（每辆坦克）：造成伤害、射击数、命中数、命中率、行驶距离、存活时间、击杀数、违规次数。</li>
          </ul>
        </section>

        {/* ---------- 12. 赛事、组队与排名 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ 赛事、组队与排名（天梯 / 吃鸡）</h2>
          <p>
            赛事是平台上的正式对战：创建赛事 → 报名 → （可选）组队 → 发起挑战 → 看实时排行榜。
            所有对战由<b>服务端权威结算</b>并入库，任何一场都可以回放观看。
          </p>

          <h3>两种赛事</h3>
          <ul>
            <li>
              <b>天梯赛</b>：自由挑战。单挑或组队团战都行，打到哪算哪，排行榜实时更新。
            </li>
            <li>
              <b>吃鸡赛</b>：报名名单全员两两循环混战（≤8 车，28 场一键跑完），适合快速分出高下。
            </li>
          </ul>

          <h3>报名与组队</h3>
          <ul>
            <li>
              <b>报名</b>：凭<b>坦克密钥</b>把坦克挂进赛事（防止别人冒用你的坦克报名）。
            </li>
            <li>
              <b>组队</b>：报名后凭密钥创建 / 加入队伍。<b>每队 1~5 车，一辆坦克同一赛事只能属于一支队伍</b>；
              想换队先退出再加入。队伍信息存在数据库（tf_teams / tf_team_members 表）。
            </li>
            <li>
              <b>退出</b>：凭该坦克自己的密钥退出队伍；队伍清空后自动解散。不组队也不影响单挑。
            </li>
          </ul>

          <h3>发起挑战（不需要密钥）</h3>
          <ul>
            <li>
              <b>快速单挑 1v1</b>：从报名名单里选自己和对手直接开战，对手可以是 NPC。<b>挑战本身免密钥</b>——
              报名时已经验证过车主身份。
            </li>
            <li>
              <b>队伍团战 NvN</b>：选两支队伍开战（每队 1~5 车，可以不等人数）。团战走引擎<b>真实团队规则</b>：
              队友数据链全图共享、队内通信生效（详见「团战与通信」章节）。
            </li>
            <li>每场对战 90 秒，地图十字路口，服务端结算后前端重演完整画面。</li>
          </ul>

          <h3>排行榜与积分规则（实时计算）</h3>
          <p>
            排行榜在<b>赛事主页右侧</b>，每次打开页面<b>实时现算</b>（不落库，改一场立刻反映）。积分公式：
          </p>
          <pre className="rule-code">{`积分 = 胜场 × 3 + 平局 × 1 + 击杀 × 1 + 命中率 × 5

例：2 胜 1 平、击杀 3、命中率 60% → 6 + 1 + 3 + 3 = 13 分`}</pre>
          <ul>
            <li>
              <b>队伍团战</b>：胜负按<b>队伍</b>记——胜方每辆坦克各 +1 胜，个人击杀/命中照常累计。
            </li>
            <li>
              <b>同分排序</b>（依次比较）：积分 ↓ → 胜场 ↓ → 击杀 ↓ → 命中率 ↓ → 总场次少者优先（同分效率高）→
              名字。没打过的排在最后。
            </li>
            <li>
              <b>为什么这么设计</b>：胜场是硬指标（权重最高）；击杀奖励主动输出；命中率×5（封顶 5 分）奖励精准
              打法但不至于盖过胜负；平局给 1 分保留超时裁定局的区分度；场次少者优先避免「刷场次堆积分」。
            </li>
          </ul>
          <p className="tf-hint">
            坦克名旁标 NPC 的是内置 AI（创建赛事时自动加入，也可被挑战练手）。想改积分权重？
            排名逻辑在 server/index.ts 的 leaderboard 端点里，公式一目了然。
          </p>
        </section>

        {/* ---------- 13. RL 模型训练完全攻略 ---------- */}
        <section className="rule-card tf-panel">
          <h2 className="tf-title">◈ RL 模型训练完全攻略（不写代码，练一个神经网络当大脑）</h2>

          <h3>这是什么：第三种玩法</h3>
          <p>
            除了「手写策略代码」和「抄内置 AI」，还可以<b>训练一个神经网络（MLP）</b>当坦克大脑：你负责定训练目标和陪练，
            模型在真实对战中自己学会走位、索敌、控距、开火时机。上传后模型被编译成<b>确定性策略代码</b>，与脚本坦克
            同场竞技、同规则结算——训练环境跑的就是本平台引擎，<b>训练即实战</b>。
          </p>
          <p>
            模型的接口是平台标准化的：<b>输入 24 维战场观测 → 输出 18 选 1 的动作</b>；炮塔不用模型管（平台自动带提前量
            瞄准最近可见敌），模型专注「往哪走 + 开不开火」。
          </p>

          <h3>第 1 步 · 选一条训练路线</h3>
          <table className="rule-table">
            <thead>
              <tr>
                <th>路线</th>
                <th>门槛</th>
                <th>命令</th>
                <th>特点</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>① 进化训练</td>
                <td>零依赖（只要 Node）</td>
                <td>
                  <code>npm run evolve 100 16</code>
                </td>
                <td>
                  随机网络种群 → 打内置 AI → 选优变异迭代。几分钟出可用模型，产物{' '}
                  <code>scripts/rl/best-model.json</code> 直接上传
                </td>
              </tr>
              <tr>
                <td>② PPO 正式训练</td>
                <td>
                  <code>pip install stable-baselines3 gymnasium numpy</code>
                </td>
                <td>
                  <code>python3 scripts/rl/train_ppo.py --steps 2000000 --envs 8 --opponent veteran</code>
                </td>
                <td>强化学习正统路线，桥接真实引擎逐帧训练，上限最高，耗时也最长</td>
              </tr>
              <tr>
                <td>③ 自我进化联赛</td>
                <td>同②</td>
                <td>
                  <code>python3 scripts/rl/selfplay.py --rounds 10</code>
                </td>
                <td>先自动训到能打赢 master，再逐轮和「上一轮的自己」对练（详见下文）</td>
              </tr>
            </tbody>
          </table>
          <p className="tf-hint">
            命令参数：--steps 总步数（1 局 = 1080 步）；--envs 并行环境数；--opponent 陪练
            （rookie / veteran / master / evolve-best）；--resume 断点续训；--lr 学习率覆盖；--save 保存名；--device mps 可用
            Apple GPU。
          </p>

          <h3>第 2 步 · 看效果，决定练多久</h3>
          <ul>
            <li>
              PPO / 自我进化每轮结束会自动对 rookie / veteran / master 各打 10 局并打印<b>胜率</b>——这就是你的成绩单。
            </li>
            <li>
              推荐课程：<b>veteran 起步 → 胜率 60%+ 后切 master 进阶</b>（接续命令见下方「课程式训练」）。
            </li>
            <li>
              <b>早停心法</b>：vs master 胜率连续 2~3 轮不涨就该停了，边际收益递减，别机械跑满轮数。
            </li>
          </ul>

          <h3>第 3 步 · 导出并参战</h3>
          <pre className="rule-code">{`# PPO / 自我进化训完后（产出 tank-ppo.zip）：
python3 scripts/rl/export_sb3.py tank-ppo.zip -o my-tank.json

# 然后：坦克工坊 → 🧠 模型策略（RL）→ 上传 my-tank.json → 创建坦克 → 参加任何比赛`}</pre>

          <h3>模型的眼睛和手（观测 / 动作空间）</h3>
          <p>
            观测 <b>24 维</b>（v2，全部归一化）。前 20 维是即时战场快照；后 4 维是<b>目击记忆</b>——敌人躲进草丛或跑出视野后，
            模型仍然知道「上次在哪看见的」，可以导航回去搜索（没有记忆的模型会原地绕圈）：
          </p>
          <table className="rule-table">
            <thead>
              <tr>
                <th>维度</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>[0..1]</td>
                <td>自身 HP 比例、装填进度</td>
              </tr>
              <tr>
                <td>[2..5]</td>
                <td>车体 / 炮塔朝向（sin/cos）</td>
              </tr>
              <tr>
                <td>[6..15]</td>
                <td>最近可见敌：标记、相对位置、距离、朝向、速度、HP、与炮口夹角（敌不可见时全 0）</td>
              </tr>
              <tr>
                <td>[16..19]</td>
                <td>剩余时间、自身位置、偏置</td>
              </tr>
              <tr>
                <td>[20]</td>
                <td>是否有过目击（0/1）</td>
              </tr>
              <tr>
                <td>[21..22]</td>
                <td>上次目击点相对当前位置（x/600、y/400）——「去那儿找」的方向</td>
              </tr>
              <tr>
                <td>[23]</td>
                <td>记忆新鲜度：0 = 刚看见，1 = 很久 / 从未（越旧越不可信）</td>
              </tr>
            </tbody>
          </table>
          <p>
            动作 <b>18 选 1</b>：转向（左/直/右）× 油门（全速/中速/倒车）× 开火（打/不打）。开火意愿由模型输出，
            炮塔瞄准和提前量由平台托管。
          </p>
          <p className="tf-hint">
            训练奖励（PPO 路线）＝ 造成伤害 − 承受伤害 ＋ 视野塑形（保持接触 / 逼近敌人有小奖、丢失目标有小罚）＋ 终局
            ±100。视野塑形是为了避免模型学成「原地绕圈」的投机解。
          </p>

          <h3>课程式训练（推荐）</h3>
          <pre className="rule-code">{`# 阶段 1：veteran 起步（存为 tank-ppo）
python3 scripts/rl/train_ppo.py --steps 1000000 --envs 8 --opponent veteran

# 阶段 2：切 master 进阶（--resume 载入阶段 1 的经验，--save 换名防覆盖，--lr 减半微调）
python3 scripts/rl/train_ppo.py --steps 1000000 --envs 8 --opponent master \\
    --resume tank-ppo.zip --save tank-ppo-master --lr 1.5e-4`}</pre>
          <p className="tf-hint">切换后胜率暂时下跌是正常现象（对手变强了），模型会在新环境里重新适应。</p>

          <h3>自我进化联赛（self-play）</h3>
          <p>
            「先打赢 master，再打自己，一轮轮变强」——这是 AlphaGo Zero / AlphaStar 验证过的路线。但<b>纯打自己</b>有两个坑：
            ①<b>灾难性遗忘</b>（打赢自己的套路 ≠ 打赢 master 的套路，几轮后可能把老本事忘掉）；②<b>循环克制</b>（A 克 B、B
            克 C、C 克 A，震荡不收敛）。
          </p>
          <p>
            所以平台的联赛用<b>混合陪练池</b>：每局按种子确定性轮换——5 局打「上一轮的自己」、3 局打 master、2 局打
            veteran。一条命令全自动（含起点训练）：
          </p>
          <pre className="rule-code">{`python3 scripts/rl/selfplay.py --rounds 10 --steps 300000
# 产物：tank-ppo-sp0.zip（起点）→ … → tank-ppo-sp10.zip（最终模型）
# 中途 Ctrl-C 不作废：--base tank-ppo-sp5 可从第 5 轮继续`}</pre>

          <h3>定制你自己的训练管道（进阶）</h3>
          <p>所有训练代码都在 <code>scripts/rl/</code>，改完直接重跑即可，无需改平台：</p>
          <table className="rule-table">
            <thead>
              <tr>
                <th>想定制什么</th>
                <th>改哪里</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>训练奖励</td>
                <td>
                  <code>scripts/rl/bridge.ts</code>
                </td>
                <td>
                  塑形系数 <code>CONTACT_BONUS / APPROACH_K / IDLE_PENALTY</code>；想要激进风格就加重伤害项、想要猥琐流就加重
                  HP 保留项
                </td>
              </tr>
              <tr>
                <td>进化适应度</td>
                <td>
                  <code>scripts/rl/evolve.ts</code>
                </td>
                <td>评分公式（胜 / 击杀 / 伤害 / 视野占比 / 受击惩罚的权重）、固定种子集 SEEDS、对手列表</td>
              </tr>
              <tr>
                <td>陪练对手</td>
                <td>命令行 <code>--opponent</code></td>
                <td>
                  rookie / veteran / master / evolve-best（进化最优）；<code>file:路径.json</code> 指定任意模型文件；
                  <code>league:路径.json</code> 走混合陪练池
                </td>
              </tr>
              <tr>
                <td>陪练池比例</td>
                <td>
                  <code>scripts/rl/bridge.ts</code>
                </td>
                <td>
                  <code>makeOpponent</code> 里 <code>seed % 10</code> 分支（默认 5 自己 / 3 master / 2 veteran）
                </td>
              </tr>
              <tr>
                <td>网络结构 / 规模</td>
                <td>
                  <code>scripts/rl/evolve.ts</code> 的 HIDDEN 或 <code>train_ppo.py</code> 的 MlpPolicy 参数
                </td>
                <td>进化路线默认 [32,32]；PPO 默认 [64,64]，可以加大到 [128,128] 试试（更慢但容量更大）</td>
              </tr>
              <tr>
                <td>超参数</td>
                <td>
                  <code>scripts/rl/train_ppo.py</code>
                </td>
                <td>
                  n_steps / batch_size / gamma / ent_coef 等都在 PPO 构造处；gamma=0.995 适合更长远的终局规划
                </td>
              </tr>
              <tr>
                <td>训练地图 / 车型</td>
                <td>
                  <code>scripts/rl/gym_tankforge.py</code>
                </td>
                <td>
                  <code>map_id</code>（crossroads / arena_ruins / open_field）与 <code>preset_idx</code>（RL 车的 Build
                  预设，默认 3 = 游侠）
                </td>
              </tr>
              <tr>
                <td>观测空间</td>
                <td>
                  <code>src/game/modelBrain.ts</code>
                </td>
                <td>
                  <code>buildObs</code> 加你想要的特征（如草丛感知、墙壁距离）。⚠️ 改维度是破坏性改动：必须同步{' '}
                  <code>gym_tankforge.py</code> 的 shape 和 <code>export_sb3.py</code> 的说明，且旧模型全部不兼容（需要
                  version 3）
                </td>
              </tr>
              <tr>
                <td>自己的训练算法</td>
                <td>
                  <code>scripts/rl/bridge.ts</code> 协议
                </td>
                <td>
                  stdio JSONL 协议（reset / step / close），接 DQN、A2C、你自研的算法都行——环境就是真实引擎
                </td>
              </tr>
            </tbody>
          </table>

          <h3>调参心法（常见问题速查）</h3>
          <ul>
            <li>
              <b>模型原地绕圈 / 消极</b>：视野塑形奖励已内置；若还出现，加重 <code>CONTACT_BONUS</code> 或
              <code>IDLE_PENALTY</code>。
            </li>
            <li>
              <b>模型无脑送死换接触</b>：加重受击惩罚（bridge 的 <code>-taken</code> 权重 / evolve 的{' '}
              <code>受击/5</code>）。
            </li>
            <li>
              <b>能打赢陪练、实战拉胯</b>：对手太单一导致过拟合——用 <code>league:</code> 混合陪练，或轮换
              --opponent 训几个存档。
            </li>
            <li>
              <b>训练速度太慢</b>：先用 <code>--steps 20000</code> 测速再线性外推总耗时；--envs 不是越大越好（每个环境一个
              Node 进程，会抢 CPU）。
            </li>
            <li>
              <b>想试 Apple GPU</b>：<code>--device mps</code>。
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
