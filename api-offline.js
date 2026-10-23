'use strict';
// 资产聚合管理终端 · 离线 API 层（M6.1/6.2）— 与 server/index.js 全部端点同口径
// 前端 api() 在离线模式下路由到这里；返回形状与后端一致

const r2 = x => Math.round(x * 100) / 100;

function deprecInfo(r) {
  const cost = r.cost || r.est_value;
  if (!r.useful_life_years || r.useful_life_years <= 0 || !r.buy_date || !cost) {
    return { deprec: false, annual_depr: 0, month_depr: 0, accum_depr: 0, net_value: r.est_value };
  }
  const salvage = cost * (r.salvage_rate || 0);
  const annual = (cost - salvage) / r.useful_life_years;
  const start = new Date(r.buy_date);
  const now = new Date();
  const years = Math.max(0, Math.floor((now - start) / (365.25 * 864e5)));
  const accum = Math.min(cost - salvage, annual * years);
  return { deprec: true, annual_depr: r2(annual), month_depr: r2(annual / 12), accum_depr: r2(accum), net_value: r2(cost - accum) };
}
const fmt2 = x => (Math.round(x * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function Err(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
// 2.3.2 当前账本（与前端 CURRENT_BOOK 同步，记账归当前/默认账本）
function lb() { try { return Number(localStorage.getItem('at_book')) || 1; } catch (e) { return 1; } }
// 2.3.3 账本报表（离线聚合）
async function reportForBook(a, rows, booksRows, id, ym) {
  const book = booksRows.find(b => b.id === id) || { id, name: '账本' + id, is_default: 0 };
  const rs = rows.filter(r => (r.book_id || 1) === id);
  const m = rs.filter(r => (r.created_at || '').slice(0, 7) === ym);
  const inc = m.filter(r => r.direction === 'income').reduce((s, r) => s + r.amount, 0);
  const exp = m.filter(r => r.direction === 'expense').reduce((s, r) => s + r.amount, 0);
  const tMap = {};
  for (const r of rs) {
    const mk = (r.created_at || '').slice(0, 7);
    if (!tMap[mk]) tMap[mk] = { inc: 0, exp: 0 };
    if (r.direction === 'income') tMap[mk].inc += r.amount; else tMap[mk].exp += r.amount;
  }
  const trend = Object.keys(tMap).sort().slice(-6).map(mk => ({ month: mk, income: r2(tMap[mk].inc), expense: r2(tMap[mk].exp) }));
  const cMap = {};
  for (const r of m) {
    const k = r.cat_path || '未分类';
    if (!cMap[k]) cMap[k] = { inc: 0, exp: 0 };
    if (r.direction === 'income') cMap[k].inc += r.amount; else cMap[k].exp += r.amount;
  }
  const cats = Object.entries(cMap).map(([path, v]) => ({ path, direction: v.inc >= v.exp ? 'income' : 'expense', amount: r2(Math.max(v.inc, v.exp)) }))
    .sort((x, y) => y.amount - x.amount).slice(0, 20);
  const recs = [...rs].sort((x, y) => (y.created_at || '').localeCompare(x.created_at || '')).slice(0, 60)
    .map(r => ({ id: r.id, direction: r.direction, amount: r.amount, cat_path: r.cat_path,
      cat_leaf_id: r.cat_leaf_id, pool_id: r.pool_id, remark: r.remark, source: r.source,
      book_id: r.book_id, created_at: r.created_at }));
  return { book: { id: book.id, name: book.name, is_default: !!book.is_default },
    month: { income: r2(inc), expense: r2(exp), balance: r2(inc - exp), cnt: m.length },
    trend, cats, records: recs };
}

// 四标签独立判定（与后端 judgeTags 完全一致）
function judgeTags(net, cfg, tolerance = 10) {
  // 四组合：良好/优秀/高温（大病商业险不按金额判定，由用户手动标记后反向定档）
  const combos = [];
  for (const excellent of [false, true]) {
    for (const hot of [false, true]) {
      const expected = cfg.good_base
        + (excellent ? cfg.bonus_excellent : 0)
        + (hot ? cfg.bonus_hot : 0);
      combos.push({ excellent, hot, expected, diff: Math.abs(net - expected) });
    }
  }
  combos.sort((a, b) => a.diff - b.diff || a.expected - b.expected);
  const best = combos[0];
  if (best.diff > tolerance) return null;
  return { good: best.excellent ? 0 : 1, excellent: best.excellent ? 1 : 0, hot: best.hot ? 1 : 0, ill: 0, expected: best.expected };
}

// 某月生效配置
function configFor(cfgs, month) {
  const list = cfgs.filter(c => c.valid_from <= month).sort((a, b) =>
    b.valid_from.localeCompare(a.valid_from) || b.id - a.id);
  return list[0] || null;
}

// 五险一金分险种明细（与服务端 salaryBreakdown 完全同口径）
// 五险逐项四舍五入到分汇总；公积金个人/企业分边四舍五入到元再相加
function salaryBreakdown(cfg) {
  const base = cfg.social_base || 0;
  const R = (v, d) => (v === null || v === undefined) ? d : v;
  const items = [
    { key: 'pension',   name: '养老', cu: R(cfg.ins_pension_u, 0.16),    cp: R(cfg.ins_pension_p, 0.08) },
    { key: 'medical',   name: '医疗', cu: R(cfg.ins_medical_u, 0.07),    cp: R(cfg.ins_medical_p, 0.02) },
    { key: 'unemploy',  name: '失业', cu: R(cfg.ins_unemploy_u, 0.007),  cp: R(cfg.ins_unemploy_p, 0.003) },
    { key: 'injury',    name: '工伤', cu: R(cfg.ins_injury_u, 0.0104),   cp: 0 },
    { key: 'maternity', name: '生育', cu: R(cfg.ins_maternity_u, 0.01),  cp: 0 },
  ].map(r => {
    const cu = r2(base * r.cu);
    const cp = r2(base * r.cp);
    return { key: r.key, name: r.name, base, cu, cp, cu_pct: r.cu, cp_pct: r.cp };
  });
  const company_social = r2(items.reduce((s, x) => s + x.cu, 0));
  const personal_social = r2(items.reduce((s, x) => s + x.cp, 0));
  const fund_personal = Math.round(base * cfg.fund_rate);
  const fund_company = Math.round(base * R(cfg.fund_rate_u, cfg.fund_rate));
  const fund_total = fund_personal + fund_company;
  const gross = r2(base - personal_social - fund_personal);
  const company_cost = r2(gross + company_social + fund_company);
  return {
    items, company_social, personal_social,
    fund_personal, fund_company, fund_total, gross, company_cost,
    personal_total: r2(personal_social + fund_personal),
    company_total: r2(company_social + fund_company)
  };
}

// 报表聚合（与后端 reportAgg 同口径）
function offlineReportAgg(rows) {
  let income = 0, expense = 0;
  const incCat = {}, expCat = {}, pool = {};
  for (const r of rows) {
    if (r.direction === 'income') income += r.amount; else expense += r.amount;
    const k = (r.cat_path || '').split('/')[1] || '其他';
    if (r.direction === 'income') incCat[k] = (incCat[k] || 0) + r.amount;
    else expCat[k] = (expCat[k] || 0) + r.amount;
    pool[r.pool_id] = pool[r.pool_id] || { in: 0, out: 0 };
    if (r.direction === 'income') pool[r.pool_id].in += r.amount; else pool[r.pool_id].out += r.amount;
  }
  const top = rows.filter(r => r.direction === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 8)
    .map(r => ({ cat_path: r.cat_path, amount: r.amount, date: (r.created_at || '').slice(0, 10), remark: r.remark, source: r.source }));
  return {
    income_total: r2(income), expense_total: r2(expense), balance: r2(income - expense),
    income_by_cat: Object.entries(incCat).map(([k, v]) => ({ name: k, amount: r2(v) })).sort((a, b) => b.amount - a.amount),
    expense_by_cat: Object.entries(expCat).map(([k, v]) => ({ name: k, amount: r2(v) })).sort((a, b) => b.amount - a.amount),
    top_expense: top, by_pool: pool
  };
}

// M7.2 等额本息月供
function annuityMonthly(P, annualRatePct, months) {
  const r = annualRatePct / 100 / 12;
  if (r === 0) return P / months;
  return P * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
}
// M7.2 XIRR（与后端同算法，多起点）
function offlineXirr(cashflows) {
  if (cashflows.length < 2) return null;
  const fs = [...cashflows].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date(fs[0].date).getTime();
  const days = fs.map(c => (new Date(c.date).getTime() - t0) / 86400000);
  for (const guess of [0.1, 0.01, 0.3, 0.5]) {
    let rate = guess;
    for (let i = 0; i < 300; i++) {
      let f = 0, fd = 0;
      for (let j = 0; j < fs.length; j++) {
        const t = days[j] / 365;
        const base = Math.pow(1 + rate, t);
        f += fs[j].amount / base;
        fd += -t * fs[j].amount / Math.pow(1 + rate, t + 1);
      }
      if (fd === 0) break;
      const dr = f / fd;
      rate -= dr;
      if (Math.abs(dr) < 1e-8) return rate;
      if (rate < -0.999 || rate > 100) break;
    }
  }
  return null;
}

// 重算项目盈余账本
function rebuildBizSurplus(all, projectId) {
  const rows = all.biz_records.filter(r => r.project_id === projectId);
  const byMonth = {};
  for (const r of rows) {
    const m = (r.date || '').slice(0, 7);
    if (!m) continue;
    byMonth[m] = byMonth[m] || { inc: 0, cost: 0, tr: 0 };
    if (r.type === 'in') byMonth[m].inc += r.amount;
    else if (r.type === 'out') byMonth[m].cost += r.amount;
    else if (r.type === 'transfer') byMonth[m].tr += r.amount;
  }
  const months = Object.keys(byMonth).sort();
  let cum = 0;
  const out = [];
  for (const m of months) {
    cum += byMonth[m].inc - byMonth[m].cost - byMonth[m].tr;
    out.push({ project_id: projectId, month: m, income: r2(byMonth[m].inc), cost: r2(byMonth[m].cost), surplus: r2(byMonth[m].inc - byMonth[m].cost), cum_surplus: r2(cum) });
  }
  return out;
}

// 投资估值（与后端 investValuation 一致）
function investValuation(r) {
  if (r.kind === 'gold' || r.kind === 'security') {
    const mv = r2(r.quantity * r.price);
    const cost = r2(r.quantity * r.cost_price);
    const profit = r2(mv - cost);
    const profit_pct = cost > 0 ? r2((profit / cost) * 100) : 0;
    return { market_value: mv, profit, profit_pct };
  }
  let interest = 0;
  if (r.profit_rate && r.profit_rate > 0) {
    const years = (r.term_months || 12) / 12;
    interest = r2(r.quantity * (r.profit_rate / 100) * years);
  }
  return { market_value: r.quantity, profit: interest, profit_pct: r.profit_rate || 0 };
}

function daysLeftOf(dueDate, today) {
  return Math.round((new Date(dueDate) - new Date(today)) / 86400000);
}

// 按方向/级别/父级排序的分类树
function sortCats(list) {
  return [...list].sort((a, b) =>
    (a.direction === b.direction ? 0 : a.direction < b.direction ? -1 : 1)
    || a.lvl - b.lvl || a.sort - b.sort || a.id - b.id);
}

const OfflineAPI = {
  async route(path, opts) {
    const method = (opts?.method || 'GET').toUpperCase();
    let body = null;
    if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (_) { /* 忽略 */ } }
    const url = new URL(path, location.origin);
    const segs = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const q = Object.fromEntries(url.searchParams.entries());
    const P = (i) => segs[i];

    await IDB.idbSeedIfEmpty(); // 空库自动种子

    // ── 健康 / 状态 ─────────────────────────────────────
    if (segs.length === 2 && segs[1] === 'health') {
      return { ok: true, name: 'asset-terminal-offline', version: '0.1.0-offline', time: new Date().toISOString() };
    }
    if (segs.length === 3 && segs[1] === 'offline' && segs[2] === 'status') {
      const counts = {};
      for (const s of IDB.IDB_STORES) counts[s] = (await IDB.idbAll(s)).length;
      // 重复检测：同名同父同方向的分类 / 同名账户 / 同名经营项目（早期版本并发种子双写痕迹）
      const dupOf = (arr, key) => { const m = {}; let n = 0; for (const x of arr) { const k = key(x); m[k] = (m[k] || 0) + 1; } for (const k in m) if (m[k] > 1) n += m[k] - 1; return n; };
      const cats = await IDB.idbAll('rec_categories');
      const dup = dupOf(cats, c => `${c.direction}|${c.lvl}|${c.parent_id}|${c.name}`)
        + dupOf(await IDB.idbAll('pools'), p => `${p.name}|${p.tail}`)
        + dupOf(await IDB.idbAll('biz_projects'), p => `${p.name}|${p.pool_id}`);
      return { app: 'asset-terminal-offline', stores: counts, dup: dup || 0 };
    }
    if (segs.length === 3 && segs[1] === 'offline' && segs[2] === 'import') {
      if (method !== 'POST') throw Err('method not allowed');
      if (!body || typeof body !== 'object' || !body.pools) throw Err('无效的备份 JSON');
      await IDB.idbClearAll();
      await IDB.idbTx(async a => {
        for (const s of IDB.IDB_STORES) {
          if (Array.isArray(body[s])) for (const row of body[s]) await a.put(s, row);
        }
      });
      const counts = {};
      for (const s of IDB.IDB_STORES) counts[s] = (await IDB.idbAll(s)).length;
      return { ok: true, imported: counts };
    }

    // ── 导出备份（离线模式从 IndexedDB 全量导出）──────────
    if (segs[1] === 'export' && segs[2] === 'full' && segs.length === 3 && method === 'GET') {
      const out = { exported_at: new Date().toLocaleString('zh-CN'), app: 'asset-terminal-offline', version: '2.7.0' };
      for (const s of IDB.IDB_STORES) out[s] = await IDB.idbAll(s);
      return out;
    }
    if (segs[1] === 'export' && segs[2] === 'csv' && segs.length === 3 && method === 'GET') {
      const t = q.table;
      if (!t || !IDB.IDB_STORES.includes(t)) throw Err('未知表名');
      const rows = await IDB.idbAll(t);
      if (!rows.length) return { __csv: '无数据' };
      const cols = Object.keys(rows[0]);
      const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = '\uFEFF' + cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
      return { __csv: csv };
    }

    // ── 账户 ──────────────────────────────────────────
    if (segs[1] === 'pools' && segs.length === 2 && method === 'GET') {
      const all = await IDB.idbAll('pools');
      const list = q.book_id ? all.filter(p => (p.book_id || 1) === Number(q.book_id)) : all;
      return list.sort((a, b) => a.id - b.id);
    }
    if (segs[1] === 'pools' && segs.length === 2 && method === 'POST') {
      const { name, tail, kind = 'asset', balance = 0, bill_day = 0, due_day = 0, apr = 0, credit_limit = 0, book_id = 1 } = body || {};
      if (!name || !tail) throw Err('name 和 tail 必填');
      const id = await IDB.idbTx(async a => {
        const now = IDB.nowStr();
        return await a.add('pools', { name, tail, kind, balance, bill_day: Number(bill_day) || 0, due_day: Number(due_day) || 0, apr: Number(apr) || 0, credit_limit: Number(credit_limit) || 0, book_id: Number(book_id) || 1, created_at: now, updated_at: now });
      });
      return await IDB.idbGet('pools', id);
    }
    if (segs[1] === 'pools' && segs.length === 3 && method === 'PUT') {
      const p = await IDB.idbGet('pools', P(2));
      if (!p) throw Err('账户不存在', 404);
      const b = body || {};
      await IDB.idbTx(async a => {
        await a.put('pools', { ...p, name: b.name ?? p.name, tail: b.tail ?? p.tail, kind: b.kind ?? p.kind, bill_day: b.bill_day !== undefined ? (Number(b.bill_day) || 0) : (p.bill_day || 0), due_day: b.due_day !== undefined ? (Number(b.due_day) || 0) : (p.due_day || 0), apr: b.apr !== undefined ? (Number(b.apr) || 0) : (p.apr || 0), credit_limit: b.credit_limit !== undefined ? (Number(b.credit_limit) || 0) : (p.credit_limit || 0), book_id: b.book_id !== undefined ? (Number(b.book_id) || 1) : (p.book_id || 1), updated_at: IDB.nowStr() });
      });
      return await IDB.idbGet('pools', P(2));
    }
    if (segs[1] === 'pools' && segs.length === 3 && method === 'DELETE') {
      const records = await IDB.idbAll('records');
      if (records.some(r => r.pool_id === Number(P(2)))) throw Err('该池已有流水，禁止删除（请先转移流水）', 409);
      await IDB.idbTx(async a => { await a.del('pools', P(2)); });
      return { ok: true };
    }
    // 池间互转
    if (segs[1] === 'pools' && segs[2] === 'transfer' && method === 'POST') {
      const { from_pool_id, to_pool_id, amount, remark } = body || {};
      if (!from_pool_id || !to_pool_id) throw Err('from_pool_id/to_pool_id 必填');
      if (amount === undefined || amount === null || isNaN(amount) || amount <= 0) throw Err('金额必须大于 0');
      if (Number(from_pool_id) === Number(to_pool_id)) throw Err('转出与转入不能是同一账户');
      const out = await IDB.idbTx(async a => {
        const from = await a.get('pools', from_pool_id);
        const to = await a.get('pools', to_pool_id);
        if (!from || !to) throw Err('账户不存在', 404);
        if (from.kind === 'liability') throw Err('负债账户不可转出');
        if (from.balance < amount) throw Err('转出金额超过余额');
        const now = IDB.nowStr();
        const nf = r2(from.balance - amount), nt = r2(to.balance + amount);
        await a.put('pools', { ...from, balance: nf, updated_at: now });
        await a.put('pools', { ...to, balance: nt, updated_at: now });
        const op = await a.add('pool_ops', { op_type: 'transfer', from_pool_id: from.id, to_pool_id: to.id, amount, remark: remark || null, created_at: now });
        return { op, from: { ...from, balance: nf }, to: { ...to, balance: nt } };
      });
      return out;
    }
    // 对账冲正
    if (segs[1] === 'pools' && segs.length === 4 && segs[3] === 'reconcile' && method === 'POST') {
      const { actual_balance, remark } = body || {};
      if (actual_balance === undefined || actual_balance === null) throw Err('actual_balance 必填');
      const out = await IDB.idbTx(async a => {
        const pool = await a.get('pools', P(2));
        if (!pool) throw Err('账户不存在', 404);
        const diff = r2(Number(actual_balance) - pool.balance);
        const now = IDB.nowStr();
        await a.put('pools', { ...pool, balance: r2(Number(actual_balance)), updated_at: now });
        const op = await a.add('pool_ops', { op_type: 'reconcile', from_pool_id: pool.id, amount: diff, actual_balance: Number(actual_balance), prev_balance: pool.balance, remark: remark || null, created_at: now });
        return { op, pool: { ...pool, balance: r2(Number(actual_balance)) } };
      });
      return out;
    }
    // 池操作记录
    if (segs[1] === 'pool-ops' && method === 'GET') {
      const ops = await IDB.idbAll('pool_ops');
      const pools = await IDB.idbAll('pools');
      const pm = Object.fromEntries(pools.map(p => [p.id, p]));
      return ops.slice().sort((a, b) => b.id - a.id).slice(0, 100).map(o => ({
        ...o, from_name: o.from_pool_id ? pm[o.from_pool_id]?.name : null, to_name: o.to_pool_id ? pm[o.to_pool_id]?.name : null
      }));
    }

    // ── 记账分类树 ──────────────────────────────────────
    if (segs[1] === 'rec-categories' && segs.length === 2 && method === 'GET') {
      return sortCats(await IDB.idbAll('rec_categories'));
    }
    if (segs[1] === 'rec-categories' && segs.length === 2 && method === 'POST') {
      const { lvl, name, parent_id, direction } = body || {};
      if (!lvl || !name || !direction) throw Err('lvl/name/direction 必填');
      if (lvl > 1 && !parent_id) throw Err('非一级分类必须指定 parent_id');
      const cats = await IDB.idbAll('rec_categories');
      const sibs = cats.filter(c => c.parent_id === (lvl === 1 ? null : Number(parent_id)) && c.direction === direction);
      const maxSort = Math.max(-1, ...sibs.map(c => c.sort));
      const id = await IDB.idbTx(async a => await a.add('rec_categories', {
        lvl: Number(lvl), name, parent_id: lvl === 1 ? null : Number(parent_id), direction, sort: maxSort + 1, is_custom: 1
      }));
      return await IDB.idbGet('rec_categories', id);
    }
    if (segs[1] === 'rec-categories' && segs.length === 3 && method === 'PUT') {
      const c = await IDB.idbGet('rec_categories', P(2));
      if (!c) throw Err('分类不存在', 404);
      const b = body || {};
      await IDB.idbTx(async a => { await a.put('rec_categories', { ...c, name: b.name ?? c.name, sort: b.sort !== undefined ? Number(b.sort) : c.sort }); });
      return await IDB.idbGet('rec_categories', P(2));
    }
    if (segs[1] === 'rec-categories' && segs.length === 4 && segs[3] === 'move' && method === 'POST') {
      const { dir } = body || {};
      if (!['up', 'down'].includes(dir)) throw Err('dir 必须为 up/down');
      const out = await IDB.idbTx(async a => {
        const self = await a.get('rec_categories', P(2));
        if (!self) throw Err('分类不存在', 404);
        const cats = await a.all('rec_categories');
        const sibs = cats.filter(c => c.direction === self.direction && c.lvl === self.lvl && c.parent_id === self.parent_id)
          .sort((x, y) => x.sort - y.sort || x.id - y.id);
        const idx = sibs.findIndex(s => s.id === self.id);
        const swap = dir === 'up' ? sibs[idx - 1] : sibs[idx + 1];
        if (!swap) return { ok: false, error: '已在边界' };
        await a.put('rec_categories', { ...self, sort: swap.sort });
        await a.put('rec_categories', { ...swap, sort: self.sort });
        return { ok: true, self: { ...self, sort: swap.sort }, swap: { ...swap, sort: self.sort } };
      });
      return out;
    }
    if (segs[1] === 'rec-categories' && segs.length === 3 && method === 'DELETE') {
      const cats = await IDB.idbAll('rec_categories');
      const records = await IDB.idbAll('records');
      const id = Number(P(2));
      if (cats.some(c => c.parent_id === id)) throw Err('该分类下有子分类，请先删除子分类', 409);
      const flow = records.filter(r => r.cat_leaf_id === id).length;
      if (flow) throw Err(`该分类已有 ${flow} 条流水，禁止删除`, 409);
      await IDB.idbTx(async a => { await a.del('rec_categories', id); });
      return { ok: true };
    }

    // ── 记账流水 ────────────────────────────────────────
    if (segs[1] === 'records' && segs.length === 2 && method === 'GET') {
      let rows = await IDB.idbAll('records');
      if (q.month) rows = rows.filter(r => (r.created_at || '').slice(0, 7) === q.month);
      if (q.book_id) rows = rows.filter(r => (r.book_id || 1) === Number(q.book_id));
      if (q.pool_id) rows = rows.filter(r => r.pool_id === Number(q.pool_id));
      if (q.direction) rows = rows.filter(r => r.direction === q.direction);
      if (q.cat_id) rows = rows.filter(r => r.cat_leaf_id === Number(q.cat_id));
      if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(r => ((r.remark || '') + ' ' + (r.cat_path || '')).toLowerCase().includes(s)); }
      if (q.from) rows = rows.filter(r => (r.created_at || '').slice(0, 10) >= q.from);
      if (q.to) rows = rows.filter(r => (r.created_at || '').slice(0, 10) <= q.to);
      if (q.star) rows = rows.filter(r => r.is_star === 1);
      if (q.tag_id) {
        const rts = await IDB.idbAll('record_tags');
        const ids = new Set(rts.filter(x => x.tag_id === Number(q.tag_id)).map(x => x.record_id));
        rows = rows.filter(r => ids.has(r.id));
      }
      const lim = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
      const out = rows.sort((a, b) => b.id - a.id).slice(0, lim);
      const rts = await IDB.idbAll('record_tags');
      const tags = await IDB.idbAll('tags');
      const tmap = {};
      for (const rt of rts) (tmap[rt.record_id] = tmap[rt.record_id] || []).push({ id: rt.tag_id, name: tags.find(t => t.id === rt.tag_id)?.name, color: tags.find(t => t.id === rt.tag_id)?.color });
      return out.map(r => ({ ...r, tags: (tmap[r.id] || []).filter(t => t.name) }));
    }
    if (segs[1] === 'records' && segs.length === 2 && method === 'POST') {
      const { direction, amount, cat_path, cat_leaf_id, pool_id, remark, source = 'manual', book_id } = body || {};
      if (!direction || !amount || !cat_path || !pool_id) throw Err('direction/amount/cat_path/pool_id 必填');
      const out = await IDB.idbTx(async a => {
        const pool = await a.get('pools', pool_id);
        if (!pool) throw Err('账户不存在', 404);
        const sign = direction === 'income' ? 1 : -1;
        const rec = await a.add('records', {
          direction, amount, cat_path, cat_leaf_id: cat_leaf_id || null, pool_id: Number(pool_id),
          remark: remark || null, source, book_id: Number(book_id) || pool.book_id || lb(), created_at: IDB.nowStr()
        });
        if (source !== 'fund') {
          await a.put('pools', { ...pool, balance: r2(pool.balance + sign * amount), updated_at: IDB.nowStr() });
        }
        return rec;
      });
      return await IDB.idbGet('records', out);
    }
    // 撤销一笔（删除+回滚余额；fund 不动池）
    if (segs[1] === 'records' && segs.length === 3 && method === 'DELETE') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const r = await a.get('records', id);
        if (!r) throw Err('记录不存在', 404);
        if (r.source !== 'fund') {
          const pool = await a.get('pools', r.pool_id);
          if (pool) {
            const sign = r.direction === 'income' ? -1 : 1;
            await a.put('pools', { ...pool, balance: r2(pool.balance + sign * r.amount), updated_at: IDB.nowStr() });
          }
        }
        await a.del('records', id);
        return { ok: true };
      });
    }
    // 删除某月工资（回滚实发+删工资/公积金记账）
    if (segs[1] === 'salary' && segs[2] === 'month' && segs.length === 4 && method === 'DELETE') {
      const m = segs[3];
      return await IDB.idbTx(async a => {
        const sm = (await a.all('salary_month')).find(x => x.month === m);
        if (!sm) throw Err('该月份无工资记录', 404);
        const pool = (await a.all('pools')).filter(p => p.kind === 'asset').sort((x, y) => x.id - y.id)[0];
        if (pool) await a.put('pools', { ...pool, balance: r2(pool.balance - sm.net), updated_at: IDB.nowStr() });
        const recs = await a.all('records');
        for (const r of recs) {
          if ((r.source === 'salary' || r.source === 'fund') && (r.remark || '').startsWith(m)) await a.del('records', r.id);
        }
        await a.del('salary_month', sm.id);
        return { ok: true, cleared: sm.net };
      });
    }
    // 全量恢复（清库重写）
    if (segs[1] === 'import' && segs.length === 2 && method === 'POST') {
      const data = body || {};
      if (!Array.isArray(data.pools) || !Array.isArray(data.records)) throw Err('备份文件缺少 pools/records，导入中止');
      return await IDB.idbTx(async a => {
        for (const s of IDB.IDB_STORES) {
          const all = await a.all(s);
          for (const row of all) await a.del(s, row.id);
        }
        for (const s of IDB.IDB_STORES) {
          if (Array.isArray(data[s])) for (const row of data[s]) await a.put(s, row);
        }
        return { ok: true, pools: data.pools.length, records: data.records.length };
      });
    }

    // ── 预算（M7.1）──────────────────────────────────────
    if (segs[1] === 'budgets' && segs.length === 2 && method === 'GET') {
      if (!q.month) throw Err('month 必填，如 2026-09');
      const all = await IDB.idbAll('budgets');
      const rows = all.filter(b => b.year_month === q.month).sort((a, b) => (a.category_id ? 1 : 0) - (b.category_id ? 1 : 0) || a.id - b.id);
      const recs = (await IDB.idbAll('records')).filter(r => r.direction === 'expense' && (r.created_at || '').slice(0, 7) === q.month);
      const spentMap = {};
      let totalSpent = 0;
      for (const r of recs) { spentMap[r.cat_leaf_id] = (spentMap[r.cat_leaf_id] || 0) + r.amount; totalSpent += r.amount; }
      const totalBudget = rows.filter(r => !r.category_id).reduce((s, r) => s + r.amount, 0);
      const catBudget = rows.filter(r => r.category_id).reduce((s, r) => s + r.amount, 0);
      return {
        items: rows.map(r => ({ ...r, spent: r.category_id ? r2(spentMap[r.category_id] || 0) : null })),
        total_spent: r2(totalSpent), total_budget: r2(totalBudget), cat_budget: r2(catBudget)
      };
    }
    if (segs[1] === 'budgets' && segs.length === 2 && method === 'POST') {
      const { year_month, category_id, category_name, amount, carry_enabled } = body || {};
      if (!year_month || amount === undefined || isNaN(amount) || amount < 0) throw Err('year_month/amount 必填且金额≥0');
      return await IDB.idbTx(async a => {
        const all = await a.all('budgets');
        const catId = category_id ? Number(category_id) : null;
        const old = all.find(b => b.year_month === year_month && (catId ? b.category_id === catId : !b.category_id));
        if (old) {
          const nb = { ...old, amount, category_name: category_name || old.category_name, carry_enabled: carry_enabled ? 1 : (old.carry_enabled || 0) };
          await a.put('budgets', nb); return { budget: nb, ok: true };
        }
        const id = await a.add('budgets', { year_month, category_id: catId, category_name: category_name || null, amount, carry_enabled: carry_enabled ? 1 : 0, created_at: IDB.nowStr() });
        return { budget: await a.get('budgets', id), ok: true };
      });
    }
    if (segs[1] === 'budgets' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(a => a.del('budgets', Number(segs[2])));
      return { ok: true };
    }

    // 预算执行状态（离线版）
    if (segs[1] === 'budget' && segs[2] === 'status' && segs.length === 3 && method === 'GET') {
      const month = String(q.month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw Err('month 必填');
      const year = Number(month.slice(0, 4)), m = Number(month.slice(5));
      const budgets = await IDB.idbAll('budgets');
      const totalB = budgets.find(b => b.year_month === month && !b.category_id);
      const budget = totalB ? totalB.amount : 0;
      let carryOver = 0;
      if (totalB && totalB.carry_enabled) {
        const prevM = m === 1 ? (year - 1) + '-12' : year + '-' + String(m - 1).padStart(2, '0');
        const prev = budgets.find(b => b.year_month === prevM && !b.category_id);
        if (prev) {
          const prevRecs = (await IDB.idbAll('records')).filter(r => (r.created_at || '').slice(0, 7) === prevM && r.direction === 'expense' && r.source !== 'fund' && r.source !== 'transfer');
          const prevExp = prevRecs.reduce((s, r) => s + r.amount, 0);
          carryOver = Math.max(0, prev.amount - prevExp);
        }
      }
      const effBudget = budget + carryOver;
      const recs = await IDB.idbAll('records');
      const monthRecs = recs.filter(r => (r.created_at || '').slice(0, 7) === month);
      const exp = monthRecs.filter(r => r.direction === 'expense' && r.source !== 'fund' && r.source !== 'transfer').reduce((s, r) => s + r.amount, 0);
      const inc = monthRecs.filter(r => r.direction === 'income' && r.source !== 'fund' && r.source !== 'transfer').reduce((s, r) => s + r.amount, 0);
      const now = new Date();
      const daysInMonth = new Date(year, m, 0).getDate();
      const dayPassed = Math.min(Math.max(now.getDate(), 1), daysInMonth);
      const dailyBudget = effBudget / daysInMonth;
      const expected = dailyBudget * dayPassed;
      const remain = effBudget - exp;
      const dailyRemain = remain / Math.max(1, daysInMonth - dayPassed + 1);
      let level = 'ok';
      if (effBudget > 0) { const p = exp / effBudget; if (p >= 1) level = 'over'; else if (p >= 0.8) level = 'warn'; }
      const catRows = budgets.filter(c => c.year_month === month && c.category_id).map(c => {
        const e = monthRecs.filter(r => r.direction === 'expense' && r.cat_leaf_id === c.category_id).reduce((s, r) => s + r.amount, 0);
        return { id: c.id, category_id: c.category_id, category_name: c.category_name, amount: c.amount, spent: r2(e), remain: r2(c.amount - e) };
      });
      return { month, budget, carryOver: r2(carryOver), effBudget: r2(effBudget), exp: r2(exp), inc: r2(inc), remain: r2(remain), dailyBudget: r2(dailyBudget), expected: r2(expected), dailyRemain: r2(dailyRemain), level, daysInMonth, dayPassed, catRows };
    }

    // ── 周期记账（M7.1）──────────────────────────────────
    if (segs[1] === 'recurring' && segs.length === 2 && method === 'GET') {
      const rows = (await IDB.idbAll('recurring')).sort((a, b) => (b.enabled || 0) - (a.enabled || 0) || a.day_of_month - b.day_of_month || a.id - b.id);
      const d0 = new Date();
      const ym = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
      const today = d0.getDate();
      return rows.map(r => ({ ...r, due: r.enabled === 1 && (r.last_done_month || '') !== ym && r.day_of_month <= today }));
    }
    if (segs[1] === 'recurring' && segs.length === 2 && method === 'POST') {
      const { name, amount, direction, cat_path, cat_leaf_id, pool_id, day_of_month, remark } = body || {};
      if (!name || amount === undefined || isNaN(amount) || !cat_path || !pool_id) throw Err('name/amount/cat_path/pool_id 必填');
      const id = await IDB.idbTx(a => a.add('recurring', {
        name, amount, direction, cat_path, cat_leaf_id: cat_leaf_id || null, pool_id: Number(pool_id),
        day_of_month: Number(day_of_month) || 1, remark: remark || null, enabled: 1, last_done_month: null, created_at: IDB.nowStr()
      }));
      return { recurring: await IDB.idbGet('recurring', id), ok: true };
    }
    if (segs[1] === 'recurring' && segs.length === 3 && segs[2] !== 'run-all' && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('recurring', id);
        if (!old) throw Err('模板不存在', 404);
        const b = body || {};
        const v = (x, d) => (x === undefined ? d : x);
        const nb = {
          ...old, name: v(b.name, old.name), amount: v(b.amount, old.amount), direction: v(b.direction, old.direction),
          cat_path: v(b.cat_path, old.cat_path), cat_leaf_id: b.cat_leaf_id === undefined ? old.cat_leaf_id : b.cat_leaf_id,
          pool_id: v(b.pool_id, old.pool_id), day_of_month: b.day_of_month === undefined ? old.day_of_month : b.day_of_month,
          remark: b.remark === undefined ? old.remark : b.remark, enabled: b.enabled === undefined ? old.enabled : (b.enabled ? 1 : 0)
        };
        await a.put('recurring', nb); return { recurring: nb, ok: true };
      });
    }
    if (segs[1] === 'recurring' && segs.length === 3 && segs[2] !== 'run-all' && method === 'DELETE') {
      await IDB.idbTx(a => a.del('recurring', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'recurring' && segs[2] === 'run-all' && method === 'POST') {
      return await IDB.idbTx(async a => {
        const rows = (await a.all('recurring')).filter(r => r.enabled === 1);
        const d0 = new Date();
        const ym = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
        const today = d0.getDate();
        let n = 0;
        for (const t of rows) {
          if (t.last_done_month === ym || t.day_of_month > today) continue;
          const pool = await a.get('pools', t.pool_id);
          if (!pool) continue;
          const sign = t.direction === 'income' ? 1 : -1;
          await a.add('records', {
            direction: t.direction, amount: t.amount, cat_path: t.cat_path, cat_leaf_id: t.cat_leaf_id,
            pool_id: t.pool_id, remark: `${t.name}（${ym}周期）`, source: 'recurring', book_id: lb(), created_at: IDB.nowStr()
          });
          await a.put('pools', { ...pool, balance: r2(pool.balance + sign * t.amount), updated_at: IDB.nowStr() });
          await a.put('recurring', { ...t, last_done_month: ym });
          n++;
        }
        return { ok: true, executed: n };
      });
    }
    if (segs[1] === 'recurring' && segs.length === 3 && segs[2] !== 'run-all' && method === 'POST') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const t = await a.get('recurring', id);
        if (!t) throw Err('模板不存在', 404);
        const d0 = new Date();
        const ym = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
        if (t.last_done_month === ym) throw Err('本月已执行，防止重复入账', 409);
        const pool = await a.get('pools', t.pool_id);
        if (!pool) throw Err('绑定账户不存在', 404);
        const sign = t.direction === 'income' ? 1 : -1;
        const rid = await a.add('records', {
          direction: t.direction, amount: t.amount, cat_path: t.cat_path, cat_leaf_id: t.cat_leaf_id,
          pool_id: t.pool_id, remark: `${t.name}（${ym}周期）`, source: 'recurring', created_at: IDB.nowStr()
        });
        await a.put('pools', { ...pool, balance: r2(pool.balance + sign * t.amount), updated_at: IDB.nowStr() });
        await a.put('recurring', { ...t, last_done_month: ym });
        return { ok: true, record_id: rid, month: ym };
      });
    }
    if (segs[1] === 'recurring' && segs.length === 4 && segs[3] === 'run' && method === 'POST') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const t = await a.get('recurring', id);
        if (!t) throw Err('模板不存在', 404);
        const d0 = new Date();
        const ym = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
        if (t.last_done_month === ym) throw Err('本月已执行，防止重复入账', 409);
        const pool = await a.get('pools', t.pool_id);
        if (!pool) throw Err('绑定账户不存在', 404);
        const sign = t.direction === 'income' ? 1 : -1;
        const rid = await a.add('records', {
          direction: t.direction, amount: t.amount, cat_path: t.cat_path, cat_leaf_id: t.cat_leaf_id,
          pool_id: t.pool_id, remark: `${t.name}（${ym}周期）`, source: 'recurring', created_at: IDB.nowStr()
        });
        await a.put('pools', { ...pool, balance: r2(pool.balance + sign * t.amount), updated_at: IDB.nowStr() });
        await a.put('recurring', { ...t, last_done_month: ym });
        return { ok: true, record_id: rid, month: ym };
      });
    }

    // ── 报表（M7.1 月报/年报）────────────────────────────
    if (segs[1] === 'report' && segs[2] === 'month' && method === 'GET') {
      const { month } = q;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) throw Err('month 必填，格式 YYYY-MM');
      const recs = (await IDB.idbAll('records')).filter(r => (r.created_at || '').slice(0, 7) === month);
      const agg = offlineReportAgg(recs);
      const salary = (await IDB.idbAll('salary_month')).find(r => r.month === month) || null;
      const bizRecs = (await IDB.idbAll('biz_records')).filter(r => (r.date || '').slice(0, 7) === month);
      const biz = {};
      for (const r of bizRecs) biz[r.type] = r2((biz[r.type] || 0) + r.amount);
      const pools = await IDB.idbAll('pools');
      return { month, ...agg, salary, biz, pools };
    }
    if (segs[1] === 'report' && segs[2] === 'year' && method === 'GET') {
      const { year } = q;
      if (!year || !/^\d{4}$/.test(year)) throw Err('year 必填，格式 YYYY');
      const all = await IDB.idbAll('records');
      const agg = offlineReportAgg(all.filter(r => (r.created_at || '').slice(0, 4) === year));
      const months = [];
      for (let m = 1; m <= 12; m++) {
        const mm = `${year}-${String(m).padStart(2, '0')}`;
        const a = offlineReportAgg(all.filter(r => (r.created_at || '').slice(0, 7) === mm));
        months.push({ month: mm, income: a.income_total, expense: a.expense_total, balance: a.balance });
      }
      const salary = (await IDB.idbAll('salary_month')).filter(r => (r.month || '').slice(0, 4) === year).sort((a, b) => a.month.localeCompare(b.month));
      const salSum = salary.reduce((s, r) => ({
        net: s.net + (r.net || 0), gross: s.gross + (r.gross || 0),
        good: s.good + (r.tag_good || 0), excellent: s.excellent + (r.tag_excellent || 0),
        hot: s.hot + (r.tag_hot || 0), ill: s.ill + (r.tag_ill || 0)
      }), { net: 0, gross: 0, good: 0, excellent: 0, hot: 0, ill: 0 });
      return { year, ...agg, months, salary: { rows: salary, ...salSum } };
    }

    // ── 月度汇总 ────────────────────────────────────────
    if (segs[1] === 'summary' && method === 'GET') {
      if (!q.month) throw Err('month 必填，如 2026-09');
      const rows = await IDB.idbAll('records');
      const m = rows.filter(r => (r.created_at || '').slice(0, 7) === q.month && !(r.cat_path || '').startsWith('资金/'));
      let inc = 0, exp = 0;
      for (const r of m) { if (r.direction === 'income') inc += r.amount; else exp += r.amount; }
      return { month: q.month, income: r2(inc), expense: r2(exp), balance: r2(inc - exp), count: m.length };
    }

    // ── 工资模块 ────────────────────────────────────────
    if (segs[1] === 'salary' && segs[2] === 'config' && segs.length === 3 && method === 'GET') {
      return (await IDB.idbAll('salary_config')).sort((a, b) => b.valid_from.localeCompare(a.valid_from));
    }
    if (segs[1] === 'salary' && segs[2] === 'config' && segs[3] === 'current' && method === 'GET') {
      const m = q.month || IDB.monthStr();
      const cfgs = await IDB.idbAll('salary_config');
      const cfg = configFor(cfgs, m);
      if (!cfg) throw Err('该月份无生效配置', 404);
      const bd = salaryBreakdown(cfg);
      return {
        ...cfg, ins_personal_amt: bd.personal_social, fund_personal_amt: bd.fund_personal,
        fund_company_amt: bd.fund_company, fund_total: bd.fund_total, gross: bd.gross,
        company_cost: bd.company_cost, breakdown: bd
      };
    }
    if (segs[1] === 'salary' && segs[2] === 'months' && method === 'GET') {
      return (await IDB.idbAll('salary_month')).sort((a, b) => b.month.localeCompare(a.month));
    }
    if (segs[1] === 'salary' && segs[2] === 'overview' && method === 'GET') {
      const y = String(q.year || new Date().getFullYear());
      const rows = (await IDB.idbAll('salary_month')).filter(r => (r.month || '').slice(0, 4) === y);
      const s = { total: rows.length, good: 0, excellent: 0, hot: 0, ill: 0, net_sum: 0, gross_sum: 0 };
      for (const r of rows) {
        s.good += r.tag_good || 0; s.excellent += r.tag_excellent || 0; s.hot += r.tag_hot || 0; s.ill += r.tag_ill || 0;
        s.net_sum += r.net || 0; s.gross_sum += r.gross || 0;
      }
      return { year: Number(y), ...s, net_sum: r2(s.net_sum), gross_sum: r2(s.gross_sum) };
    }
    if (segs[1] === 'salary' && segs[2] === 'adj-log' && method === 'GET') {
      return (await IDB.idbAll('salary_adj_log')).sort((a, b) => b.id - a.id);
    }
    // 保存工资月记录（四标签判定 + 工资/公积金记账）
    if (segs[1] === 'salary' && segs[2] === 'month' && method === 'POST') {
      const { month, net, remark, tags_override } = body || {};
      if (!month || net === undefined || net === null || isNaN(net)) throw Err('month/net 必填');
      const out = await IDB.idbTx(async a => {
        const months = await a.all('salary_month');
        if (months.some(r => r.month === month)) throw Err(`${month} 已记录，请先删除或修改`, 409);
        const cfgs = await a.all('salary_config');
        const cfg = configFor(cfgs, month);
        if (!cfg) throw Err('该月份无生效工资配置，请先设置');
        const netV = Number(net);
        const illFlag = Number(body.ill || 0) ? 1 : 0;
        let tags;
        if (illFlag) {
          tags = judgeTags(netV + cfg.serious_ill, cfg); // 手动标记大病 → 金额+大病额反向定档
          if (tags) tags.ill = 1;
        } else {
          tags = judgeTags(netV, cfg); // 四组合：良好/优秀/高温
        }
        const final = tags_override ? { ...tags_override } : tags;
        if (!final) {
          throw Err(illFlag
            ? `金额 ¥${netV}+大病额未命中标准档位，请核对金额`
            : `金额 ¥${netV} 未命中标准档位（基准 ¥${cfg.good_base}±10），若本月含大病商业险扣款请先标记`);
        }
        const bd = salaryBreakdown(cfg);
        const gross = bd.gross;
        const pools = await a.all('pools');
        const defaultPool = pools.filter(p => p.kind === 'asset').sort((x, y) => x.id - y.id)[0];
        if (!defaultPool) throw Err('无资产账户可入账', 500);
        const sm = await a.add('salary_month', {
          month, social_base: cfg.social_base, gross, net: netV,
          tag_good: final.good, tag_excellent: final.excellent, tag_hot: final.hot, tag_ill: final.ill,
          config_id: cfg.id, remark: remark || null, created_at: IDB.nowStr()
        });
        // 工资实发入账
        const cats = await a.all('rec_categories');
        const salaryCat = cats.find(c => c.name === '工资' && c.direction === 'income' && c.lvl === 2);
        await a.add('records', {
          direction: 'income', amount: netV, cat_path: '收入/工资/基本工资', cat_leaf_id: salaryCat ? salaryCat.id : null,
          pool_id: defaultPool.id, remark: `${month} 工资`, source: 'salary', book_id: lb(), created_at: IDB.nowStr()
        });
        await a.put('pools', { ...defaultPool, balance: r2(defaultPool.balance + netV), updated_at: IDB.nowStr() });
        // 公积金同步记账（个人+单位，不动池余额）
        let fundCat = cats.find(c => c.name === '公积金' && c.direction === 'income');
        let fundCatId = fundCat ? fundCat.id : null;
        if (!fundCat) {
          const parent = cats.find(c => c.name === '工资' && c.direction === 'income' && c.lvl === 2);
          const nc = await a.add('rec_categories', { lvl: 3, name: '公积金', parent_id: parent ? parent.id : null, direction: 'income', sort: 10, is_custom: 1 });
          fundCatId = nc;
        }
        await a.add('records', {
          direction: 'income', amount: bd.fund_total, cat_path: '收入/工资/公积金', cat_leaf_id: fundCatId,
          pool_id: defaultPool.id, remark: `${month} 公积金(个人+单位)`, source: 'fund', book_id: lb(), created_at: IDB.nowStr()
        });
        return { salary: sm, tags: final, gross, cfg: { id: cfg.id, good_base: cfg.good_base }, fund_total: bd.fund_total };
      });
      return out;
    }
    // 调薪/调基/调比例（新增配置行 + 留痕）
    if (segs[1] === 'salary' && segs[2] === 'config' && segs.length === 3 && method === 'POST') {
      const { valid_from, adj_type, note, social_base, ins_personal, ins_unit, fund_rate, good_base,
        ins_pension_u, ins_pension_p, ins_medical_u, ins_medical_p,
        ins_unemploy_u, ins_unemploy_p, ins_injury_u, ins_maternity_u, fund_rate_u } = body || {};
      if (!valid_from) throw Err('valid_from 必填（如 2027-01）');
      if (!['salary', 'fund_base', 'rate'].includes(adj_type)) throw Err('adj_type 必须为 salary/fund_base/rate');
      const out = await IDB.idbTx(async a => {
        const cfgs = await a.all('salary_config');
        const prev = configFor(cfgs, valid_from);
        if (!prev) throw Err('该月份前无生效配置，无法调整');
        const pv = (v, d) => (v === undefined ? d : v);
        const cfg = await a.add('salary_config', {
          valid_from, social_base: pv(social_base, prev.social_base), ins_personal: pv(ins_personal, prev.ins_personal),
          ins_unit: pv(ins_unit, prev.ins_unit), fund_rate: pv(fund_rate, prev.fund_rate), good_base: pv(good_base, prev.good_base),
          bonus_excellent: prev.bonus_excellent, bonus_hot: prev.bonus_hot, serious_ill: prev.serious_ill,
          ins_pension_u: pv(ins_pension_u, prev.ins_pension_u), ins_pension_p: pv(ins_pension_p, prev.ins_pension_p),
          ins_medical_u: pv(ins_medical_u, prev.ins_medical_u), ins_medical_p: pv(ins_medical_p, prev.ins_medical_p),
          ins_unemploy_u: pv(ins_unemploy_u, prev.ins_unemploy_u), ins_unemploy_p: pv(ins_unemploy_p, prev.ins_unemploy_p),
          ins_injury_u: pv(ins_injury_u, prev.ins_injury_u), ins_maternity_u: pv(ins_maternity_u, prev.ins_maternity_u),
          fund_rate_u: pv(fund_rate_u, prev.fund_rate_u),
          created_at: IDB.nowStr()
        });
        const oldV = adj_type === 'salary' ? prev.good_base : adj_type === 'fund_base' ? prev.social_base : prev.fund_rate;
        const newV = adj_type === 'salary' ? pv(good_base, prev.good_base) : adj_type === 'fund_base' ? pv(social_base, prev.social_base) : pv(fund_rate, prev.fund_rate);
        await a.add('salary_adj_log', { adj_type, valid_from, old_value: oldV, new_value: newV, note: note || null, created_at: IDB.nowStr() });
        return cfg;
      });
      return { config: await IDB.idbGet('salary_config', out), ok: true };
    }

    // ── 经营：项目 ──────────────────────────────────────
    if (segs[1] === 'biz' && segs[2] === 'projects' && segs.length === 3 && method === 'GET') {
      const projects = await IDB.idbAll('biz_projects');
      const records = await IDB.idbAll('biz_records');
      const pools = await IDB.idbAll('pools');
      const pm = Object.fromEntries(pools.map(p => [p.id, p]));
      const ym = IDB.monthStr();
      return projects.sort((a, b) => a.id - b.id).map(p => {
        const rs = records.filter(r => r.project_id === p.id);
        const inc = rs.filter(r => r.type === 'in').reduce((s, r) => s + r.amount, 0);
        const cost = rs.filter(r => r.type === 'out').reduce((s, r) => s + r.amount, 0);
        const tr = rs.filter(r => r.type === 'transfer').reduce((s, r) => s + r.amount, 0);
        const ms = rs.filter(r => (r.date || '').slice(0, 7) === ym);
        const mi = ms.filter(r => r.type === 'in').reduce((s, r) => s + r.amount, 0);
        const mc = ms.filter(r => r.type === 'out').reduce((s, r) => s + r.amount, 0);
        const pool = pm[p.pool_id];
        return {
          ...p, pool_name: pool?.name || null, pool_tail: pool?.tail || null,
          total_income: r2(inc), total_cost: r2(cost), total_transfer: r2(tr),
          month_income: r2(mi), month_cost: r2(mc), month_surplus: r2(mi - mc),
          total_surplus: r2(inc - cost), cum_surplus: r2(inc - cost - tr),
          record_count: rs.length
        };
      });
    }
    if (segs[1] === 'biz' && segs[2] === 'projects' && segs.length === 3 && method === 'POST') {
      const { name, pool_id } = body || {};
      if (!name || !name.trim()) throw Err('项目名称必填');
      if (!pool_id) throw Err('请绑定账户');
      const out = await IDB.idbTx(async a => {
        const projects = await a.all('biz_projects');
        if (projects.some(p => p.name === name.trim())) throw Err('项目已存在', 409);
        const pool = await a.get('pools', pool_id);
        if (!pool) throw Err('账户不存在', 404);
        const pid = await a.add('biz_projects', { name: name.trim(), asset_id: null, pool_id: Number(pool_id), created_at: IDB.nowStr() });
        const ins = (lvl, nm, parent, dir, sort, custom) =>
          a.add('biz_categories', { project_id: pid, lvl, name: nm, direction: dir, parent_id: parent, sort, is_custom: custom || 0 });
        const inc = await ins(1, '收入', null, 'in', 0, 0);
        const outC = await ins(1, '成本', null, 'out', 1, 0);
        let p = await ins(2, '租金', inc, 'in', 0, 0);
        await ins(3, '住宅租金', p, 'in', 0, 0); await ins(3, '商铺租金', p, 'in', 1, 0);
        p = await ins(2, '营业收入', inc, 'in', 1, 0);
        await ins(3, '商品销售', p, 'in', 0, 0); await ins(3, '服务费', p, 'in', 1, 0);
        await ins(2, '其他收入', inc, 'in', 2, 0);
        p = await ins(2, '经营成本', outC, 'out', 0, 0);
        await ins(3, '水电', p, 'out', 0, 0); await ins(3, '物业', p, 'out', 1, 0); await ins(3, '维修', p, 'out', 2, 0);
        await ins(3, '人工', p, 'out', 3, 0); await ins(3, '物料', p, 'out', 4, 0);
        p = await ins(2, '税费', outC, 'out', 1, 0);
        await ins(3, '增值税', p, 'out', 0, 0); await ins(3, '个税', p, 'out', 1, 0);
        await ins(2, '其他支出', outC, 'out', 2, 0);
        return pid;
      });
      return await IDB.idbGet('biz_projects', out);
    }
    if (segs[1] === 'biz' && segs[2] === 'projects' && segs.length === 4 && method === 'PUT') {
      const p = await IDB.idbGet('biz_projects', P(3));
      if (!p) throw Err('项目不存在', 404);
      const b = body || {};
      await IDB.idbTx(async a => {
        const projects = await a.all('biz_projects');
        if (b.name !== undefined && (!b.name.trim() || projects.some(x => x.name === b.name.trim() && x.id !== p.id)))
          throw Err('项目名称为空或已存在', 409);
        if (b.pool_id !== undefined && !(await a.get('pools', b.pool_id))) throw Err('账户不存在', 404);
        await a.put('biz_projects', { ...p, name: b.name?.trim() ?? p.name, pool_id: b.pool_id !== undefined ? Number(b.pool_id) : p.pool_id });
      });
      return await IDB.idbGet('biz_projects', P(3));
    }
    if (segs[1] === 'biz' && segs[2] === 'projects' && segs.length === 4 && method === 'DELETE') {
      const p = await IDB.idbGet('biz_projects', P(3));
      if (!p) throw Err('项目不存在', 404);
      const records = await IDB.idbAll('biz_records');
      const c = records.filter(r => r.project_id === p.id).length;
      if (c) throw Err(`项目已有 ${c} 条流水，禁止删除（可先重置）`, 409);
      await IDB.idbTx(async a => {
        const cats = await a.all('biz_categories');
        for (const x of cats.filter(x => x.project_id === p.id)) await a.del('biz_categories', x.id);
        await a.del('biz_projects', p.id);
      });
      return { ok: true };
    }
    // 重置项目：清空流水（回滚绑池余额）+ 清往来/盈余 + 分类恢复默认模板
    if (segs[1] === 'biz' && segs[2] === 'projects' && segs.length === 5 && segs[4] === 'reset' && method === 'POST') {
      const p = await IDB.idbGet('biz_projects', P(3));
      if (!p) throw Err('项目不存在', 404);
      await IDB.idbTx(async a => {
        const pool = await a.get('pools', p.pool_id);
        if (!pool) throw Err('绑池不存在', 500);
        const rows = (await a.all('biz_records')).filter(r => r.project_id === p.id);
        for (const r of rows) {
          if (r.type === 'in' || r.type === 'out') {
            const sign = r.type === 'in' ? -1 : 1;
            await a.put('pools', { ...pool, balance: r2(pool.balance + sign * r.amount), updated_at: IDB.nowStr() });
          }
          await a.del('biz_records', r.id);
        }
        // 联动删除记账流水（source=biz 且含项目名）
        for (const rc of (await a.all('records')).filter(x => x.source === 'biz' && (x.remark || '').includes(p.name)))
          await a.del('records', rc.id);
        for (const s of (await a.all('biz_surplus')).filter(x => x.project_id === p.id)) await a.del('biz_surplus', s.id);
        for (const ar of (await a.all('biz_arap')).filter(x => x.project_id === p.id)) await a.del('biz_arap', ar.id);
        for (const c of (await a.all('biz_categories')).filter(x => x.project_id === p.id)) await a.del('biz_categories', c.id);
        // 重建默认分类模板
        const ins = (lvl, nm, parent, dir, sort, custom) =>
          a.add('biz_categories', { project_id: p.id, lvl, name: nm, direction: dir, parent_id: parent, sort, is_custom: custom || 0 });
        const inc = await ins(1, '收入', null, 'in', 0, 0);
        const outC = await ins(1, '成本', null, 'out', 1, 0);
        let cp = await ins(2, '租金', inc, 'in', 0, 0);
        await ins(3, '住宅租金', cp, 'in', 0, 0); await ins(3, '商铺租金', cp, 'in', 1, 0);
        cp = await ins(2, '营业收入', inc, 'in', 1, 0);
        await ins(3, '商品销售', cp, 'in', 0, 0); await ins(3, '服务费', cp, 'in', 1, 0);
        await ins(2, '其他收入', inc, 'in', 2, 0);
        cp = await ins(2, '经营成本', outC, 'out', 0, 0);
        await ins(3, '水电', cp, 'out', 0, 0); await ins(3, '物业', cp, 'out', 1, 0);
        await ins(3, '维修', cp, 'out', 2, 0); await ins(3, '人工', cp, 'out', 3, 0); await ins(3, '物料', cp, 'out', 4, 0);
        cp = await ins(2, '税费', outC, 'out', 1, 0);
        await ins(3, '增值税', cp, 'out', 0, 0); await ins(3, '个税', cp, 'out', 1, 0);
        await ins(2, '其他支出', outC, 'out', 2, 0);
      });
      return { ok: true };
    }

    // ── 经营：分类 ──────────────────────────────────────
    if (segs[1] === 'biz' && segs[2] === 'categories' && segs.length === 3 && method === 'GET') {
      if (!q.project_id) throw Err('project_id 必填');
      return (await IDB.idbAll('biz_categories')).filter(c => c.project_id === Number(q.project_id))
        .sort((a, b) => a.lvl - b.lvl || a.sort - b.sort || a.id - b.id);
    }
    if (segs[1] === 'biz' && segs[2] === 'categories' && segs.length === 3 && method === 'POST') {
      const { project_id, lvl, name, parent_id, direction } = body || {};
      if (!project_id || !lvl || !name?.trim()) throw Err('project_id/lvl/name 必填');
      if (![2, 3].includes(Number(lvl))) throw Err('经营分类仅支持二级/三级自定义');
      const out = await IDB.idbTx(async a => {
        const proj = await a.get('biz_projects', project_id);
        if (!proj) throw Err('项目不存在', 404);
        let dir = direction;
        if (Number(lvl) > 1) {
          const parent = await a.get('biz_categories', parent_id);
          if (!parent || parent.project_id !== Number(project_id)) throw Err('父分类不存在');
          dir = parent.direction;
        }
        if (!['in', 'out'].includes(dir)) throw Err('direction 必须为 in/out');
        const cats = await a.all('biz_categories');
        const sibs = cats.filter(c => c.project_id === Number(project_id) && c.parent_id === (Number(lvl) === 1 ? null : Number(parent_id)));
        const maxSort = Math.max(-1, ...sibs.map(c => c.sort));
        return await a.add('biz_categories', {
          project_id: Number(project_id), lvl: Number(lvl), name: name.trim(), direction: dir,
          parent_id: Number(lvl) === 1 ? null : Number(parent_id), sort: maxSort + 1, is_custom: 1
        });
      });
      return await IDB.idbGet('biz_categories', out);
    }
    if (segs[1] === 'biz' && segs[2] === 'categories' && segs.length === 4 && method === 'PUT') {
      const c = await IDB.idbGet('biz_categories', P(3));
      if (!c) throw Err('分类不存在', 404);
      const { name } = body || {};
      if (!name?.trim()) throw Err('名称必填');
      await IDB.idbTx(async a => { await a.put('biz_categories', { ...c, name: name.trim() }); });
      return { ok: true };
    }
    if (segs[1] === 'biz' && segs[2] === 'categories' && segs.length === 5 && segs[4] === 'move' && method === 'POST') {
      const c = await IDB.idbGet('biz_categories', P(3));
      if (!c) throw Err('分类不存在', 404);
      const { dir } = body || {};
      const out = await IDB.idbTx(async a => {
        const cats = await a.all('biz_categories');
        const sibs = cats.filter(x => x.project_id === c.project_id && x.lvl === c.lvl && x.parent_id === c.parent_id)
          .sort((x, y) => x.sort - y.sort || x.id - y.id);
        const i = sibs.findIndex(x => x.id === c.id);
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= sibs.length) throw Err('已在边界');
        const other = sibs[j];
        await a.put('biz_categories', { ...c, sort: other.sort });
        await a.put('biz_categories', { ...other, sort: c.sort });
        return { ok: true };
      });
      return out;
    }
    if (segs[1] === 'biz' && segs[2] === 'categories' && segs.length === 4 && method === 'DELETE') {
      const c = await IDB.idbGet('biz_categories', P(3));
      if (!c) throw Err('分类不存在', 404);
      const cats = await IDB.idbAll('biz_categories');
      const recs = await IDB.idbAll('biz_records');
      if (cats.some(x => x.parent_id === c.id)) throw Err('该分类下有子分类，请先删除子分类', 409);
      const flow = recs.filter(r => r.cat_leaf_id === c.id).length;
      if (flow) throw Err(`该分类已有 ${flow} 条流水，禁止删除`, 409);
      await IDB.idbTx(async a => { await a.del('biz_categories', c.id); });
      return { ok: true };
    }

    // ── 经营：流水 + 盈余账本 ───────────────────────────
    if (segs[1] === 'biz' && segs[2] === 'surplus' && method === 'GET') {
      if (!q.project_id) throw Err('project_id 必填');
      return (await IDB.idbAll('biz_surplus')).filter(s => s.project_id === Number(q.project_id))
        .sort((a, b) => b.month.localeCompare(a.month));
    }
    if (segs[1] === 'biz' && segs[2] === 'records' && segs.length === 3 && method === 'POST') {
      const { project_id, cat_leaf_id, amount, date, remark } = body || {};
      if (!project_id || !cat_leaf_id) throw Err('project_id/cat_leaf_id 必填');
      if (amount === undefined || isNaN(amount) || amount <= 0) throw Err('金额必须大于 0');
      const out = await IDB.idbTx(async a => {
        const proj = await a.get('biz_projects', project_id);
        if (!proj) throw Err('项目不存在', 404);
        const cat = await a.get('biz_categories', cat_leaf_id);
        if (!cat || cat.project_id !== Number(project_id)) throw Err('分类不存在', 404);
        const d = date || IDB.todayStr();
        const type = cat.direction === 'in' ? 'in' : 'out';
        let path = cat.name;
        let cur = cat;
        for (let i = 0; i < 4 && cur.parent_id; i++) {
          const parent = await a.get('biz_categories', cur.parent_id);
          if (parent) { path = parent.name + '/' + path; cur = parent; } else break;
        }
        const pool = await a.get('pools', proj.pool_id);
        if (!pool) throw Err('项目绑池不存在', 500);
        if (type === 'out' && pool.balance < amount) throw Err('绑池余额不足');
        const sign = type === 'in' ? 1 : -1;
        const rec = await a.add('biz_records', {
          project_id: Number(project_id), type, cat_path: path, cat_leaf_id: Number(cat_leaf_id),
          amount, pool_id: pool.id, date: d, remark: remark || null, created_at: IDB.nowStr()
        });
        await a.put('pools', { ...pool, balance: r2(pool.balance + sign * amount), updated_at: IDB.nowStr() });
        const dir = type === 'in' ? 'income' : 'expense';
        const cats = await a.all('rec_categories');
        const recCat = cats.find(c => c.name === '经营' && c.direction === dir && c.lvl === 2);
        await a.add('records', {
          direction: dir, amount, cat_path: '经营/' + path, cat_leaf_id: recCat ? recCat.id : null,
          pool_id: pool.id, remark: `${proj.name}·${d} ${path}${remark ? ' ' + remark : ''}`, source: 'biz', book_id: lb(), created_at: IDB.nowStr()
        });
        // 重建盈余账本
        const all = { biz_records: await a.all('biz_records') };
        const surplus = rebuildBizSurplus(all, Number(project_id));
        const oldSurplus = await a.all('biz_surplus');
        for (const s of oldSurplus.filter(s => s.project_id === Number(project_id))) await a.del('biz_surplus', s.id);
        for (const s of surplus) await a.add('biz_surplus', s);
        return rec;
      });
      return await IDB.idbGet('biz_records', out);
    }
    if (segs[1] === 'biz' && segs[2] === 'records' && segs.length === 3 && method === 'GET') {
      if (!q.project_id) throw Err('project_id 必填');
      let rows = (await IDB.idbAll('biz_records')).filter(r => r.project_id === Number(q.project_id));
      if (q.month) rows = rows.filter(r => (r.date || '').slice(0, 7) === q.month);
      return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id).slice(0, 200);
    }
    if (segs[1] === 'biz' && segs[2] === 'records' && segs.length === 4 && method === 'DELETE') {
      const r = await IDB.idbGet('biz_records', P(3));
      if (!r) throw Err('流水不存在', 404);
      if (r.type === 'transfer') throw Err('转存记录请在转存明细中处理，不可直接删除');
      await IDB.idbTx(async a => {
        const sign = r.type === 'in' ? -1 : 1;
        const pool = await a.get('pools', r.pool_id);
        if (pool) await a.put('pools', { ...pool, balance: r2(pool.balance + sign * r.amount), updated_at: IDB.nowStr() });
        await a.del('biz_records', r.id);
        const recs = await a.all('records');
        for (const rc of recs) {
          if (rc.source === 'biz' && rc.amount === r.amount && rc.pool_id === r.pool_id
            && (r.remark ? (rc.remark || '').includes(r.remark) : true)) {
            await a.del('records', rc.id);
            break;
          }
        }
        const all = { biz_records: await a.all('biz_records') };
        const surplus = rebuildBizSurplus(all, r.project_id);
        const oldSurplus = await a.all('biz_surplus');
        for (const s of oldSurplus.filter(s => s.project_id === r.project_id)) await a.del('biz_surplus', s.id);
        for (const s of surplus) await a.add('biz_surplus', s);
      });
      return { ok: true };
    }
    // 盈余转存
    if (segs[1] === 'biz' && segs[2] === 'transfer' && method === 'POST') {
      const { project_id, amount, target_pool_id, date, remark } = body || {};
      if (!project_id || !target_pool_id) throw Err('project_id/target_pool_id 必填');
      if (amount === undefined || isNaN(amount) || amount <= 0) throw Err('金额必须大于 0');
      const out = await IDB.idbTx(async a => {
        const proj = await a.get('biz_projects', project_id);
        if (!proj) throw Err('项目不存在', 404);
        const from = await a.get('pools', proj.pool_id);
        const to = await a.get('pools', target_pool_id);
        if (!to) throw Err('目标账户不存在', 404);
        if (Number(target_pool_id) === proj.pool_id) throw Err('目标池不能与绑池相同');
        if (!from) throw Err('项目绑池不存在', 500);
        if (from.balance < amount) throw Err('绑池余额不足');
        const rs = await a.all('biz_records');
        const recs = rs.filter(r => r.project_id === Number(project_id));
        const can = recs.reduce((s, r) => s + (r.type === 'in' ? r.amount : r.type === 'out' ? -r.amount : -r.amount), 0);
        if (amount > can + 0.001) throw Err(`可转存盈余仅 ¥${fmt2(can)}`);
        const d = date || IDB.todayStr();
        const nf = r2(from.balance - amount), nt = r2(to.balance + amount);
        await a.put('pools', { ...from, balance: nf, updated_at: IDB.nowStr() });
        await a.put('pools', { ...to, balance: nt, updated_at: IDB.nowStr() });
        await a.add('pool_ops', { op_type: 'transfer', from_pool_id: from.id, to_pool_id: to.id, amount, remark: `盈余转存·${proj.name} ${remark || ''}`.trim(), created_at: IDB.nowStr() });
        const tr = await a.add('biz_records', {
          project_id: Number(project_id), type: 'transfer', cat_path: '盈余转存', cat_leaf_id: null,
          amount, pool_id: to.id, date: d, remark: remark || `转存至 ${to.name}`, created_at: IDB.nowStr()
        });
        const all = { biz_records: await a.all('biz_records') };
        const surplus = rebuildBizSurplus(all, Number(project_id));
        const oldSurplus = await a.all('biz_surplus');
        for (const s of oldSurplus.filter(s => s.project_id === Number(project_id))) await a.del('biz_surplus', s.id);
        for (const s of surplus) await a.add('biz_surplus', s);
        return { transfer: tr, from: { ...from, balance: nf }, to: { ...to, balance: nt } };
      });
      return out;
    }

    // ── 经营：资金往来 ──────────────────────────────────
    if (segs[1] === 'biz' && segs[2] === 'arap' && segs.length === 3 && method === 'GET') {
      const today = IDB.todayStr();
      const all = await IDB.idbAll('biz_arap');
      return (q.project_id ? all.filter(r => r.project_id === Number(q.project_id)) : all)
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1)
          || (a.due_date || '').localeCompare(b.due_date || '') || b.id - a.id)
        .map(r => ({ ...r, days_left: daysLeftOf(r.due_date, today) }));
    }
    if (segs[1] === 'biz' && segs[2] === 'arap' && segs[3] === 'summary' && method === 'GET') {
      const today = IDB.todayStr();
      const all = await IDB.idbAll('biz_arap');
      const rows = q.project_id ? all.filter(r => r.project_id === Number(q.project_id)) : all;
      const s = { recv: 0, pay: 0, recv_settled: 0, pay_settled: 0, overdue: 0, overdue_amt: 0, due7: 0, due7_amt: 0 };
      const monthly = {};
      for (const r of rows) {
        const dl = daysLeftOf(r.due_date, today);
        if (r.type === 'receivable') {
          s.recv += r.amount;
          if (r.status === 'settled') s.recv_settled += r.amount;
          else if (dl < 0) { s.overdue++; s.overdue_amt += r.amount; }
          else if (dl <= 7) { s.due7++; s.due7_amt += r.amount; }
        } else {
          s.pay += r.amount;
          if (r.status === 'settled') s.pay_settled += r.amount;
          else if (dl < 0) { s.overdue++; s.overdue_amt += r.amount; }
          else if (dl <= 7) { s.due7++; s.due7_amt += r.amount; }
        }
        const m = (r.due_date || '').slice(0, 7);
        if (m) {
          monthly[m] = monthly[m] || { recv: 0, pay: 0 };
          if (r.type === 'receivable') monthly[m].recv += r.amount; else monthly[m].pay += r.amount;
        }
      }
      const months = Object.keys(monthly).sort();
      return {
        receivable: r2(s.recv), receivable_settled: r2(s.recv_settled), receivable_open: r2(s.recv - s.recv_settled),
        payable: r2(s.pay), payable_settled: r2(s.pay_settled), payable_open: r2(s.pay - s.pay_settled),
        net_receivable: r2((s.recv - s.recv_settled) - (s.pay - s.pay_settled)),
        overdue_count: s.overdue, overdue_amount: r2(s.overdue_amt),
        due7_count: s.due7, due7_amount: r2(s.due7_amt),
        monthly: months.map(m => ({ month: m, recv: r2(monthly[m].recv), pay: r2(monthly[m].pay) }))
      };
    }
    if (segs[1] === 'biz' && segs[2] === 'arap' && segs.length === 3 && method === 'POST') {
      const { project_id, type, party, amount, record_date, due_days, remark, nature } = body || {};
      if (!project_id || !type || !party?.trim()) throw Err('project_id/type/party 必填');
      if (!['receivable', 'payable'].includes(type)) throw Err('type 必须为 receivable/payable');
      if (amount === undefined || isNaN(amount) || amount <= 0) throw Err('金额必须大于 0');
      const out = await IDB.idbTx(async a => {
        const proj = await a.get('biz_projects', project_id);
        if (!proj) throw Err('项目不存在', 404);
        const days = Number(due_days || 30);
        if (isNaN(days) || days < 0) throw Err('账期天数不合法');
        const base = record_date || IDB.todayStr();
        const due = new Date(new Date(base).getTime() + days * 86400000).toISOString().slice(0, 10);
        const nat = nature === 'loan' ? 'loan' : 'biz';
        return await a.add('biz_arap', {
          project_id: Number(project_id), type, nature: nat, party: party.trim(), amount, record_date: base,
          due_days: days, due_date: due, status: 'open', remark: remark || null, created_at: IDB.nowStr(), sync_record_id: null
        });
      });
      return await IDB.idbGet('biz_arap', out);
    }
    if (segs[1] === 'biz' && segs[2] === 'arap' && segs.length === 4 && method === 'PUT') {
      const a0 = await IDB.idbGet('biz_arap', P(3));
      if (!a0) throw Err('记录不存在', 404);
      const b = body || {};
      if (b.status) {
        if (!['open', 'settled'].includes(b.status)) throw Err('status 必须为 open/settled');
        if (b.status === a0.status) return a0;
        const out = await IDB.idbTx(async a => {
          if (b.status === 'settled') {
            const proj = await a.get('biz_projects', a0.project_id);
            const pool = proj && await a.get('pools', proj.pool_id);
            if (!pool || pool.kind === 'liability') throw Err('项目未绑定资产账户，无法联动入账。请先给项目绑定账户');
            const isRecv = a0.type === 'receivable';
            const isLoan = a0.nature === 'loan';
            const countIncome = b.sync_income !== undefined ? !!b.sync_income : !isLoan;
            const cat = isLoan ? (isRecv ? '资金/借出收回' : '资金/借入偿还') : (isRecv ? '收入/资金回收' : '支出/资金付款');
            const newBal = r2(pool.balance + (isRecv ? a0.amount : -a0.amount));
            const rec = await a.add('records', {
              direction: isRecv ? 'income' : 'expense', amount: a0.amount, cat_path: cat, cat_leaf_id: null,
              pool_id: pool.id, remark: (isRecv ? '应收结清·' : '应付结清·') + a0.party + (isLoan ? (isRecv ? '（借出收回）' : '（借入偿还）') : ''),
              source: 'arap', book_id: lb(), created_at: IDB.nowStr()
            });
            await a.put('pools', { ...pool, balance: newBal, updated_at: IDB.nowStr() });
            await a.put('biz_arap', { ...a0, status: 'settled', sync_record_id: rec });
            return { ...a0, status: 'settled', sync_record_id: rec, synced: { direction: isRecv ? 'income' : 'expense', amount: a0.amount, pool: pool.name + '·' + pool.tail, balance: newBal, counted: countIncome, cat } };
          }
          // 重开：回滚
          if (a0.sync_record_id) {
            const rec = await a.get('records', a0.sync_record_id);
            if (rec) {
              const pool = await a.get('pools', rec.pool_id);
              if (pool) {
                const isRecv = rec.direction === 'income';
                await a.put('pools', { ...pool, balance: r2(pool.balance + (isRecv ? -rec.amount : rec.amount)), updated_at: IDB.nowStr() });
              }
              await a.del('records', rec.id);
            }
          }
          await a.put('biz_arap', { ...a0, status: 'open', sync_record_id: null });
          return { ...a0, status: 'open', sync_record_id: null, rolled_back: true };
        });
        return out;
      }
      // 编辑
      const party = b.party?.trim() ?? a0.party;
      if (!party) throw Err('对方名称必填');
      const amount = b.amount !== undefined ? Number(b.amount) : a0.amount;
      if (isNaN(amount) || amount <= 0) throw Err('金额必须大于 0');
      const base = b.record_date || a0.record_date;
      const days = b.due_days !== undefined ? Number(b.due_days) : a0.due_days;
      if (isNaN(days) || days < 0) throw Err('账期天数不合法');
      const due = new Date(new Date(base).getTime() + days * 86400000).toISOString().slice(0, 10);
      const nat = b.nature !== undefined ? (b.nature === 'loan' ? 'loan' : 'biz') : a0.nature;
      await IDB.idbTx(async a => {
        await a.put('biz_arap', {
          ...a0, party, amount, record_date: base, due_days: days, due_date: due,
          remark: b.remark !== undefined ? (b.remark || null) : a0.remark, nature: nat
        });
      });
      return await IDB.idbGet('biz_arap', P(3));
    }
    if (segs[1] === 'biz' && segs[2] === 'arap' && segs.length === 4 && method === 'DELETE') {
      await IDB.idbTx(async a => { await a.del('biz_arap', P(3)); });
      return { ok: true };
    }

    // ── 数据导出 ────────────────────────────────────────
    if (segs[1] === 'export' && segs[2] === 'full' && method === 'GET') {
      const out = { exported_at: new Date().toLocaleString('zh-CN'), app: 'asset-terminal', version: 'M6.1-offline' };
      for (const s of IDB.IDB_STORES) out[s] = (await IDB.idbAll(s)).sort((a, b) => a.id - b.id);
      return out;
    }
    if (segs[1] === 'export' && segs[2] === 'csv' && method === 'GET') {
      const EXPORT_TABLES = {
        pools: '账户', records: '记账流水', biz_projects: '经营项目', biz_records: '经营流水',
        biz_arap: '资金往来', invest_assets: '投资资产', fixed_assets: '固定资产',
        salary_config: '工资配置', salary_month: '工资记录', salary_adj_log: '调薪记录',
        net_snapshots: '净值快照', pool_ops: '账户操作', rec_categories: '记账分类',
        biz_categories: '经营分类', biz_surplus: '经营盈余账本'
      };
      const t = q.table;
      if (!t || !EXPORT_TABLES[t]) throw Err('未知表名，可选: ' + Object.keys(EXPORT_TABLES).join('/'));
      const rows = (await IDB.idbAll(t)).sort((a, b) => a.id - b.id);
      if (!rows.length) return { __csv: '无数据' };
      const cols = Object.keys(rows[0]);
      const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      return { __csv: '\uFEFF' + cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n') };
    }

    // ── 投资资产 ────────────────────────────────────────
    if (segs[1] === 'invest' && segs.length === 2 && method === 'GET') {
      return (await IDB.idbAll('invest_assets')).sort((a, b) => a.id - b.id).map(r => ({ ...r, ...investValuation(r) }));
    }
    if (segs[1] === 'invest' && segs.length === 2 && method === 'POST') {
      const { kind, name, quantity, price, cost_price, profit_rate, term_months, maturity_date, note } = body || {};
      if (!kind || !name?.trim()) throw Err('kind/name 必填');
      if (!['gold', 'security', 'wealth', 'deposit', 'other'].includes(kind)) throw Err('kind 必须为 gold/security/wealth/deposit/other');
      if (quantity === undefined || isNaN(quantity) || quantity <= 0) throw Err('数量/本金必须大于 0');
      const id = await IDB.idbTx(async a => await a.add('invest_assets', {
        kind, name: name.trim(), quantity: Number(quantity), price: Number(price || 0), cost_price: Number(cost_price || 0),
        profit_rate: profit_rate === undefined || profit_rate === null || profit_rate === '' ? null : Number(profit_rate),
        term_months: term_months === undefined || term_months === null || term_months === '' ? null : Number(term_months),
        maturity_date: maturity_date || null, note: note || null, created_at: IDB.nowStr()
      }));
      const row = await IDB.idbGet('invest_assets', id);
      return { ...row, ...investValuation(row) };
    }
    if (segs[1] === 'invest' && segs.length === 3 && method === 'PUT') {
      const a0 = await IDB.idbGet('invest_assets', P(2));
      if (!a0) throw Err('投资资产不存在', 404);
      const b = body || {};
      const qty = b.quantity !== undefined ? Number(b.quantity) : a0.quantity;
      if (isNaN(qty) || qty <= 0) throw Err('数量必须大于 0');
      await IDB.idbTx(async a => {
        await a.put('invest_assets', {
          ...a0, name: b.name?.trim() ?? a0.name, quantity: qty, price: Number(b.price ?? a0.price),
          cost_price: Number(b.cost_price ?? a0.cost_price),
          profit_rate: b.profit_rate !== undefined ? (b.profit_rate === '' || b.profit_rate === null ? null : Number(b.profit_rate)) : a0.profit_rate,
          term_months: b.term_months !== undefined ? (b.term_months === '' || b.term_months === null ? null : Number(b.term_months)) : a0.term_months,
          maturity_date: b.maturity_date !== undefined ? (b.maturity_date || null) : a0.maturity_date,
          note: b.note !== undefined ? (b.note || null) : a0.note
        });
      });
      const row = await IDB.idbGet('invest_assets', P(2));
      return { ...row, ...investValuation(row) };
    }
    if (segs[1] === 'invest' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(async a => { await a.del('invest_assets', P(2)); });
      return { ok: true };
    }

    // ── 固定资产 ────────────────────────────────────────
    if (segs[1] === 'fixed' && segs.length === 2 && method === 'GET') {
      return (await IDB.idbAll('fixed_assets')).sort((a, b) => a.id - b.id).map(r => ({
        ...r, profit: r2(r.est_value - (r.cost || r.est_value)),
        profit_pct: r.cost > 0 ? r2(((r.est_value - r.cost) / r.cost) * 100) : 0, ...deprecInfo(r)
      }));
    }
    if (segs[1] === 'fixed' && segs.length === 2 && method === 'POST') {
      const { name, kind, est_value, cost, buy_date, useful_life_years, salvage_rate, note } = body || {};
      if (!name?.trim()) throw Err('名称必填');
      if (est_value === undefined || isNaN(est_value) || est_value < 0) throw Err('估值必须 ≥ 0');
      const id = await IDB.idbTx(async a => await a.add('fixed_assets', {
        name: name.trim(), kind: kind || 'realestate', est_value: Number(est_value),
        cost: cost === undefined || cost === null || cost === '' ? null : Number(cost),
        buy_date: buy_date || null, useful_life_years: Number(useful_life_years) || 0,
        salvage_rate: Number(salvage_rate) || 0, note: note || null, created_at: IDB.nowStr()
      }));
      const row = await IDB.idbGet('fixed_assets', id);
      return { ...row, profit: r2(row.est_value - (row.cost || row.est_value)), profit_pct: row.cost > 0 ? r2(((row.est_value - row.cost) / row.cost) * 100) : 0, ...deprecInfo(row) };
    }
    if (segs[1] === 'fixed' && segs.length === 3 && method === 'PUT') {
      const a0 = await IDB.idbGet('fixed_assets', P(2));
      if (!a0) throw Err('固定资产不存在', 404);
      const b = body || {};
      await IDB.idbTx(async a => {
        await a.put('fixed_assets', {
          ...a0, name: b.name?.trim() ?? a0.name, est_value: Number(b.est_value ?? a0.est_value),
          cost: b.cost !== undefined ? (b.cost === '' || b.cost === null ? null : Number(b.cost)) : a0.cost,
          buy_date: b.buy_date !== undefined ? (b.buy_date || null) : a0.buy_date,
          useful_life_years: b.useful_life_years !== undefined ? (Number(b.useful_life_years) || 0) : (a0.useful_life_years || 0),
          salvage_rate: b.salvage_rate !== undefined ? (Number(b.salvage_rate) || 0) : (a0.salvage_rate || 0),
          note: b.note !== undefined ? (b.note || null) : a0.note
        });
      });
      const up = await IDB.idbGet('fixed_assets', P(2));
      return { ...up, ...deprecInfo(up) };
    }
    if (segs[1] === 'fixed' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(async a => { await a.del('fixed_assets', P(2)); });
      return { ok: true };
    }

    // ── 总览聚合 ────────────────────────────────────────
    if (segs[1] === 'overview' && method === 'GET') {
      const pools = await IDB.idbAll('pools');
      const cash = r2(pools.filter(p => p.kind === 'asset').reduce((s, p) => s + p.balance, 0)
        + pools.filter(p => p.kind === 'liability').reduce((s, p) => s + p.balance, 0));
      const investRows = await IDB.idbAll('invest_assets');
      const invest = r2(investRows.reduce((s, r) => s + investValuation(r).market_value, 0));
      const fixedRows = await IDB.idbAll('fixed_assets');
      const fixed = r2(fixedRows.reduce((s, r) => s + r.est_value, 0));
      const net = r2(cash + invest + fixed);
      const today = IDB.todayStr();
      await IDB.idbTx(async a => {
        const snaps = await a.all('net_snapshots');
        const old = snaps.find(s => s.date === today);
        if (old) await a.put('net_snapshots', { ...old, cash, invest, fixed, net });
        else await a.add('net_snapshots', { date: today, cash, invest, fixed, net });
      });
      let snaps = await IDB.idbAll('net_snapshots');
      snaps = snaps.sort((x, y) => x.date.localeCompare(y.date)).slice(-60);
      const trend = snaps.map(s => ({ date: s.date, cash: s.cash, invest: s.invest, fixed: s.fixed, net: s.net }));
      // M5 聚合
      const ym = today.slice(0, 7);
      const records = await IDB.idbAll('records');
      const srcName = { salary: '工资', fund: '公积金', gongjijin: '公积金', biz: '经营' };
      const incBySrcMap = {};
      const expByCatMap = {};
      const flowMap = {};
      for (const r of records) {
        if ((r.cat_path || '').startsWith('资金/')) continue;
        const m = (r.created_at || '').slice(0, 7);
        if (!flowMap[m]) flowMap[m] = { inc: 0, exp: 0 };
        if (r.direction === 'income') flowMap[m].inc += r.amount; else flowMap[m].exp += r.amount;
        if (m === ym) {
          if (r.direction === 'income') {
            const k = srcName[r.source] || '其他';
            incBySrcMap[k] = (incBySrcMap[k] || 0) + r.amount;
          } else {
            const c1 = (r.cat_path || '').split('/')[0];
            expByCatMap[c1] = (expByCatMap[c1] || 0) + r.amount;
          }
        }
      }
      const incBySrc = Object.entries(incBySrcMap).map(([name, value]) => ({ name, value: r2(value) }));
      const expByCat = Object.entries(expByCatMap).map(([name, value]) => ({ name, value: r2(value) }));
      const flow6 = Object.keys(flowMap).sort().slice(-6).map(m => ({ month: m, income: r2(flowMap[m].inc), expense: r2(flowMap[m].exp) }));
      // 经营项目本月概览
      const projects = await IDB.idbAll('biz_projects');
      const bizRecords = await IDB.idbAll('biz_records');
      const pm2 = Object.fromEntries(pools.map(p => [p.id, p]));
      const bizOverview = projects.map(p => {
        const rs = bizRecords.filter(r => r.project_id === p.id && (r.date || '').slice(0, 7) === ym);
        const inc = rs.filter(r => r.type === 'in').reduce((s, r) => s + r.amount, 0);
        const cost = rs.filter(r => r.type === 'out').reduce((s, r) => s + r.amount, 0);
        const pool = pm2[p.pool_id];
        return { id: p.id, name: p.name, pool_id: p.pool_id, pool_name: pool?.name || null, pool_tail: pool?.tail || null, income: r2(inc), cost: r2(cost), surplus: r2(inc - cost) };
      });
      // 资金往来概览（全项目）
      const arapRows = await IDB.idbAll('biz_arap');
      let arRecv = 0, arPay = 0, arOverdue = 0;
      for (const r of arapRows) {
        if (r.status !== 'open') continue;
        const dl = daysLeftOf(r.due_date, today);
        if (r.type === 'receivable') { arRecv += r.amount; if (dl < 0) arOverdue++; }
        else { arPay += r.amount; if (dl < 0) arOverdue++; }
      }
      // 账本汇总（本月各账本收支独立统计）
      const bookRows = (await IDB.idbAll('ledger_books')).sort((a, b) => (b.is_default || 0) - (a.is_default || 0) || a.id - b.id);
      const mbMap = {};
      for (const r of records) {
        const bid = r.book_id || 1;
        if (!mbMap[bid]) mbMap[bid] = { inc: 0, exp: 0, cnt: 0 };
        mbMap[bid].cnt++;
        if ((r.created_at || '').slice(0, 7) !== ym) continue;
        if (r.direction === 'income') mbMap[bid].inc += r.amount; else mbMap[bid].exp += r.amount;
      }
      const books = bookRows.map(b => {
        const mb = mbMap[b.id] || { inc: 0, exp: 0, cnt: 0 };
        return { id: b.id, name: b.name, is_default: !!b.is_default, record_count: mb.cnt, income: r2(mb.inc), expense: r2(mb.exp) };
      });
      return {
        net_assets: net, total_assets: r2(cash + invest + fixed),
        total_debt: Math.abs(pools.filter(p => p.kind === 'liability').reduce((s, p) => s + p.balance, 0)),
        cash, invest, fixed, pools,
        invest_assets: investRows.map(r => ({ ...r, ...investValuation(r) })),
        fixed_assets: fixedRows, trend,
        month_income_src: incBySrc, month_expense_cat: expByCat, flow6, books,
        biz_overview: bizOverview,
        arap: { recv_open: r2(arRecv), pay_open: r2(arPay), overdue_count: arOverdue }
      };
    }


    // ── M7.2 信用卡账单 ─────────────────────────────────
    if (segs[1] === 'credit-bills' && segs.length === 2 && method === 'GET') {
      const all = await IDB.idbAll('credit_bills');
      const rows = q.pool_id ? all.filter(b => b.pool_id === Number(q.pool_id)) : all;
      return rows.sort((a, b) => b.month.localeCompare(a.month));
    }
    if (segs[1] === 'credit-bills' && segs.length === 2 && method === 'POST') {
      const { pool_id, month, due_date, amount, min_amount, remark } = body || {};
      if (!pool_id || !month || !due_date) throw Err('pool_id/month/due_date 必填');
      const id = await IDB.idbTx(a => a.add('credit_bills', {
        pool_id: Number(pool_id), month, due_date, amount: Number(amount) || 0, min_amount: Number(min_amount) || 0,
        paid_amount: 0, status: 'open', remark: remark || null, created_at: IDB.nowStr()
      }));
      return { bill: await IDB.idbGet('credit_bills', id), ok: true };
    }
    if (segs[1] === 'credit-bills' && segs.length === 3 && segs[2] !== 'pay' && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('credit_bills', id);
        if (!old) throw Err('账单不存在', 404);
        const b = body || {};
        const v = (x, d) => (x === undefined ? d : x);
        const nb = { ...old, month: v(b.month, old.month), due_date: v(b.due_date, old.due_date),
          amount: v(b.amount, old.amount), min_amount: v(b.min_amount, old.min_amount),
          remark: b.remark === undefined ? old.remark : b.remark, status: v(b.status, old.status) };
        await a.put('credit_bills', nb); return { bill: nb, ok: true };
      });
    }
    if (segs[1] === 'credit-bills' && segs.length === 3 && segs[2] !== 'pay' && method === 'DELETE') {
      await IDB.idbTx(a => a.del('credit_bills', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'credit-bills' && segs.length === 4 && segs[3] === 'pay' && method === 'POST') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const bill = await a.get('credit_bills', id);
        if (!bill) throw Err('账单不存在', 404);
        const pay = Number((body || {}).amount);
        const from = await a.get('pools', Number((body || {}).from_pool_id));
        if (!pay || pay <= 0) throw Err('还款金额必填且>0');
        if (!from) throw Err('扣款账户不存在', 404);
        if (from.balance < pay) throw Err('扣款账户余额不足');
        const remain = bill.amount - bill.paid_amount;
        if (pay > remain + 1e-6) throw Err('超出账单剩余应还');
        const cbPool = await a.get('pools', bill.pool_id);
        await a.put('pools', { ...from, balance: r2(from.balance - pay), updated_at: IDB.nowStr() });
        await a.put('pools', { ...cbPool, balance: r2(cbPool.balance + pay), updated_at: IDB.nowStr() });
        const newPaid = r2(bill.paid_amount + pay);
        const status = newPaid >= bill.amount - 1e-6 ? 'paid' : 'open';
        await a.put('credit_bills', { ...bill, paid_amount: newPaid, status });
        await a.add('records', { direction: 'expense', amount: pay, cat_path: '资金/信用卡还款', cat_leaf_id: null,
          pool_id: from.id, remark: `信用卡还款 ${bill.month}`, source: 'credit', book_id: lb(), created_at: IDB.nowStr() });
        await a.add('records', { direction: 'income', amount: pay, cat_path: '资金/信用卡还款', cat_leaf_id: null,
          pool_id: bill.pool_id, remark: `信用卡还款 ${bill.month}`, source: 'credit', book_id: lb(), created_at: IDB.nowStr() });
        return { ok: true, paid: pay, status };
      });
    }

    // ── M7.2 到期提醒 ───────────────────────────────────
    if (segs[1] === 'reminders' && segs.length === 2 && method === 'GET') {
      const rows = (await IDB.idbAll('due_reminders')).sort((a, b) => (a.done || 0) - (b.done || 0) || a.remind_date.localeCompare(b.remind_date));
      const today = new Date().toISOString().slice(0, 10);
      const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      return rows.map(r => ({
        ...r,
        overdue: !r.done && r.remind_date < today,
        today: !r.done && r.remind_date === today,
        within7: !r.done && r.remind_date > today && r.remind_date <= in7
      }));
    }
    if (segs[1] === 'reminders' && segs.length === 2 && method === 'POST') {
      const { name, remind_date, target_type, target_id, remark } = body || {};
      if (!name || !remind_date) throw Err('name/remind_date 必填');
      const id = await IDB.idbTx(a => a.add('due_reminders', { name, remind_date, target_type: target_type || null,
        target_id: target_id || null, remark: remark || null, done: 0, created_at: IDB.nowStr() }));
      return { reminder: await IDB.idbGet('due_reminders', id), ok: true };
    }
    if (segs[1] === 'reminders' && segs.length === 3 && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('due_reminders', id);
        if (!old) throw Err('提醒不存在', 404);
        const b = body || {};
        const nb = { ...old, name: b.name === undefined ? old.name : b.name,
          remind_date: b.remind_date === undefined ? old.remind_date : b.remind_date,
          remark: b.remark === undefined ? old.remark : b.remark,
          done: b.done === undefined ? old.done : (b.done ? 1 : 0) };
        await a.put('due_reminders', nb); return { reminder: nb, ok: true };
      });
    }
    if (segs[1] === 'reminders' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(a => a.del('due_reminders', Number(segs[2])));
      return { ok: true };
    }

    // ── M7.2 储蓄目标 ───────────────────────────────────
    if (segs[1] === 'goals' && segs.length === 2 && method === 'GET') {
      const rows = await IDB.idbAll('savings_goals');
      return rows.sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(a.deadline || '').localeCompare(String(b.deadline || '')));
    }
    if (segs[1] === 'goals' && segs.length === 2 && method === 'POST') {
      const { name, target_amount, start_date, deadline, pool_id } = body || {};
      if (!name || target_amount === undefined || isNaN(target_amount) || target_amount <= 0) throw Err('name/target_amount 必填且>0');
      const id = await IDB.idbTx(a => a.add('savings_goals', { name, target_amount: Number(target_amount), current_amount: 0,
        start_date: start_date || null, deadline: deadline || null, pool_id: pool_id ? Number(pool_id) : null,
        status: 'active', created_at: IDB.nowStr() }));
      return { goal: await IDB.idbGet('savings_goals', id), ok: true };
    }
    if (segs[1] === 'goals' && segs.length === 3 && segs[2] !== 'deposit' && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('savings_goals', id);
        if (!old) throw Err('目标不存在', 404);
        const b = body || {};
        const v = (x, d) => (x === undefined ? d : x);
        const nb = { ...old, name: v(b.name, old.name), target_amount: v(b.target_amount, old.target_amount),
          deadline: b.deadline === undefined ? old.deadline : b.deadline,
          pool_id: b.pool_id === undefined ? old.pool_id : b.pool_id, status: v(b.status, old.status) };
        await a.put('savings_goals', nb); return { goal: nb, ok: true };
      });
    }
    if (segs[1] === 'goals' && segs.length === 3 && segs[2] !== 'deposit' && method === 'DELETE') {
      await IDB.idbTx(a => a.del('savings_goals', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'goals' && segs.length === 4 && segs[3] === 'deposit' && method === 'POST') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const g = await a.get('savings_goals', id);
        if (!g) throw Err('目标不存在', 404);
        const amt = Number((body || {}).amount);
        const pool = await a.get('pools', Number((body || {}).pool_id) || g.pool_id);
        if (!amt || amt <= 0) throw Err('金额必填且>0');
        if (!pool) throw Err('扣款账户不存在', 404);
        if (pool.balance < amt) throw Err('账户余额不足');
        await a.put('pools', { ...pool, balance: r2(pool.balance - amt), updated_at: IDB.nowStr() });
        const cur = r2(g.current_amount + amt);
        const status = cur >= g.target_amount - 1e-6 ? 'done' : g.status;
        await a.put('savings_goals', { ...g, current_amount: cur, status });
        await a.add('records', { direction: 'expense', amount: amt, cat_path: '资金/储蓄目标', cat_leaf_id: null,
          pool_id: pool.id, remark: `储蓄目标「${g.name}」`, source: 'goal', book_id: lb(), created_at: IDB.nowStr() });
        return { ok: true, current: cur, status };
      });
    }

    // ── M7.2 投资现金流（XIRR）──────────────────────────
    if (segs[1] === 'invest-cashflows' && segs.length === 2 && method === 'GET') {
      const all = await IDB.idbAll('invest_cashflows');
      const rows = q.asset_id ? all.filter(f => f.asset_id === Number(q.asset_id)) : all;
      return rows.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    }
    if (segs[1] === 'invest-cashflows' && segs.length === 2 && method === 'POST') {
      const { asset_id, date, amount, note } = body || {};
      if (!asset_id || !date || amount === undefined || isNaN(amount)) throw Err('asset_id/date/amount 必填');
      const id = await IDB.idbTx(a => a.add('invest_cashflows', { asset_id: Number(asset_id), date, amount: Number(amount),
        note: note || null, created_at: IDB.nowStr() }));
      return { flow: await IDB.idbGet('invest_cashflows', id), ok: true };
    }
    if (segs[1] === 'invest-cashflows' && segs.length === 3 && segs[2] !== 'xirr' && method === 'DELETE') {
      await IDB.idbTx(a => a.del('invest_cashflows', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'invest-cashflows' && segs[2] === 'xirr' && method === 'GET') {
      const flows = (await IDB.idbAll('invest_cashflows')).filter(f => f.asset_id === Number(q.asset_id)).sort((a, b) => a.date.localeCompare(b.date));
      const asset = await IDB.idbGet('invest_assets', Number(q.asset_id));
      if (!asset) throw Err('资产不存在', 404);
      if (flows.length < 2) return { asset: asset.name, kind: asset.kind, xirr: null, xirr_pct: null,
        invested: r2(flows.reduce((s, f) => s + Math.max(0, f.amount), 0)), redeemed: 0, market: r2(asset.quantity * asset.price) };
      const marketValue = r2(asset.quantity * asset.price);
      const cf = flows.map(f => ({ date: f.date, amount: f.amount }));
      const invested = cf.reduce((s, f) => s + Math.max(0, f.amount), 0);
      const redeemed = cf.reduce((s, f) => s + Math.min(0, f.amount), 0);
      cf.push({ date: new Date().toISOString().slice(0, 10), amount: marketValue });
      const rate = offlineXirr(cf);
      return { asset: asset.name, kind: asset.kind, xirr: rate, xirr_pct: rate === null ? null : r2(rate * 100),
        invested: r2(invested), redeemed: r2(Math.abs(redeemed)), market: marketValue };
    }

    // ── M7.2 还款计划 ───────────────────────────────────
    if (segs[1] === 'repayments' && segs.length === 2 && method === 'GET') {
      const rows = await IDB.idbAll('repayment_plans');
      return rows.sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(a.start_month || '').localeCompare(String(b.start_month || '')))
        .map(r => ({ ...r, due_months: r.status === 'active' ? Math.max(0, r.months - r.paid_months) : 0 }));
    }
    if (segs[1] === 'repayments' && segs.length === 2 && method === 'POST') {
      const { name, total, annual_rate, months, start_month, pool_id } = body || {};
      if (!name || !total || isNaN(total) || total <= 0 || !months || months <= 0) throw Err('name/total/months 必填且>0');
      const monthly = r2(annuityMonthly(Number(total), Number(annual_rate) || 0, Number(months)));
      const id = await IDB.idbTx(a => a.add('repayment_plans', { name, total: Number(total), annual_rate: Number(annual_rate) || 0,
        months: Number(months), monthly, start_month: start_month || null, pool_id: pool_id ? Number(pool_id) : null,
        paid_months: 0, status: 'active', created_at: IDB.nowStr() }));
      return { plan: await IDB.idbGet('repayment_plans', id), ok: true };
    }
    if (segs[1] === 'repayments' && segs.length === 3 && segs[2] !== 'pay' && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('repayment_plans', id);
        if (!old) throw Err('计划不存在', 404);
        const b = body || {};
        const v = (x, d) => (x === undefined ? d : x);
        const nb = { ...old, name: v(b.name, old.name), total: v(b.total, old.total), annual_rate: v(b.annual_rate, old.annual_rate),
          months: v(b.months, old.months), monthly: b.monthly === undefined ? old.monthly : b.monthly,
          start_month: b.start_month === undefined ? old.start_month : b.start_month,
          pool_id: b.pool_id === undefined ? old.pool_id : b.pool_id,
          paid_months: b.paid_months === undefined ? old.paid_months : b.paid_months, status: v(b.status, old.status) };
        await a.put('repayment_plans', nb); return { plan: nb, ok: true };
      });
    }
    if (segs[1] === 'repayments' && segs.length === 3 && segs[2] !== 'pay' && method === 'DELETE') {
      await IDB.idbTx(a => a.del('repayment_plans', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'repayments' && segs.length === 4 && segs[3] === 'pay' && method === 'POST') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const p = await a.get('repayment_plans', id);
        if (!p) throw Err('计划不存在', 404);
        if (p.status !== 'active' || p.paid_months >= p.months) throw Err('计划已完成');
        const pool = await a.get('pools', p.pool_id);
        if (!pool) throw Err('扣款账户不存在', 404);
        if (pool.balance < p.monthly) throw Err('账户余额不足');
        await a.put('pools', { ...pool, balance: r2(pool.balance - p.monthly), updated_at: IDB.nowStr() });
        const paid = p.paid_months + 1;
        const status = paid >= p.months ? 'done' : 'active';
        await a.put('repayment_plans', { ...p, paid_months: paid, status });
        await a.add('records', { direction: 'expense', amount: p.monthly, cat_path: '资金/还款计划', cat_leaf_id: null,
          pool_id: pool.id, remark: `还款「${p.name}」第${paid}期`, source: 'repayment', book_id: lb(), created_at: IDB.nowStr() });
        return { ok: true, paid_months: paid, status };
      });
    }

    // ── M7.2 多账本 ─────────────────────────────────────
    if (segs[1] === 'books' && segs.length === 4 && segs[3] === 'report' && method === 'GET') {
      return await IDB.idbTx(async a => {
        const rows = await a.all('records');
        const booksRows = await a.all('ledger_books');
        const ym = String(q.month || IDB.todayStr().slice(0, 7)).slice(0, 7);
        return reportForBook(a, rows, booksRows, Number(segs[2]), ym);
      });
    }
    if (segs[1] === 'books' && segs.length === 2 && method === 'GET') {
      let rows = await IDB.idbAll('ledger_books');
      if (!rows.length) {
        await IDB.idbTx(a => a.add('ledger_books', { name: '默认账本', is_default: 1, created_at: IDB.nowStr() }));
        rows = await IDB.idbAll('ledger_books');
      }
      rows = rows.sort((a, b) => (b.is_default || 0) - (a.is_default || 0) || a.id - b.id);
      const recs = await IDB.idbAll('records');
      const cm = {};
      for (const r of recs) cm[r.book_id || 1] = (cm[r.book_id || 1] || 0) + 1;
      return rows.map(b => ({ ...b, record_count: cm[b.id] || 0 }));
    }
    if (segs[1] === 'books' && segs.length === 2 && method === 'POST') {
      const { name } = body || {};
      if (!name || !String(name).trim()) throw Err('账本名必填');
      const id = await IDB.idbTx(a => a.add('ledger_books', { name: String(name).trim(), is_default: 0, created_at: IDB.nowStr() }));
      return { book: await IDB.idbGet('ledger_books', id), ok: true };
    }
    if (segs[1] === 'books' && segs.length === 3 && method === 'PUT') {
      const id = Number(segs[2]);
      return await IDB.idbTx(async a => {
        const old = await a.get('ledger_books', id);
        if (!old) throw Err('账本不存在', 404);
        const b = body || {};
        if (b.is_default) {
          for (const x of await a.all('ledger_books')) if (x.is_default) await a.put('ledger_books', { ...x, is_default: 0 });
        }
        const nb = { ...old, name: b.name === undefined ? old.name : b.name,
          is_default: b.is_default === undefined ? old.is_default : (b.is_default ? 1 : 0) };
        await a.put('ledger_books', nb); return { book: nb, ok: true };
      });
    }
    if (segs[1] === 'books' && segs.length === 3 && method === 'DELETE') {
      const id = Number(segs[2]);
      if (id === 1) throw Err('默认账本不可删除');
      const n = (await IDB.idbAll('records')).filter(r => (r.book_id || 1) === id).length;
      if (n > 0) throw Err(`该账本有 ${n} 笔流水，请先转移或删除`);
      await IDB.idbTx(a => a.del('ledger_books', id));
      return { ok: true };
    }

    // ── M7.2 CSV 导入 ───────────────────────────────────
    if (segs[1] === 'import' && segs[2] === 'csv' && method === 'POST') {
      const { rows, book_id } = body || {};
      if (!Array.isArray(rows) || !rows.length) throw Err('rows 必填');
      return await IDB.idbTx(async a => {
        const cats = (await a.all('rec_categories')).filter(c => c.lvl === 2);
        const catByName = Object.fromEntries(cats.map(c => [c.name, c]));
        let ok = 0, skip = [];
        for (const row of rows) {
          const date = String(row.date || '').trim();
          const dir = String(row.direction || '').trim();
          const amount = Number(row.amount);
          const cat = String(row.category || '').trim();
          const pool_id = Number(row.pool_id);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['income', 'expense'].includes(dir) || !amount || isNaN(amount)) { skip.push(`${date} 格式错误`); continue; }
          const leaf = catByName[cat];
          if (!leaf) { skip.push(`${date} 分类「${cat}」不存在`); continue; }
          const cat_path = [dir === 'expense' ? '支出' : '收入', cat].join('/');
          await a.add('records', { direction: dir, amount, cat_path, cat_leaf_id: leaf.id, pool_id,
            remark: row.remark || null, source: 'import', book_id: Number(book_id) || 1, created_at: date + ' 00:00:00' });
          ok++;
        }
        return { ok: true, imported: ok, skipped: skip };
      });
    }

    // ── M7.1 净资产趋势（离线镜像）─────────────────────
    if (segs[1] === 'net-trend' && method === 'GET') {
      let rows = (await IDB.idbAll('net_snapshots')).sort((a, b) => a.date.localeCompare(b.date));
      const days = Number(q.days) || 0;
      if (days > 0) {
        const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
        rows = rows.filter(r => r.date >= cutoff);
      }
      const first = rows[0] || null, last = rows[rows.length - 1] || null;
      let change = 0, change_pct = null;
      if (first && last) {
        change = r2(last.net - first.net);
        change_pct = first.net !== 0 ? r2((last.net - first.net) / Math.abs(first.net) * 100) : null;
      }
      return {
        points: rows.map(r => ({ date: r.date, cash: r.cash, invest: r.invest, fixed: r.fixed, net: r.net })),
        first, last, change, change_pct, count: rows.length
      };
    }

    // ── M7.2 报表同比环比 ───────────────────────────────
    if (segs[1] === 'report' && segs[2] === 'compare' && method === 'GET') {
      const { month } = q;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) throw Err('month 必填');
      const y = Number(month.slice(0, 4)), m = Number(month.slice(5));
      const prevM = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      const lastY = `${y - 1}-${String(m).padStart(2, '0')}`;
      const all = await IDB.idbAll('records');
      const agg = prefix => offlineReportAgg(all.filter(r => (r.created_at || '').slice(0, prefix.length) === prefix));
      return { month, cur: agg(month), prev_month: agg(prevM), last_year: agg(lastY) };
    }

    // ══════════════ 批A 记账体验（离线镜像） ══════════════
    // 快捷模板
    if (segs[1] === 'templates' && segs.length === 2 && method === 'GET') {
      return (await IDB.idbAll('quick_templates')).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id);
    }
    if (segs[1] === 'templates' && segs.length === 2 && method === 'POST') {
      const { name, amount, direction, cat_path, cat_leaf_id, pool_id, remark, sort } = body || {};
      if (!name?.trim() || amount === undefined || isNaN(amount) || amount < 0 || !cat_path || !pool_id) throw Err('name/amount/cat_path/pool_id 必填且金额≥0');
      const id = await IDB.idbTx(a => a.add('quick_templates', {
        name: name.trim(), amount: Number(amount), direction: direction === 'income' ? 'income' : 'expense',
        cat_path, cat_leaf_id: cat_leaf_id || null, pool_id: Number(pool_id), remark: remark || null,
        sort: Number(sort) || 0, created_at: IDB.nowStr()
      }));
      return { template: await IDB.idbGet('quick_templates', id), ok: true };
    }
    if (segs[1] === 'templates' && segs.length === 3 && method === 'PUT') {
      const old = await IDB.idbGet('quick_templates', Number(P(2)));
      if (!old) throw Err('模板不存在', 404);
      const b = body || {};
      const v = (x, d) => (x === undefined ? d : x);
      const nb = { ...old, name: b.name?.trim() ?? old.name, amount: v(b.amount, old.amount), direction: v(b.direction, old.direction),
        cat_path: v(b.cat_path, old.cat_path), cat_leaf_id: b.cat_leaf_id === undefined ? old.cat_leaf_id : b.cat_leaf_id,
        pool_id: v(b.pool_id, old.pool_id), remark: b.remark === undefined ? old.remark : b.remark, sort: v(b.sort, old.sort) };
      await IDB.idbTx(a => a.put('quick_templates', nb));
      return { template: nb, ok: true };
    }
    if (segs[1] === 'templates' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(a => a.del('quick_templates', Number(P(2))));
      return { ok: true };
    }
    // 星标
    if (segs[1] === 'records' && segs.length === 4 && segs[3] === 'star' && method === 'POST') {
      const r = await IDB.idbGet('records', Number(segs[2]));
      if (!r) throw Err('记录不存在', 404);
      const cur = r.is_star ? 0 : 1;
      await IDB.idbTx(a => a.put('records', { ...r, is_star: cur }));
      return { ok: true, is_star: cur };
    }
    // 标签
    if (segs[1] === 'tags' && segs.length === 2 && method === 'GET') {
      const tags = (await IDB.idbAll('tags')).sort((a, b) => a.id - b.id);
      const rts = await IDB.idbAll('record_tags');
      const cnt = {};
      for (const r of rts) cnt[r.tag_id] = (cnt[r.tag_id] || 0) + 1;
      return tags.map(t => ({ ...t, usage: cnt[t.id] || 0 }));
    }
    if (segs[1] === 'tags' && segs.length === 2 && method === 'POST') {
      const { name, color } = body || {};
      if (!name?.trim()) throw Err('标签名必填');
      const all = await IDB.idbAll('tags');
      if (all.some(t => t.name === name.trim())) throw Err('标签已存在');
      const id = await IDB.idbTx(a => a.add('tags', { name: name.trim(), color: color || '#2f7d5d', created_at: IDB.nowStr() }));
      return { tag: await IDB.idbGet('tags', id), ok: true };
    }
    if (segs[1] === 'tags' && segs.length === 3 && method === 'PUT') {
      const t = await IDB.idbGet('tags', Number(P(2)));
      if (!t) throw Err('标签不存在', 404);
      const b = body || {};
      const nb = { ...t, name: b.name?.trim() || t.name, color: b.color || t.color };
      await IDB.idbTx(a => a.put('tags', nb));
      return { tag: nb, ok: true };
    }
    if (segs[1] === 'tags' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(async a => {
        const rts = await a.all('record_tags');
        for (const r of rts.filter(x => x.tag_id === Number(P(2)))) await a.del('record_tags', r.id);
        await a.del('tags', Number(P(2)));
      });
      return { ok: true };
    }
    if (segs[1] === 'records' && segs.length === 4 && segs[3] === 'tags' && method === 'POST') {
      const rec = await IDB.idbGet('records', Number(segs[2]));
      if (!rec) throw Err('记录不存在', 404);
      const ids = (body?.tag_ids || []).map(Number);
      const rts = (await IDB.idbAll('record_tags')).filter(x => x.record_id === rec.id);
      await IDB.idbTx(async a => {
        for (const r of rts) await a.del('record_tags', r.id);
        for (const tid of ids) {
          const t = await a.get('tags', tid);
          if (t) await a.add('record_tags', { record_id: rec.id, tag_id: tid });
        }
      });
      return { ok: true, tag_ids: ids };
    }
    if (segs[1] === 'records' && segs.length === 4 && segs[3] === 'tags' && method === 'GET') {
      const rts = (await IDB.idbAll('record_tags')).filter(x => x.record_id === Number(segs[2]));
      const tags = await IDB.idbAll('tags');
      return rts.map(r => ({ id: r.tag_id, ...(tags.find(t => t.id === r.tag_id) || {}) })).filter(t => t.name);
    }
    // 附件（离线：IndexedDB 存 Blob；file 端点返回 base64 dataURL）
    if (segs[1] === 'records' && segs.length === 4 && segs[3] === 'attachments' && method === 'GET') {
      return (await IDB.idbAll('attachments')).filter(a => a.record_id === Number(segs[2])).sort((a, b) => a.id - b.id)
        .map(a => ({ id: a.id, record_id: a.record_id, filename: a.filename, mime: a.mime, size: a.size, created_at: a.created_at }));
    }
    if (segs[1] === 'records' && segs.length === 4 && segs[3] === 'attachments' && method === 'POST') {
      const rec = await IDB.idbGet('records', Number(segs[2]));
      if (!rec) throw Err('记录不存在', 404);
      const raw = body?.raw || null; // base64 dataURL
      if (!raw) throw Err('空文件');
      const m = raw.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw Err('仅支持图片附件');
      const mime = m[1].split('/')[0] === 'image' ? m[1] : null;
      if (!mime) throw Err('仅支持图片附件');
      const ext = ({ 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.jpg');
      const fn = `rec${rec.id}_${Date.now()}${ext}`;
      const bytes = atob(m[2]);
      const size = bytes.length;
      const id = await IDB.idbTx(a => a.add('attachments', { record_id: rec.id, filename: fn, mime, size, data: raw, created_at: IDB.nowStr() }));
      const a = await IDB.idbGet('attachments', id);
      return { attachment: { id: a.id, record_id: a.record_id, filename: a.filename, mime: a.mime, size: a.size, created_at: a.created_at }, ok: true };
    }
    if (segs[1] === 'attachments' && segs.length === 4 && segs[3] === 'file' && method === 'GET') {
      const a = await IDB.idbGet('attachments', Number(q.id || P(2)));
      if (!a) throw Err('附件不存在', 404);
      return { dataURL: a.data || null, mime: a.mime, filename: a.filename };
    }
    if (segs[1] === 'attachments' && segs.length === 3 && method === 'DELETE') {
      const a = await IDB.idbGet('attachments', Number(P(2)));
      if (a) await IDB.idbTx(x => x.del('attachments', a.id));
      return { ok: true };
    }

    // ══════════════ 批B 工资税务（离线镜像） ══════════════
    // 年终奖
    if (segs[1] === 'salary' && segs[2] === 'bonus' && segs.length === 3 && method === 'GET') {
      const rows = (await IDB.idbAll('salary_bonus')).sort((a, b) => (b.month || '').localeCompare(a.month || '') || b.id - a.id);
      const BKT = [{ cap: 36000, rate: 0.03, quick: 0 }, { cap: 144000, rate: 0.10, quick: 2520 }, { cap: 300000, rate: 0.20, quick: 16920 }, { cap: 420000, rate: 0.25, quick: 31920 }, { cap: 660000, rate: 0.30, quick: 52920 }, { cap: 960000, rate: 0.35, quick: 85920 }, { cap: Infinity, rate: 0.45, quick: 181920 }];
      return rows.map(b => {
        const m = b.amount / 12;
        const bkt = BKT.find(x => m <= x.cap) || BKT[BKT.length - 1];
        return { ...b, bonus_tax: Math.round((b.amount * bkt.rate - bkt.quick) * 100) / 100 };
      });
    }
    if (segs[1] === 'salary' && segs[2] === 'bonus' && segs.length === 3 && method === 'POST') {
      const { month, type, amount, remark } = body || {};
      if (!/^\d{4}-\d{2}$/.test(month || '')) throw Err('month 必填 YYYY-MM');
      if (amount === undefined || isNaN(amount) || amount <= 0) throw Err('amount 必填且>0');
      const id = await IDB.idbTx(a => a.add('salary_bonus', { month, type: type === '13th' ? '13th' : 'bonus', amount: Number(amount), remark: remark || null, created_at: IDB.nowStr() }));
      return { bonus: await IDB.idbGet('salary_bonus', id), ok: true };
    }
    if (segs[1] === 'salary' && segs[2] === 'bonus' && segs.length === 4 && method === 'PUT') {
      const b = await IDB.idbGet('salary_bonus', Number(P(3)));
      if (!b) throw Err('记录不存在', 404);
      const x = body || {};
      const nb = { ...b, month: x.month || b.month, type: x.type === '13th' ? '13th' : (x.type || b.type), amount: x.amount === undefined ? b.amount : Number(x.amount), remark: x.remark === undefined ? b.remark : (x.remark || null) };
      await IDB.idbTx(a => a.put('salary_bonus', nb));
      return { bonus: nb, ok: true };
    }
    if (segs[1] === 'salary' && segs[2] === 'bonus' && segs.length === 4 && method === 'DELETE') {
      await IDB.idbTx(a => a.del('salary_bonus', Number(P(3))));
      return { ok: true };
    }
    // 个税累计预扣（离线同算法）
    if (segs[1] === 'salary' && segs[2] === 'tax' && segs.length === 3 && method === 'GET') {
      const month = String(q.month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw Err('month 必填 YYYY-MM');
      const year = Number(month.slice(0, 4));
      const months = (await IDB.idbAll('salary_month')).filter(m => (m.month || '') <= month).sort((a, b) => a.month.localeCompare(b.month));
      const cfgs = (await IDB.idbAll('salary_config')).sort((a, b) => (a.valid_from || '').localeCompare(b.valid_from || ''));
      const eff = {};
      for (const m of months) { let c = null; for (const cc of cfgs) if ((cc.valid_from || '') <= m.month) c = cc; eff[m.month] = c; }
      const BKT = [{ cap: 36000, rate: 0.03, quick: 0 }, { cap: 144000, rate: 0.10, quick: 2520 }, { cap: 300000, rate: 0.20, quick: 16920 }, { cap: 420000, rate: 0.25, quick: 31920 }, { cap: 660000, rate: 0.30, quick: 52920 }, { cap: 960000, rate: 0.35, quick: 85920 }, { cap: Infinity, rate: 0.45, quick: 181920 }];
      let cumIncome = 0, cumDed = 0, cumExtra = 0, cumPaid = 0, paid = 0;
      const series = [];
      for (const m of months) {
        if (Number(m.month.slice(0, 4)) !== year) continue;
        const cfg = eff[m.month];
        const personalIns = cfg ? Math.max(0, cfg.social_base - m.gross) : 0;
        cumIncome += m.gross; cumDed += personalIns; cumExtra += (cfg?.tax_extra || 0); paid += 1;
        const cumTaxable = Math.max(0, cumIncome - 5000 * paid - cumDed - cumExtra);
        const bkt = BKT.find(x => cumTaxable <= x.cap) || BKT[BKT.length - 1];
        const t = Math.max(0, Math.round((cumTaxable * bkt.rate - bkt.quick) * 100) / 100);
        const monthTax = Math.max(0, Math.round((t - cumPaid) * 100) / 100);
        cumPaid += monthTax;
        series.push({ month: m.month, gross: m.gross, net: m.net, personalIns, tax: monthTax, cumTaxable, cumPaid });
      }
      return { month, year, current: series.find(s => s.month === month) || null, series };
    }
    // 年度工资汇总
    if (segs[1] === 'salary' && segs[2] === 'year-summary' && segs.length === 3 && method === 'GET') {
      const year = Number(q.year) || new Date().getFullYear();
      const months = (await IDB.idbAll('salary_month')).filter(m => (m.month || '').slice(0, 4) === String(year)).sort((a, b) => a.month.localeCompare(b.month));
      const cfgs = (await IDB.idbAll('salary_config')).sort((a, b) => (a.valid_from || '').localeCompare(b.valid_from || ''));
      const eff = {};
      for (const m of months) { let c = null; for (const cc of cfgs) if ((cc.valid_from || '') <= m.month) c = cc; eff[m.month] = c; }
      const bonuses = (await IDB.idbAll('salary_bonus')).filter(b => (b.month || '').slice(0, 4) === String(year));
      const taxByMonth = {};
      let cumIncome = 0, cumDed = 0, cumExtra = 0, cumPaid = 0, paid = 0;
      const BKT = [{ cap: 36000, rate: 0.03, quick: 0 }, { cap: 144000, rate: 0.10, quick: 2520 }, { cap: 300000, rate: 0.20, quick: 16920 }, { cap: 420000, rate: 0.25, quick: 31920 }, { cap: 660000, rate: 0.30, quick: 52920 }, { cap: 960000, rate: 0.35, quick: 85920 }, { cap: Infinity, rate: 0.45, quick: 181920 }];
      for (const m of months) {
        const cfg = eff[m.month];
        cumIncome += m.gross; cumDed += cfg ? Math.max(0, cfg.social_base - m.gross) : 0; cumExtra += (cfg?.tax_extra || 0); paid += 1;
        const cumTaxable = Math.max(0, cumIncome - 5000 * paid - cumDed - cumExtra);
        const bkt = BKT.find(x => cumTaxable <= x.cap) || BKT[BKT.length - 1];
        const t = Math.max(0, Math.round((cumTaxable * bkt.rate - bkt.quick) * 100) / 100);
        const monthTax = Math.max(0, Math.round((t - cumPaid) * 100) / 100);
        cumPaid += monthTax;
        taxByMonth[m.month] = monthTax;
      }
      const tags = { good: 0, excellent: 0, hot: 0, ill: 0 };
      for (const m of months) { tags.good += m.tag_good || 0; tags.excellent += m.tag_excellent || 0; tags.hot += m.tag_hot || 0; tags.ill += m.tag_ill || 0; }
      return {
        year, months: months.length,
        grossTotal: months.reduce((s, m) => s + m.gross, 0),
        netTotal: months.reduce((s, m) => s + m.net, 0),
        taxTotal: months.reduce((s, m) => s + (taxByMonth[m.month] || 0), 0),
        personalIns: months.reduce((s, m) => s + Math.max(0, (eff[m.month]?.social_base || m.social_base) - m.gross), 0),
        bonusTotal: bonuses.reduce((s, b) => s + b.amount, 0),
        fundTotal: months.reduce((s, m) => { const c = eff[m.month]; return s + (c ? Math.round(c.social_base * c.fund_rate * 100) / 100 + Math.round(c.social_base * (c.fund_rate_u ?? c.fund_rate) * 100) / 100 : 0); }, 0),
        tags, bonuses
      };
    }
    // 调薪预览（离线简化：仅返回参数+估算）
    if (segs[1] === 'salary' && segs[2] === 'forecast' && segs.length === 3 && method === 'POST') {
      const { new_good_base, new_social_base, from_month } = body || {};
      const from = /^\d{4}-\d{2}$/.test(from_month || '') ? from_month : new Date().toISOString().slice(0, 7);
      const year = Number(from.slice(0, 4));
      const cfgs = (await IDB.idbAll('salary_config')).sort((a, b) => (a.valid_from || '').localeCompare(b.valid_from || ''));
      const cfg = [...cfgs].reverse().find(c => (c.valid_from || '') <= from) || cfgs[cfgs.length - 1];
      if (!cfg) throw Err('请先设置工资配置');
      const goodBase = new_good_base !== undefined && !isNaN(new_good_base) ? Number(new_good_base) : cfg.good_base;
      const socialBase = new_social_base !== undefined && !isNaN(new_social_base) ? Number(new_social_base) : cfg.social_base;
      const insP = Math.round(socialBase * (cfg.ins_pension_p + cfg.ins_medical_p + cfg.ins_unemploy_p) * 100) / 100;
      const fundP = Math.round(socialBase * cfg.fund_rate * 100) / 100;
      const gross = Math.round((socialBase - insP - fundP) * 100) / 100;
      const months = (await IDB.idbAll('salary_month')).filter(m => (m.month || '').slice(0, 4) === String(year) && m.month < from);
      const eff = {};
      for (const m of months) { let c = null; for (const cc of cfgs) if ((cc.valid_from || '') <= m.month) c = cc; eff[m.month] = c; }
      const BKT = [{ cap: 36000, rate: 0.03, quick: 0 }, { cap: 144000, rate: 0.10, quick: 2520 }, { cap: 300000, rate: 0.20, quick: 16920 }, { cap: 420000, rate: 0.25, quick: 31920 }, { cap: 660000, rate: 0.30, quick: 52920 }, { cap: 960000, rate: 0.35, quick: 85920 }, { cap: Infinity, rate: 0.45, quick: 181920 }];
      let cumIncome = 0, cumDed = 0, cumExtra = 0, cumPaid = 0, paid = 0;
      for (const m of months) {
        const c = eff[m.month];
        cumIncome += m.gross; cumDed += c ? Math.max(0, c.social_base - m.gross) : 0; cumExtra += (c?.tax_extra || 0); paid += 1;
        const ct = Math.max(0, cumIncome - 5000 * paid - cumDed - cumExtra);
        const bkt = BKT.find(x => ct <= x.cap) || BKT[BKT.length - 1];
        const t = Math.max(0, Math.round((ct * bkt.rate - bkt.quick) * 100) / 100);
        const mt = Math.max(0, Math.round((t - cumPaid) * 100) / 100); cumPaid += mt;
      }
      const histTax = cumPaid, histGross = cumIncome;
      const sim = []; let simTax = 0, simNet = 0;
      for (let i = Number(from.slice(5)); i <= 12; i++) {
        paid += 1; cumIncome += gross; cumDed += Math.max(0, socialBase - gross); cumExtra += (cfg.tax_extra || 0);
        const ct = Math.max(0, cumIncome - 5000 * paid - cumDed - cumExtra);
        const bkt = BKT.find(x => ct <= x.cap) || BKT[BKT.length - 1];
        const t = Math.max(0, Math.round((ct * bkt.rate - bkt.quick) * 100) / 100);
        const mt = Math.max(0, Math.round((t - cumPaid) * 100) / 100); cumPaid += mt;
        simTax += mt;
        const net = Math.round((gross - mt - (cfg.serious_ill || 0)) * 100) / 100; simNet += net;
        sim.push({ month: `${year}-${String(i).padStart(2, '0')}`, gross, tax: mt, net });
      }
      return { from, good_base: goodBase, social_base: socialBase, gross, simMonths: sim.length, simGross: sim.reduce((s, x) => s + x.gross, 0), simTax, simNet, histMonths: months.length, histTax, yearTotal: { gross: histGross + sim.reduce((s, x) => s + x.gross, 0), tax: histTax + simTax, net: months.reduce((s, m) => s + m.net, 0) + simNet } };
    }

    // ══════════════ 批C 资产分析（离线镜像） ══════════════
    if (segs[1] === 'finance' && segs[2] === 'health' && segs.length === 3 && method === 'GET') {
      const pools = await IDB.idbAll('pools');
      const assets = pools.filter(p => p.kind === 'asset').reduce((s, p) => s + (p.balance || 0), 0);
      const debts = pools.filter(p => p.kind === 'liability').reduce((s, p) => s + Math.abs(p.balance || 0), 0);
      const inv = (await IDB.idbAll('invest_assets')).reduce((s, a) => s + (a.quantity || 0) * (a.price || 0), 0);
      const fx = await IDB.idbAll('fixed_assets');
      const fxVal = fx.reduce((s, a) => {
        if (!a.useful_life_years) return s + (a.value || 0);
        const ageY = a.age_years || 0;
        const dep = ((a.value || 0) * (1 - (a.salvage_rate || 0))) / a.useful_life_years * Math.min(ageY, a.useful_life_years);
        return s + Math.max(0, (a.value || 0) - dep);
      }, 0);
      const totalAssets = assets + inv + fxVal;
      const now = new Date();
      const monthKey = i => { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
      const recs = await IDB.idbAll('records');
      let inc = 0, exp = 0;
      for (let i = 0; i < 3; i++) {
        const mk = monthKey(i);
        for (const r of recs) {
          if ((r.created_at || '').slice(0, 7) !== mk) continue;
          if (r.source === 'fund' || r.source === 'transfer') continue;
          if (r.direction === 'income') inc += r.amount; else exp += r.amount;
        }
      }
      const monthlyInc = inc / 3, monthlyExp = exp / 3;
      const saveRate = monthlyInc > 0 ? Math.max(0, (monthlyInc - monthlyExp) / monthlyInc) : 0;
      const debtRate = totalAssets > 0 ? debts / totalAssets : 0;
      const eFundMonths = monthlyExp > 0 ? assets / monthlyExp : (assets > 0 ? 99 : 0);
      const score = v => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
      const saveScore = score(saveRate * 100 / 0.5 * 100 / 2);
      const debtScore = score((1 - debtRate / 0.6) * 100);
      const eScore = score(Math.min(100, eFundMonths / 6 * 100));
      const total = Math.round((saveScore + debtScore + eScore) / 3 * 10) / 10;
      return { total, items: [
        { key: 'save', name: '结余率', value: saveRate, score: saveScore, detail: '近3月' },
        { key: 'debt', name: '负债率', value: debtRate, score: debtScore, detail: '负债 ' + Math.round(debts) + ' / 资产 ' + Math.round(totalAssets) },
        { key: 'efund', name: '应急金月数', value: eFundMonths, score: eScore, detail: '现金 ' + Math.round(assets) }
      ], summary: { assets, debts, totalAssets, inv, fxVal, monthlyInc, monthlyExp } };
    }
    if (segs[1] === 'finance' && segs[2] === 'emergency' && segs.length === 3 && method === 'GET') {
      const pools = await IDB.idbAll('pools');
      const cash = pools.filter(p => p.kind === 'asset').reduce((s, p) => s + (p.balance || 0), 0);
      const recs = await IDB.idbAll('records');
      const now = new Date();
      const monthKey = i => { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
      let e3 = 0, e6 = 0;
      for (let i = 0; i < 6; i++) {
        const mk = monthKey(i);
        let mExp = 0;
        for (const r of recs) {
          if ((r.created_at || '').slice(0, 7) !== mk || r.direction !== 'expense') continue;
          if (r.source === 'fund' || r.source === 'transfer') continue;
          mExp += r.amount;
        }
        if (i < 3) e3 += mExp;
        e6 += mExp;
      }
      const monthly = Math.max(e3 / 3, e6 / 6);
      return { monthly, target3: monthly * 3, target6: monthly * 6, cash, gap3: Math.max(0, monthly * 3 - cash), gap6: Math.max(0, monthly * 6 - cash) };
    }
    if (segs[1] === 'invest' && segs[2] === 'portfolio' && segs.length === 3 && method === 'GET') {
      const assets = (await IDB.idbAll('invest_assets')).sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || a.id - b.id);
      const KIND = { gold: '黄金', security: '证券', wealth: '理财', deposit: '定期存款', other: '其他' };
      const rows = assets.map(a => {
        const cost = a.cost_price ? (a.quantity || 0) * a.cost_price : ((a.quantity || 0) * (a.price || 0));
        const value = (a.quantity || 0) * (a.price || 0);
        const profit = value - cost;
        const profitRate = cost > 0 ? profit / cost : 0;
        let interest = null, daysLeft = null;
        if (a.kind === 'deposit' && a.profit_rate && a.term_months) {
          interest = Math.round(a.quantity * a.profit_rate / 100 * a.term_months / 12 * 100) / 100;
          if (a.maturity_date) {
            const dd = new Date(a.maturity_date + 'T00:00:00');
            const nd = new Date();
            daysLeft = Math.ceil((dd - nd) / 86400000);
          }
        }
        return { ...a, kind_name: KIND[a.kind] || a.kind, cost, value, profit, profit_rate: profitRate, interest, days_left: daysLeft };
      });
      const totalCost = rows.reduce((s, r) => s + r.cost, 0);
      const totalValue = rows.reduce((s, r) => s + r.value, 0);
      const byKind = {};
      for (const r of rows) byKind[r.kind_name] = (byKind[r.kind_name] || 0) + r.value;
      return { rows, totalCost, totalValue, totalProfit: totalValue - totalCost, totalRate: totalCost > 0 ? (totalValue - totalCost) / totalCost : 0, byKind };
    }
    // ── 保障：保单台账（重构 P4） ──
    if (segs[1] === 'insurance' && segs.length === 2 && method === 'GET') {
      const today = IDB.todayStr();
      const rows = (await IDB.idbAll('insurance_policies'))
        .sort((a, b) => (a.renew_date || '') === (b.renew_date || '') ? b.id - a.id : ((a.renew_date || '') > (b.renew_date || '') ? 1 : -1))
        .map(r => ({ ...r, days_left: r.renew_date ? daysLeftOf(r.renew_date, today) : null }));
      return { rows };
    }
    if (segs[1] === 'insurance' && segs.length === 2 && method === 'POST') {
      const b = body || {};
      if (!b.insurer || !b.name) throw Err('保险公司与保单名称必填');
      const id = await IDB.idbTx(a => a.add('insurance_policies', {
        insurer: b.insurer, kind: b.kind || '其他', name: b.name,
        amount: Number(b.amount) || 0, premium: Number(b.premium) || 0,
        start_date: b.start_date || null, end_date: b.end_date || null, renew_date: b.renew_date || null,
        pay_pool_id: b.pay_pool_id ? Number(b.pay_pool_id) : null,
        beneficiary: b.beneficiary || null, remark: b.remark || null,
        last_paid_date: null, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
      }));
      return { ok: true, id };
    }
    if (segs[1] === 'insurance' && segs.length === 3 && method === 'PUT') {
      const id = Number(segs[2]);
      const old = await IDB.idbGet('insurance_policies', id);
      if (!old) throw Err('保单不存在');
      const b = body || {};
      const v = (k, d) => (b[k] === undefined ? d : b[k]);
      await IDB.idbTx(a => a.put('insurance_policies', {
        ...old, insurer: v('insurer', old.insurer), kind: v('kind', old.kind), name: v('name', old.name),
        amount: Number(v('amount', old.amount)), premium: Number(v('premium', old.premium)),
        start_date: v('start_date', old.start_date), end_date: v('end_date', old.end_date), renew_date: v('renew_date', old.renew_date),
        pay_pool_id: v('pay_pool_id', old.pay_pool_id), beneficiary: v('beneficiary', old.beneficiary), remark: v('remark', old.remark)
      }));
      return { ok: true };
    }
    if (segs[1] === 'insurance' && segs.length === 3 && method === 'DELETE') {
      await IDB.idbTx(a => a.del('insurance_policies', Number(segs[2])));
      return { ok: true };
    }
    if (segs[1] === 'insurance' && segs.length === 4 && segs[3] === 'pay' && method === 'POST') {
      // 缴保费：/insurance/:id/pay
      {
        const id = Number(segs[2]);
        const p = await IDB.idbGet('insurance_policies', id);
        if (!p) throw Err('保单不存在');
        const b = body || {};
        const pid = b.pool_id ? Number(b.pool_id) : p.pay_pool_id;
        if (!pid) throw Err('请选择缴费账户');
        const date = b.pay_date || IDB.todayStr();
        const cats = await IDB.idbAll('rec_categories');
        const cat = cats.find(c => c.name === '保险');
        const rid = await IDB.idbTx(a => {
          const nid = a.add('records', {
            direction: 'expense', amount: p.premium, cat_path: cat ? (cat.cat_path || '支出/保险') : '支出/保险',
            cat_leaf_id: cat ? cat.id : null, pool_id: pid, remark: b.remark || ('保费 · ' + p.name),
            source: 'insurance', biz: 0, book_id: lb(), created_at: date + ' 00:00:00'
          });
          let nextRenew = null;
          if (p.renew_date) {
            const [yy, mm, dd] = p.renew_date.split('-').map(Number);
            const lastDay = new Date(yy + 1, mm, 0).getDate();
            nextRenew = (yy + 1) + '-' + String(mm).padStart(2, '0') + '-' + String(Math.min(dd, lastDay)).padStart(2, '0');
          }
          a.put('insurance_policies', { ...p, last_paid_date: date, renew_date: nextRenew || p.renew_date });
          return nid;
        });
        return { ok: true, record_id: rid, next_renew: null };
      }
    }
    if (segs[1] === 'pay-calendar' && segs.length === 2 && method === 'GET') {
      const prefix = String(q.month || '').slice(0, 7);
      const out = [];
      const bills = await IDB.idbAll('credit_bills');
      const pools = await IDB.idbAll('pools');
      for (const b of bills) {
        if (b.status !== 'open' || (b.due_date || '').slice(0, 7) !== prefix) continue;
        const pool = pools.find(p => p.id === b.pool_id);
        out.push({ date: b.due_date, type: 'credit', label: '信用卡 · ' + (pool?.name || ''), amount: (b.amount || 0) - (b.paid_amount || 0), pool_id: b.pool_id, id: b.id });
      }
      const rps = (await IDB.idbAll('repayment_plans')).filter(r => r.status === 'active');
      for (const rp of rps) {
        if ((rp.paid_months || 0) >= (rp.months || 0)) continue;
        const start = rp.start_month ? new Date(rp.start_month + '-01T00:00:00') : new Date();
        const due = new Date(start.getFullYear(), start.getMonth() + (rp.paid_months || 0), Math.min(28, start.getDate() || 1));
        const key = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0');
        if (key === prefix) out.push({ date: key + '-' + String(due.getDate()).padStart(2, '0'), type: 'repay', label: '还款计划 · ' + rp.name, amount: rp.monthly, pool_id: rp.pool_id, id: rp.id });
      }
      const arap = (await IDB.idbAll('biz_arap')).filter(a => a.type === 'payable' && a.status === 'open' && (a.due_date || '').slice(0, 7) === prefix);
      for (const a of arap) out.push({ date: a.due_date, type: 'arap', label: '应付 · ' + a.party, amount: a.amount, project_id: a.project_id, id: a.id });
      // 周期记账（本月待记）
      const recs = (await IDB.idbAll('recurring')).filter(r => r.enabled === 1);
      const mDays = new Date(Number(prefix.slice(0, 4)), Number(prefix.slice(5)), 0).getDate();
      for (const r of recs) {
        if ((r.last_done_month || '') === prefix) continue;
        const day = Math.min(r.day_of_month || 1, mDays);
        out.push({ date: prefix + '-' + String(day).padStart(2, '0'), type: 'recur', label: '周期 · ' + (r.name || r.remark || ''), amount: r.amount, id: r.id });
      }
      // 保费续费（保障域）
      for (const p2 of (await IDB.idbAll('insurance_policies')).filter(x => x.renew_date && (x.renew_date || '').slice(0, 7) === prefix)) {
        out.push({ date: p2.renew_date, type: 'ins', label: '保费 · ' + (p2.name || ''), amount: p2.premium, id: p2.id });
      }
      out.sort((x, y) => (x.date || '').localeCompare(y.date || ''));
      return { month: prefix, rows: out, total: out.reduce((s, x) => s + x.amount, 0), count: out.length };
    }
    if (segs[1] === 'budget' && segs[2] === 'status' && segs.length === 3 && method === 'GET') {
      const month = String(q.month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw Err('month 必填');
      const year = Number(month.slice(0, 4)), m = Number(month.slice(5));
      const budgets = await IDB.idbAll('budgets');
      const b = budgets.find(x => x.year_month === month && !x.category_id);
      const budget = b?.amount || 0;
      let carryOver = 0;
      if (b?.carry_enabled) {
        const prevM = m === 1 ? (year - 1) + '-12' : year + '-' + String(m - 1).padStart(2, '0');
        const prev = budgets.find(x => x.year_month === prevM && !x.category_id);
        if (prev) {
          const recs = await IDB.idbAll('records');
          let pe = 0;
          for (const r of recs) {
            if ((r.created_at || '').slice(0, 7) !== prevM || r.direction !== 'expense') continue;
            if (r.source === 'fund' || r.source === 'transfer') continue;
            pe += r.amount;
          }
          carryOver = Math.max(0, prev.amount - pe);
        }
      }
      const effBudget = budget + carryOver;
      const recs = await IDB.idbAll('records');
      let exp = 0, inc = 0;
      const byCat = {};
      for (const r of recs) {
        if ((r.created_at || '').slice(0, 7) !== month) continue;
        if (r.source === 'fund' || r.source === 'transfer') continue;
        if (r.direction === 'income') inc += r.amount;
        else { exp += r.amount; if (r.cat_leaf_id) byCat[r.cat_leaf_id] = (byCat[r.cat_leaf_id] || 0) + r.amount; }
      }
      const now = new Date();
      const daysInMonth = new Date(year, m, 0).getDate();
      const dayPassed = Math.min(Math.max(now.getDate(), 1), daysInMonth);
      const dailyBudget = effBudget / daysInMonth;
      const expected = dailyBudget * dayPassed;
      const remain = effBudget - exp;
      const dailyRemain = remain / Math.max(1, daysInMonth - dayPassed + 1);
      let level = 'ok';
      if (effBudget > 0) { const p = exp / effBudget; if (p >= 1) level = 'over'; else if (p >= 0.8) level = 'warn'; }
      const catRows = budgets.filter(x => x.year_month === month && x.category_id).map(c => ({ id: c.id, category_id: c.category_id, category_name: c.category_name, amount: c.amount, spent: byCat[c.category_id] || 0, remain: c.amount - (byCat[c.category_id] || 0) }));
      return { month, budget, carryOver, effBudget, exp, inc, remain, dailyBudget, expected, dailyRemain, level, daysInMonth, dayPassed, catRows };
    }

    throw Err('未知接口: ' + method + ' ' + url.pathname, 404);
  }
};
