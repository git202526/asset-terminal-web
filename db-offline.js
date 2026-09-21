'use strict';
// 资产聚合管理终端 · 离线数据层（M6.1）— IndexedDB 封装，无外部依赖
// 15 张表与后端 SQLite schema 完全对齐（见 server/schema.sql）

const IDB_NAME = 'asset-terminal-offline';
const IDB_VER = 6;
const IDB_STORES = [
  'pools', 'pool_ops', 'rec_categories', 'records',
  'salary_config', 'salary_month', 'salary_adj_log',
  'invest_assets', 'fixed_assets', 'net_snapshots',
  'biz_projects', 'biz_categories', 'biz_records', 'biz_surplus', 'biz_arap',
  'budgets', 'recurring',
  'credit_bills', 'due_reminders', 'savings_goals', 'invest_cashflows', 'repayment_plans', 'ledger_books',
  'quick_templates', 'attachments', 'tags', 'record_tags',
  'salary_bonus', 'insurance_policies'
];

let _db = null;
function openDB() {
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of IDB_STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error || new Error('IndexedDB 打开失败'));
  });
}

function reqP(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error || new Error('IndexedDB 请求失败'));
  });
}

// 只读：取整表
async function idbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly');
    const r = t.objectStore(store).getAll();
    t.oncomplete = () => res(r.result);
    t.onerror = () => rej(t.error);
  });
}
// 只读：按 id 取单条
async function idbGet(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly');
    const r = t.objectStore(store).get(Number(id));
    t.oncomplete = () => res(r.result);
    t.onerror = () => rej(t.error);
  });
}

// 写事务：fn(api) 内可跨多 store 顺序操作（await 每个请求，同事务原子提交）
async function idbTx(fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(IDB_STORES, 'readwrite');
    const api = {
      get: (s, id) => reqP(t.objectStore(s).get(Number(id))),
      all: (s) => reqP(t.objectStore(s).getAll()),
      add: (s, row) => reqP(t.objectStore(s).add(row)),
      put: (s, row) => reqP(t.objectStore(s).put(row)),
      del: (s, id) => reqP(t.objectStore(s).delete(Number(id))),
      clear: (s) => reqP(t.objectStore(s).clear()),
      count: (s) => reqP(t.objectStore(s).count())
    };
    let result, finished = false, lastErr = null;
    t.oncomplete = () => { if (!finished) { finished = true; res(result); } };
    t.onerror = () => { if (!finished) { finished = true; rej(lastErr || t.error || new Error('事务失败')); } };
    t.onabort = () => { if (!finished) { finished = true; rej(lastErr || t.error || new Error('事务中止')); } };
    (async () => {
      try {
        result = await fn(api);
      } catch (e) {
        lastErr = e; // 业务错误原样透传（abort 用于回滚已写数据）
        try { t.abort(); } catch (_) { /* 已中止 */ }
      }
    })();
  });
}

// 清空全部表（导入/重置用）
async function idbClearAll() {
  await idbTx(async a => { for (const s of IDB_STORES) await a.clear(s); });
}

// ── 默认种子（对齐 server/db.js seed()，仅空库时执行）────────
// 并发安全：全局互斥锁 + 事务内二次检查（rw 事务串行，第二个并发事务进入时已可见首个事务的数据），
// 修复总览 Promise.all 并发 API 请求同时触发空库种子导致的分类/资金池双写
let _seedPromise = null;
async function idbSeedIfEmpty() {
  if (_seedPromise) return _seedPromise;
  _seedPromise = (async () => {
    const pools = await idbAll('pools');
    if (pools.length) return;
    await idbTx(async a => {
      const p2 = await a.all('pools');
      if (p2.length) return;
      const addPool = (name, tail, kind, balance) => a.add('pools', { name, tail, kind, balance, created_at: nowStr(), updated_at: nowStr() });
    const zz = await addPool('郑州银行', '8965', 'asset', 58240);
    await addPool('工商银行', '1234', 'asset', 31150);
    await addPool('支付宝', '8899', 'asset', 21990);
    await addPool('现金', '—', 'asset', 12200);
    await addPool('信用卡', '6688', 'liability', -2800);

    // 记账分类树（与后端 seed 顺序一致）
    const ins = (lvl, name, parent_id, direction, sort, is_custom) =>
      a.add('rec_categories', { lvl, name, parent_id: parent_id ?? null, direction, sort, is_custom: is_custom || 0 });
    const expense = await ins(1, '支出', null, 'expense', 0, 0);
    const income = await ins(1, '收入', null, 'income', 0, 0);
    const c = (lvl, name, parent, sort) => ins(lvl, name, parent, 'expense', sort, 0);
    const food = await c(2, '餐饮', expense, 0);
    const transit = await c(2, '交通', expense, 1);
    const live = await c(2, '居住', expense, 2);
    const shop = await c(2, '购物', expense, 3);
    const fun = await c(2, '娱乐', expense, 4);
    await c(2, '医疗', expense, 5); await c(2, '教育', expense, 6);
    await c(2, '人情', expense, 7); await c(2, '其他', expense, 8);
    const c3 = (name, parent, sort) => c(3, name, parent, sort);
    const c4 = (name, parent, sort) => c(4, name, parent, sort);
    let p = await c3('正餐', food, 0); await c4('堂食', p, 0); await c4('外卖', p, 1);
    p = await c3('早餐', food, 1); await c4('包子豆浆', p, 0); await c4('咖啡牛奶', p, 1);
    await c3('零食', food, 2);
    p = await c3('公共交通', transit, 0); await c4('公交', p, 0); await c4('地铁', p, 1);
    p = await c3('打车', transit, 1); await c4('滴滴', p, 0); await c4('出租', p, 1);
    await c3('加油', transit, 2); await c3('停车', transit, 3);
    p = await c3('房租', live, 0); await c4('月租', p, 0);
    p = await c3('水电', live, 1); await c4('水费', p, 0); await c4('电费', p, 1);
    await c3('物业', live, 2); await c3('燃气', live, 3);
    p = await c3('日用百货', shop, 0); await c4('超市', p, 0); await c4('便利店', p, 1);
    p = await c3('服装', shop, 1); await c4('线上', p, 0); await c4('线下', p, 1);
    p = await c3('数码', shop, 2); await c4('手机', p, 0); await c4('电脑', p, 1);
    await c3('美妆', shop, 3);
    p = await c3('电影', fun, 0); await c4('线上购票', p, 0);
    p = await c3('游戏', fun, 1); await c4('充值', p, 0);
    p = await c3('旅行', fun, 2); await c4('机票', p, 0); await c4('酒店', p, 1);
    const r = (name, sort) => ins(2, name, income, 'income', sort, 0);
    const salary = await r('工资', 0); await c3('基本工资', salary, 0); await c3('奖金', salary, 1);
    const part = await r('兼职', 1); await c3('稿费', part, 0); await c3('劳务', part, 1);
    const invest = await r('投资', 2); await c3('利息', invest, 0); await c3('理财收益', invest, 1); await c3('分红', invest, 2);
    const biz = await r('经营', 3); await c3('租金收入', biz, 0); await c3('营业收入', biz, 1);
    await r('理财', 4); await r('其他', 5);

    // 工资配置（2026-01 起生效）
    await a.add('salary_config', {
      valid_from: '2026-01', social_base: 4700, ins_personal: 0.103, ins_unit: 0.237,
      fund_rate: 0.08, good_base: 3840, bonus_excellent: 180, bonus_hot: 300,
      serious_ill: 130, created_at: nowStr(),
      ins_pension_u: 0.16, ins_pension_p: 0.08, ins_medical_u: 0.07, ins_medical_p: 0.02,
      ins_unemploy_u: 0.007, ins_unemploy_p: 0.003, ins_injury_u: 0.0104, ins_maternity_u: 0.01,
      fund_rate_u: 0.08
    });

    // 经营：默认项目（房屋租赁）+ 分类体系
    const proj = await a.add('biz_projects', { name: '房屋租赁', asset_id: null, pool_id: zz, created_at: nowStr() });
    const bl1 = (lvl, name, sort, direction) =>
      a.add('biz_categories', { project_id: proj, lvl, name, direction, parent_id: null, sort, is_custom: 0 });
    const bchild = (lvl, name, parent, sort, dir) =>
      a.add('biz_categories', { project_id: proj, lvl, name, direction: dir, parent_id: parent, sort, is_custom: 0 });
    const binc = await bl1(1, '收入', 0, 'in');
    const bcost = await bl1(1, '成本', 1, 'out');
    p = await bchild(2, '租金', binc, 0, 'in'); await bchild(3, '住宅租金', p, 0, 'in'); await bchild(3, '商铺租金', p, 1, 'in');
    p = await bchild(2, '营业收入', binc, 1, 'in'); await bchild(3, '商品销售', p, 0, 'in'); await bchild(3, '服务费', p, 1, 'in');
    await bchild(2, '其他收入', binc, 2, 'in');
    p = await bchild(2, '经营成本', bcost, 0, 'out'); await bchild(3, '水电', p, 0, 'out'); await bchild(3, '物业', p, 1, 'out');
    await bchild(3, '维修', p, 2, 'out'); await bchild(3, '人工', p, 3, 'out'); await bchild(3, '物料', p, 4, 'out');
    p = await bchild(2, '税费', bcost, 1, 'out'); await bchild(3, '增值税', p, 0, 'out'); await bchild(3, '个税', p, 1, 'out');
    await bchild(2, '其他支出', bcost, 2, 'out');
    });
  })().catch(e => { _seedPromise = null; throw e; });
  return _seedPromise;
}

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function monthStr() { return todayStr().slice(0, 7); }

const IDB = { openDB, idbAll, idbGet, idbTx, idbClearAll, idbSeedIfEmpty, nowStr, todayStr, monthStr, IDB_STORES };
