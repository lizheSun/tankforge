/**
 * README 截图生成器 → docs/screenshots/*.png
 *
 * 用法：
 *   1) 终端 A：npm run dev
 *   2) 终端 B：node scripts/screenshots.mjs
 *
 * 依赖 playwright-core（复用本机 Chrome，无需下载浏览器）。
 * UI 大改后重跑本脚本即可刷新 README 截图。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173';
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

// ── 1. 首页：本地布阵（双方战略舱 + Build + 部署开战） ──────────────
await page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1500);
await page.screenshot({ path: `${OUT}setup.png` });
console.log('✓ setup.png');

// ── 2. 战斗画面：2v2 团战 ×4 速度跑一段，抓交火瞬间 ────────────────
await page.getByRole('button', { name: '2v2', exact: true }).click();
await page.getByRole('button', { name: '部署并开战' }).click();
await page.waitForSelector('canvas');
await sleep(600);
await page.getByRole('button', { name: '×4', exact: true }).click();
await sleep(4200); // 交火中（太久会打完出现结算面板）
await page.screenshot({ path: `${OUT}battle.png` });
console.log('✓ battle.png');

// ── 3. 代码编辑模式：红方切「自定义代码」，展示 decide(ctx) 编辑器 ──
await page.getByRole('button', { name: '⇤ 返回布阵', exact: true }).click();
await sleep(800);
await page.locator('.side-console.red select').first().selectOption('script');
await sleep(900);
await page.screenshot({ path: `${OUT}code.png` });
console.log('✓ code.png');

// ── 4. 坦克工坊：创建坦克（名称 / 密钥 / 大脑） ─────────────────────
await page.getByRole('button', { name: '坦克工坊' }).click();
await sleep(900);
await page.screenshot({ path: `${OUT}workshop.png` });
console.log('✓ workshop.png');

await browser.close();
console.log(`\n全部完成 → ${OUT}`);
