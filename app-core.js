'use strict';
// 资产聚合管理终端 · 纯逻辑层（无 DOM/无副作用），供 app.js 与 Node 测试共用
// 约定：本文件所有函数为纯函数；依赖全局 localStorage 的函数必须内置 try/catch 兜底

// ── 返回栈（P0-4：系统返回键/浏览器后退逐级返回）──────────
function createBackStack() {
  const items = [];
  let backing = false;
  const stack = {
    push(id, meta) {
      if (items.length && items[items.length - 1].id === id) return false;
      items.push(Object.assign({ id }, meta || {}));
      return true;
    },
    pop() { return items.pop() || null; },
    peek() { return items.length ? items[items.length - 1] : null; },
    size() { return items.length; },
    clear() { items.length = 0; backing = false; }
  };
  Object.defineProperty(stack, 'length', { get: () => items.length });
  return { stack, markBacking: () => { backing = true; }, consumeBacking: () => { const b = backing; backing = false; return b; } };
}

// 系统返回键 / 浏览器后退统一处理：
// 返回 true=已消费（无需默认行为），false=无内容可退
// modalOpen/closeModal/onPopView 由调用方注入（DOM 副作用留在 app.js）
function handleBackKey(bs, modalOpen, closeModal, onPopView) {
  if (bs.consumeBacking()) return true;
  if (modalOpen && modalOpen()) { if (closeModal) closeModal(); return true; }
  const top = bs.stack.pop();
  if (!top) return false;
  if (onPopView) onPopView(top);
  return true;
}

// ── 季报（P0-2：YYYY-Qn 解析与区间计算）────────────────
function pad2(n) { return String(n).padStart(2, '0'); }
function lastDayOfMonth(year, month) { return new Date(year, month, 0).getDate(); }

// '2026-Q3' / '2026-q1' → { year, quarter }；非法返回 null
function parseQuarter(value) {
  const m = /^(\d{4})[- ]Q([1-4])$/i.exec(String(value || '').trim());
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}
function fmtQuarter(pq) { return pq.year + '-Q' + pq.quarter; }
function currentQuarter() {
  const d = new Date();
  return { year: d.getFullYear(), quarter: Math.floor(d.getMonth() / 3) + 1 };
}
// {year, quarter} → { from: 'YYYY-MM-01', to: 'YYYY-MM-31' }
function quarterMonths(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: year + '-' + pad2(startMonth) + '-01',
    to: year + '-' + pad2(endMonth) + '-' + pad2(lastDayOfMonth(year, endMonth))
  };
}

// ── 左滑返回判定（P0-3）───────────────────────────────
// 松手时：水平位移 > 阈值 且 纵向偏移不显著 → 完成返回
function swipeShouldClose(dx, dy, opts) {
  const o = opts || {};
  const minDx = o.minDx ?? 88;
  const ratio = o.ratio ?? 0.7;
  return dx > minDx && Math.abs(dy) < dx * ratio;
}

// ── 资金池分类（P0-1）─────────────────────────────────
// 池分类兜底：无 cat 时按 kind 回落；cat 已不存在（被删）时回落 'other'
function poolResolvedCat(pool, catMap) {
  const fallback = pool && pool.kind === 'liability' ? 'credit' : 'saving';
  const c = (pool && pool.cat) || fallback;
  return catMap && catMap[c] ? c : 'other';
}

// 删除分类后，把引用该分类的池统一归入 'other'（纯计算，返回需更新的池 id 列表）
function poolsToRehome(pools, deletedCatKey) {
  return (pools || []).filter(p => (p.cat || (p.kind === 'liability' ? 'credit' : 'saving')) === deletedCatKey).map(p => p.id);
}

// ── P1-2 折旧投影（月度净值曲线）─────────────────────────
// asset: { cost, est_value, buy_date, useful_life_years, salvage_rate }
// 返回 { deprec, annual_depr, month_depr, salvage, points: [{month:'YYYY-MM', net}] }
function deprecProjection(asset, opts) {
  const o = opts || {};
  const cost = asset && (asset.cost || asset.est_value);
  const years = asset ? (Number(asset.useful_life_years) || 0) : 0;
  const buy = asset && asset.buy_date;
  if (!asset || !years || years <= 0 || !buy || !cost) return { deprec: false, points: [] };
  const salvage = cost * (Number(asset.salvage_rate) || 0);
  const annual = (cost - salvage) / years;
  const start = new Date(buy);
  if (isNaN(start.getTime())) return { deprec: false, points: [] };
  const horizon = Math.min(Math.max(1, Math.round(years * 12)), o.maxMonths || 240);
  const points = [];
  for (let i = 0; i <= horizon; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const accum = Math.min(cost - salvage, annual * (i / 12));
    points.push({
      month: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
      net: Math.round((cost - accum) * 100) / 100
    });
  }
  return { deprec: true, annual_depr: Math.round(annual * 100) / 100, month_depr: Math.round(annual / 12 * 100) / 100, salvage: Math.round(salvage * 100) / 100, points };
}

// ── P1-3 预算模板库（按支出分类名称配比）──────────────────
const BUDGET_TEMPLATES = [
  { key: 'lean', name: '极简型', note: '储蓄优先，非必要不消费', weights: { 餐饮: 0.35, 交通: 0.10, 居住: 0.30, 购物: 0.08, 娱乐: 0.05, 医疗: 0.05, 教育: 0.04, 人情: 0.03 } },
  { key: 'standard', name: '均衡型', note: '消费与储蓄并重', weights: { 餐饮: 0.40, 交通: 0.12, 居住: 0.25, 购物: 0.08, 娱乐: 0.06, 医疗: 0.04, 教育: 0.03, 人情: 0.02 } },
  { key: 'comfort', name: '舒适型', note: '改善生活质量', weights: { 餐饮: 0.45, 交通: 0.15, 居住: 0.20, 购物: 0.08, 娱乐: 0.06, 医疗: 0.03, 教育: 0.02, 人情: 0.01 } }
];

// cats: [{id, name}]；total 为月度总预算
// 返回 [{category_id, category_name, amount}]（金额保留 2 位；未命中权重的分类均分剩余权重）
function applyBudgetTemplate(tpl, total, cats) {
  if (!tpl || !total || total <= 0 || !cats || !cats.length) return [];
  const weights = tpl.weights || {};
  const usedW = cats.reduce((s, c) => s + (weights[c.name] || 0), 0);
  const rest = Math.max(0, 1 - usedW);
  const unmatched = cats.filter(c => weights[c.name] == null);
  const perUnmatched = unmatched.length ? Math.round((rest * total) / unmatched.length * 100) / 100 : 0;
  const out = [];
  for (const c of cats) {
    const w = weights[c.name];
    const amount = w != null ? Math.round(w * total * 100) / 100 : perUnmatched;
    if (amount > 0) out.push({ category_id: c.id, category_name: c.name, amount });
  }
  return out;
}

// ── P1-4 云同步合并（冲突感知）─────────────────────────
// 规则：同 id 双方都更新过（updated_at > lastSyncTs）且记录不同 → 冲突（保留本地并登记）；
//       仅云端更新 → 云端覆盖；仅本地更新/未变 → 保留本地。
// lastSyncTs 为空（首次同步）时双方有差异即视为冲突，交由用户选择。
function mergeCloudSync(local, cloud, lastSyncTs) {
  const stores = {};
  let added = 0, updated = 0;
  const conflicts = [];
  const TABLES = Object.keys(cloud || {}).filter(k => k !== 'exported_at' && k !== 'app' && k !== 'version');
  for (const t of TABLES) {
    const localRows = (local && local[t]) || [];
    const cloudRows = cloud[t] || [];
    const map = new Map();
    for (const row of localRows) if (row.id != null) map.set(row.id, row);
    for (const crow of cloudRows) {
      if (crow.id == null) continue;
      const old = map.get(crow.id);
      const lt = old ? (old.updated_at || old.created_at || '') : '';
      const ct = crow.updated_at || crow.created_at || '';
      if (!old) { map.set(crow.id, crow); added++; continue; }
      if (lt === ct) continue;
      const syncTs = lastSyncTs || '';
      const localNewer = syncTs && lt > syncTs && ct <= syncTs;
      const cloudNewer = syncTs && ct > syncTs && lt <= syncTs;
      const bothNew = !syncTs || (lt > syncTs && ct > syncTs);
      if (cloudNewer) { map.set(crow.id, crow); updated++; }
      else if (bothNew) {
        conflicts.push({ table: t, id: crow.id, local: old, cloud: crow, localAt: lt, cloudAt: ct });
      } else if (ct > lt) { map.set(crow.id, crow); updated++; }
      // 其余：保留本地
    }
    stores[t] = [...map.values()];
  }
  return { stores, added, updated, conflicts };
}

// 重试执行异步函数（指数退避；网络/服务端瞬时错误场景使用）
async function retryAsync(fn, opts) {
  const o = opts || {};
  const retries = o.retries ?? 2;
  const base = o.baseDelay ?? 1200;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, base * Math.pow(2, i))); }
  }
  throw lastErr;
}

// 大小写不敏感匹配（全局搜索用）
function searchMatch(text, q) {
  const t = String(text || '').toLowerCase();
  const k = String(q || '').toLowerCase();
  return k ? t.includes(k) : false;
}

// ── P2-3 主题跟随系统（auto=跟随系统深浅）────────────────
function resolveTheme(choice, systemDark) {
  if (choice === 'auto') return systemDark ? 'dark' : 'light';
  return choice || 'light';
}

// ── P2-1 自动估值解析（autoPrice 存在时用于黄金/证券，否则回落手动价）─
// 与后端 investValuation 口径一致；返回含 price_used / price_auto 标记
function resolveMarketValue(a, autoPrice) {
  const a0 = a || {};
  const p = (autoPrice != null && autoPrice > 0) ? autoPrice : (a0.price || 0);
  if (a0.kind === 'gold' || a0.kind === 'security') {
    const mv = Math.round((a0.quantity * p) * 100) / 100;
    const cost = Math.round((a0.quantity * (a0.cost_price || 0)) * 100) / 100;
    const profit = Math.round((mv - cost) * 100) / 100;
    const profit_pct = cost > 0 ? Math.round((profit / cost) * 10000) / 100 : 0;
    return { market_value: mv, profit, profit_pct, price_used: p, price_auto: !!(autoPrice != null && autoPrice > 0) };
  }
  let interest = 0;
  if (a0.profit_rate && a0.profit_rate > 0) {
    const years = (a0.term_months || 12) / 12;
    interest = Math.round((a0.quantity * (a0.profit_rate / 100) * years) * 100) / 100;
  }
  return { market_value: a0.quantity, profit: interest, profit_pct: a0.profit_rate || 0, price_used: p, price_auto: false };
}

