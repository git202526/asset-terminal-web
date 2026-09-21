'use strict';
// 资产聚合管理终端 · M1 — 账户互转/对账 + 记账四级分类 + 流水引擎（API 驱动）
// M6.1 模式感知：server（Node+SQLite）/ offline（IndexedDB 本地全离线）
// 全局规则：红涨绿跌（盈利/上涨/收入=红，亏损/下跌/支出/负债=绿）

// 启动时自动检查版本：如果本地加载的是旧版，强制硬刷一次
const APP_VERSION = '2.26.7';

const API = '/api';
const fmt = n => (n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtMonth = () => new Date().toISOString().slice(0, 7);

// ── 运行模式（M6.1）────────────────────────────────────
const APP_MODE = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get('mode') === 'offline') return 'offline';
  if (q.get('mode') === 'server') return 'server';
  // 远程部署（GitHub Pages等）默认离线模式，不检测本地服务
  if (location.protocol === 'https:' && !location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1')) return 'offline';
  return 'server';
})();

async function api(path, opts) {
  if (APP_MODE === 'offline') return OfflineAPI.route('/api' + path, opts);
  const r = await fetch(API + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const put = (path, body) => api(path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const del = path => api(path, { method: 'DELETE' });

// ── seg 选中态（通用）──────────────────────────────────
function segSel(btn) {
  btn.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ── Toast ───────────────────────────────────────────────
let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isErr ? 'rgba(179,84,30,.95)' : 'rgba(20,33,27,.92)';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Modal ───────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-root').innerHTML =
    `<div class="modal-mask" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
let _cfResolve = null;
function appConfirmResolve(v) { const r = document.getElementById('cf-root'); if (r) r.innerHTML = ''; if (_cfResolve) { _cfResolve(v); _cfResolve = null; } }
function appConfirm(msg) {
  return new Promise(resolve => {
    _cfResolve = resolve;
    const root = document.getElementById('cf-root');
    if (!root) return resolve(false);
    root.innerHTML = `
      <div class="cf-mask">
        <div class="cf-box">
          <div class="cf-title">操作确认</div>
          <div class="cf-msg">${String(msg).replace(/\n/g, '<br>')}</div>
          <div class="cf-btns">
            <button class="btn ghost" onclick="appConfirmResolve(false)">取消</button>
            <button class="btn danger" onclick="appConfirmResolve(true)">确认</button>
          </div>
        </div>
      </div>`;
  });
}

// ── Tab 路由（5 底栏 + 4 宫格域）──────────────────────
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('page-' + tab)?.classList.add('active');
  // 总览页保留顶部品牌栏，其它tab隐藏
  document.querySelector('.topbar').style.display = (tab === 'overview') ? '' : 'none';
  ({ overview: () => Overview.load(), pools: () => PoolUI.load(), ledger: () => Ledger.init(), salary: () => SalaryUI.load(), me: () => Me.load() })[tab]?.();
}
function openDomain(domain) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + domain)?.classList.add('active');
  ({ assets: () => { AssetsUI.load(); PoolUI.load(); }, biz: () => BizUI.load(), debt: () => DebtUI.load(), insurance: () => { InsUI.load(); PoolUI.load(); } })[domain]?.();
}
function closeDomain() { switchTab('overview'); }
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ── 总览（M4 数据聚合展示中心）────────────────────────
const Overview = {
  charts: {},
  async load() {
    try {
      const [ov, sm, bills] = await Promise.all([api('/overview'), api('/summary?month=' + fmtMonth()), api('/credit-bills')]);
      const net = document.getElementById('ov-net');
      net.textContent = '¥' + fmt(ov.net_assets);
      net.className = 'hero-num ' + (ov.net_assets >= 0 ? 'up' : 'down');
      document.getElementById('ov-sub').textContent =
        `总资产 ¥${fmt(ov.total_assets)} · 总负债 ¥${fmt(ov.total_debt)}`;
      const crPending = bills.filter(b => b.status !== 'paid');
      const crTotal = crPending.reduce((s2, b) => s2 + (b.amount - b.paid_amount), 0);
      const crOver = crPending.filter(b => b.status === 'overdue').length;
      const ovd = document.getElementById('ov-debt');
      if (ovd) ovd.textContent = crPending.length
        ? `信用卡未还 ¥${fmt(crTotal)} · 逾期 ${crOver} 笔${crOver ? '，点击账户-还款计划处理' : ''}`
        : (ov.total_debt > 0 ? '本月无待还信用卡账单' : '');
      document.getElementById('ov-income').textContent = '¥' + fmt(sm.income);
      document.getElementById('ov-expense').textContent = '¥' + fmt(sm.expense);
      this.distChart(ov);
      this.trendChart(ov.trend);
      this.incExpCharts(ov);
      this.flowChart(ov.flow6);
      this.poolChart(ov.pools);
      this.allocCard(ov);
      RemindUI.load();
      CalendarUI.load();
      InsUI.load().catch(() => {});
      // 宫格摘要（资产/债务/经营/保障）
      const domAssets = document.getElementById('ov-dom-assets');
      if (domAssets) domAssets.textContent = `持仓 ¥${fmt(ov.invest + ov.fixed)}`;
      const domDebt = document.getElementById('ov-dom-debt');
      if (domDebt) domDebt.textContent = ov.total_debt > 0 ? `待还 ¥${fmt(ov.total_debt)}` : '无负债';
      const domBiz = document.getElementById('ov-dom-biz');
      if (domBiz) {
        const bizSurplus = ov.biz_overview.reduce((s2, b) => s2 + b.surplus, 0);
        domBiz.textContent = ov.biz_overview.length ? `本月盈余 ¥${fmt(bizSurplus)}` : '暂无项目';
      }
      const domIns = document.getElementById('ov-dom-ins');
      if (domIns) domIns.textContent = '—';
      // 账本汇总（各账本本月收支独立统计）
      const booksEl = document.getElementById('ov-books');
      if (booksEl && ov.books) {
        const total = ov.books.reduce((t, b) => t + (b.income > 0 ? b.income : 0) + (b.expense > 0 ? b.expense : 0), 0);
        booksEl.innerHTML = ov.books.length ? ov.books.map(b => {
          const bal = b.income - b.expense;
          const pct = total > 0 ? Math.max(2, r2((b.income + b.expense) / total * 100)) : 0;
          return `<div class="mini-item" style="cursor:pointer" onclick="BookReportUI.open(${b.id},'${(b.name||'').replace(/'/g,"\\'")}')">
            <span>${b.name}${b.is_default ? ' <span class="dim-s">·默认</span>' : ''} <span class="dim-s">本月${b.record_count}笔</span></span>
            <span style="text-align:right">收 <span class="up">¥${fmt(b.income)}</span> · 支 <span class="down">¥${fmt(b.expense)}</span><br>
            <span class="${bal >= 0 ? 'up' : 'down'}">结余 ¥${fmt(bal)}</span>
            <span class="dim-s" style="font-size:10px">占比${pct.toFixed(1)}%</span></span>
          </div>`;
        }).join('') + `<div class="hint" style="margin-top:6px">本卡按流水归属账本统计本月收支，不改变账户资金全局共用。</div>`
          : '<div class="empty">暂无账本</div>';
      }
      // 本月总结
      const sumEl = document.getElementById('ov-summary');
      if (sumEl) {
        const inc = sm.income, exp = sm.expense, bal = inc - exp;
        const rate = inc > 0 ? (exp / inc * 100).toFixed(1) : '—';
        const trend = ov.trend && ov.trend.length >= 2 ? ov.trend[ov.trend.length - 1] : null;
        let tip = '';
        if (bal < 0) tip = '<span class="down">本月入不敷出，注意控制支出</span>';
        else if (rate !== '—' && rate > 80) tip = '<span class="down">支出占收入比偏高（' + rate + '%）</span>';
        else if (rate !== '—' && rate < 50) tip = '<span class="up">储蓄率不错，继续保持</span>';
        sumEl.innerHTML = `本月收入 <b class="up">¥${fmt(inc)}</b> · 支出 <b class="down">¥${fmt(exp)}</b><br>
          结余 <b class="${bal >= 0 ? 'up' : 'down'}">¥${fmt(bal)}</b> · 支出占收入 ${rate}%<br>${tip}`;
      }
      // 账本对比卡片
      const bc = document.getElementById('ov-book-compare');
      if (bc && ov.books && ov.books.length >= 2) {
        const maxExp = Math.max(...ov.books.map(b => b.expense), 1);
        bc.innerHTML = '<div class="sub-t" style="margin:10px 0 6px">账本对比</div>' + ov.books.map(b => {
          const bal = b.income - b.expense;
          const w = Math.max(2, b.expense / maxExp * 100);
          return `<div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
              <b>${b.name}</b><span class="${bal >= 0 ? 'up' : 'down'}">结余 ¥${fmt(bal)}</span></div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="dim-s" style="font-size:10px;min-width:28px">收</span>
              <div class="rep-bar-track" style="flex:1"><div class="rep-bar-fill" style="width:${Math.max(2, b.income / maxExp * 100)}%;background:var(--up)"></div></div>
              <span class="dim-s" style="font-size:10px;min-width:50px;text-align:right">¥${fmt(b.income)}</span></div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
              <span class="dim-s" style="font-size:10px;min-width:28px">支</span>
              <div class="rep-bar-track" style="flex:1"><div class="rep-bar-fill" style="width:${w}%;background:var(--down)"></div></div>
              <span class="dim-s" style="font-size:10px;min-width:50px;text-align:right">¥${fmt(b.expense)}</span></div>
          </div>`;
        }).join('');
      } else if (bc) {
        bc.innerHTML = '<div class="empty">多账本后自动对比</div>';
      }
    } catch (e) { document.getElementById('ov-net').textContent = '连接失败: ' + e.message; console.error(e); }
    HealthUI.load();
  },
  allocCard(ov) {
    const box = document.getElementById('ov-alloc');
    if (!box) return;
    const total = ov.total_assets || 0;
    if (!total) { box.innerHTML = '<div class="empty">无资产数据</div>'; return; }
    const pct = (v) => r2(v / total * 100);
    const cashP = pct(ov.cash), invP = pct(ov.invest), fixP = pct(ov.fixed);
    const rows = [
      { name: '现金货币', pct: cashP, suggest: '10-20%', ok: cashP >= 10 && cashP <= 30, color: '#2d6a4f' },
      { name: '投资资产', pct: invP, suggest: '30-60%', ok: invP >= 20 && invP <= 70, color: '#c23a3a' },
      { name: '固定资产', pct: fixP, suggest: '10-40%', ok: fixP <= 50, color: '#2f7d5d' }
    ];
    box.innerHTML = rows.map(r => `
      <div class="rep-bar-row">
        <span class="rep-bar-name">${r.name}</span>
        <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${Math.max(2, r.pct)}%;background:${r.color}"></div></div>
        <span class="rep-bar-val" style="color:${r.color}">${r.pct.toFixed(1)}%</span>
        <span class="dim-s" style="font-size:10px;width:52px;text-align:right">参考 ${r.suggest}</span>
      </div>`).join('') +
      `<div class="hint" style="margin-top:6px">参考区间为常见家庭配置（现金 10-30% / 投资 20-70% / 固定 ≤50%），仅供自检参考。</div>`;
  },
  distChart(ov) {
    const el = document.getElementById('ov-dist-chart');
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
    const chart = this.charts.dist || (this.charts.dist = echarts.init(el));
    const colors = ['#d33a3a', '#e8a13c', '#2e7d5b'];
    const data = [
      { name: '现金·账户', value: ov.cash },
      { name: '投资', value: ov.invest },
      { name: '固定', value: ov.fixed }
    ].filter(d => d.value > 0);
    chart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}<br/>¥{c} ({d}%)' },
      color: colors,
      series: [{
        type: 'pie', radius: ['45%', '72%'], center: ['50%', '50%'],
        label: { show: false }, labelLine: { show: false }, data
      }]
    });
    document.getElementById('ov-dist-legend').innerHTML = data.map((d, i) =>
      `<span><i style="background:${colors[i]}"></i>${d.name} ¥${fmt(d.value)}</span>`).join('');
  },
  trendChart(trend) {
    const el = document.getElementById('ov-trend-chart');
    const note = document.getElementById('ov-trend-note');
    if (note) note.textContent = trend.length < 2 ? '每日打开自动记录净资产，累计 ${trend.length} 天，多用几天后生成完整趋势' : `近 60 日 · ${trend.length} 个记录日`;
    if (trend.length < 2) {
      el.innerHTML = '<div class="empty" style="margin-top:0">累计 ' + trend.length + ' 个记录日，连续使用后自动生成趋势曲线</div>';
      return;
    }
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
    const chart = this.charts.trend || (this.charts.trend = echarts.init(el));
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['净资产'], top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 44, right: 12, top: 26, bottom: 22 },
      xAxis: { type: 'category', data: trend.map(t => t.date.slice(5)), axisLabel: { fontSize: 9 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 9, formatter: v => v >= 10000 ? (v / 10000).toFixed(1) + 'w' : v } },
      series: [{
        name: '净资产', type: 'line', smooth: true, symbol: 'none',
        data: trend.map(t => t.net),
        lineStyle: { color: '#d33a3a', width: 2.5 },
        areaStyle: { color: 'rgba(211,58,58,.08)' }
      }]
    });
  },
  // 本月收支构成：收入来源（红系）/ 支出分类（绿系）
  incExpCharts(ov) {
    const mk = (elId, key, colors) => {
      const el = document.getElementById(elId);
      if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
      const chart = this.charts[key] || (this.charts[key] = echarts.init(el));
      chart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}<br/>¥{c} ({d}%)', confine: true },
        color: colors,
        series: [{
          type: 'pie', radius: ['48%', '72%'], center: ['50%', '52%'],
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 9, color: '#666' },
          labelLine: { length: 6, length2: 4 },
          data: (key === 'inc' ? ov.month_income_src : ov.month_expense_cat).filter(d => d.value > 0)
        }]
      });
    };
    mk('ov-inc-chart', 'inc', ['#d33a3a', '#e2734a', '#e8a13c', '#c94f5e']);
    mk('ov-exp-chart', 'exp', ['#2e7d5b', '#4a9d7a', '#6fae8e']);
  },
  // 近6月现金流柱状
  flowChart(flow6) {
    const el = document.getElementById('ov-flow-chart');
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
    const chart = this.charts.flow || (this.charts.flow = echarts.init(el));
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['收入', '支出'], top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 44, right: 12, top: 26, bottom: 22 },
      xAxis: { type: 'category', data: flow6.map(f => f.month.slice(2)), axisLabel: { fontSize: 9 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 9 } },
      series: [
        { name: '收入', type: 'bar', data: flow6.map(f => f.income), itemStyle: { color: '#d33a3a', borderRadius: [3, 3, 0, 0] }, barWidth: 12 },
        { name: '支出', type: 'bar', data: flow6.map(f => f.expense), itemStyle: { color: '#2e7d5b', borderRadius: [3, 3, 0, 0] }, barWidth: 12 }
      ]
    });
  },
  // 账户分布条形图（负债绿）
  poolChart(pools) {
    const el = document.getElementById('ov-pool-chart');
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
    const chart = this.charts.pool || (this.charts.pool = echarts.init(el));
    const sorted = [...pools].sort((a, b) => a.balance - b.balance);
    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 90, right: 40, top: 8, bottom: 20 },
      xAxis: { type: 'value', axisLabel: { fontSize: 9 } },
      yAxis: {
        type: 'category', data: sorted.map(p => p.name + '·' + p.tail + (p.kind === 'liability' ? '(负债)' : '')),
        axisLabel: { fontSize: 9.5 }
      },
      series: [{
        type: 'bar', data: sorted.map(p => ({
          value: p.balance,
          itemStyle: { color: p.kind === 'liability' ? '#2e7d5b' : '#d33a3a', borderRadius: [0, 3, 3, 0] }
        })), barWidth: 13,
        label: { show: true, position: 'right', fontSize: 9, formatter: v => '¥' + fmt(v.value) }
      }]
    });
  }
};

// ── 报表（M7.1 月报/年报）───────────────────────────────
// 2.3.3 账本报表（总览账本汇总卡点击进入）
const BookReportUI = {
  id: null, name: '', month: fmtMonth(),
  async open(id, name) {
    this.id = id; this.name = name; this.month = fmtMonth();
    document.getElementById('book-report-view').style.display = 'block';
    document.getElementById('br-title').textContent = name + ' · 账本报表';
    ViewStack.open('book-report-view', () => { document.getElementById('book-report-view').style.display = 'none'; });
    await this.load();
  },
  close() {
    ViewStack.close();
  },
  async monthPrev() { const d = new Date(this.month + '-01'); d.setMonth(d.getMonth() - 1); this.month = d.toISOString().slice(0, 7); await this.load(); },
  async monthNext() { const d = new Date(this.month + '-01'); d.setMonth(d.getMonth() + 1); this.month = d.toISOString().slice(0, 7); await this.load(); },
  async load() {
    const box = document.getElementById('br-body');
    box.innerHTML = '<div class="empty">加载中…</div>';
    document.getElementById('br-month').textContent = this.month;
    try {
      const r = await api('/books/' + this.id + '/report?month=' + this.month);
      const m = r.month;
      const bal = m.income - m.expense;
      const pct = v => v <= 0 ? 0 : (v / Math.max(m.income + m.expense, 1) * 100).toFixed(1);
      const catRows = r.cats.map(c => `
        <div class="mini-item">
          <span>${c.direction === 'income' ? '收' : '支'} · ${c.path}</span>
          <span class="${c.direction === 'income' ? 'up' : 'down'}">¥${fmt(c.amount)} <span class="dim-s" style="font-size:10px">${pct(c.amount)}%</span></span>
        </div>`).join('') || '<div class="empty">本月无分类流水</div>';
      const trendBars = r.trend.length ? r.trend.map(t => {
        const tot = t.income + t.expense;
        const mx = Math.max(...r.trend.map(x => x.income + x.expense), 1);
        const h = tot > 0 ? Math.max(6, Math.round(tot / mx * 56)) : 2;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
          <div style="font-size:9px;color:var(--dim)">${t.month.slice(5)}</div>
          <div style="display:flex;align-items:flex-end;gap:2px;height:60px">
            <div style="width:9px;height:${Math.max(2, t.income > 0 ? h : 2)}px;background:var(--up,#c23a3a);border-radius:2px 2px 0 0"></div>
            <div style="width:9px;height:${Math.max(2, t.expense > 0 ? h : 2)}px;background:var(--down,#2d6a4f);border-radius:2px 2px 0 0"></div>
          </div>
          <div style="font-size:9px;color:var(--dim)">${fmt(t.income - t.expense)}</div>
        </div>`;
      }).join('') : '<div class="empty">暂无趋势数据</div>';
      const recRows = r.records.map(x => `
        <div class="mini-item">
          <span>${x.direction === 'income' ? '收' : '支'} · ${x.cat_path || '未分类'}${x.remark ? ' <span class="dim-s">' + x.remark + '</span>' : ''}</span>
          <span class="${x.direction === 'income' ? 'up' : 'down'}">${x.direction === 'income' ? '+' : '-'}¥${fmt(x.amount)}</span>
        </div>`).join('') || '<div class="empty">该月暂无流水</div>';
      box.innerHTML = `
        <div class="card">
          <div class="card-title">${this.month} 收支</div>
          <div class="grid2">
            <div class="stat-card"><div class="stat-label">收入</div><div class="stat-num up">¥${fmt(m.income)}</div></div>
            <div class="stat-card"><div class="stat-label">支出</div><div class="stat-num down">¥${fmt(m.expense)}</div></div>
          </div>
          <div style="margin-top:8px;font-size:13px">结余 <span class="${bal >= 0 ? 'up' : 'down'}">¥${fmt(bal)}</span>
            <span class="dim-s" style="font-size:11px"> · 共 ${m.cnt} 笔</span></div>
        </div>
        <div class="card">
          <div class="card-title">近 6 月收支趋势 <span class="hint">红收绿支</span></div>
          <div style="display:flex;gap:6px">${trendBars}</div>
        </div>
        <div class="card">
          <div class="card-title">${this.month} 分类排行</div>
          <div class="mini-list">${catRows}</div>
        </div>
        <div class="card">
          <div class="card-title">最近流水 <span class="hint">该账本最近 ${r.records.length} 笔</span></div>
          <div class="mini-list">${recRows}</div>
        </div>`;
    } catch (e) { box.innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
  }
};
const ReportUI = {
  type: 'month',
  date: () => new Date().toISOString().slice(0, 7),
  open() {
    document.getElementById('report-view').style.display = '';
    ViewStack.open('report-view', () => { document.getElementById('report-view').style.display = 'none'; });
    document.getElementById('rep-date').value = this.date();
    document.querySelectorAll('#report-view .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.rt === 'month'));
    this.load();
  },
  close() { ViewStack.close(); },
  setType(t) {
    this.type = t;
    document.querySelectorAll('#report-view .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.rt === t));
    const el = document.getElementById('rep-date');
    if (t === 'year') {
      el.type = 'text'; el.value = (el.value || this.date()).slice(0, 4); el.placeholder = '年份 YYYY';
    } else if (t === 'quarter') {
      el.type = 'month';
      const now = new Date();
      const q = Math.floor(now.getMonth() / 3) + 1;
      el.value = now.getFullYear() + '-Q' + q;
    } else {
      el.type = 'month'; el.value = this.date();
    }
    this.load();
  },
  async load() {
    const el = document.getElementById('rep-date');
    const body = document.getElementById('report-body');
    if (this.type === 'month') {
      const month = el.value || this.date();
      try { body.innerHTML = this.renderMonth(await api('/report/month?month=' + month)); }
      catch (e) { body.innerHTML = '<div class="empty">加载失败</div>'; }
    } else if (this.type === 'quarter') {
      const m = el.value || this.date();
      const y = m.slice(0, 4);
      const mo = parseInt(m.slice(5, 7) || '1');
      const q = Math.floor((mo - 1) / 3) + 1;
      const from = y + '-' + String((q - 1) * 3 + 1).padStart(2, '0') + '-01';
      const to = y + '-' + String(q * 3).padStart(2, '0') + '-31';
      try {
        const rows = await api('/records?from=' + from + '&to=' + to + '&limit=100000');
        body.innerHTML = this.renderQuarter(y + ' 年 Q' + q, rows);
      } catch (e) { body.innerHTML = '<div class="empty">加载失败</div>'; }
    } else {
      const year = (el.value || this.date()).slice(0, 4);
      try { body.innerHTML = this.renderYear(await api('/report/year?year=' + year)); }
      catch (e) { body.innerHTML = '<div class="empty">加载失败</div>'; }
    }
  },
  renderQuarter(title, rows) {
    let inc = 0, exp = 0;
    const catMap = {};
    for (const r of rows) {
      if (r.direction === 'income') inc += r.amount; else exp += r.amount;
      const k = r.cat_path || '未分类';
      if (!catMap[k]) catMap[k] = { in: 0, out: 0 };
      if (r.direction === 'income') catMap[k].in += r.amount; else catMap[k].out += r.amount;
    }
    const expCats = Object.entries(catMap).map(([n, v]) => ({ name: n, amount: v.out })).filter(x => x.amount > 0).sort((a, b) => b.amount - a.amount);
    const incCats = Object.entries(catMap).map(([n, v]) => ({ name: n, amount: v.in })).filter(x => x.amount > 0).sort((a, b) => b.amount - a.amount);
    return `
      <div class="rep-hero">
        <div><div class="hint">季度收入</div><div class="rep-num up">${fmt(inc)}</div></div>
        <div><div class="hint">季度支出</div><div class="rep-num down">${fmt(exp)}</div></div>
        <div class="rep-bal">结余 <b class="${inc-exp >= 0 ? 'up' : 'down'}">${fmt(inc - exp)}</b></div>
      </div>
      <div class="card"><div class="card-title">${title} 收入构成</div>${this.bar(incCats, '#d33a3a')}</div>
      <div class="card"><div class="card-title">${title} 支出构成</div>${this.bar(expCats, '#2d6a4f')}</div>
      <div class="card"><div class="card-title">${title} 共 ${rows.length} 笔流水</div></div>`;
  },
  bar(list, color) {
    const max = Math.max(...list.map(x => x.amount), 1);
    return list.length ? list.map(x => `
      <div class="rep-bar-row">
        <span class="rep-bar-name">${x.name}</span>
        <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${Math.max(2, x.amount / max * 100)}%;background:${color}"></div></div>
        <span class="rep-bar-val" style="color:${color}">${fmt(x.amount)}</span>
      </div>`).join('') : '<div class="hint">无数据</div>';
  },
  renderMonth(r) {
    const sal = r.salary;
    const tags = sal ? [sal.tag_good ? '良好' : '', sal.tag_excellent ? '优秀' : '', sal.tag_hot ? '高温' : '', sal.tag_ill ? '大病保险' : ''].filter(Boolean).join(' ') : '';
    const pname = id => (r.pools.find(p => p.id === id) || {}).name || '—';
    const poolRows = Object.entries(r.by_pool).map(([id, v]) => ({
      name: pname(Number(id)), in: v.in, out: v.out
    }));
    return `
      <div class="rep-hero">
        <div><div class="hint">本月收入</div><div class="rep-num up">${fmt(r.income_total)}</div></div>
        <div><div class="hint">本月支出</div><div class="rep-num down">${fmt(r.expense_total)}</div></div>
        <div class="rep-bal">结余 <b class="${r.balance >= 0 ? 'up' : 'down'}">${fmt(r.balance)}</b></div>
      </div>
      ${sal ? `<div class="card"><div class="card-title">工资 ${sal.month}</div>
        <div style="font-size:12.5px">实发 <b>${fmt(sal.net)}</b> · 应发 ${fmt(sal.gross)} ${tags ? '<span style="color:var(--key)">' + tags + '</span>' : ''}</div></div>` : ''}
      ${Object.keys(r.biz).length ? `<div class="card"><div class="card-title">经营</div>
        <div style="font-size:12.5px">收入 <b class="up">${fmt(r.biz.in || 0)}</b> · 成本 <b class="down">${fmt(r.biz.out || 0)}</b></div></div>` : ''}
      <div class="card"><div class="card-title">收入构成</div>${this.bar(r.income_by_cat, '#c23a3a')}</div>
      <div class="card"><div class="card-title">支出构成</div>${this.bar(r.expense_by_cat, '#2f7d5d')}</div>
      <div class="card"><div class="card-title">大额支出 TOP8</div>
        ${r.top_expense.length ? r.top_expense.map(x => `
          <div class="mini-item"><div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:600">${x.cat_path}</div>
            <div style="font-size:11px;color:var(--dim)">${x.date}${x.remark ? ' · ' + x.remark : ''}</div>
          </div><span class="amt-out">−${fmt(x.amount)}</span></div>`).join('') : '<div class="hint">无支出</div>'}
      </div>
      <div class="card"><div class="card-title">账户收支</div>
        ${poolRows.length ? poolRows.map(p => `<div class="mini-item"><div style="flex:1">${p.name}</div>
          <span style="font-size:12px"><span class="up">+${fmt(p.in)}</span> <span class="down">−${fmt(p.out)}</span></span></div>`).join('') : '<div class="hint">无数据</div>'}
      </div>`;
  },
  renderYear(r) {
    const sal = r.salary;
    const months = r.months.map(m => ({ month: m.month.slice(5), balance: m.balance, income: m.income }));
    let chart = '';
    if (typeof echarts !== 'undefined') {
      chart = `<div id="rep-year-chart" style="height:200px;margin-top:8px"></div>`;
      setTimeout(() => {
        const el = document.getElementById('rep-year-chart');
        if (!el) return;
        const c = echarts.init(el);
        c.setOption({
          grid: { left: 40, right: 12, top: 16, bottom: 24 },
          xAxis: { type: 'category', data: months.map(m => m.month), axisLabel: { fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { fontSize: 9 } },
          series: [{
            type: 'bar', data: months.map(m => m.balance),
            itemStyle: { color: p => p.value >= 0 ? '#c23a3a' : '#2f7d5d' }, barWidth: '55%'
          }]
        });
      }, 30);
    }
    return `
      <div class="rep-hero">
        <div><div class="hint">年度收入</div><div class="rep-num up">${fmt(r.income_total)}</div></div>
        <div><div class="hint">年度支出</div><div class="rep-num down">${fmt(r.expense_total)}</div></div>
        <div class="rep-bal">年度结余 <b class="${r.balance >= 0 ? 'up' : 'down'}">${fmt(r.balance)}</b></div>
      </div>
      <div class="card"><div class="card-title">每月结余（红盈绿亏）</div>${chart || '<div class="hint">图表库未加载</div>'}</div>
      <div class="card"><div class="card-title">年度工资统计 <span class="hint">${sal.rows.length} 个月</span></div>
        <div style="font-size:12.5px;line-height:1.9">实发合计 <b>${fmt(sal.net)}</b> · 应发合计 ${fmt(sal.gross)}<br>
        标签：良好 ${sal.good} 次 · 优秀 ${sal.excellent} 次 · 高温 ${sal.hot} 次 · 大病保险 ${sal.ill} 次</div></div>
      <div class="card"><div class="card-title">年度支出分类</div>${this.bar(r.expense_by_cat, '#2f7d5d')}</div>
      <div class="card"><div class="card-title">年度收入分类</div>${this.bar(r.income_by_cat, '#c23a3a')}</div>`;
  }
};

const PoolUI = {
  list: [],
  DEFAULT_CATS: {
    cash:{name:'现金账户',type:'asset'}, saving:{name:'储蓄账户',type:'asset'}, virtual:{name:'虚拟账户',type:'asset'},
    recharge:{name:'充值账户',type:'asset'}, credit:{name:'信用账户',type:'debt'}, investment:{name:'投资账户',type:'asset'},
    receivable:{name:'债权账户',type:'asset'}, payable:{name:'负债账户',type:'debt'}, other:{name:'其他',type:'asset'}
  },
  getCatMap() {
    try {
      const custom = JSON.parse(localStorage.getItem('at_pool_cats') || '{}');
      return Object.assign({}, this.DEFAULT_CATS, custom);
    } catch(e) { return Object.assign({}, this.DEFAULT_CATS); }
  },
  saveCatMap(map) {
    // 只存自定义的（覆盖默认名或新增）
    const custom = {};
    for (const k of Object.keys(map)) {
      const def = this.DEFAULT_CATS[k];
      if (!def || def.name !== map[k].name || def.type !== map[k].type) custom[k] = map[k];
    }
    localStorage.setItem('at_pool_cats', JSON.stringify(custom));
  },
  openCatManager() {
    const map = this.getCatMap();
    const rows = Object.entries(map).map(([k, v]) => `
      <div class="cat-node"><span class="nm" data-cat="${k}">${v.name}</span>
        <span class="hint">${v.type === 'debt' ? '负债' : '资产'}</span>
        <button class="btn ghost xs" onclick="PoolUI.renameCat('${k}')">改名</button>
        <button class="btn ghost xs danger-t" onclick="PoolUI.delCat('${k}')">删除</button>
      </div>`).join('');
    openModal(`
      <h4>账户分类管理</h4>
      <div style="font-size:12px;color:var(--dim);margin-bottom:8px">改名即时生效；自定义分类可删除（账户会自动归入"其他"）</div>
      <div id="cat-list">${rows}</div>
      <div class="field" style="margin-top:10px"><label>新分类名</label><input id="new-cat-name" type="text" placeholder="如：公积金账户"></div>
      <div class="field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0">类型</label>
        <select id="new-cat-type" class="sel" style="width:120px">
          <option value="asset">资产</option><option value="debt">负债</option>
        </select>
      </div>
      <button class="btn block" onclick="PoolUI.addCat()">新增分类</button>
      <button class="btn ghost block" style="margin-top:8px" onclick="closeModal()">完成</button>`);
  },
  addCat() {
    const name = document.getElementById('new-cat-name').value.trim();
    if (!name) return toast('请输入分类名', true);
    const type = document.getElementById('new-cat-type').value;
    const key = 'custom_' + Date.now();
    const map = this.getCatMap();
    map[key] = { name, type };
    this.saveCatMap(map);
    toast('已新增 ' + name);
    this.openCatManager(); this.load();
  },
  renameCat(key) {
    const map = this.getCatMap();
    const newName = prompt('新分类名：', map[key].name);
    if (!newName || !newName.trim()) return;
    map[key].name = newName.trim();
    this.saveCatMap(map);
    toast('已改名');
    this.openCatManager(); this.load();
  },
  delCat(key) {
    if (!confirm('删除该分类？账户会自动归入"其他"')) return;
    const map = this.getCatMap();
    delete map[key];
    this.saveCatMap(map);
    toast('已删除');
    this.openCatManager(); this.load();
  },
  async load() {
    const box = document.getElementById('pool-list');
    try { this.list = await api('/pools?book_id=' + CURRENT_BOOK); }
    catch (e) { box.innerHTML = '<div class="empty">服务未连接：请先 npm start</div>'; return; }
    if (!this.list.length) { box.innerHTML = '<div class="empty">暂无账户</div>'; return; }
    const today = new Date();
    const todayD = today.getDate();
    // 按分类分组（支持自定义分类）
    const catMap = PoolUI.getCatMap();
    const catOrder = Object.keys(catMap);
    const groups = {};
    for (const p of this.list) {
      const c = p.cat || (p.kind === 'liability' ? 'credit' : 'saving');
      if (!groups[c]) groups[c] = [];
      groups[c].push(p);
    }
    box.innerHTML = catOrder.filter(c => groups[c]).map(c => {
      const items = groups[c];
      const sum = items.reduce((s, p) => s + p.balance, 0);
      const isDebt = catMap[c].type === 'debt';
      return `<div style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;padding:0 4px">
          <span style="font-size:15px;font-weight:700;color:var(--ink)">${catMap[c].name}</span>
          <span style="font-size:17px;font-weight:800;color:${isDebt ? 'var(--down)' : 'var(--up)'}">${isDebt ? '负债' : '资产'} ¥${fmt(Math.abs(sum))}</span>
        </div>
        ${items.map(p => {
          let sub = '尾号 ' + p.tail;
          if (p.kind === 'liability' && p.due_day) {
            const overdue = todayD > p.due_day && p.balance > 0;
            sub = `还款日 ${p.due_day} 日 · ${overdue ? '本月已过还款日' : '待还'}`;
          }
          return `<div class="pool-item">
            <div style="min-width:0;flex:1;cursor:pointer" onclick="PoolUI.detail(${p.id})">
              <div class="pool-name">${p.name} <span class="hint">›</span></div>
              <div class="pool-tail ${p.kind === 'liability' && p.due_day && todayD > p.due_day && p.balance > 0 ? 'down' : ''}">${sub}</div>
            </div>
            <div class="pool-balance ${p.balance >= 0 ? 'up' : 'down'}" style="cursor:pointer" onclick="PoolUI.detail(${p.id})">¥${fmt(p.balance)}</div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
    this.loadOps();
  },
  manageMenu() {
    if (!this.list.length) { toast('暂无账户', true); return; }
    openModal(`
      <h4>账户管理</h4>
      <button class="btn ghost block" style="margin-bottom:10px" onclick="closeModal();PoolUI.openCatManager()">⚙ 分类管理（新建/改名/删除）</button>
      <div class="manage-menu">
        ${this.list.map(p => `
          <div class="mm-row">
            <div class="mm-main" onclick="closeModal();PoolUI.detail(${p.id})">
              <div class="mm-name">${p.name} <span class="hint">尾号${p.tail}</span></div>
              <div class="mm-bal ${p.balance >= 0 ? 'up' : 'down'}">¥${fmt(p.balance)}</div>
            </div>
            <div class="mm-ops">
              <button class="btn ghost xs" onclick="PoolUI.openEdit(${p.id})">编辑</button>
              <button class="btn ghost xs" onclick="PoolUI.openReconcile(${p.id})">对账</button>
              <button class="btn ghost xs danger-t" onclick="PoolUI.del(${p.id})">删除</button>
            </div>
          </div>`).join('')}
      </div>`);
  },
  async detail(id) {
    const p = this.list.find(x => x.id === id) || (await api('/pools')).find(x => x.id === id);
    if (!p) return toast('账户不存在', true);
    document.getElementById('pd-title').textContent = p.name;
    document.getElementById('pd-edit').setAttribute('onclick', `PoolUI.openEdit(${p.id})`);
    document.getElementById('pool-detail-view').style.display = 'block';
    ViewStack.open('pool-detail-view', () => { document.getElementById('pool-detail-view').style.display = 'none'; });
    const body = document.getElementById('pd-body');
    body.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const rows = await api('/records?pool_id=' + id + '&limit=500');
      let inc = 0, exp = 0;
      for (const r of rows) { if (r.direction === 'income') inc += r.amount; else exp += r.amount; }
      const byDay = {};
      for (const r of rows) {
        const d = (r.created_at || '').slice(0, 10) || '未知日期';
        (byDay[d] = byDay[d] || []).push(r);
      }
      const debtCard = p.kind === 'liability' ? `
        <div class="card" style="margin:8px 0">
          <div class="card-title">还款信息</div>
          <div style="font-size:12.5px;line-height:2">
            账单日 ${p.bill_day ? '每月 ' + p.bill_day + ' 日' : '未设'} · 还款日 ${p.due_day ? '每月 ' + p.due_day + ' 日' : '未设'}<br>
            年利率 ${p.apr ? p.apr + '%' : '未设'} · 授信额度 ${p.credit_limit ? '¥' + fmt(p.credit_limit) : '未设'}<br>
            预估年息 ${p.apr ? '<b class="down">¥' + fmt(Math.abs(p.balance) * p.apr / 100) + '</b>' : '—'}
          </div>
        </div>` : '';
      body.innerHTML = `
        <div class="pd-head">
          <div class="nm">${p.name} <span class="hint">尾号 ${p.tail || '—'}</span></div>
          <div class="bal ${p.balance >= 0 ? 'up' : 'down'}">¥${fmt(p.balance)}</div>
          <div class="hint">${p.kind === 'liability' ? '负债账户 · 余额为待还金额' : '资产账户 · 余额为可用资金'}</div>
        </div>
        ${debtCard}
        <div class="pd-stats">
          <div class="box"><div class="v up">+¥${fmt(inc)}</div><div>累计收入</div></div>
          <div class="box"><div class="v down">-¥${fmt(exp)}</div><div>累计支出</div></div>
          <div class="box"><div class="v">${rows.length}</div><div>流水笔数</div></div>
        </div>
        ${rows.length ? Object.entries(byDay).map(([d, list]) => `
          <div class="pd-day">
            <div class="dt">${d} · ${list.length} 笔</div>
            ${list.map(r => `
              <div class="pd-row" onclick="Ledger.detail(${r.id})">
                <div style="min-width:0">
                  <div class="lbl">${r.cat_path || '未分类'}</div>
                  <div class="cat">${r.remark || '无备注'}${r.source === 'fund' ? ' · 公积金' : r.source === 'transfer' ? ' · 转账' : r.source === 'salary' ? ' · 工资' : ''}</div>
                </div>
                <div class="amt ${r.direction === 'income' ? 'up' : 'down'}">${r.direction === 'income' ? '+' : '-'}¥${fmt(r.amount)}</div>
              </div>`).join('')}
          </div>`).join('')
        : '<div class="empty">该账户暂无流水，记账后自动归入</div>'}`;
    } catch (e) { body.innerHTML = '<div class="empty">加载失败</div>'; }
  },
  detailClose() { ViewStack.close(); },
  async loadOps() {
    const ops = await api('/pool-ops').catch(() => []);
    document.getElementById('pool-ops').innerHTML = ops.length ? ops.slice(0, 8).map(o => {
      const t = o.op_type === 'transfer'
        ? `转账 ${o.from_name}→${o.to_name} <span class="${o.amount >= 0 ? 'up' : 'down'}">¥${fmt(o.amount)}</span>`
        : `对账 ${o.from_name} 差额 <span class="${o.amount >= 0 ? 'up' : 'down'}">${o.amount >= 0 ? '+' : ''}¥${fmt(o.amount)}</span>`;
      return `<div class="mini-item"><span>${t}</span><span class="dim-s">${(o.created_at || '').slice(5, 16)}</span></div>`;
    }).join('') : '<div class="empty">暂无转账 / 对账记录</div>';
  },
  async openNew() {
    const books = await BookUI.list();
    const bookSel = `<div class="field"><label>所属账本</label>
      <select id="np-book">${books.map(b =>
        `<option value="${b.id}" ${b.id === CURRENT_BOOK ? 'selected' : ''}>${b.name}</option>`).join('')}</select></div>`;
    openModal(`
      <h4>新建账户</h4>
      ${bookSel}
      <div class="field"><label>名称（如：郑州银行）</label><input id="np-name" type="text" placeholder="银行/平台名"></div>
      <div class="field"><label>尾号</label><input id="np-tail" type="text" placeholder="如 8965"></div>
      <div class="field"><label>类型</label>
        <div class="seg"><button class="seg-btn active" data-v="asset" onclick="PoolUI.kind='asset';segSel(this);PoolUI.toggleDebt()">资产账户</button>
        <button class="seg-btn" data-v="liability" onclick="PoolUI.kind='liability';segSel(this);PoolUI.toggleDebt()">负债账户（信用卡）</button></div>
      </div>
      <div class="field"><label>账户分类</label>
        <select id="np-cat" class="sel">
          ${Object.entries(this.getCatMap()).map(([k, v]) => `<option value="${k}" ${k === 'credit' ? 'selected' : ''}>${v.name}</option>`).join('')}
        </select>
      </div>
      <div id="np-debt" style="display:none">
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>账单日（每月几号）</label><input id="np-bill" type="number" min="1" max="28" placeholder="如 5"></div>
          <div class="field" style="flex:1"><label>还款日（每月几号）</label><input id="np-due" type="number" min="1" max="28" placeholder="如 25"></div>
        </div>
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>年利率 %</label><input id="np-apr" type="number" step="0.01" placeholder="如 18.25"></div>
          <div class="field" style="flex:1"><label>授信额度 ¥</label><input id="np-limit" type="number" step="0.01" placeholder="如 30000"></div>
        </div>
        <div class="hint" style="margin-top:-4px;margin-bottom:8px">负债账户余额为待还金额；还款日用于逾期提醒</div>
      </div>
      <button class="btn block" onclick="PoolUI.create()">创建</button>`);
    PoolUI.kind = 'asset';
  },
  toggleDebt() {
    const d = document.getElementById('np-debt');
    if (d) d.style.display = PoolUI.kind === 'liability' ? '' : 'none';
  },
  async create() {
    const name = document.getElementById('np-name').value.trim();
    const tail = document.getElementById('np-tail').value.trim();
    if (!name || !tail) return toast('名称和尾号必填', true);
    const isL = PoolUI.kind === 'liability';
    const cat = document.getElementById('np-cat')?.value || (isL ? 'credit' : 'saving');
    const body = { name, tail, kind: PoolUI.kind, cat, book_id: Number(document.getElementById('np-book')?.value || CURRENT_BOOK) };
    if (isL) {
      body.bill_day = Number(document.getElementById('np-bill').value) || 0;
      body.due_day = Number(document.getElementById('np-due').value) || 0;
      body.apr = Number(document.getElementById('np-apr').value) || 0;
      body.credit_limit = Number(document.getElementById('np-limit').value) || 0;
    }
    try {
      await post('/pools', body);
      closeModal(); toast('已创建账户'); PoolUI.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  },
  openEdit(id) {
    const p = PoolUI.list.find(x => x.id === id);
    if (!p) return;
    const isL = p.kind === 'liability';
    BookUI.list().then(books => {
      const bookSel = `<div class="field"><label>所属账本</label>
        <select id="ep-book">${books.map(b =>
          `<option value="${b.id}" ${b.id === (p.book_id || 1) ? 'selected' : ''}>${b.name}</option>`).join('')}</select></div>`;
      openModal(`
        <h4>编辑账户</h4>
        ${bookSel}
        <div class="field"><label>名称</label><input id="ep-name" type="text" value="${p.name}"></div>
      <div class="field"><label>尾号</label><input id="ep-tail" type="text" value="${p.tail}"></div>
      ${isL ? `
      <div id="ep-debt">
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>账单日（每月几号）</label><input id="ep-bill" type="number" min="1" max="28" value="${p.bill_day || ''}"></div>
          <div class="field" style="flex:1"><label>还款日（每月几号）</label><input id="ep-due" type="number" min="1" max="28" value="${p.due_day || ''}"></div>
        </div>
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>年利率 %</label><input id="ep-apr" type="number" step="0.01" value="${p.apr || ''}"></div>
          <div class="field" style="flex:1"><label>授信额度 ¥</label><input id="ep-limit" type="number" step="0.01" value="${p.credit_limit || ''}"></div>
        </div>
      </div>` : ''}
      <button class="btn block" onclick="PoolUI.saveEdit(${id})">保存</button>`);
    });
  },
  async saveEdit(id) {
    const name = document.getElementById('ep-name').value.trim();
    const tail = document.getElementById('ep-tail').value.trim();
    if (!name || !tail) return toast('名称和尾号必填', true);
    const body = { name, tail, book_id: Number(document.getElementById('ep-book')?.value || 1) };
    const p = PoolUI.list.find(x => x.id === id);
    if (p && p.kind === 'liability') {
      body.bill_day = Number(document.getElementById('ep-bill').value) || 0;
      body.due_day = Number(document.getElementById('ep-due').value) || 0;
      body.apr = Number(document.getElementById('ep-apr').value) || 0;
      body.credit_limit = Number(document.getElementById('ep-limit').value) || 0;
    }
    try { await put('/pools/' + id, body); closeModal(); toast('已保存'); PoolUI.load(); Overview.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该账户？'))) return;
    try { await del('/pools/' + id); toast('已删除'); PoolUI.load(); }
    catch (e) { toast(e.message, true); }
  },
  openReconcile(id) {
    const p = PoolUI.list.find(x => x.id === id);
    if (!p) return;
    openModal(`
      <h4>对账冲正 · ${p.name} 余额调整</h4>
      <div class="field"><label>当前账面余额</label><div class="stat-num ${p.balance >= 0 ? 'up' : 'down'}">¥${fmt(p.balance)}</div></div>
      <div class="field"><label>实际余额</label><input id="rc-actual" type="number" step="0.01" placeholder="${p.balance}"></div>
      <div class="diff-preview" id="rc-diff">输入实际余额后预览差额</div>
      <button class="btn block" onclick="PoolUI.confirmReconcile(${id})">确认冲正</button>`);
    document.getElementById('rc-actual').addEventListener('input', e => {
      const act = parseFloat(e.target.value);
      const diff = isNaN(act) ? null : Math.round((act - p.balance) * 100) / 100;
      const el = document.getElementById('rc-diff');
      if (diff === null) el.textContent = '输入实际余额后预览差额';
      else el.innerHTML = `差额 <span class="${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}¥${fmt(diff)}</span> · 冲正后余额 ¥${fmt(act)}`;
    });
  },
  async confirmReconcile(id) {
    const act = parseFloat(document.getElementById('rc-actual').value);
    if (isNaN(act)) return toast('请输入实际余额', true);
    try {
      const r = await post(`/pools/${id}/reconcile`, { actual_balance: act });
      closeModal(); toast(`已冲正 ${r.op.amount >= 0 ? '+' : ''}¥${fmt(r.op.amount)}`); PoolUI.load();
    } catch (e) { toast(e.message, true); }
  }
};

// ── 资金转账 ────────────────────────────────────────────
const TransferUI = {
  cur: { from: null, to: null },
  allPools: [],
  async open() {
    // 跨账本转账：加载全部账户（不限当前账本）
    this.allPools = await api('/pools');
    const assets = this.allPools.filter(p => p.kind === 'asset');
    if (assets.length < 2) return toast('至少需要两个资产账户', true);
    this.cur.from = assets[0];
    this.cur.to = assets.find(p => p.id !== assets[0].id) || assets[0];
    this.render();
  },
  render() {
    const { from, to } = this.cur;
    const assets = this.allPools.filter(p => p.kind === 'asset');
    const fmtP = p => `${p.name}·${p.tail}${p.book_id ? '' : ''} ${fmt(p.balance)}`;
    openModal(`
      <h4>资金转账（支持跨账本）</h4>
      <div class="tf-row">
        <div class="tf-card">
          <h5>转出账户（负债账户不可转出）</h5>
          <div class="chips" id="tf-from">
            ${assets.map(p => `<button class="chip ${p.id === from?.id ? 'active' : ''}"
              onclick="TransferUI.set('from',${p.id})">${fmtP(p)}</button>`).join('')}
          </div>
        </div>
        <div class="tf-card">
          <h5>转入账户（自动排除转出）</h5>
          <div class="chips" id="tf-to">
            ${this.allPools.filter(p => p.id !== from?.id).map(p =>
              `<button class="chip ${p.id === to?.id ? 'active' : ''}"
                onclick="TransferUI.set('to',${p.id})">${fmtP(p)}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="field" style="margin-top:12px"><label>转账金额</label>
        <input id="tf-amount" type="number" step="0.01" placeholder="0.00" min="0"></div>
      <div class="balance-note" id="tf-note">转出：${from?.name} 可用余额 ¥${fmt(from?.balance)}</div>
      <button class="btn block" onclick="TransferUI.confirm()">确认转账</button>`);
  },
  set(side, id) {
    if (side === 'from') {
      this.cur.from = this.allPools.find(p => p.id === id);
      if (this.cur.to?.id === id)
        this.cur.to = this.allPools.find(p => p.id !== id && p.kind === 'asset') || null;
      this.render();
    } else {
      this.cur.to = this.allPools.find(p => p.id === id);
      this.render();
    }
  },
  async confirm() {
    const amount = parseFloat(document.getElementById('tf-amount').value);
    const { from, to } = this.cur;
    if (!from || !to) return toast('请选择转出与转入池', true);
    if (isNaN(amount) || amount <= 0) return toast('金额必须大于 0', true);
    try {
      const r = await post('/pools/transfer', { from_pool_id: from.id, to_pool_id: to.id, amount });
      closeModal(); toast(`已互转 ¥${fmt(amount)} ${r.from.name}→${r.to.name}`); PoolUI.load();
    } catch (e) { toast(e.message, true); }
  }
};

// ── 记账 ────────────────────────────────────────────────
const LedgerUI = {
  openMenu() {
    openModal(`
      <div style="min-width:80vw">
        <div class="card-title">记账管理</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          <button class="btn" onclick="closeModal();CatUI.open()">分类管理</button>
          <button class="btn" onclick="closeModal();TagUI.openManage()">标签管理</button>
          <button class="btn" onclick="closeModal();TplUI.openForm()">记账模板</button>
          <button class="btn ghost" onclick="closeModal()">关闭</button>
        </div>
      </div>
    `);
  }
};
const Ledger = {
  tree: [], direction: 'expense', sel: {}, poolId: null, inited: false,
  async init() {
    // 账本校正：本地无切换记录时，默认进服务端默认账本
    if (!localStorage.getItem('at_book')) {
      try {
        const books = await api('/books');
        const def = books.find(b => b.is_default);
        if (def) { CURRENT_BOOK = def.id; localStorage.setItem('at_book', String(def.id)); }
      } catch (e) {}
    }
    if (!this.inited) {
      try {
        this.tree = await api('/rec-categories');
        this.inited = true;
      } catch (e) { return; }
    }
    RecForm.remember();
    this.renderCats();
    this.fillCatFilter();
    this.reload();
    BudgetUI.load();
    RecurUI.load();
    BookUI.renderSwitch();
    TplUI.load();
    TagUI.fillFilter();
  },
  // M7.0 流水查询：分类筛选下拉（一级=方向，二级挂方向下）
  fillCatFilter() {
    const sel = document.getElementById('rec-f-cat');
    if (!sel) return;
    const l2 = this.tree.filter(c => c.lvl === 2).sort((a, b) => a.sort - b.sort || a.id - b.id);
    sel.innerHTML = '<option value="">全部分类</option>' + l2.map(c =>
      `<option value="${c.id}">${c.direction === 'income' ? '收' : '支'}·${c.name}</option>`).join('');
  },
  // M7.0 组合筛选 + 关键词搜索
  async reload(delay) {
    if (delay) { clearTimeout(this._t); this._t = setTimeout(() => this.reload(), delay); return; }
    // 记账Tab默认只显示当月流水
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const label = document.getElementById('rec-month-label');
    if (label) label.textContent = ym + ' 月';
    const p = new URLSearchParams();
    p.set('book_id', CURRENT_BOOK);
    p.set('from', ym + '-01');
    p.set('to', ym + '-' + String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0'));
    try {
      let rows = await api('/records?' + p.toString());
      this.renderRecords(rows);
    } catch (e) { document.getElementById('rec-list').innerHTML = '<div class="empty">加载失败</div>'; }
  },
  renderRecords(rows) {
    const pools = PoolUI.list;
    const pname = id => (pools.find(p => p.id === id) || {}).name || '—';
    document.getElementById('rec-list').innerHTML = rows.length ? rows.map(r => `
      <div class="mini-item ${r.is_star ? 'starred' : ''}">
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600">${r.cat_path}
            ${(r.tags || []).map(t => `<span class="tag-chip" style="background:${t.color || '#2f7d5d'}">${t.name}</span>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--dim)">${(r.created_at || '').slice(0, 16)} · ${pname(r.pool_id)}${r.remark ? ' · ' + r.remark : ''}</div>
        </div>
        <button class="rec-star ${r.is_star ? 'on' : ''}" onclick="Ledger.star(${r.id}, this)">${r.is_star ? '★' : '☆'}</button>
        <button class="btn xs ghost" onclick="Ledger.detail(${r.id})">详</button>
        <span class="${r.direction === 'income' ? 'amt-in' : 'amt-out'}">${r.direction === 'income' ? '+' : '−'}${fmt(r.amount)}</span>
        <button class="btn xs ghost" onclick="Ledger.undo(${r.id})">撤销</button>
      </div>`).join('') : '<div class="empty">无匹配流水</div>';
  },
  _starOnly: false,
  async star(id, el) {
    try {
      const r = await post('/records/' + id + '/star', {});
      if (el) { el.textContent = r.is_star ? '★' : '☆'; el.classList.toggle('on', !!r.is_star); }
    } catch (e) { toast(e.message, true); }
  },
  toggleStarFilter() {
    this._starOnly = !this._starOnly;
    const b = document.getElementById('rec-star-btn');
    if (b) b.textContent = this._starOnly ? '★ 星标' : '☆ 星标';
    this.reload();
  },
  async detail(id) {
    const r = (await api('/records?limit=1')).find(x => x.id === id) || { id, cat_path: '—' };
    const atts = await api('/records/' + id + '/attachments').catch(() => []);
    const tags = await api('/records/' + id + '/tags').catch(() => []);
    openModal(`
      <h4>流水详情 #${id}</h4>
      <div class="mini-item"><div style="flex:1"><b>${r.cat_path}</b><br><span class="dim-s">${(r.created_at || '').slice(0, 16)}${r.remark ? ' · ' + r.remark : ''}</span></div>
        <span class="${r.direction === 'income' ? 'up' : 'down'}">${r.direction === 'income' ? '+' : '−'}${fmt(r.amount)}</span></div>
      <div class="field" style="margin-top:10px">
        <label>标签</label>
        <div class="chips" id="dt-tags">${TagUI.allTags.map(t => `<span class="chip ${tags.some(x => x.id === t.id) ? 'active' : ''}" onclick="this.classList.toggle('active')" data-tid="${t.id}">${t.name}</span>`).join('') || '<span class="dim-s">暂无标签</span>'}</div>
      </div>
      <button class="btn block" onclick="Ledger.saveDetailTags(${id})">保存标签</button>
      ${atts.length ? `<div class="field"><label>凭证</label><div style="display:flex;gap:8px;flex-wrap:wrap">${atts.map(a => `<img src="${APP_MODE === 'offline' ? 'data:image/png;base64,' : '/api/attachments/' + a.id + '/file'}" class="att-thumb" onclick="Ledger.lightbox(this.src)">`).join('')}</div></div>` : '<div class="hint" style="margin-top:8px">无凭证图</div>'}
    `);
  },
  async saveDetailTags(id) {
    const ids = [...document.querySelectorAll('#dt-tags .chip.active')].map(c => Number(c.dataset.tid));
    try { await post('/records/' + id + '/tags', { tag_ids: ids }); closeModal(); toast('标签已保存'); this.reload(); }
    catch (e) { toast(e.message, true); }
  },
  lightbox(src) {
    const div = document.createElement('div');
    div.className = 'att-lightbox';
    div.innerHTML = '<img src="' + src + '" onclick="this.parentElement.remove()">';
    document.body.appendChild(div);
  },
  async undo(id) {
    if (!(await appConfirm('确认撤销这笔流水？\n对应账户余额将自动回滚。'))) return;
    try {
      await del('/records/' + id);
      toast('已撤销并回滚余额');
      await Promise.all([this.reload(), PoolUI.load(), Overview.load()]);
    } catch (e) { toast(e.message, true); }
  },
  clearFilter() {
    document.getElementById('rec-q').value = '';
    document.getElementById('rec-f-dir').value = '';
    document.getElementById('rec-f-cat').value = '';
    document.getElementById('rec-f-from').value = '';
    document.getElementById('rec-f-to').value = '';
    this.reload();
  },
  setDir(d) {
    this.direction = d;
    this.sel = {};
    document.querySelectorAll('#rec-dir .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.dir === d));
    this.renderCats();
  },
  // 取某方向的 lvl2，及选中路径下的子级
  children(parentId, lvl, dir) {
    return this.tree.filter(c => c.lvl === lvl && c.direction === dir && c.parent_id === parentId)
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
  },
  renderCats() {
    const dir = this.direction;
    // 一级=方向（支出/收入），二级直接挂在方向下（parent_id 为一级行 id）
    const l2 = this.tree.filter(c => c.lvl === 2 && c.direction === dir)
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
    const s2 = l2.find(c => c.id === this.sel.l2) || l2[0];
    const l3 = s2 ? this.children(s2.id, 3, dir) : [];
    const s3 = l3.find(c => c.id === this.sel.l3) || l3[0];
    const l4 = s3 ? this.children(s3.id, 4, dir) : [];
    const s4 = l4.find(c => c.id === this.sel.l4) || l4[0];
    const mkChips = (list, sel, fn) => list.map(c =>
      `<button class="chip ${c.id === sel ? 'active' : ''}" onclick="Ledger.${fn}(${c.id})">${c.name}</button>`).join('');
    document.getElementById('rec-cat2').innerHTML = mkChips(l2, s2?.id, 'pick2');
    document.getElementById('rec-cat3').innerHTML = mkChips(l3, s3?.id, 'pick3');
    document.getElementById('rec-cat4').innerHTML = l4.length ? mkChips(l4, s4?.id, 'pick4') : '';
    this.sel = { l2: s2?.id, l3: s3?.id, l4: s4?.id };
    this.renderPools();
  },
  pick2(id) { this.sel.l2 = id; this.sel.l3 = this.sel.l4 = undefined; this.renderCats(); },
  pick3(id) { this.sel.l3 = id; this.sel.l4 = undefined; this.renderCats(); },
  pick4(id) { this.sel.l4 = id; this.renderCats(); },
  renderPools() {
    if (!PoolUI.list.length) PoolUI.load().then(() => this.renderPools());
    if (!this.poolId || !PoolUI.list.find(p => p.id === this.poolId))
      this.poolId = PoolUI.list.find(p => p.kind === 'asset')?.id;
    document.getElementById('rec-pool').innerHTML = PoolUI.list.filter(p => p.kind === 'asset').map(p =>
      `<button class="chip ${p.id === this.poolId ? 'active' : ''}" onclick="Ledger.pickPool(${p.id})">${p.name}·${p.tail}</button>`).join('');
  },
  pickPool(id) { this.poolId = id; this.renderPools(); },
  async save() {
    const amount = parseFloat(document.getElementById('rec-amount').value);
    if (isNaN(amount) || amount <= 0) return toast('请输入金额', true);
    if (!this.poolId) return toast('请选择入账账户', true);
    const dir = this.direction;
    const c2 = this.tree.find(c => c.id === this.sel.l2);
    const c3 = this.tree.find(c => c.id === this.sel.l3);
    const c4 = this.tree.find(c => c.id === this.sel.l4);
    const leaf = c4 || c3;
    if (!c2 || !leaf) return toast('分类数据缺失，请刷新', true);
    const cat_path = [dir === 'expense' ? '支出' : '收入', c2.name, c3?.name, c4?.name].filter(Boolean).join('/');
    try {
      const r = await post('/records', {
        direction: dir, amount, cat_path, cat_leaf_id: leaf.id,
        pool_id: this.poolId, remark: document.getElementById('rec-remark').value.trim() || null, book_id: CURRENT_BOOK
      });
      const rid = r.id || r.record?.id;
      // 标签
      if (RecForm.selTagIds.size && rid) {
        await post('/records/' + rid + '/tags', { tag_ids: [...RecForm.selTagIds] }).catch(() => {});
      }
      // 凭证图（压缩后上传）
      if (RecForm.attachDataURL && rid) {
        await post('/records/' + rid + '/attachments', { raw: RecForm.attachDataURL }).catch(() => {});
      }
      // 记忆上次选择
      try {
        localStorage.setItem('at_last_form', JSON.stringify({ dir: this.direction, poolId: this.poolId, l2: this.sel.l2 }));
      } catch (_) {}
      RecForm.selTagIds.clear(); RecForm.attachDataURL = null;
      const an = document.getElementById('rec-attach-name'); if (an) an.textContent = '';
      document.getElementById('rec-amount').value = '';
      document.getElementById('rec-remark').value = '';
      RecForm.renderTagChips();
      toast(`已记账 ${cat_path} ¥${fmt(amount)}`);
      PoolUI.load(); Overview.load(); this.reload();
      BudgetUI.load(); RecurUI.load();
      AuthUI.scheduleAutoSync();
    } catch (e) { toast(e.message, true); }
  }
};

// ── 全局搜索（跨账本搜流水）────────────────────────────
const GlobalSearch = {
  _t: null,
  onInput(v) {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.search(v.trim()), 300);
  },
  async search(q) {
    const box = document.getElementById('g-results');
    if (!q || q.length < 1) { box.style.display = 'none'; box.innerHTML = ''; return; }
    try {
      const rows = await api('/records?q=' + encodeURIComponent(q) + '&limit=50');
      box.style.display = '';
      box.innerHTML = rows.length ? rows.map(r => `
        <div class="mini-item" style="padding:8px 0;border-bottom:1px solid var(--line)">
          <span style="font-size:13px">${(r.created_at || '').slice(0, 10)}</span>
          <span style="font-size:13px;margin-left:6px">${r.cat_path}</span>
          ${r.remark ? `<span style="color:var(--dim);font-size:12px"> · ${r.remark}</span>` : ''}
          <span style="float:right" class="${r.direction === 'income' ? 'up' : 'down'}">${r.direction === 'income' ? '+' : '-'}¥${fmt(r.amount)}</span>
        </div>`).join('') : '<div class="empty" style="padding:12px">无匹配结果</div>';
    } catch (e) { box.style.display = ''; box.innerHTML = '<div class="empty">搜索失败</div>'; }
  }
};

// ── 预算（M7.1）───────────────────────────────────────────
const BudgetUI = {
  month: () => new Date().toISOString().slice(0, 7),
  async load() {
    const m = this.month();
    const mm = document.getElementById('bdg-month');
    if (mm) mm.textContent = m;
    try {
      const d = await api('/budget/status?month=' + m);
      const total = d.effBudget, spent = d.exp;
      const dailyTxt = total > 0
        ? `日均 <b>¥${fmt(d.dailyBudget)}</b> · 今日应花 ¥${fmt(d.expected)} · 剩余日均 <b>¥${fmt(d.dailyRemain)}</b>` + (d.carryOver > 0 ? ` · 结转 +¥${fmt(d.carryOver)}` : '')
        : '';
      document.getElementById('bdg-total').innerHTML = total > 0
        ? `总预算 <b>¥${fmt(total)}</b> · 已支出 <b class="${spent > total ? 'down' : 'up'}">¥${fmt(spent)}</b> · 剩余 <b>¥${fmt(total - spent)}</b>`
        : '本月未设总预算，点「设置」开启';
      const daily = document.getElementById('bdg-daily');
      if (daily) daily.innerHTML = dailyTxt;
      const bar = document.getElementById('bdg-bar');
      if (total > 0) {
        const pct = Math.min(100, spent / total * 100);
        bar.style.width = pct + '%';
        bar.style.background = spent > total ? '#d33a3a' : (pct > 80 ? '#e8a13a' : '#2d6a4f');
        document.getElementById('bdg-progress').style.display = '';
        const pctEl = document.getElementById('bdg-pct');
        if (pctEl) pctEl.textContent = pct.toFixed(0) + '%';
      } else {
        document.getElementById('bdg-progress').style.display = 'none';
      }
      const cats = document.getElementById('bdg-cats');
      if (cats) cats.innerHTML = (d.catRows || []).map(i => {
        const over = i.spent > i.amount;
        return `<span class="bdg-chip ${over ? 'over' : ''}">${i.category_name} ${fmt(i.spent)}/${fmt(i.amount)}${over ? ' 超' : ''}</span>`;
      }).join('') || '<span class="hint">未设分类预算</span>';
      const warn = document.getElementById('bdg-warn');
      if (warn) warn.textContent = total > 0 && spent > total ? `本月已超预算 ¥${fmt(spent - total)}` : (d.level === 'warn' ? '已用 80%+，注意控制' : '');
      // 年度预算
      const y = new Date().getFullYear();
      const yb = parseFloat(localStorage.getItem('at_year_budget_' + y) || '0');
      const yRow = document.getElementById('bdg-year-row');
      if (yRow) {
        if (yb > 0) {
          yRow.style.display = '';
          // 查今年累计支出
          const from = y + '-01-01';
          const to = y + '-12-31';
          const yr = await api('/records?direction=expense&from=' + from + '&to=' + to + '&book_id=' + CURRENT_BOOK).catch(() => []);
          const ySpent = yr.reduce((s, r) => s + r.amount, 0);
          document.getElementById('bdg-year-label').textContent = y + ' 年度预算';
          document.getElementById('bdg-year-total').innerHTML = `总预算 <b>¥${fmt(yb)}</b> · 已支出 <b class="${ySpent > yb ? 'down' : 'up'}">¥${fmt(ySpent)}</b> · 剩余 <b>¥${fmt(yb - ySpent)}</b>`;
          const yPct = Math.min(100, ySpent / yb * 100);
          document.getElementById('bdg-year-bar').style.width = yPct + '%';
          document.getElementById('bdg-year-bar').style.background = ySpent > yb ? '#d33a3a' : (yPct > 80 ? '#e8a13a' : '#2d6a4f');
          document.getElementById('bdg-year-pct').textContent = yPct.toFixed(0) + '%';
        } else {
          yRow.style.display = 'none';
        }
      }
    } catch (e) { document.getElementById('bdg-total').textContent = '加载失败'; }
  },
  async open() {
    const cats = Ledger.tree.filter(c => c.lvl === 2 && c.direction === 'expense').sort((a, b) => a.sort - b.sort || a.id - b.id);
    const m = this.month();
    const y = new Date().getFullYear();
    let total = '', carry = false;
    const catVals = {};
    const yearBudget = localStorage.getItem('at_year_budget_' + y) || '';
    try {
      const d = await api('/budgets?month=' + m);
      total = d.total_budget || '';
      const tot = (d.items || []).find(r => !r.category_id);
      carry = !!(tot && tot.carry_enabled);
      for (const r of d.items || []) if (r.category_id) catVals[r.category_id] = r.amount;
    } catch (e) {}
    openModal(`
      <h4>预算设置</h4>
      <div class="field"><label>月份</label><input id="bdg-m" type="month" value="${m}"></div>
      <div class="field"><label>${y} 年度总预算（元）</label><input id="bdg-year" type="number" step="0.01" placeholder="如 60000" value="${yearBudget}"></div>
      <div class="field"><label>月度总预算（元）</label><input id="bdg-t" type="number" step="0.01" placeholder="如 5000" value="${total}"></div>
      <div class="field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0">上月结余自动结转</label>
        <input id="bdg-carry" type="checkbox" style="width:18px;height:18px" ${carry ? 'checked' : ''}>
      </div>
      <div class="field"><label>分类预算（可选，支出二级分类）</label></div>
      <div id="bdg-cat-list">${cats.map(c => `
        <div class="cat-node"><span class="nm">${c.name}</span>
          <input id="bdg-cat-${c.id}" type="number" step="0.01" placeholder="0" value="${catVals[c.id] ?? ''}" style="width:110px;padding:6px 8px;border-radius:8px;border:1px solid var(--line)">
        </div>`).join('')}</div>
      <button class="btn block" onclick="BudgetUI.save()">保存预算</button>
      <button class="btn ghost block" style="margin-top:8px" onclick="BudgetUI.copyLastMonth()">复制上月预算</button>`);
  },
  async copyLastMonth() {
    const m = document.getElementById('bdg-m').value;
    const [y, mo] = m.split('-').map(Number);
    const lastMo = mo === 1 ? 12 : mo - 1;
    const lastY = mo === 1 ? y - 1 : y;
    const lastMonth = lastY + '-' + String(lastMo).padStart(2, '0');
    try {
      const list = await api('/budgets?month=' + lastMonth);
      if (!list || !list.length) return toast(lastMonth + ' 无预算可复制', true);
      for (const b of list) {
        await post('/budgets', { year_month: m, category_id: b.category_id, category_name: b.category_name, amount: b.amount, carry_enabled: b.carry_enabled });
      }
      toast('已复制 ' + lastMonth + ' 预算');
      this.settings();
    } catch (e) { toast(e.message, true); }
  },
  async save() {
    const m = document.getElementById('bdg-m').value;
    const y = new Date().getFullYear();
    const yb = parseFloat(document.getElementById('bdg-year').value);
    if (!isNaN(yb) && yb >= 0) localStorage.setItem('at_year_budget_' + y, yb);
    else localStorage.removeItem('at_year_budget_' + y);
    const t = parseFloat(document.getElementById('bdg-t').value);
    const cats = Ledger.tree.filter(c => c.lvl === 2 && c.direction === 'expense');
    const carryEl = document.getElementById('bdg-carry');
    const carry = carryEl && carryEl.checked ? 1 : 0;
    const tasks = [];
    if (!isNaN(t) && t >= 0) tasks.push(post('/budgets', { year_month: m, category_id: null, amount: t, carry_enabled: carry }));
    for (const c of cats) {
      const v = parseFloat(document.getElementById('bdg-cat-' + c.id).value);
      if (!isNaN(v) && v >= 0) tasks.push(post('/budgets', { year_month: m, category_id: c.id, category_name: c.name, amount: v }));
    }
    try {
      await Promise.all(tasks);
      closeModal(); toast('预算已保存'); this.load();
    } catch (e) { toast(e.message, true); }
  }
};

// ── 周期记账（M7.1）───────────────────────────────────────
const RecurUI = {
  async load() {
    try {
      const rows = await api('/recurring');
      const pools = PoolUI.list;
      const pname = id => (pools.find(p => p.id === id) || {}).name || '—';
      const dueN = rows.filter(r => r.due).length;
      document.getElementById('rec-list2').innerHTML = (dueN ? `<div class="due-banner" onclick="RecurUI.runAll()">${dueN} 笔待记（一键入账）›</div>` : '') +
        (rows.length ? rows.map(r => `
        <div class="mini-item ${r.due ? 'due' : ''}">
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:600">${r.name} ${r.due ? '<span class="tag-pill hot">待记</span>' : ''}</div>
            <div style="font-size:11px;color:var(--dim)">每月${r.day_of_month}日 · ${pname(r.pool_id)}${r.enabled ? '' : ' · 已停用'}</div>
          </div>
          <span class="${r.direction === 'income' ? 'amt-in' : 'amt-out'}">${r.direction === 'income' ? '+' : '−'}${fmt(r.amount)}</span>
          ${r.due ? `<button class="btn xs" onclick="RecurUI.run(${r.id})">记</button>` : ''}
          <button class="btn xs ghost" onclick="RecurUI.edit(${r.id})">改</button>
        </div>`).join('') : '<div class="empty">暂无周期模板，点右上角新建</div>');
    } catch (e) { document.getElementById('rec-list2').innerHTML = '<div class="empty">加载失败</div>'; }
  },
  openForm() {
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    const cats = Ledger.tree.filter(c => c.lvl === 2).sort((a, b) => a.sort - b.sort || a.id - b.id);
    openModal(`
      <h4>新建周期记账模板</h4>
      <div class="field"><label>名称（如 房租 / 水电 / 工资）</label><input id="rc-name" type="text" placeholder="房租"></div>
      <div class="field"><label>金额</label><input id="rc-amount" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>方向</label>
        <select id="rc-dir" class="sel"><option value="expense">支出</option><option value="income">收入</option></select></div>
      <div class="field"><label>分类</label><select id="rc-cat" class="sel">${cats.map(c => `<option value="${c.id}">${c.direction === 'income' ? '收·' : '支·'}${c.name}</option>`).join('')}</select></div>
      <div class="field"><label>入账账户</label>
        <select id="rc-pool" class="sel">${pools.map(p => `<option value="${p.id}">${p.name}·${p.tail}</option>`).join('')}</select></div>
      <div class="field"><label>每月触发日（1-28）</label><input id="rc-day" type="number" min="1" max="28" value="1"></div>
      <button class="btn block" onclick="RecurUI.saveNew()">保存模板</button>`);
  },
  async saveNew() {
    const name = document.getElementById('rc-name').value.trim();
    const amount = parseFloat(document.getElementById('rc-amount').value);
    const dir = document.getElementById('rc-dir').value;
    const c = Ledger.tree.find(x => x.id === Number(document.getElementById('rc-cat').value));
    const pool_id = Number(document.getElementById('rc-pool').value);
    const day = Number(document.getElementById('rc-day').value) || 1;
    if (!name || isNaN(amount) || amount <= 0 || !c) return toast('请填写名称/金额/分类', true);
    const body = { name, amount, direction: dir, cat_path: [dir === 'expense' ? '支出' : '收入', c.name].join('/'), cat_leaf_id: c.id, pool_id, day_of_month: day };
    try {
      await post('/recurring', body);
      closeModal(); toast('模板已保存'); this.load();
    } catch (e) { toast(e.message, true); }
  },
  async edit(id) {
    const rows = await api('/recurring');
    const t = rows.find(r => r.id === id);
    if (!t) return;
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    const cats = Ledger.tree.filter(c => c.lvl === 2).sort((a, b) => a.sort - b.sort || a.id - b.id);
    openModal(`
      <h4>编辑模板</h4>
      <div class="field"><label>名称</label><input id="rc-name" type="text" value="${t.name}"></div>
      <div class="field"><label>金额</label><input id="rc-amount" type="number" step="0.01" value="${t.amount}"></div>
      <div class="field"><label>方向</label>
        <select id="rc-dir" class="sel"><option value="expense" ${t.direction === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${t.direction === 'income' ? 'selected' : ''}>收入</option></select></div>
      <div class="field"><label>分类</label><select id="rc-cat" class="sel">${cats.map(c => `<option value="${c.id}" ${c.id === t.cat_leaf_id ? 'selected' : ''}>${c.direction === 'income' ? '收·' : '支·'}${c.name}</option>`).join('')}</select></div>
      <div class="field"><label>入账账户</label>
        <select id="rc-pool" class="sel">${pools.map(p => `<option value="${p.id}" ${p.id === t.pool_id ? 'selected' : ''}>${p.name}·${p.tail}</option>`).join('')}</select></div>
      <div class="field"><label>每月触发日（1-28）</label><input id="rc-day" type="number" min="1" max="28" value="${t.day_of_month}"></div>
      <div class="op-row" style="margin-bottom:8px">
        <button class="btn ghost" onclick="RecurUI.toggle(${t.id})">${t.enabled ? '停用' : '启用'}</button>
        <button class="btn danger ghost" onclick="RecurUI.del(${t.id})">删除模板</button>
      </div>
      <button class="btn block" onclick="RecurUI.saveEdit(${t.id})">保存修改</button>`);
  },
  async saveEdit(id) {
    const name = document.getElementById('rc-name').value.trim();
    const amount = parseFloat(document.getElementById('rc-amount').value);
    const dir = document.getElementById('rc-dir').value;
    const c = Ledger.tree.find(x => x.id === Number(document.getElementById('rc-cat').value));
    const pool_id = Number(document.getElementById('rc-pool').value);
    const day = Number(document.getElementById('rc-day').value) || 1;
    if (!name || isNaN(amount) || amount <= 0 || !c) return toast('请填写名称/金额/分类', true);
    const body = { name, amount, direction: dir, cat_path: [dir === 'expense' ? '支出' : '收入', c.name].join('/'), cat_leaf_id: c.id, pool_id, day_of_month: day };
    try { await put('/recurring/' + id, body); closeModal(); toast('已保存'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async toggle(id) {
    const rows = await api('/recurring');
    const t = rows.find(r => r.id === id);
    try { await put('/recurring/' + id, { enabled: t.enabled ? 0 : 1 }); closeModal(); toast('已切换'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该周期模板？'))) return;
    try { await del('/recurring/' + id); closeModal(); toast('已删除'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async run(id) {
    if (!(await appConfirm('确认将本模板记入本月？'))) return;
    try { await post('/recurring/' + id + '/run', {}); toast('已入账'); this.load(); Ledger.reload(); PoolUI.load(); Overview.load(); }
    catch (e) { toast(e.message, true); }
  },
  async runAll() {
    if (!(await appConfirm('确认将本月全部待记模板一键入账？'))) return;
    try {
      const r = await post('/recurring/run-all', {});
      toast(`已入账 ${r.executed} 笔`); this.load(); Ledger.reload(); PoolUI.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  }
};

// ── 分类管理 ────────────────────────────────────────────
const CatUI = {
  open() {
    openModal(`
      <h4>分类管理</h4>
      <div class="op-row" style="margin-bottom:10px">
        <button class="btn ghost" onclick="CatUI.addForm()">＋ 新增自定义分类</button>
        <span class="hint">↑↓ 排序 · ✎ 改名 · ✕ 删除（有流水禁止删）</span>
      </div>
      <div class="cat-tree" id="cat-tree"></div>`);
    this.render();
  },
  render() {
    const dirs = [['expense', '支出'], ['income', '收入']];
    let html = '';
    for (const [dir, dname] of dirs) {
      const nodes = Ledger.tree.filter(c => c.direction === dir).sort((a, b) => a.lvl - b.lvl || a.sort - b.sort || a.id - b.id);
      html += `<div style="font-weight:800;font-size:13px;margin:10px 0 4px">${dname}</div>`;
      nodes.forEach(c => {
        const pad = (c.lvl - 2) * 16;
        html += `<div class="cat-node" style="padding-left:${pad}px">
          <span class="lv">L${c.lvl}${c.is_custom ? '·自' : ''}</span>
          <span class="nm">${c.name}</span>
          <span class="ops">
            <button onclick="CatUI.move(${c.id},'up')" title="上移">↑</button>
            <button onclick="CatUI.move(${c.id},'down')" title="下移">↓</button>
            <button onclick="CatUI.rename(${c.id})" title="改名">✎</button>
            <button onclick="CatUI.remove(${c.id})" title="删除">✕</button>
          </span>
        </div>`;
      });
    }
    document.getElementById('cat-tree').innerHTML = html;
  },
  addForm() {
    const dirs = [['expense', '支出'], ['income', '收入']];
    const cats = Ledger.tree;
    const opt = (id, name) => `<option value="${id}">${name}</option>`;
    openModal(`
      <h4>新增自定义分类</h4>
      <div class="field"><label>方向</label>
        <select id="ca-dir">${dirs.map(([d, n]) => `<option value="${d}">${n}</option>`).join('')}</select></div>
      <div class="field"><label>级别</label>
        <select id="ca-lvl"><option value="2">二级（类别）</option><option value="3">三级</option><option value="4">四级</option></select></div>
      <div class="field"><label>父级（二级无需选）</label>
        <select id="ca-parent">${cats.filter(c => c.lvl === 2).map(c => opt(c.id, '支出/收入 · ' + c.name)).join('')}</select></div>
      <div class="field"><label>名称</label><input id="ca-name" type="text" placeholder="分类名称"></div>
      <button class="btn block" onclick="CatUI.add()">保存</button>`);
  },
  async add() {
    const lvl = Number(document.getElementById('ca-lvl').value);
    const name = document.getElementById('ca-name').value.trim();
    const direction = document.getElementById('ca-dir').value;
    if (!name) return toast('请输入名称', true);
    const parent_id = lvl > 2 ? Number(document.getElementById('ca-parent').value) : null;
    try {
      await post('/rec-categories', { lvl, name, parent_id, direction });
      Ledger.tree = await api('/rec-categories');
      toast('已新增分类'); this.open();
    } catch (e) { toast(e.message, true); }
  },
  async rename(id) {
    const c = Ledger.tree.find(x => x.id === id);
    const name = prompt('新名称：', c?.name);
    if (!name || name === c?.name) return;
    try { await put('/rec-categories/' + id, { name }); Ledger.tree = await api('/rec-categories'); this.render(); }
    catch (e) { toast(e.message, true); }
  },
  async move(id, dir) {
    try {
      const r = await post(`/rec-categories/${id}/move`, { dir });
      if (r.ok === false) return toast(r.error || '已在边界', true);
      Ledger.tree = await api('/rec-categories'); this.render(); toast('已排序');
    } catch (e) { toast(e.message, true); }
  },
  async remove(id) {
    if (!(await appConfirm('确认删除该分类？'))) return;
    try { await del('/rec-categories/' + id); Ledger.tree = await api('/rec-categories'); this.render(); toast('已删除'); }
    catch (e) { toast(e.message, true); }
  }
};

// ── 工资（M2）───────────────────────────────────────────
const SalaryUI = {
  cfg: null,              // 当前月份生效配置（含折算）
  inited: false,
  async load() {
    if (!this.inited) {
      document.getElementById('sal-month').addEventListener('change', () => this.refreshCfg());
      document.getElementById('sal-net').addEventListener('input', () => this.judge());
      this.inited = true;
    }
    await Promise.all([this.refreshCfg(), this.loadStats(), this.loadList()]);
    this.loadTax();
  },
  async loadTax() {
    const month = document.getElementById('sal-month').value || '2026-09';
    const box = document.getElementById('sal-tax-card');
    if (!box) return;
    try {
      const o = await api('/salary/tax?month=' + month);
      const cur = o.current;
      if (!cur) { box.innerHTML = '<div class="empty">本月暂无工资记录，保存后自动计算个税参考</div>'; return; }
      const eff = (1 - o.series[0]?.personalIns / (o.series[0]?.gross || 1)) * 100;
      box.innerHTML = `
        <div class="tax-row"><span>当月应发</span><b>¥${fmt(cur.gross)}</b></div>
        <div class="tax-row"><span>累计应纳税所得额</span><span>¥${fmt(cur.cumTaxable)}</span></div>
        <div class="tax-row"><span>累计已预扣</span><span>¥${fmt(cur.cumPaid - cur.tax)}</span></div>
        <div class="tax-row"><span>本月个税（累计预扣参考）</span><b class="${cur.tax > 0 ? 'down' : ''}">¥${fmt(cur.tax)}</b></div>
        <div class="hint" style="margin-top:4px">实发为手动输入，个税仅供参考；如需计入扣款，请在备注中填写（如 -个税 ¥${fmt(cur.tax)}）</div>`;
    } catch (e) { box.innerHTML = '<div class="empty">个税计算加载失败</div>'; }
  },
  async refreshCfg() {
    const month = document.getElementById('sal-month').value || '2026-09';
    try {
      this.cfg = await api('/salary/config/current?month=' + month);
      const bd = this.cfg.breakdown;
      document.getElementById('sal-cfg').innerHTML = `
        良好基准 <b>¥${fmt(this.cfg.good_base)}</b> · 社保基数 <b>${fmt(this.cfg.social_base)}</b><br>
        应发(自动折算) <b>¥${fmt(bd.gross)}</b> · 公积金合计 <b>¥${fmt(bd.fund_total)}</b>/月
        <span class="hint">（公积金个人/企业分边四舍五入）</span>`;
      const row = it => `
        <tr><td>${it.name}</td><td>${fmt(it.base)}</td>
        <td class="up">${fmt(it.cu)} <span class="hint">(${(it.cu_pct * 100).toFixed(2).replace(/\.?0+$/, '')}%)</span></td>
        <td>${fmt(it.cp)} <span class="hint">(${(it.cp_pct * 100).toFixed(2).replace(/\.?0+$/, '')}%)</span></td></tr>`;
      document.getElementById('sal-bd').innerHTML = `
        <table class="bd-table">
          <thead><tr><th>险种</th><th>基数</th><th>企业缴纳</th><th>个人缴纳</th></tr></thead>
          <tbody>
            ${bd.items.map(row).join('')}
            <tr class="bd-fund"><td>公积金</td><td>${fmt(this.cfg.social_base)}</td>
              <td class="up">${fmt(bd.fund_company)} <span class="hint">(${((this.cfg.fund_rate_u ?? this.cfg.fund_rate) * 100)}%)</span></td>
              <td>${fmt(bd.fund_personal)} <span class="hint">(${(this.cfg.fund_rate * 100)}%)</span></td></tr>
            <tr class="bd-total"><td>合计</td><td>—</td>
              <td class="up">${fmt(bd.company_social + bd.fund_company)}</td>
              <td>${fmt(bd.personal_social + bd.fund_personal)}</td></tr>
          </tbody>
        </table>
        <div class="bd-cost">企业综合成本 <b>¥${fmt(bd.company_cost)}</b>
          <span class="hint">= 应发 ${fmt(bd.gross)} + 企业五险 ${fmt(bd.company_social)} + 企业公积金 ${fmt(bd.fund_company)}</span></div>`;
      this.judge();
    } catch (e) {
      document.getElementById('sal-cfg').textContent = '该月份无生效配置，请先到设置中配置';
      document.getElementById('sal-bd').innerHTML = '';
    }
  },
  // 与后端一致的判定逻辑（预览用；保存以后端为准）
  judge() {
    const el = document.getElementById('sal-judge');
    const net = parseFloat(document.getElementById('sal-net').value);
    if (!this.cfg || isNaN(net)) { el.textContent = '输入实发后自动判定四标签'; return; }
    const illOn = this.illOn();
    const t = this.matchTags(illOn ? net + this.cfg.serious_ill : net, this.cfg);
    if (!t) {
      el.innerHTML = '<span style="color:var(--warn,#b3541e)">' + (illOn
        ? '金额+大病额未命中标准档位，请核对金额'
        : '未命中标准档位（基准 ¥' + fmt(this.cfg.good_base) + '±10），若本月含大病商业险扣款请点下方「标记大病商业险」') + '</span>';
      return;
    }
    if (illOn) t.ill = 1;
    el.innerHTML = this.tagPills(t);
  },
  matchTags(net, cfg) {
    // 四组合：良好/优秀/高温（大病商业险不按金额判定，由用户手动标记）
    const combos = [];
    for (const excellent of [false, true]) for (const hot of [false, true]) {
      const expected = cfg.good_base + (excellent ? cfg.bonus_excellent : 0) + (hot ? cfg.bonus_hot : 0);
      combos.push({ excellent, hot, expected, diff: Math.abs(net - expected) });
    }
    combos.sort((a, b) => a.diff - b.diff || a.expected - b.expected);
    const best = combos[0];
    if (best.diff > 10) return null;
    return { good: !best.excellent, excellent: best.excellent, hot: best.hot, ill: 0 };
  },
  illOn() {
    const b = document.getElementById('sal-ill');
    return b ? b.dataset.on === '1' : false;
  },
  toggleIll() {
    const b = document.getElementById('sal-ill');
    if (!b) return;
    const on = b.dataset.on !== '1';
    b.dataset.on = on ? '1' : '';
    b.textContent = on ? '已标记大病商业险' : '标记大病商业险';
    b.classList.toggle('on', on);
    this.judge();
  },
  tagPills(t) {
    const pills = [];
    if (t.good) pills.push('<span class="tag-pill good">良好</span>');
    if (t.excellent) pills.push('<span class="tag-pill excellent">优秀 +' + this.cfg.bonus_excellent + '</span>');
    if (t.hot) pills.push('<span class="tag-pill hot">高温 +' + this.cfg.bonus_hot + '</span>');
    if (t.ill) pills.push('<span class="tag-pill ill">大病保险 -' + this.cfg.serious_ill + '</span>');
    return pills.join('') || '<span style="color:var(--dim)">无标签</span>';
  },
  async save() {
    const month = document.getElementById('sal-month').value;
    const net = parseFloat(document.getElementById('sal-net').value);
    if (!month || isNaN(net) || net <= 0) return toast('请输入月份和实发金额', true);
    try {
      const r = await post('/salary/month', {
        month, net, remark: document.getElementById('sal-remark').value.trim() || null, ill: this.illOn() ? 1 : 0
      });
      toast(`${month} 已保存：${this.tagPills(r.tags)} 公积金 ¥${fmt(r.fund_total)} 同步记账` + (r.tax ? ` · 个税参考 ¥${fmt(r.tax)}` : ''));
      document.getElementById('sal-net').value = '';
      document.getElementById('sal-remark').value = '';
      const illBtn = document.getElementById('sal-ill');
      if (illBtn) { illBtn.dataset.on = ''; illBtn.textContent = '标记大病商业险'; illBtn.classList.remove('on'); }
      this.judge();
      await Promise.all([this.loadStats(), this.loadList(), this.loadTax(), PoolUI.load(), Overview.load()]);
    } catch (e) { toast(e.message, true); }
  },
  async loadStats() {
    const year = (document.getElementById('sal-month').value || '2026-09').slice(0, 4);
    try {
      const o = await api('/salary/overview?year=' + year);
      document.getElementById('sal-year-tag').textContent = year;
      document.getElementById('sal-stats').innerHTML = `
        <div class="tag-stat good"><div class="ts-num">${o.good}</div><div class="ts-label">良好</div></div>
        <div class="tag-stat excellent"><div class="ts-num">${o.excellent}</div><div class="ts-label">优秀</div></div>
        <div class="tag-stat hot"><div class="ts-num">${o.hot}</div><div class="ts-label">高温</div></div>
        <div class="tag-stat ill"><div class="ts-num">${o.ill}</div><div class="ts-label">大病保险</div></div>`;
    } catch (e) { /* 忽略 */ }
  },
  async loadList() {
    try {
      const rows = await api('/salary/months');
      document.getElementById('sal-list').innerHTML = rows.length ? rows.map(s => `
        <div class="sal-row">
          <div><span class="m">${s.month}</span>
            <span style="color:var(--dim);font-size:11px"> 应发¥${fmt(s.gross)} → 实发¥${fmt(s.net)}</span>
            ${s.tag_good ? '<span class="tag-pill good">良好</span>' : ''}
            ${s.tag_excellent ? '<span class="tag-pill excellent">优秀</span>' : ''}
            ${s.tag_hot ? '<span class="tag-pill hot">高温</span>' : ''}
            ${s.tag_ill ? '<span class="tag-pill ill">大病保险</span>' : ''}
          </div>
          <span class="hint" style="cursor:pointer" onclick="SalaryUI.delMonth('${s.month}')">删</span>
        </div>`).join('') : '<div class="empty">暂无工资记录</div>';
    } catch (e) { document.getElementById('sal-list').innerHTML = '<div class="empty">加载失败</div>'; }
  },
  async delMonth(month) {
    if (!(await appConfirm(`确认删除 ${month} 月工资记录？\n将回滚实发入账，并删除该月工资/公积金记账。`))) return;
    try {
      await del('/salary/month/' + month);
      toast('已删除'); await this.load(); await this.loadList(); await this.loadAdjLog();
      PoolUI.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  },
  async openSettings() {
    const pools = await api('/pools').catch(() => []);
    const assets = pools.filter(p => p.kind === 'asset');
    const curPool = (this.cfg && this.cfg.pool_id) || '';
    const poolSel = `<div class="field"><label>工资入账账户</label>
      <select id="sc-pool">${assets.length ? assets.map(x =>
        `<option value="${x.id}" ${x.id == curPool ? 'selected' : ''}>${x.name}·${x.tail}</option>`).join('') : '<option value="">（暂无资产账户）</option>'}</select>
      <div class="hint">工资实发自动入账到此账户</div></div>`;
    openModal(`
      <h4>工资设置</h4>
      ${poolSel}
      <div class="field"><label>生效月份（如 2027-01）</label><input id="sc-from" type="month" value="${new Date().toISOString().slice(0, 7)}"></div>
      <div class="op-row" style="margin-bottom:8px">
        <button class="btn ghost" onclick="SalaryUI.settingsForm('salary')">调薪（新基准）</button>
        <button class="btn ghost" onclick="SalaryUI.settingsForm('fund_base')">公积金基数调整</button>
        <button class="btn ghost" onclick="SalaryUI.settingsForm('rate')">比例调整</button>
      </div>
      <div id="sc-form"></div>
      <div class="card-title" style="margin-top:12px">调整留痕</div>
      <div id="sc-log" class="mini-list"></div>`);
    this.loadAdjLog();
  },
  settingsForm(type) {
    const c = this.cfg || {};
    if (type === 'rate') {
      // 分险种比例编辑：五险企业/个人 + 公积金企业/个人
      const pct = v => v === undefined ? 0 : (v * 100);
      const f = (id, label, val) => `
        <div class="field" style="margin:4px 0"><label style="font-size:11.5px">${label}（%）</label>
        <input id="${id}" type="number" step="0.01" value="${val}" style="padding:6px 10px"></div>`;
      openModal(`
        <h4>五险一金比例调整</h4>
        <div class="field"><label>生效月份</label><input id="sc-from" type="month" value="${(document.getElementById('sal-month').value || '2026-09')}"></div>
        <div class="grid2">
          ${f('r-pen-u', '养老·企业', pct(c.ins_pension_u))}${f('r-pen-p', '养老·个人', pct(c.ins_pension_p))}
          ${f('r-med-u', '医疗·企业', pct(c.ins_medical_u))}${f('r-med-p', '医疗·个人', pct(c.ins_medical_p))}
          ${f('r-un-u', '失业·企业', pct(c.ins_unemploy_u))}${f('r-un-p', '失业·个人', pct(c.ins_unemploy_p))}
          ${f('r-inj-u', '工伤·企业', pct(c.ins_injury_u))}${f('r-mat-u', '生育·企业', pct(c.ins_maternity_u))}
          ${f('r-fun-u', '公积金·企业', pct(c.fund_rate_u))}${f('r-fun-p', '公积金·个人', pct(c.fund_rate))}
        </div>
        <div class="field"><label>备注</label><input id="sc-note" type="text" placeholder="可选"></div>
        <button class="btn block" onclick="SalaryUI.applyConfig('rate')">保存并留痕</button>`);
      return;
    }
    const label = { salary: '新良好基准', fund_base: '新社保基数' }[type];
    const ph = type === 'salary' ? c.good_base : c.social_base;
    openModal(`
      <h4>${label}</h4>
      <div class="field"><label>生效月份</label><input id="sc-from" type="month" value="${(document.getElementById('sal-month').value || '2026-09')}"></div>
      <div class="field"><label>${label}</label><input id="sc-val" type="number" step="0.01" placeholder="${ph}"></div>
      <div class="field"><label>备注</label><input id="sc-note" type="text" placeholder="可选"></div>
      <button class="btn block" onclick="SalaryUI.applyConfig('${type}')">保存并留痕</button>`);
  },
  async applyConfig(type) {
    const valid_from = document.getElementById('sc-from').value;
    if (!valid_from) return toast('请填写生效月份', true);
    const body = { valid_from, adj_type: type, note: document.getElementById('sc-note').value.trim() || null,
      pool_id: document.getElementById('sc-pool') ? Number(document.getElementById('sc-pool').value) : undefined };
    if (type === 'salary') {
      const val = parseFloat(document.getElementById('sc-val').value);
      if (isNaN(val)) return toast('请填写新基准', true);
      body.good_base = val;
    }
    if (type === 'fund_base') {
      const val = parseFloat(document.getElementById('sc-val').value);
      if (isNaN(val)) return toast('请填写新社保基数', true);
      body.social_base = val;
    }
    if (type === 'rate') {
      const ids = ['r-pen-u', 'r-pen-p', 'r-med-u', 'r-med-p', 'r-un-u', 'r-un-p', 'r-inj-u', 'r-mat-u', 'r-fun-u', 'r-fun-p'];
      const map = { 'r-pen-u': 'ins_pension_u', 'r-pen-p': 'ins_pension_p', 'r-med-u': 'ins_medical_u', 'r-med-p': 'ins_medical_p', 'r-un-u': 'ins_unemploy_u', 'r-un-p': 'ins_unemploy_p', 'r-inj-u': 'ins_injury_u', 'r-mat-u': 'ins_maternity_u', 'r-fun-u': 'fund_rate_u', 'r-fun-p': 'fund_rate' };
      for (const id of ids) {
        const v = parseFloat(document.getElementById(id).value);
        if (isNaN(v)) return toast('比例请填写数字', true);
        body[map[id]] = v / 100;
      }
    }
    try {
      await post('/salary/config', body);
      closeModal(); toast('已保存，历史月份标签不重算'); this.load(); this.loadAdjLog();
    } catch (e) { toast(e.message, true); }
  },
  async loadAdjLog() {
    try {
      const rows = await api('/salary/adj-log');
      document.getElementById('sc-log').innerHTML = rows.length ? rows.map(r => `
        <div class="mini-item">
          <span>${r.adj_type === 'salary' ? '调薪' : r.adj_type === 'fund_base' ? '公积金基数' : '比例'} · ${r.valid_from} · ${fmt(r.old_value)} → ${fmt(r.new_value)}</span>
          <span class="dim-s">${r.note || ''}</span>
        </div>`).join('') : '<div class="empty">暂无调整记录</div>';
    } catch (e) { /* 忽略 */ }
  }
};

// ── 经营（M3）───────────────────────────────────────────
const BizUI = {
  projects: [], cats: [], current: null, inited: false,
  async load() {
    if (!this.inited) {
      document.getElementById('bz-date').value = new Date().toISOString().slice(0, 10);
      this.inited = true;
    }
    this.projects = await api('/biz/projects');
    this.renderProjects();
    if (!this.current && this.projects.length) this.select(this.projects[0].id);
  },
  renderProjects() {
    document.getElementById('biz-projects').innerHTML = this.projects.map(p => `
      <div class="biz-card ${p.id === this.current ? 'active' : ''}" onclick="BizUI.select(${p.id})">
        <div class="bc-name">${p.name}<span class="bz-dir-${p.month_surplus >= 0 ? 'in' : 'out'}">${fmt(p.month_surplus)}</span></div>
        <div class="bc-pool">${p.pool_name || '未绑池'} · ${p.record_count} 笔</div>
        <div class="bc-metrics">
          <span>本月收<b>${fmt(p.month_income)}</b></span>
          <span>本月支<b>${fmt(p.month_cost)}</b></span>
          <span>可转存<b>${fmt(p.cum_surplus)}</b></span>
        </div>
      </div>`).join('') || '<div class="empty">暂无经营项目，点右上角「管理」新建</div>';
  },
  // 「＋ 管理」菜单：新建 / 重命名 / 重置 / 删除（收敛操作，防卡片误触）
  manageMenu() {
    const cur = this.current ? this.projects.find(x => x.id === this.current) : null;
    const item = (label, cls, fn) => `<div class="mm-item ${cls || ''}" onclick="${fn}">${label}</div>`;
    const disabled = !cur;
    openModal(`
      <h4>项目管理</h4>
      <div class="manage-menu">
        ${item('＋ 新建项目', '', 'BizUI.newProject()')}
        ${item('✎ 重命名 / 换绑账户' + (cur ? ` · ${cur.name}` : ''), disabled ? 'dim' : '', disabled ? "toast('请先选择项目',true)" : `BizUI.editProject(${cur.id})`)}
        ${item('↺ 重置（清空流水·回滚余额·恢复分类）', disabled ? 'dim' : 'warn', disabled ? "toast('请先选择项目',true)" : `BizUI.resetProject(${cur.id})`)}
        ${item('✕ 删除项目', disabled ? 'dim' : 'danger', disabled ? "toast('请先选择项目',true)" : `BizUI.delProject(${cur.id})`)}
      </div>`);
  },
  // 编辑/重命名/换绑池
  async editProject(id) {
    const p = this.projects.find(x => x.id === id);
    if (!p) return;
    let pools;
    try { pools = await api('/pools'); } catch (e) { return toast('加载账户失败: ' + e.message, true); }
    const assets = pools.filter(x => x.kind === 'asset');
    openModal(`
      <h4>重命名 / 换绑账户</h4>
      <div class="field"><label>项目名称</label><input id="ep-name" type="text" value="${p.name}"></div>
      <div class="field"><label>绑定账户（收支自动入账/出账）</label>
        <select id="ep-pool">${assets.length ? assets.map(x => `<option value="${x.id}" ${x.id === p.pool_id ? 'selected' : ''}>${x.name}（余额 ${fmt(x.balance)}）</option>`).join('') : '<option value="">（暂无资产账户，请先新建账户）</option>'}</select></div>
      <button class="btn block" onclick="BizUI.saveEditProject(${id})">保存修改</button>`);
  },
  async saveEditProject(id) {
    const name = document.getElementById('ep-name').value.trim();
    const pool_id = Number(document.getElementById('ep-pool').value);
    if (!name) return toast('请输入项目名称', true);
    if (!pool_id) return toast('请选择绑定账户', true);
    try {
      await put('/biz/projects/' + id, { name, pool_id });
      toast('已保存'); closeModal();
      await this.load(); this.select(id);
    } catch (e) { toast(e.message, true); }
  },
  // 重置：清空流水（回滚绑池余额）+ 往来 + 分类恢复默认
  async resetProject(id) {
    const p = this.projects.find(x => x.id === id);
    if (!p) return;
    if (!(await appConfirm(`确认重置「${p.name}」？\n将清空全部流水（绑池余额冲回）、资金往来、分类恢复默认模板。\n该操作不可撤销。`))) return;
    try {
      const r = await post(`/biz/projects/${id}/reset`, {});
      toast(`已重置，清除 ${r.cleared_records || 0} 笔流水`);
      await this.load(); this.select(id);
    } catch (e) { toast(e.message, true); }
  },
  // 删除（有流水提示先重置）
  async delProject(id) {
    const p = this.projects.find(x => x.id === id);
    if (!p) return;
    if (!(await appConfirm(`确认删除「${p.name}」？\n项目分类将一并移除。`))) return;
    try {
      await del('/biz/projects/' + id);
      toast('已删除');
      this.current = null;
      await this.load();
      if (this.projects.length) this.select(this.projects[0].id);
    } catch (e) {
      if (e.message.includes('禁止删除')) toast('项目已有流水，请先「重置」再删除', true);
      else toast(e.message, true);
    }
  },
  async select(id) {
    this.current = id;
    this.renderProjects();
    document.getElementById('biz-main').style.display = 'block';
    this.cats = await api('/biz/categories?project_id=' + id);
    this.catL1();
    await this.refreshTargets();
    await Promise.all([this.loadSurplus(), this.loadRecords(), this.refreshCanTransfer()]);
  },
  // 分类联动
  catL1() {
    const l1 = this.cats.filter(c => c.lvl === 1).sort((a, b) => a.sort - b.sort || a.id - b.id);
    document.getElementById('bz-l1').innerHTML = l1.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    this.catL2();
  },
  catL2() {
    const p1 = Number(document.getElementById('bz-l1').value);
    const l2 = this.cats.filter(c => c.lvl === 2 && c.parent_id === p1).sort((a, b) => a.sort - b.sort || a.id - b.id);
    document.getElementById('bz-l2').innerHTML = l2.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    this.catL3();
  },
  catL3() {
    const p2 = Number(document.getElementById('bz-l2').value);
    const l3 = this.cats.filter(c => c.lvl === 3 && c.parent_id === p2).sort((a, b) => a.sort - b.sort || a.id - b.id);
    const el = document.getElementById('bz-l3');
    el.innerHTML = l3.map(c => `<option value="${c.id}">${c.name}</option>`).join('') ||
      '<option value="">（无三级，直接用二级）</option>';
  },
  leafCat() {
    const l3 = document.getElementById('bz-l3').value;
    const id = l3 ? Number(l3) : Number(document.getElementById('bz-l2').value);
    return this.cats.find(c => c.id === id);
  },
  async saveRecord() {
    const cat = this.leafCat();
    const amount = parseFloat(document.getElementById('bz-amount').value);
    if (!cat || isNaN(amount) || amount <= 0) return toast('请选择分类并填写金额', true);
    try {
      await post('/biz/records', {
        project_id: this.current, cat_leaf_id: cat.id, amount,
        date: document.getElementById('bz-date').value || null,
        remark: document.getElementById('bz-remark').value.trim() || null
      });
      toast(`已记 ${cat.direction === 'in' ? '收入' : '支出'} ¥${fmt(amount)}`);
      document.getElementById('bz-amount').value = '';
      document.getElementById('bz-remark').value = '';
      await this.refreshAll();
    } catch (e) { toast(e.message, true); }
  },
  async delRecord(id) {
    if (!(await appConfirm('确认删除这笔经营流水？将回滚绑池余额'))) return;
    try { await del('/biz/records/' + id); toast('已删除'); await this.refreshAll(); }
    catch (e) { toast(e.message, true); }
  },
  async refreshTargets() {
    let pools = PoolUI.list || [];
    if (!pools.length) { try { pools = await api('/pools'); PoolUI.list = pools; } catch (e) { pools = []; } }
    const cur = this.projects.find(p => p.id === this.current);
    document.getElementById('bz-target').innerHTML = pools
      .filter(p => p.kind === 'asset' && p.id !== cur?.pool_id)
      .map(p => `<option value="${p.id}">${p.name}（余额 ${fmt(p.balance)}）</option>`).join('');
  },
  async refreshCanTransfer() {
    const p = this.projects.find(x => x.id === this.current);
    if (p) document.getElementById('bz-can').textContent = `可转存 ¥${fmt(p.cum_surplus)}`;
  },
  async transfer() {
    const amount = parseFloat(document.getElementById('bz-transfer-amount').value);
    const target = Number(document.getElementById('bz-target').value);
    if (isNaN(amount) || amount <= 0 || !target) return toast('请填写金额并选择目标池', true);
    try {
      await post('/biz/transfer', { project_id: this.current, amount, target_pool_id: target });
      toast(`已转存 ¥${fmt(amount)}`); document.getElementById('bz-transfer-amount').value = '';
      await Promise.all([this.load(), PoolUI.load(), Overview.load()]);
      if (this.current) this.select(this.current);
    } catch (e) { toast(e.message, true); }
  },
  async loadSurplus() {
    try {
      const rows = await api('/biz/surplus?project_id=' + this.current);
      const year = (new Date().toISOString().slice(0, 7));
      document.getElementById('bz-month-tag').textContent = '按年累计';
      document.getElementById('bz-surplus').innerHTML = rows.length ? rows.map(s => `
        <div class="sal-row">
          <div><span class="m">${s.month}</span>
            <span style="color:var(--dim);font-size:11px"> 收 ${fmt(s.income)} / 支 ${fmt(s.cost)}</span></div>
          <div><span class="bz-dir-${s.surplus >= 0 ? 'in' : 'out'}">盈余 ${fmt(s.surplus)}</span>
            <span style="color:var(--dim);font-size:11px"> · 累计 ${fmt(s.cum_surplus)}</span></div>
        </div>`).join('') : '<div class="empty">暂无月度盈余</div>';
    } catch (e) { /* 忽略 */ }
  },
  async loadRecords() {
    try {
      const rows = await api('/biz/records?project_id=' + this.current);
      document.getElementById('bz-records').innerHTML = rows.length ? rows.map(r => `
        <div class="sal-row">
          <div><span class="m">${r.date.slice(0, 10)}</span> ${r.cat_path}
            <span style="color:var(--dim);font-size:11px">${r.remark ? ' · ' + r.remark : ''}</span></div>
          <div><span class="bz-dir-${r.type === 'in' ? 'in' : 'out'}">${r.type === 'in' ? '+' : r.type === 'out' ? '−' : '⇄'} ${fmt(r.amount)}</span>
            ${r.type !== 'transfer' ? `<button onclick="BizUI.delRecord(${r.id})" style="border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px">删</button>` : ''}
          </div>
        </div>`).join('') : '<div class="empty">暂无流水</div>';
    } catch (e) { /* 忽略 */ }
  },
  async refreshAll() {
    await Promise.all([this.load(), PoolUI.load(), Overview.load()]);
    if (this.current) this.select(this.current);
  },
  // 分类管理弹层
  openCatManager() {
    const cats = this.cats;
    openModal(`
      <h4>分类管理 · ${this.projects.find(p => p.id === this.current)?.name}</h4>
      <div class="card-title">新增自定义分类</div>
      <div class="field"><label>级别</label>
        <select id="ca-lvl"><option value="2">二级</option><option value="3">三级</option></select></div>
      <div class="field"><label>父级（二级选一级方向）</label>
        <select id="ca-parent">${cats.filter(c => c.lvl === 1).map(c => `<option value="${c.id}">${c.name}（${c.direction === 'in' ? '收入' : '支出'}）</option>`).join('')}</select></div>
      <div class="field"><label>名称</label><input id="ca-name" type="text" placeholder="新分类名称"></div>
      <button class="btn block" onclick="BizUI.addCat()">保存</button>
      <div class="card-title" style="margin-top:14px">现有分类（编辑 / 排序 / 删除）</div>
      <div id="ca-list" style="max-height:340px;overflow:auto">${cats.map(c => `
        <div class="cat-node" style="padding-left:${(c.lvl - 1) * 14}px">
          <span class="bz-dir-${c.direction}">${c.direction === 'in' ? '收' : '支'}</span>
          <span class="nm">${c.name}${c.is_custom ? '<span style="color:var(--dim);font-size:10px"> 自</span>' : ''}</span>
          <span class="ops">
            <button onclick="BizUI.moveCat(${c.id},'up')">↑</button>
            <button onclick="BizUI.moveCat(${c.id},'down')">↓</button>
            <button onclick="BizUI.renameCat(${c.id})">改</button>
            <button onclick="BizUI.delCat(${c.id})">删</button>
          </span>
        </div>`).join('')}</div>`);
  },
  async addCat() {
    const lvl = Number(document.getElementById('ca-lvl').value);
    const name = document.getElementById('ca-name').value.trim();
    const parent_id = Number(document.getElementById('ca-parent').value);
    if (!name) return toast('请输入名称', true);
    try {
      await post('/biz/categories', { project_id: this.current, lvl, name, parent_id });
      toast('已新增分类');
      this.cats = await api('/biz/categories?project_id=' + this.current);
      this.openCatManager(); this.catL1();
    } catch (e) { toast(e.message, true); }
  },
  async renameCat(id) {
    const c = this.cats.find(x => x.id === id);
    const name = prompt('新名称：', c?.name);
    if (!name || name === c?.name) return;
    try { await put('/biz/categories/' + id, { name }); this.cats = await api('/biz/categories?project_id=' + this.current); this.openCatManager(); this.catL1(); }
    catch (e) { toast(e.message, true); }
  },
  async moveCat(id, dir) {
    try {
      const r = await post(`/biz/categories/${id}/move`, { dir });
      if (r.ok === false) return toast(r.error || '已在边界', true);
      this.cats = await api('/biz/categories?project_id=' + this.current);
      this.openCatManager(); toast('已排序');
    } catch (e) { toast(e.message, true); }
  },
  async delCat(id) {
    if (!(await appConfirm('确认删除该分类？'))) return;
    try { await del('/biz/categories/' + id); this.cats = await api('/biz/categories?project_id=' + this.current); this.openCatManager(); this.catL1(); toast('已删除'); }
    catch (e) { toast(e.message, true); }
  },
  async newProject() {
    let pools;
    try { pools = await api('/pools'); } catch (e) { return toast('加载账户失败: ' + e.message, true); }
    const assets = pools.filter(p => p.kind === 'asset');
    openModal(`
      <h4>新建经营项目</h4>
      <div class="field"><label>项目名称</label><input id="np-name" type="text" placeholder="如 房屋租赁 / 小卖部"></div>
      <div class="field"><label>绑定账户（收支自动入账/出账）</label>
        <select id="np-pool">${assets.length ? assets.map(p => `<option value="${p.id}">${p.name}（余额 ${fmt(p.balance)}）</option>`).join('') : '<option value="">（暂无资产账户，请先新建账户）</option>'}</select></div>
      <button class="btn block" onclick="BizUI.saveProject()">创建（自动生成默认分类）</button>`);
  },
  async saveProject() {
    const name = document.getElementById('np-name').value.trim();
    const pool_id = Number(document.getElementById('np-pool').value);
    if (!name) return toast('请输入项目名称', true);
    if (!pool_id) return toast('请先创建并选择绑定账户', true);
    try {
      const p = await post('/biz/projects', { name, pool_id });
      toast('项目已创建，默认一二三级分类已生成');
      closeModal();
      await this.load();
      this.select(p.id);
    } catch (e) { toast(e.message, true); }
  }
};

// ── 资金往来（应收/应付 + 账期看板）────────────────────
const ArapUI = {
  projectId: null, list: [], summary: null, chart: null, global: false,
  open() {
    this.global = false;
    this.projectId = BizUI.current || (BizUI.projects[0] && BizUI.projects[0].id);
    if (!this.projectId && !BizUI.projects.length) {
      // 未进过经营页时先加载项目列表
      api('/biz/projects').then(list => {
        if (!list.length) return toast('请先创建经营项目', true);
        BizUI.projects = list;
        this.projectId = list[0].id;
        document.getElementById('arap-view').style.display = 'flex';
        ViewStack.open('arap-view', () => { document.getElementById('arap-view').style.display = 'none'; });
        this.load();
      });
      return;
    }
    if (!this.projectId) return toast('请先创建经营项目', true);
    document.getElementById('arap-view').style.display = 'flex';
    ViewStack.open('arap-view', () => { document.getElementById('arap-view').style.display = 'none'; });
    this.load();
  },
  openAll() {
    this.global = true; this.projectId = null;
    document.getElementById('arap-view').style.display = 'flex';
    ViewStack.open('arap-view', () => { document.getElementById('arap-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const suffix = this.projectId ? '?project_id=' + this.projectId : '';
    const [list, summary] = await Promise.all([
      api('/biz/arap' + suffix),
      api('/biz/arap/summary' + suffix)
    ]);
    this.list = list; this.summary = summary;
    this.render();
  },
  render() {
    const s = this.summary;
    document.getElementById('arap-body').innerHTML = `
      <div class="arap-stats">
        <div class="arap-stat"><div class="as-label">应收未收</div>
          <div class="as-num recv">¥${fmt(s.receivable_open)}</div></div>
        <div class="arap-stat"><div class="as-label">应付未付</div>
          <div class="as-num pay">¥${fmt(s.payable_open)}</div></div>
        <div class="arap-stat"><div class="as-label">净应收</div>
          <div class="as-num ${s.net_receivable >= 0 ? 'recv' : 'pay'}">¥${fmt(s.net_receivable)}</div></div>
        <div class="arap-stat"><div class="as-label">已逾期 ${s.overdue_count} 笔</div>
          <div class="as-num ${s.overdue_amount > 0 ? 'pay' : 'dim-s'}">¥${fmt(s.overdue_amount)}</div></div>
      </div>
      <div class="card">
        <div class="card-title">账期分布 <span class="hint">按到期月份</span></div>
        <div id="arap-chart" style="height:170px"></div>
      </div>
      <div class="card">
        <div class="card-title">往来明细 <span class="hint">应收红 / 应付绿</span></div>
        <div id="arap-list">${this.listHTML()}</div>
      </div>`;
    this.drawChart();
  },
  listHTML() {
    if (!this.list.length) return '<div class="empty">暂无资金往来记录</div>';
    return this.list.map(r => {
      const cls = r.type === 'receivable' ? 'recv' : 'pay';
      const sign = r.type === 'receivable' ? '+' : '−';
      const projName = this.global ? ((BizUI.projects.find(p => p.id === r.project_id) || {}).name || '?') + ' · ' : '';
      const natTag = r.nature === 'loan'
        ? `<span class="ast-badge ast-loan">${r.type === 'receivable' ? '借出款' : '借入款'}</span>` : '';
      let badge = '';
      if (r.status === 'settled') badge = '<span class="ast-badge ast-settled">已结清</span>';
      else if (r.days_left < 0) badge = `<span class="ast-badge ast-overdue">逾期${-r.days_left}天</span>`;
      else if (r.days_left <= 7) badge = `<span class="ast-badge ast-due">剩${r.days_left}天</span>`;
      else badge = `<span class="ast-badge ast-normal">${r.days_left}天</span>`;
      return `<div class="arap-item">
        <div><span class="p">${projName}${r.type === 'receivable' ? '应收·' : '应付·'}${r.party}</span>${natTag}${badge}<br>
          <span style="color:var(--dim);font-size:11px">登记 ${r.record_date} · 账期 ${r.due_days}天 · 到期 ${r.due_date}${r.remark ? ' · ' + r.remark : ''}</span></div>
        <div><span class="${cls}" style="font-weight:800">${sign}${fmt(r.amount)}</span><br>
          <span style="font-size:11px">
            <button onclick="ArapUI.settle(${r.id})" style="border:none;background:none;color:var(--key);cursor:pointer">${r.status === 'settled' ? '重开' : '结清'}</button>
            <button onclick="ArapUI.edit(${r.id})" style="border:none;background:none;color:var(--dim);cursor:pointer">改</button>
            <button onclick="ArapUI.del(${r.id})" style="border:none;background:none;color:var(--dim);cursor:pointer">删</button>
          </span></div>
      </div>`;
    }).join('');
  },
  drawChart() {
    const el = document.getElementById('arap-chart');
    if (!el) return;
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="empty">图表库未加载</div>'; return; }
    const chart = this.chart || (this.chart = echarts.init(el));
    const m = this.summary.monthly;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['应收', '应付'], top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 44, right: 12, top: 26, bottom: 20 },
      xAxis: { type: 'category', data: m.map(x => x.month.slice(2)), axisLabel: { fontSize: 9 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 9 } },
      series: [
        { name: '应收', type: 'bar', data: m.map(x => x.recv), itemStyle: { color: '#d33a3a', borderRadius: [3, 3, 0, 0] }, barWidth: 12 },
        { name: '应付', type: 'bar', data: m.map(x => x.pay), itemStyle: { color: '#2e7d5b', borderRadius: [3, 3, 0, 0] }, barWidth: 12 }
      ]
    });
  },
  form(a) {
    const p = BizUI.projects.find(x => x.id === this.projectId);
    const nat = a?.nature || 'biz';
    const projSel = (this.global || !p)
      ? `<div class="field"><label>所属经营项目</label>
          <select id="ar-project">${BizUI.projects.map(x =>
            `<option value="${x.id}" ${a?.project_id === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>`
      : '';
    openModal(`
      <h4>${a ? '编辑资金往来' : '新增资金往来'} · ${p?.name || (this.global ? '全部项目' : '')}</h4>
      ${projSel}
      <div class="field"><label>类型</label>
        <select id="ar-type">
          <option value="receivable" ${a?.type === 'receivable' ? 'selected' : ''}>应收账款（债务人）</option>
          <option value="payable" ${a?.type === 'payable' ? 'selected' : ''}>应付账款（债权人）</option>
        </select></div>
      <div class="field"><label>性质</label>
        <select id="ar-nature">
          <option value="biz" ${nat === 'biz' ? 'selected' : ''}>经营应收/应付（结清计入收支统计）</option>
          <option value="loan" ${nat === 'loan' ? 'selected' : ''}>借出款/借入款（结清只回流资金，不计收支）</option>
        </select>
        <div class="hint">借出款收回 = 自有资金回流，不计入年度收入（主流记账口径）</div></div>
      <div class="field"><label>${a?.type === 'payable' ? '债权人' : '债务人'}名称</label>
        <input id="ar-party" type="text" value="${a?.party || ''}" placeholder="${a?.type === 'payable' ? '如 供应商' : '如 租户'}"></div>
      <div class="field"><label>金额</label>
        <input id="ar-amount" type="number" step="0.01" value="${a?.amount ?? ''}" placeholder="0.00"></div>
      <div class="field"><label>登记日期</label>
        <input id="ar-date" type="date" value="${a?.record_date || new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>账期（天）</label>
        <input id="ar-days" type="number" value="${a?.due_days ?? 30}" placeholder="30"></div>
      <div class="field"><label>备注</label>
        <input id="ar-remark" type="text" value="${a?.remark || ''}" placeholder="可选"></div>
      <button class="btn block" onclick="ArapUI.save(${a?.id || 0})">保存</button>`);
  },
  openNew() { this.form(); },
  edit(id) { this.form(this.list.find(x => x.id === id)); },
  async save(id) {
    const projEl = document.getElementById('ar-project');
    const body = {
      project_id: projEl ? Number(projEl.value) : this.projectId,
      type: document.getElementById('ar-type').value,
      nature: document.getElementById('ar-nature').value,
      party: document.getElementById('ar-party').value.trim(),
      amount: parseFloat(document.getElementById('ar-amount').value),
      record_date: document.getElementById('ar-date').value,
      due_days: parseInt(document.getElementById('ar-days').value) || 0,
      remark: document.getElementById('ar-remark').value.trim() || null
    };
    if (!body.party || isNaN(body.amount) || body.amount <= 0) return toast('对方与金额必填', true);
    try {
      if (id) await put('/biz/arap/' + id, body); else await post('/biz/arap', body);
      closeModal(); toast('已保存'); this.load();
    } catch (e) { toast(e.message, true); }
  },
  async settle(id) {
    const r = this.list.find(x => x.id === id);
    const isRecv = r.type === 'receivable';
    const isLoan = r.nature === 'loan';
    const proj = BizUI.projects.find(p => p.id === (r.project_id || this.projectId));
    const poolName = (proj && (proj.pool_name + '·' + (proj.pool_tail || ''))) || '项目绑定池';
    if (r.status === 'settled') {
      if (!(await appConfirm('重新打开该记录？将回滚已联动入账/出账的流水与账户余额。'))) return;
      return this.doConfirm(id, null, true);
    }
    const act = isRecv ? `收款入账 +¥${fmt(r.amount)} → ${poolName}` : `付款出账 −¥${fmt(r.amount)} ← ${poolName}`;
    const defaultChecked = !isLoan;
    openModal(`
      <h4>结清${isRecv ? '应收' : '应付'} · ${r.party}</h4>
      <div class="field"><div class="settle-act">${act}</div></div>
      <div class="field"><label class="chk"><input type="checkbox" id="ar-sync-inc" ${defaultChecked ? 'checked' : ''}>
        同步记入${isRecv ? '收入' : '支出'}（计入收支统计）</label>
        <div class="hint">${isLoan
          ? '借出/借入属自有资金回流，主流记账口径不计入收支，只体现账户变动。'
          : '经营类结清计入收入/支出统计；若该笔已在经营/记账中登记过，请取消勾选避免重复。'}</div></div>
      <button class="btn block" onclick="ArapUI.doConfirm(${id})">确认结清</button>`);
  },
  async doConfirm(id, syncInc, rollback) {
    if (!rollback) {
      syncInc = document.getElementById('ar-sync-inc').checked;
      closeModal();
    }
    try {
      const resp = await put('/biz/arap/' + id, { status: rollback ? 'open' : 'settled', sync_income: syncInc });
      if (resp.synced) {
        const counted = resp.synced.counted ? '已计入收支' : '仅资金回流（不计收支）';
        toast(`已结清 · ${resp.synced.pool} 余额 ¥${fmt(resp.synced.balance)} · ${counted}`);
        await Promise.all([this.load(), BizUI.load(), Overview.load()]);
      } else if (resp.rolled_back) {
        toast('已重开 · 流水与余额已回滚');
        await Promise.all([this.load(), BizUI.load(), Overview.load()]);
      } else { toast('状态已更新'); this.load(); }
    } catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该笔往来记录？'))) return;
    try { await del('/biz/arap/' + id); toast('已删除'); this.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── 资产（M4：投资 + 固定）─────────────────────────────
const AssetsUI = {
  invest: [], fixed: [],
  async load() {
    const [inv, fx] = await Promise.all([api('/invest'), api('/fixed')]);
    this.invest = inv; this.fixed = fx;
    this.portfolioCard(inv);
    GoalUI.load().catch(() => {});
    document.getElementById('as-invest').innerHTML = inv.length ? inv.map(a => `
      <div class="mini-item">
        <span>${this.kindName(a.kind)} · ${a.name} <span class="dim-s">${this.qtyText(a)}</span></span>
        <span>¥${fmt(a.market_value)} <span class="${a.profit >= 0 ? 'up' : 'down'}">${a.profit >= 0 ? '+' : ''}${fmt(a.profit)}</span>
          <button onclick="XirrUI.open(${a.id})" style="border:none;background:none;color:var(--key);cursor:pointer;font-size:11px">收益</button>
          <button onclick="AssetsUI.editInvest(${a.id})" style="border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px">改</button>
          <button onclick="AssetsUI.delInvest(${a.id})" style="border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px">删</button></span>
      </div>`).join('') : '<div class="empty">暂无投资资产，点右上角 + 投资</div>';
    document.getElementById('as-fixed').innerHTML = fx.length ? fx.map(f => `
      <div class="mini-item">
        <span>${f.name} <span class="dim-s">${f.buy_date ? '购于 ' + f.buy_date : ''}</span></span>
        <span>¥${fmt(f.est_value)} <span class="${f.profit >= 0 ? 'up' : 'down'}">${f.profit >= 0 ? '+' : ''}${fmt(f.profit)}</span>
          ${f.deprec ? `<span class="dim-s" style="font-size:10px">净 ¥${fmt(f.net_value)} · 月折 ¥${fmt(f.month_depr)}</span>` : ''}
          <button onclick="AssetsUI.editFixed(${f.id})" style="border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px">改</button>
          <button onclick="AssetsUI.delFixed(${f.id})" style="border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px">删</button></span>
      </div>`).join('') : '<div class="empty">暂无固定资产，点右上角 + 固定</div>';
  },
  kindName(k) { return { gold: '黄金', security: '证券', wealth: '理财', deposit: '定存', other: '其他' }[k] || k; },
  portfolioCard(inv) {
    const el = document.getElementById('as-portfolio');
    if (!el) return;
    if (!inv.length) { el.innerHTML = '<div class="empty">暂无投资持仓，添加后自动汇总</div>'; return; }
    const totalMv = inv.reduce((s, a) => s + a.market_value, 0);
    const totalCost = inv.reduce((s, a) => s + Math.max(0, a.market_value - a.profit), 0);
    const totalProfit = inv.reduce((s, a) => s + a.profit, 0);
    const pct = totalCost > 0 ? totalProfit / totalCost * 100 : 0;
    const byKind = {};
    for (const a of inv) byKind[a.kind] = (byKind[a.kind] || 0) + a.market_value;
    const kinds = Object.entries(byKind).sort((x, y) => y[1] - x[1]);
    const colors = { gold: '#e8a13a', security: '#2d6a4f', wealth: '#4a7fd4', deposit: '#8a6fd1', other: '#9aa5b1' };
    const totalW = Math.max(0.1, totalMv);
    el.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div style="flex:1"><div class="hint">持仓市值</div><div class="stat-num" style="font-size:17px">¥${fmt(totalMv)}</div></div>
        <div style="flex:1"><div class="hint">累计盈亏</div><div class="stat-num ${totalProfit >= 0 ? 'up' : 'down'}" style="font-size:17px">${totalProfit >= 0 ? '+' : ''}¥${fmt(totalProfit)}</div></div>
        <div style="flex:1"><div class="hint">收益率</div><div class="stat-num ${pct >= 0 ? 'up' : 'down'}" style="font-size:17px">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</div></div>
      </div>
      <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px;margin-bottom:8px">
        ${kinds.map(([k, v]) => `<div style="flex:${v / totalW};background:${colors[k] || '#9aa5b1'};border-radius:3px" title="${this.kindName(k)}"></div>`).join('')}
      </div>
      <div style="font-size:11.5px;line-height:1.9;color:var(--dim)">
        ${kinds.map(([k, v]) => `${this.kindName(k)} <b style="color:var(--txt)">${(v / totalW * 100).toFixed(1)}%</b> ¥${fmt(v)}`).join(' · ')}
      </div>`;
  },
  qtyText(a) {
    if (a.kind === 'gold') return a.quantity.toFixed(4) + 'g × ¥' + Number(a.price).toFixed(2);
    if (a.kind === 'security') return fmt(a.quantity) + '份 × ' + fmt(a.price);
    if (a.kind === 'wealth' || a.kind === 'deposit') return (a.profit_rate ? a.profit_rate + '%' : '') + (a.term_months ? ' / ' + a.term_months + '月' : '');
    return fmt(a.quantity);
  },
  openNewInvest() { this.investForm(); },
  editInvest(id) { this.investForm(this.invest.find(a => a.id === id)); },
  investForm(a) {
    openModal(`
      <h4>${a ? '编辑投资资产' : '新增投资资产'}</h4>
      <div class="field"><label>类型</label>
        <select id="iv-kind">
          <option value="gold" ${a?.kind === 'gold' ? 'selected' : ''}>黄金（克重）</option>
          <option value="security" ${a?.kind === 'security' ? 'selected' : ''}>有价证券（份额）</option>
          <option value="wealth" ${a?.kind === 'wealth' ? 'selected' : ''}>理财（本金）</option>
          <option value="deposit" ${a?.kind === 'deposit' ? 'selected' : ''}>定期存款（本金）</option>
          <option value="other" ${a?.kind === 'other' ? 'selected' : ''}>其他</option>
        </select></div>
      <div class="field"><label>名称</label><input id="iv-name" type="text" value="${a?.name || ''}" placeholder="如 投资金条"></div>
      <div class="field"><label>数量/本金 <span class="hint">黄金精确到 0.0001 克</span></label>
        <input id="iv-qty" type="number" step="0.0001" value="${a?.quantity ?? ''}" placeholder="0.0000"></div>
      <div class="field"><label>现价 <span class="hint">精确到 0.01</span></label>
        <input id="iv-price" type="number" step="0.01" value="${a?.price ?? ''}" placeholder="0.00"></div>
      <div class="field"><label>成本单价（盈亏用）</label>
        <input id="iv-cost" type="number" step="0.0001" value="${a?.cost_price ?? ''}" placeholder="0.0000"></div>
      <div class="field"><label>年化利率 %（理财/定存）</label>
        <input id="iv-rate" type="number" step="0.01" value="${a?.profit_rate ?? ''}" placeholder="可选"></div>
      <div class="field"><label>期限（月）</label>
        <input id="iv-term" type="number" value="${a?.term_months ?? ''}" placeholder="可选"></div>
      <div class="field"><label>到期日（定存）</label>
        <input id="iv-maturity" type="date" value="${a?.maturity_date || ''}"></div>
      <div class="field"><label>备注</label><input id="iv-note" type="text" value="${a?.note || ''}" placeholder="可选"></div>
      <button class="btn block" onclick="AssetsUI.saveInvest(${a?.id || 0})">保存</button>`);
  },
  async saveInvest(id) {
    const body = {
      kind: document.getElementById('iv-kind').value,
      name: document.getElementById('iv-name').value.trim(),
      quantity: parseFloat(document.getElementById('iv-qty').value),
      price: parseFloat(document.getElementById('iv-price').value) || 0,
      cost_price: parseFloat(document.getElementById('iv-cost').value) || 0,
      profit_rate: document.getElementById('iv-rate').value.trim() || null,
      term_months: document.getElementById('iv-term').value.trim() || null,
      maturity_date: document.getElementById('iv-maturity').value || null,
      note: document.getElementById('iv-note').value.trim() || null
    };
    if (!body.name || isNaN(body.quantity) || body.quantity <= 0) return toast('名称与数量必填且 >0', true);
    try {
      if (id) await put('/invest/' + id, body); else await post('/invest', body);
      closeModal(); toast(id ? '已更新（市值重算）' : '已新增投资'); await this.refresh();
    } catch (e) { toast(e.message, true); }
  },
  async delInvest(id) {
    if (!(await appConfirm('确认删除该投资资产？'))) return;
    try { await del('/invest/' + id); toast('已删除'); await this.refresh(); }
    catch (e) { toast(e.message, true); }
  },
  openNewFixed() { this.fixedForm(); },
  editFixed(id) { this.fixedForm(this.fixed.find(f => f.id === id)); },
  fixedForm(f) {
    openModal(`
      <h4>${f ? '编辑固定资产' : '新增固定资产'}</h4>
      <div class="field"><label>类型</label>
        <select id="fx-kind">
          <option value="realestate" ${f?.kind === 'realestate' ? 'selected' : ''}>不动产</option>
          <option value="vehicle" ${f?.kind === 'vehicle' ? 'selected' : ''}>车辆</option>
          <option value="other" ${f?.kind === 'other' ? 'selected' : ''}>其他</option>
        </select></div>
      <div class="field"><label>名称</label><input id="fx-name" type="text" value="${f?.name || ''}" placeholder="如 郑州房产"></div>
      <div class="field"><label>当前估值</label><input id="fx-value" type="number" step="0.01" value="${f?.est_value ?? ''}"></div>
      <div class="field"><label>购置成本</label><input id="fx-cost" type="number" step="0.01" value="${f?.cost ?? ''}" placeholder="可选"></div>
      <div class="field"><label>购买日期</label><input id="fx-date" type="date" value="${f?.buy_date || ''}"></div>
      <div class="field"><label>折旧年限（年，0=不计提）</label><input id="fx-life" type="number" step="0.5" value="${f?.useful_life_years || ''}" placeholder="如 20"></div>
      <div class="field"><label>残值率（%，默认 0）</label><input id="fx-salvage" type="number" step="1" value="${f?.salvage_rate ? f.salvage_rate * 100 : ''}" placeholder="如 5"></div>
      <div class="field"><label>备注</label><input id="fx-note" type="text" value="${f?.note || ''}" placeholder="可选"></div>
      <button class="btn block" onclick="AssetsUI.saveFixed(${f?.id || 0})">保存</button>`);
  },
  async saveFixed(id) {
    const body = {
      kind: document.getElementById('fx-kind').value,
      name: document.getElementById('fx-name').value.trim(),
      est_value: parseFloat(document.getElementById('fx-value').value),
      cost: document.getElementById('fx-cost').value.trim() || null,
      buy_date: document.getElementById('fx-date').value || null,
      useful_life_years: Number(document.getElementById('fx-life').value) || 0,
      salvage_rate: Number(document.getElementById('fx-salvage').value) / 100 || 0,
      note: document.getElementById('fx-note').value.trim() || null
    };
    if (!body.name || isNaN(body.est_value) || body.est_value < 0) return toast('名称与估值必填', true);
    try {
      if (id) await put('/fixed/' + id, body); else await post('/fixed', body);
      closeModal(); toast('已保存'); await this.refresh();
    } catch (e) { toast(e.message, true); }
  },
  async delFixed(id) {
    if (!(await appConfirm('确认删除该固定资产？'))) return;
    try { await del('/fixed/' + id); toast('已删除'); await this.refresh(); }
    catch (e) { toast(e.message, true); }
  },
  async refresh() {
    await Promise.all([this.load(), Overview.load()]);
  }
};

// ── 我的 ────────────────────────────────────────────────
const Me = {
  async load() {
    // 刷新列表右侧状态
    try {
      const st = await api('/offline/status');
      const h = document.getElementById('me-health');
      if (h) h.innerHTML = `<span style="color:#2f7d5d">云存储已连接</span> · ${st.stores.pools}账户/${st.stores.records}流水`;
      const sy = document.getElementById('sync-status');
      if (sy) sy.textContent = localStorage.getItem('at_user') ? '已登录 ›' : '未登录 ›';
      const ls = document.getElementById('me-lock-status');
      if (ls) ls.textContent = LockUI.isOn() ? '已开启 ›' : '未开启 ›';
      const ts = document.getElementById('me-theme-state');
      if (ts) ts.textContent = (localStorage.getItem('at_theme') || '默认') + ' · ' + (localStorage.getItem('at_font') || '标准') + ' ›';
    } catch (e) {}
  },
  openSync() {
    const cur = localStorage.getItem('at_github_token') || '';
    openModal(`
      <h4>云同步与账号</h4>
      <div style="font-size:12px;color:var(--dim);margin-bottom:10px">登录后可多端同步数据到 GitHub</div>
      <div class="field"><label>GitHub Token（只需输入一次）</label>
        <input id="gh-token-input" type="password" value="${cur}" placeholder="粘贴 GitHub Personal Access Token">
      </div>
      <button class="btn block" onclick="AuthUI.saveToken()">保存 Token</button>
      <div class="op-row" style="flex-wrap:wrap;gap:8px;margin-top:10px">
        <button class="btn" onclick="AuthUI.syncUp();closeModal()">立即同步到 GitHub</button>
        <button class="btn ghost" onclick="AuthUI.syncDown();closeModal()">从 GitHub 下载</button>
        <button class="btn ghost" onclick="AuthUI.relogin();closeModal()">重新登录</button>
        <button class="btn ghost" onclick="AuthUI.logout();closeModal()">退出登录</button>
      </div>`);
  },
  saveToken() {
    const v = document.getElementById('gh-token-input').value.trim();
    if (!v) return toast('请输入 Token', true);
    localStorage.setItem('at_github_token', v);
    toast('Token 已保存');
  },
  openBackup() {
    openModal(`
      <h4>数据备份与恢复</h4>
      <div class="op-row" style="flex-wrap:wrap;gap:8px">
        <button class="btn" onclick="Me.exportFull()">导出全量备份 JSON</button>
        <button class="btn ghost" onclick="Me.importOffline()">从 JSON 恢复</button>
        <button class="btn danger" onclick="Me.resetOffline()">重置离线数据</button>
      </div>
      <div class="hint" style="margin-top:8px">JSON 全量备份含全部数据，可在多设备间恢复。</div>`);
  },
  openExport() {
    openModal(`
      <h4>报表导出</h4>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="field" style="flex:1"><label>年份</label><input id="rp-year" type="number" placeholder="2026" value="2026"></div>
        <div class="field" style="flex:2"><label>账本</label><select id="rp-book" class="sel"></select></div>
      </div>
      <div class="op-row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
        <button class="btn" onclick="Me.exportCsv()">导出 CSV</button>
        <button class="btn ghost" onclick="Me.exportXlsx()">导出 Excel</button>
        <button class="btn ghost" onclick="Me.copyCsv()">复制 CSV</button>
        <button class="btn ghost" onclick="Me.exportImage()">导出长图</button>
      </div>
      <div class="hint" style="margin-top:8px">导出所选账本 + 年份的全部收支明细。</div>`);
    this.initReport();
  },
  openImport() {
    openModal(`
      <h4>CSV 导入记账</h4>
      <div class="hint" style="margin-bottom:8px">列：日期,方向,金额,分类,账户</div>
      <input type="file" id="csv-file" accept=".csv,text/csv" style="width:100%;font-size:12px;margin-bottom:8px">
      <div class="op-row" style="flex-wrap:wrap;gap:8px">
        <select id="csv-book" class="sel"><option value="1">默认账本</option></select>
        <button class="btn" onclick="Me.importCsv();closeModal()">解析并导入</button>
      </div>
      <div class="hint" id="csv-result" style="margin-top:6px">示例：2026-09-01,expense,36.5,餐饮,1,午餐</div>`);
    this.fillBookSel();
  },
  openLock() {
    LockUI.setForm();
  },
  async health() {
    try {
      const st = await api('/offline/status');
      openModal(`
        <h4>系统状态</h4>
        <div style="font-size:13px;line-height:2">
          云存储：<span style="color:#2f7d5d">已连接</span><br>
          账户：${st.stores.pools} 个<br>
          记账流水：${st.stores.records} 条<br>
          工资记录：${st.stores.salary_month} 条<br>
          经营流水：${st.stores.biz_records} 条<br>
          资金往来：${st.stores.biz_arap} 条
        </div>
        <button class="btn block" style="margin-top:12px" onclick="closeModal()">关闭</button>`);
    } catch (e) { toast('服务未连接', true); }
  },
  // 后端数据 → IndexedDB（离线库快照）
  async syncToOffline() {
    try {
      const data = await api('/export/full');
      await IDB.idbClearAll();
      await IDB.idbTx(async a => {
        for (const s of IDB.IDB_STORES) {
          if (Array.isArray(data[s])) for (const row of data[s]) await a.put(s, row);
        }
      });
      toast('已同步到本地离线库');
      await this.load();
    } catch (e) { toast('同步失败: ' + e.message, true); }
  },
  // 从 JSON 文件恢复离线库
  async importOffline() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      try {
        const data = JSON.parse(await inp.files[0].text());
        if (!data.pools) throw new Error('不是有效的全量备份');
        await IDB.idbClearAll();
        await IDB.idbTx(async a => {
          for (const s of IDB.IDB_STORES) {
            if (Array.isArray(data[s])) for (const row of data[s]) await a.put(s, row);
          }
        });
        toast('离线库已恢复');
        await this.load();
      } catch (e) { toast('恢复失败: ' + e.message, true); }
    };
    inp.click();
  },
  // 重置离线数据：清空并重新种子（修复早期版本并发种子导致的分类/账户重复）
  async resetOffline() {
    if (!(await appConfirm('确认重置本地离线数据？\n将清空离线库并恢复默认种子（账户/分类/经营项目）。\n当前服务端数据不受影响。'))) return;
    try {
      await IDB.idbClearAll();
      await IDB.idbSeedIfEmpty();
      toast('离线数据已重置为默认');
      await this.load();
    } catch (e) { toast('重置失败: ' + e.message, true); }
  },
  // 全量 JSON 备份下载
  async exportFull() {
    try {
      const data = await api('/export/full');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `asset-terminal-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      localStorage.setItem('at_last_backup', new Date().toISOString());
      toast('全量备份已导出');
    } catch (e) { toast('导出失败: ' + e.message, true); }
  },
  autoBackupCheck() {
    const last = localStorage.getItem('at_last_backup');
    if (!last) { localStorage.setItem('at_last_backup', new Date().toISOString()); return; }
    const days = (Date.now() - new Date(last).getTime()) / 86400000;
    if (days >= 7) {
      this.exportFull().catch(() => {});
    }
  },
  async exportCsv() {
    const t = document.getElementById('me-csv-table').value;
    if (!t) return;
    try {
      const r = await api('/export/csv?table=' + t);
      const blob = new Blob([r.__csv || ''], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${t}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('CSV 已导出'); document.getElementById('me-csv-table').value = '';
    } catch (e) { toast('导出失败: ' + e.message, true); }
  },
  // M7.2 CSV 导入记账
  async importCsv() {
    const inp = document.getElementById('csv-file');
    const result = document.getElementById('csv-result');
    if (!inp.files || !inp.files.length) return toast('请先选择 CSV 文件', true);
    const text = await inp.files[0].text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return toast('CSV 内容为空', true);
    // 表头探测：跳过含 日期/方向/金额/分类 的表头行
    const head = lines[0].toLowerCase();
    const skipHead = /日期|direction|date|金额|amount|分类|category/.test(head);
    const rows = (skipHead ? lines.slice(1) : lines).map((l, i) => {
      const parts = l.split(/[,，\t]/);
      const [date, direction, amount, category, pool_id, ...rest] = parts;
      return {
        date: (date || '').trim(), direction: (direction || '').trim().toLowerCase(),
        amount: Number((amount || '').trim()), category: (category || '').trim(),
        pool_id: Number((pool_id || '1').trim()) || 1,
        remark: rest.join(' ').trim() || null, line: i + (skipHead ? 2 : 1)
      };
    });
    const bad = rows.filter(r => !r.date || !['income', 'expense'].includes(r.direction) || !r.amount || isNaN(r.amount));
    if (bad.length) { result.textContent = `第 ${bad[0].line} 行格式错误（需：日期,方向,金额,分类[,账户]）`; return; }
    try {
      const book_id = Number(document.getElementById('csv-book').value) || 1;
      const r = await post('/import/csv', { rows, book_id });
      result.textContent = `导入成功 ${r.imported} 笔${r.skipped.length ? '，跳过 ' + r.skipped.length + ' 条（' + r.skipped[0] + '）' : ''}`;
      result.style.color = 'var(--dim)';
      Ledger.reload(); PoolUI.load(); Overview.load();
      inp.value = '';
    } catch (e) { result.textContent = '导入失败：' + e.message; }
  },
  // M7.2 账本下拉填充（CSV 导入用）
  async fillBookSel() {
    const sel = document.getElementById('csv-book');
    if (!sel) return;
    const books = await api('/books');
    sel.innerHTML = books.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  },
  // M7.0 应用锁状态渲染
  renderLock() {
    const on = LockUI.isOn();
    const el = document.getElementById('me-lock-status');
    if (el) el.textContent = on ? '已开启：进入 App 需输入密码' : '未开启：启动后直接进入';
    const off = document.getElementById('me-lock-off');
    if (off) off.style.display = on ? '' : 'none';
  },
  // M7.0 服务端全量恢复（覆盖）
  async importServer() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      try {
        const data = JSON.parse(await inp.files[0].text());
        if (!data.pools || !data.records) throw new Error('不是有效的全量备份');
        if (!(await appConfirm(`确认从备份恢复？\n将覆盖当前服务端全部数据（${data.pools.length} 账户 / ${data.records.length} 流水）。\n建议先导出当前备份。`))) return;
        await post('/import', data);
        toast('已恢复，正在刷新…');
        setTimeout(() => location.reload(), 700);
      } catch (e) { toast('恢复失败: ' + e.message, true); }
    };
    inp.click();
  },
  async initReport() {
    const sel = document.getElementById('rp-book');
    if (!sel) return;
    try {
      const books = await api('/books');
      const cur = await api('/ledger/current').catch(() => null);
      sel.innerHTML = books.map(b => `<option value="${b.id}" ${cur && b.id === cur.id ? 'selected' : ''}>${b.name}${b.is_default ? '（默认）' : ''}</option>`).join('') || '<option value="0">默认账本</option>';
    } catch (e) { sel.innerHTML = '<option value="0">默认账本</option>'; }
  },
  async fetchYearRows(year, bookId) {
    const rows = await api('/records?limit=100000' + (bookId ? '&book_id=' + bookId : ''));
    const y = String(year || new Date().getFullYear());
    return rows.filter(r => (r.created_at || '').slice(0, 4) === y)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },
  csvText(rows) {
    if (!rows.length) return null;
    const head = '日期,分类,方向,金额,备注,账户,来源';
    const lines = rows.map(r => {
      const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      return [esc((r.created_at || '').slice(0, 10)), esc(r.cat_path || '未分类'), esc(r.direction === 'income' ? '收入' : '支出'), r.amount, esc(r.remark || ''), esc(r.pool_name || ''), esc(r.source || '')].join(',');
    });
    let inc = 0, exp = 0;
    for (const r of rows) r.direction === 'income' ? inc += r.amount : exp += r.amount;
    return head + '\n' + lines.join('\n') + '\n\n合计收入,¥' + inc.toFixed(2) + ',合计支出,¥' + exp.toFixed(2) + ',结余,¥' + (inc - exp).toFixed(2);
  },
  async exportCsv() {
    const year = document.getElementById('rp-year').value.trim() || String(new Date().getFullYear());
    const bookId = Number(document.getElementById('rp-book').value || 0);
    const rows = await this.fetchYearRows(year, bookId);
    const txt = this.csvText(rows);
    if (!txt) return toast(year + ' 年暂无收支记录', true);
    const blob = new Blob(['\ufeff' + txt], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const bookName = (document.getElementById('rp-book').selectedOptions[0] || {}).textContent || '账本';
    a.download = year + '年收支报表-' + bookName + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已导出 ' + year + ' 年收支报表');
  },
  async copyCsv() {
    const year = document.getElementById('rp-year').value.trim() || String(new Date().getFullYear());
    const bookId = Number(document.getElementById('rp-book').value || 0);
    const rows = await this.fetchYearRows(year, bookId);
    const txt = this.csvText(rows);
    if (!txt) return toast(year + ' 年暂无收支记录', true);
    try { await navigator.clipboard.writeText(txt); toast('CSV 已复制，可直接粘贴到 Excel'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('CSV 已复制'); } catch (e2) { toast('复制失败', true); }
      ta.remove();
    }
  },
  async exportXlsx() {
    const year = document.getElementById('rp-year').value.trim() || String(new Date().getFullYear());
    const bookId = Number(document.getElementById('rp-book').value || 0);
    const rows = await this.fetchYearRows(year, bookId);
    if (!rows || !rows.length) return toast(year + ' 年暂无记录', true);
    try {
      const data = rows.map(r => ({
        '日期': r.created_at, '方向': r.direction === 'income' ? '收入' : '支出',
        '分类': r.cat_path || '', '金额': r.amount, '备注': r.remark || ''
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, year + '年收支');
      XLSX.writeFile(wb, year + '年收支明细.xlsx');
      toast('Excel 已导出');
    } catch (e) { toast('导出失败: ' + e.message, true); }
  },
  async exportImage() {
    const year = document.getElementById('rp-year').value.trim() || String(new Date().getFullYear());
    const bookId = Number(document.getElementById('rp-book').value || 0);
    const bookSel = document.getElementById('rp-book');
    const bookName = bookSel ? bookSel.options[bookSel.selectedIndex].text : '全部账本';
    toast('正在生成长图…');
    const rows = await this.fetchYearRows(year, bookId);
    if (!rows || !rows.length) return toast(year + ' 年暂无收支记录', true);
    const totalInc = rows.filter(r => r.direction === 'income').reduce((s, r) => s + r.amount, 0);
    const totalExp = rows.filter(r => r.direction === 'expense').reduce((s, r) => s + r.amount, 0);
    const months = {};
    rows.forEach(r => {
      const m = (r.created_at || '').slice(0, 7);
      if (!months[m]) months[m] = { inc: 0, exp: 0 };
      if (r.direction === 'income') months[m].inc += r.amount; else months[m].exp += r.amount;
    });
    const monthsHtml = Object.entries(months).sort().map(([m, v]) =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:13px">
        <span>${m}</span><span>收 ¥${fmt(v.inc)} · 支 ¥${fmt(v.exp)} · 结余 <b style="color:${v.inc-v.exp>=0?'#d94a4a':'#1f9d67'}">¥${fmt(v.inc-v.exp)}</b></span></div>`).join('');
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;background:#fff;padding:24px;font-family:sans-serif;';
    div.innerHTML = `<h2 style="text-align:center;margin-bottom:4px">${year} 年度收支报告</h2>
      <p style="text-align:center;color:#888;font-size:12px">${bookName}</p>
      <div style="background:#f5f9f5;border-radius:12px;padding:14px;margin:12px 0;text-align:center">
        <div style="font-size:12px;color:#888">年度结余</div>
        <div style="font-size:28px;font-weight:800;color:${totalInc-totalExp>=0?'#d94a4a':'#1f9d67'}">¥${fmt(totalInc-totalExp)}</div>
        <div style="font-size:12px;color:#666;margin-top:4px">收入 ¥${fmt(totalInc)} · 支出 ¥${fmt(totalExp)}</div>
      </div>
      <h3 style="font-size:14px;margin:10px 0 6px">月度明细</h3>
      ${monthsHtml}
      <p style="text-align:center;color:#aaa;font-size:10px;margin-top:16px">资产聚合管理终端</p>`;
    document.body.appendChild(div);
    try {
      const canvas = await html2canvas(div, { backgroundColor: '#fff', scale: 2 });
      const link = document.createElement('a');
      link.download = `${year}年度收支报告.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('长图已导出');
    } catch (e) { toast('导出失败: ' + e.message, true); }
    div.remove();
  }
};
const MineUI = Me; // 兼容 HTML 按钮命名（修复导出按钮失效的历史引用）

// ── 应用锁（M7.0）───────────────────────────────────────
const LockUI = {
  KEY: 'at_lock_hash', ON: 'at_lock_on',
  // FNV-1a 加盐散列（本地防误触用途，非密码学级）
  hash(pin) {
    let h = 2166136261;
    const s = 'asset-terminal#2026#' + pin;
    for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  },
  isOn() { return localStorage.getItem(this.ON) === '1'; },
  isUnlocked() { return sessionStorage.getItem('at_unlocked') === '1'; },
  hasPin() { return !!localStorage.getItem(this.KEY); },
  setPin(pin) { localStorage.setItem(this.KEY, this.hash(pin)); localStorage.setItem(this.ON, '1'); },
  verify(pin) { return this.hasPin() && this.hash(pin) === localStorage.getItem(this.KEY); },
  unlock() { sessionStorage.setItem('at_unlocked', '1'); const m = document.getElementById('lock-mask'); if (m) m.style.display = 'none'; },
  off() { localStorage.removeItem(this.KEY); localStorage.removeItem(this.ON); sessionStorage.removeItem('at_unlocked'); },
  setForm() {
    openModal(`
      <h4>${this.hasPin() ? '修改密码' : '设置应用锁'}</h4>
      <div class="field"><label>输入密码（4-8 位数字）</label><input id="lk-p1" type="password" inputmode="numeric" maxlength="8"></div>
      <div class="field"><label>再次输入确认</label><input id="lk-p2" type="password" inputmode="numeric" maxlength="8"></div>
      <button class="btn block" onclick="LockUI.savePin()">保存</button>`);
  },
  savePin() {
    const p1 = document.getElementById('lk-p1').value, p2 = document.getElementById('lk-p2').value;
    if (!p1 || p1.length < 4 || p1.length > 8) return toast('密码需为 4-8 位', true);
    if (p1 !== p2) return toast('两次输入不一致', true);
    this.setPin(p1); closeModal(); toast('应用锁已开启'); MineUI.renderLock();
  },
  offForm() {
    openModal(`
      <h4>关闭应用锁</h4>
      <div class="field"><label>输入当前密码</label><input id="lk-old" type="password" inputmode="numeric" maxlength="8"></div>
      <button class="btn block" onclick="LockUI.saveOff()">确认关闭</button>`);
  },
  saveOff() {
    if (!this.verify(document.getElementById('lk-old').value)) return toast('密码错误', true);
    this.off(); closeModal(); toast('应用锁已关闭'); MineUI.renderLock();
  },
  tryUnlock() {
    const v = document.getElementById('lock-input').value;
    const st = document.getElementById('lock-mask-status');
    if (this.verify(v)) { this.unlock(); document.getElementById('lock-input').value = ''; }
    else { if (st) st.textContent = '密码错误，请重试'; document.getElementById('lock-input').value = ''; }
  },
  // 启动门：开启且本会话未解锁 → 显示全屏遮罩并阻止进入
  gate() {
    if (this.isOn() && !this.isUnlocked()) {
      const m = document.getElementById('lock-mask');
      if (m) { m.style.display = 'flex'; m.querySelector('#lock-input').focus(); }
      return false;
    }
    return true;
  }
};

// ── 启动 ────────────────────────────────────────────────
(async () => {
  try {
    if (APP_MODE === 'server') {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(API + '/health', { signal: ctl.signal });
        clearTimeout(t);
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.ok !== true) throw new Error('bad');
      } catch (e) {
        const fallback = location.pathname + '?mode=offline';
        toast('未检测到本地服务，已切换离线模式', false, 3500);
        setTimeout(() => location.replace(fallback), 1200);
        return;
      }
    }
    MineUI.renderLock();
    MineUI.fillBookSel();
    const restoreBtn = document.getElementById('me-restore-btn');
    if (restoreBtn) restoreBtn.style.display = APP_MODE === 'server' ? '' : 'none';
    if (!LockUI.gate()) return;
    if (!AuthUI.gate()) return;
    switchTab('overview');
    Me.autoBackupCheck();
    if (AuthUI.token) AuthUI.syncDown(true).catch(() => {});
  } catch (e) {
    console.error('启动错误:', e);
    // 出错也要强制进总览，不能空白
    switchTab('overview');
  }
})();
// ── 登录与云同步 ──────────────────────────────────────
const AuthUI = {
  token: localStorage.getItem('at_token') || '',
  user: localStorage.getItem('at_user') || '',
  async login() {
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    if (u === 'admin' && p === 'admin123') {
      this.token = 'local_' + Date.now();
      this.user = 'admin';
      localStorage.setItem('at_token', this.token);
      localStorage.setItem('at_user', this.user);
      document.getElementById('login-mask').style.display = 'none';
      const ss = document.getElementById('sync-status');
      if (ss) ss.textContent = '已登录: admin';
      const su = document.getElementById('sync-user');
      if (su) su.textContent = '已登录，可多端同步数据到 GitHub';
      toast('登录成功');
      // 登录成功后进入总览页
      switchTab('overview');
      Me.autoBackupCheck();
      // 只有配了GitHub token才尝试云同步
      if (localStorage.getItem('at_github_token')) this.syncDown(true).catch(() => {});
    } else {
      document.getElementById('login-err').style.display = '';
    }
  },
  logout() {
    localStorage.removeItem('at_token'); localStorage.removeItem('at_user');
    this.token = ''; this.user = '';
    document.getElementById('login-mask').style.display = 'flex';
  },
  authHeaders() { return { 'Authorization': 'Bearer ' + this.token }; },
  relogin() {
    localStorage.removeItem('at_token');
    this.token = '';
    document.getElementById('login-mask').style.display = 'flex';
  },
  _autoSyncTimer: null,
  scheduleAutoSync() {
    if (!this.token) return;
    clearTimeout(this._autoSyncTimer);
    this._autoSyncTimer = setTimeout(() => {
      this.syncUp().catch(() => {});
    }, 5000);
  },
  async syncUp() {
    toast('正在上传到 GitHub…');
    try {
      const data = await api('/export/full');
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const owner = 'git202526', repo = 'asset-terminal', path = 'data/cloud-sync.json';
      const token = localStorage.getItem('at_github_token') || '';
      let sha = null;
      try {
        const gr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers: { 'Authorization': 'token ' + token } });
        if (gr.ok) { const gj = await gr.json(); sha = gj.sha; }
      } catch (e) {}
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'sync ' + new Date().toISOString(), content, sha })
      });
      if (r.ok) toast('已同步到 GitHub');
      else { const ej = await r.json().catch(()=>({})); toast('上传失败: ' + (ej.message || r.status), true); }
    } catch (e) { toast('上传失败: ' + e.message, true); }
  },
  async syncDown(silent) {
    if (!silent) toast('正在从 GitHub 下载并合并…');
    try {
      const owner = 'git202526', repo = 'asset-terminal', path = 'data/cloud-sync.json';
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`);
      if (!r.ok) { if (!silent) toast('云端暂无数据', true); return; }
      const cloud = await r.json();
      // 拉本地全量
      const local = await api('/export/full');
      // 按表合并：同 id 取 updated_at 新的
      const TABLES = Object.keys(cloud).filter(k => k !== 'exported_at' && k !== 'app' && k !== 'version');
      let merged = 0, added = 0;
      for (const t of TABLES) {
        const localRows = local[t] || [];
        const cloudRows = cloud[t] || [];
        const map = new Map();
        // 先放本地
        for (const row of localRows) {
          if (row.id != null) map.set(row.id, row);
        }
        // 合并云端：新的覆盖旧的
        for (const crow of cloudRows) {
          if (crow.id == null) continue;
          const old = map.get(crow.id);
          if (!old) { map.set(crow.id, crow); added++; }
          else {
            const lt = old.updated_at || old.created_at || '';
            const ct = crow.updated_at || crow.created_at || '';
            if (ct > lt) { map.set(crow.id, crow); merged++; }
          }
        }
        // 写回 IndexedDB
        const store = t;
        const db = await new Promise(resolve => { const req = indexedDB.open('asset-terminal-offline'); req.onsuccess = () => resolve(req.result); });
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        await new Promise(resolve => {
          os.clear().onsuccess = () => {
            for (const row of map.values()) os.put(row);
            tx.oncomplete = resolve;
          };
        });
      }
      if (!silent) {
        toast(`合并完成：更新 ${merged} 条，新增 ${added} 条`);
        setTimeout(() => location.reload(), 1500);
      } else if (merged + added > 0) {
        toast(`已从云端同步 ${merged + added} 条更新`);
        setTimeout(() => location.reload(), 1500);
      }
    } catch (e) { if (!silent) toast('合并失败: ' + e.message, true); }
  },
  gate() {
    // 已登录过（localStorage有记录）直接放行
    if (this.token && this.user) {
      const ss = document.getElementById('sync-status');
      if (ss) ss.textContent = '已登录: ' + this.user;
      const su = document.getElementById('sync-user');
      if (su) su.textContent = '已登录，可多端同步数据到 GitHub';
      return true;
    }
    // 未登录 → 显示登录页
    const mask = document.getElementById('login-mask');
    if (mask) mask.style.display = 'flex';
    return false;
  }
};

// ── M7.2 主题（深色模式）───────────────────────────────
const ThemeUI = {
  key: 'at_theme', fontKey: 'at_font',
  themes: [
    { id: 'light', name: '清新绿', desc: '默认浅色' },
    { id: 'warm', name: '晨曦橙', desc: '暖色调' },
    { id: 'ocean', name: '商务蓝', desc: '沉稳专业' },
    { id: 'dark', name: '暗夜绿', desc: '深色护眼' },
    { id: 'midnight', name: '深邃紫', desc: '个性深色' }
  ],
  fonts: [
    { id: 'small', name: '小' }, { id: 'normal', name: '标准' },
    { id: 'large', name: '大' }, { id: 'xlarge', name: '特大' }
  ],
  init() {
    const t = localStorage.getItem(this.key) || 'light';
    document.documentElement.dataset.theme = t;
    const f = localStorage.getItem(this.fontKey) || 'normal';
    document.documentElement.dataset.font = f;
    this.updateLabels();
  },
  updateLabels() {
    const t = document.documentElement.dataset.theme;
    const f = document.documentElement.dataset.font;
    const el = document.getElementById('me-theme-state');
    if (el) el.textContent = (this.themes.find(x => x.id === t) || {}).name || t;
    const fe = document.getElementById('me-font-state');
    if (fe) fe.textContent = (this.fonts.find(x => x.id === f) || {}).name || f;
  },
  open() {
    const cur = document.documentElement.dataset.theme;
    const curF = document.documentElement.dataset.font;
    openModal(`
      <h4>外观与字号</h4>
      <div class="field"><label>主题</label></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        ${this.themes.map(t => `
          <button class="btn ${t.id === cur ? '' : 'ghost'}" onclick="ThemeUI.setTheme('${t.id}')"
            style="text-align:left;padding:10px 12px">
            <b>${t.name}</b><br><span class="hint">${t.desc}</span></button>`).join('')}
      </div>
      <div class="field"><label>字号</label></div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        ${this.fonts.map(f => `
          <button class="chip ${f.id === curF ? 'active' : ''}" onclick="ThemeUI.setFont('${f.id}')">${f.name}</button>`).join('')}
      </div>
      <button class="btn block" onclick="closeModal()">完成</button>`);
  },
  setTheme(id) {
    document.documentElement.dataset.theme = id;
    localStorage.setItem(this.key, id);
    this.open();
    Overview.load();
  },
  setFont(id) {
    document.documentElement.dataset.font = id;
    localStorage.setItem(this.fontKey, id);
    this.open();
  }
};

// ── M7.2 多账本 ────────────────────────────────────────
let CURRENT_BOOK = Number(localStorage.getItem('at_book') || 1);
const BookUI = {
  async list() {
    try { return await api('/books'); } catch (e) { return []; }
  },
  async renderSwitch() {
    const box = document.getElementById('book-switch');
    if (!box) return;
    const books = await this.list();
    if (books.length <= 1) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="hint" style="margin-right:4px">账本</span>' + books.map(b =>
      `<button class="chip ${b.id === CURRENT_BOOK ? 'active' : ''}" onclick="BookUI.switchTo(${b.id})">${b.name}</button>`).join('');
  },
  async switchTo(id) {
    CURRENT_BOOK = id;
    localStorage.setItem('at_book', String(id));
    this.renderSwitch();
    Ledger.reload();
    Ledger.renderPools();
    BudgetUI.load(); RecurUI.load();
    toast('已切换到账本');
  },
  open() {
    this.render();
  },
  async render() {
    const books = await this.list();
    openModal(`
      <h4>账本管理</h4>
      <div style="font-size:12px;color:var(--dim);margin-bottom:10px">流水按账本隔离，预算/周期/报表按当前账本统计</div>
      ${books.map(b => `
        <div class="mini-item">
          <div style="flex:1">${b.name} ${b.is_default ? '<span class="tag-pill hot">默认</span>' : ''}
            <div style="font-size:11px;color:var(--dim)">${b.record_count} 笔流水</div></div>
          <button class="btn xs ghost" onclick="BookUI.rename(${b.id})">重命名</button>
          ${b.is_default ? '' : `<button class="btn xs ghost" onclick="BookUI.setDefault(${b.id})">设默认</button>`}
          <button class="btn xs ghost" onclick="BookUI.del(${b.id})">删除</button>
        </div>`).join('')}
      <div class="field" style="margin-top:10px"><label>新建账本</label>
        <div style="display:flex;gap:8px"><input id="bk-name" type="text" placeholder="如 家庭 / 工作" style="flex:1">
        <button class="btn" onclick="BookUI.add()">新建</button></div></div>
      <button class="btn block" onclick="closeModal()">完成</button>`);
  },
  async add() {
    const name = document.getElementById('bk-name').value.trim();
    if (!name) return toast('请输入账本名', true);
    try { await post('/books', { name }); toast('账本已创建'); this.render(); }
    catch (e) { toast(e.message, true); }
  },
  async rename(id) {
    const book = (await this.list()).find(x => x.id === id);
    if (!book) return;
    openModal(`
      <h4>重命名账本</h4>
      <div class="field"><label>账本名称</label><input id="bk-new-name" type="text" value="${book.name}"></div>
      <button class="btn block" onclick="BookUI.saveRename(${id})">保存</button>`);
    document.getElementById('bk-new-name').focus();
  },
  async saveRename(id) {
    const name = document.getElementById('bk-new-name').value.trim();
    if (!name) return toast('账本名不能为空', true);
    try {
      await put('/books/' + id, { name });
      toast('已重命名');
      this.render(); this.renderSwitch();
      if (id === CURRENT_BOOK) Ledger.reload();
    } catch (e) { toast(e.message, true); }
  },
  async setDefault(id) {
    try {
      await put('/books/' + id, { is_default: 1 });
      // 设默认即切换记账目标账本（修复：此前只改服务端标记，CURRENT_BOOK 未同步导致记账仍进旧账本）
      CURRENT_BOOK = id;
      localStorage.setItem('at_book', String(id));
      this.renderSwitch();
      Ledger.reload(); Ledger.renderPools(); BudgetUI.load(); RecurUI.load();
      toast('已设为默认并切换记账账本');
      this.render();
    } catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该账本？（有流水的账本不可删）'))) return;
    try { await del('/books/' + id); toast('已删除'); this.render(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── M7.2 到期提醒 ──────────────────────────────────────
const RemindUI = {
  async requestPerm() {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
        await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
      }
    } catch (e) {}
  },
  async notify(rows) {
    try {
      if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.LocalNotifications) return;
      const LN = window.Capacitor.Plugins.LocalNotifications;
      await this.requestPerm();
      // 清理旧通知再发新的
      await LN.cancelAll().catch(() => {});
      const pending = rows.filter(r => !r.done && (r.overdue || r.today));
      if (!pending.length) return;
      await LN.schedule({
        notifications: pending.slice(0, 5).map((r, i) => ({
          id: 1000 + i,
          title: r.overdue ? '已逾期提醒' : '今日提醒',
          body: r.name + (r.overdue ? ' 已逾期！' : ' 今天到期')
        }))
      });
    } catch (e) { console.warn('notify fail', e); }
  },
  async load() {
    const rows = await api('/reminders');
    const act = rows.filter(r => !r.done && (r.overdue || r.today || r.within7));
    const card = document.getElementById('ov-remind-card');
    const box = document.getElementById('ov-remind');
    if (!act.length) { card.style.display = 'none'; this.notify([]).catch(()=>{}); return; }
    card.style.display = '';
    box.innerHTML = act.slice(0, 5).map(r => `
      <div class="mini-item">
        <div style="flex:1;min-width:0"><span class="${r.overdue ? 'down' : ''}" style="font-weight:600">${r.name}</span>
          <span style="font-size:11px;color:var(--dim)"> ${r.overdue ? '已逾期' : (r.today ? '今天' : r.remind_date)}</span></div>
        <button class="btn xs ghost" onclick="RemindUI.done(${r.id})">完成</button>
      </div>`).join('');
    this.notify(rows).catch(()=>{});
  },
  async done(id) {
    try { await put('/reminders/' + id, { done: 1 }); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  open() {
    this.render();
  },
  async render() {
    const rows = await api('/reminders');
    openModal(`
      <h4>到期提醒</h4>
      <div style="font-size:12px;color:var(--dim);margin-bottom:10px">信用卡还款日、缴费日、纪念日等</div>
      ${rows.map(r => `
        <div class="mini-item">
          <div style="flex:1;min-width:0"><span style="font-weight:600">${r.name}</span>
            <span style="font-size:11px;color:var(--dim)"> ${r.remind_date}${r.done ? ' · 已完成' : (r.overdue ? ' · 逾期' : '')}</span></div>
          <button class="btn xs ghost" onclick="RemindUI.toggle(${r.id}, ${r.done ? 0 : 1})">${r.done ? '重开' : '完成'}</button>
          <button class="btn xs ghost" onclick="RemindUI.del(${r.id})">删</button>
        </div>`).join('') || '<div class="empty">暂无提醒</div>'}
      <div class="field" style="margin-top:10px"><label>新建提醒</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><input id="rm-name" type="text" placeholder="名称" style="flex:1;min-width:120px">
        <input id="rm-date" type="date" style="flex:1;min-width:130px"><button class="btn" onclick="RemindUI.add()">添加</button></div></div>
      <button class="btn block" onclick="closeModal()">完成</button>`);
  },
  async add() {
    const name = document.getElementById('rm-name').value.trim();
    const d = document.getElementById('rm-date').value;
    if (!name || !d) return toast('请填写名称和日期', true);
    try { await post('/reminders', { name, remind_date: d }); toast('已添加'); this.render(); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async toggle(id, v) {
    try { await put('/reminders/' + id, { done: v }); this.render(); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    try { await del('/reminders/' + id); this.render(); this.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── M7.2 信用卡账单 ────────────────────────────────────
// ── M7.2 还款计划 ──────────────────────────────────────
const CreditUI = {
  open() {
    document.getElementById('credit-view').style.display = '';
    ViewStack.open('credit-view', () => { document.getElementById('credit-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const bills = await api('/credit-bills');
    const pools = PoolUI.list;
    const cards = pools.filter(p => p.kind === 'liability');
    document.getElementById('credit-tool').innerHTML = cards.map(c => `
      <button class="chip ${this.poolId === c.id ? 'active' : ''}" onclick="CreditUI.pool(${c.id})">${c.name}·${c.tail}</button>`).join('') || '<span class="hint">暂无负债账户</span>';
    const pid = this.poolId || cards[0]?.id;
    const list = bills.filter(b => b.pool_id === pid);
    const total = list.reduce((s, b) => s + (b.status !== 'paid' ? b.amount - b.paid_amount : 0), 0);
    document.getElementById('credit-body').innerHTML = `
      <div class="rep-hero"><div><div class="hint">未还合计</div><div class="rep-num down">${fmt(total)}</div></div>
      <div><div class="hint">账单数</div><div class="rep-num">${list.length}</div></div></div>
      ${list.length ? list.map(b => `
        <div class="card">
          <div class="card-title">${b.month} 账单 <span class="${b.status === 'paid' ? 'up' : b.status === 'overdue' ? 'down' : ''}">${b.status === 'paid' ? '已还清' : b.status === 'overdue' ? '逾期' : '待还'}</span>
            <span class="hint" style="float:right">还款日 ${b.due_date}</span></div>
          <div style="font-size:12.5px;line-height:1.9">账单金额 <b>${fmt(b.amount)}</b> · 最低还款 ${fmt(b.min_amount)}<br>
            已还 <b>${fmt(b.paid_amount)}</b> · 剩余 <b class="${b.amount - b.paid_amount > 0 ? 'down' : 'up'}">${fmt(Math.max(0, b.amount - b.paid_amount))}</b></div>
          ${b.status !== 'paid' ? `<div class="op-row" style="margin-top:8px">
            <button class="btn" onclick="CreditUI.pay(${b.id})">还款</button>
            <button class="btn ghost" onclick="CreditUI.edit(${b.id})">编辑</button>
            <button class="btn danger ghost" onclick="CreditUI.del(${b.id})">删除</button></div>` : ''}
        </div>`).join('') : '<div class="empty">该账户暂无账单</div>'}`;
  },
  pool(id) { this.poolId = id; this.load(); },
  openNew() {
    const cards = PoolUI.list.filter(p => p.kind === 'liability');
    openModal(`
      <h4>新建账单</h4>
      <div class="field"><label>信用卡账户</label><select id="cb-pool" class="sel">${cards.map(c => `<option value="${c.id}">${c.name}·${c.tail}</option>`).join('')}</select></div>
      <div class="field"><label>账单月份</label><input id="cb-month" type="month"></div>
      <div class="field"><label>还款日</label><input id="cb-due" type="date"></div>
      <div class="field"><label>账单金额</label><input id="cb-amount" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>最低还款</label><input id="cb-min" type="number" step="0.01" placeholder="0.00"></div>
      <button class="btn block" onclick="CreditUI.saveNew()">保存账单</button>`);
  },
  async saveNew() {
    const pool_id = Number(document.getElementById('cb-pool').value);
    const month = document.getElementById('cb-month').value;
    const due_date = document.getElementById('cb-due').value;
    const amount = Number(document.getElementById('cb-amount').value);
    const min_amount = Number(document.getElementById('cb-min').value) || 0;
    if (!month || !due_date || !amount) return toast('月份/还款日/金额必填', true);
    try {
      await post('/credit-bills', { pool_id, month, due_date, amount, min_amount });
      closeModal(); toast('账单已添加'); this.poolId = pool_id; this.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  },
  async pay(id) {
    const bills = await api('/credit-bills');
    const b = bills.find(x => x.id === id);
    if (!b) return;
    const remain = b.amount - b.paid_amount;
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    openModal(`
      <h4>还款 · ${b.month}</h4>
      <div style="font-size:12.5px;color:var(--dim);margin-bottom:10px">剩余应还 <b class="down">${fmt(remain)}</b>（已还 ${fmt(b.paid_amount)}）</div>
      <div class="field"><label>还款金额</label><input id="cp-amount" type="number" step="0.01" value="${remain}" max="${remain}"></div>
      <div class="field"><label>扣款账户</label><select id="cp-pool" class="sel">${pools.map(p => `<option value="${p.id}">${p.name}·${p.tail}（余额 ${fmt(p.balance)}）</option>`).join('')}</select></div>
      <button class="btn block" onclick="CreditUI.doPay(${id})">确认还款</button>`);
  },
  async doPay(id) {
    const amount = Number(document.getElementById('cp-amount').value);
    const from_pool_id = Number(document.getElementById('cp-pool').value);
    if (!amount || amount <= 0) return toast('请输入还款金额', true);
    try {
      await post('/credit-bills/' + id + '/pay', { amount, from_pool_id });
      closeModal(); toast('还款成功'); this.load(); PoolUI.load(); Overview.load(); Ledger.reload();
    } catch (e) { toast(e.message, true); }
  },
  async edit(id) {
    const bills = await api('/credit-bills');
    const b = bills.find(x => x.id === id);
    if (!b) return;
    openModal(`
      <h4>编辑账单 ${b.month}</h4>
      <div class="field"><label>还款日</label><input id="cb-due" type="date" value="${b.due_date}"></div>
      <div class="field"><label>账单金额</label><input id="cb-amount" type="number" step="0.01" value="${b.amount}"></div>
      <div class="field"><label>最低还款</label><input id="cb-min" type="number" step="0.01" value="${b.min_amount}"></div>
      <div class="field"><label>状态</label><select id="cb-status" class="sel"><option value="open" ${b.status === 'open' ? 'selected' : ''}>待还</option><option value="paid" ${b.status === 'paid' ? 'selected' : ''}>已还清</option><option value="overdue" ${b.status === 'overdue' ? 'selected' : ''}>逾期</option></select></div>
      <button class="btn block" onclick="CreditUI.saveEdit(${id})">保存</button>`);
  },
  async saveEdit(id) {
    const body = {
      due_date: document.getElementById('cb-due').value,
      amount: Number(document.getElementById('cb-amount').value),
      min_amount: Number(document.getElementById('cb-min').value) || 0,
      status: document.getElementById('cb-status').value
    };
    try { await put('/credit-bills/' + id, body); closeModal(); toast('已保存'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该账单？'))) return;
    try { await del('/credit-bills/' + id); toast('已删除'); this.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── M7.2 还款计划 ──────────────────────────────────────

const RepayUI = {
  open() {
    document.getElementById('repay-view').style.display = '';
    ViewStack.open('repay-view', () => { document.getElementById('repay-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const [plans, bills, pools] = await Promise.all([api('/repayments'), api('/credit-bills'), api('/pools')]);
    const pname = id => (pools.find(p => p.id === id) || {}).name || '—';
    const cards = pools.filter(p => p.kind === 'liability');
    const today = new Date();
    // 信用卡未还账单 → 还款计划（按还款日排序 + 逾期可视化）
    const cr = bills.filter(b => b.status !== 'paid').map(b => {
      const due = new Date((b.due_date || '') + 'T00:00:00');
      const diff = Math.round((due - today) / 86400000);
      const pool = cards.find(c => c.id === b.pool_id);
      return { ...b, diff, remain: b.amount - b.paid_amount, poolName: pool ? pool.name + '·' + pool.tail : '—' };
    }).sort((a, b) => a.diff - b.diff);
    const crTotal = cr.reduce((s, r) => s + r.remain, 0);
    const crOver = cr.filter(r => r.diff < 0 && r.remain > 0);
    let html = '';
    if (cr.length) {
      html += `<div class="rep-hero">
          <div><div class="hint">信用卡未还</div><div class="rep-num down">¥${fmt(crTotal)}</div></div>
          <div><div class="hint">逾期笔数</div><div class="rep-num ${crOver.length ? 'up' : ''}">${crOver.length}</div></div>
        </div>` + cr.map(r => `
        <div class="card" style="margin-top:8px">
          <div class="card-title">${r.month} 账单 · ${r.poolName}
            <span class="${r.diff < 0 ? 'down' : r.diff <= 7 ? 'up' : ''}" style="float:right">${r.diff < 0 ? '已逾期 ' + (-r.diff) + ' 天' : r.diff === 0 ? '今日到期' : r.diff + ' 天后到期'}</span>
          </div>
          <div style="font-size:12.5px;line-height:1.9">还款日 <b>${r.due_date || '—'}</b> · 剩余应还 <b class="down">¥${fmt(r.remain)}</b></div>
          <div class="op-row" style="margin-top:8px">
            <button class="btn" onclick="CreditUI.pay(${r.id})">立即还款</button>
            <button class="btn ghost" onclick="CreditUI.edit(${r.id})">编辑</button></div>
        </div>`).join('');
    }
    html += `<div class="sect" style="margin:12px 4px 4px">贷款 / 分期还款计划</div>`;
    html += plans.length ? plans.map(p => {
      const remaining = p.total * (1 - p.paid_months / p.months);
      const pct = Math.min(100, p.paid_months / p.months * 100);
      return `
      <div class="card">
        <div class="card-title">${p.name} <span class="${p.status === 'done' ? 'up' : ''}">${p.status === 'done' ? '已完成' : (p.status === 'active' ? '进行中' : '已结清')}</span>
          <span class="hint" style="float:right">年利率 ${p.annual_rate}%</span></div>
        <div style="font-size:12.5px;line-height:1.9">本金 <b>${fmt(p.total)}</b> · 月供 <b>${fmt(p.monthly)}</b> · ${p.months} 期<br>
          已还 ${p.paid_months}/${p.months} 期 · 剩余本金约 <b>${fmt(remaining)}</b></div>
        <div class="bdg-progress" style="margin-top:6px"><div style="height:100%;width:${pct}%;background:var(--key);border-radius:5px"></div></div>
        ${p.status === 'active' ? `<div class="op-row" style="margin-top:8px">
          <button class="btn" onclick="RepayUI.pay(${p.id})">还一期（${fmt(p.monthly)}）</button>
          <button class="btn ghost" onclick="RepayUI.edit(${p.id})">编辑</button>
          <button class="btn danger ghost" onclick="RepayUI.del(${p.id})">删除</button></div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">暂无贷款 / 分期还款计划</div>';
    document.getElementById('repay-body').innerHTML = html;
  },
  openNew() {
    openModal(`
      <h4>新建还款计划</h4>
      <div class="op-row" style="justify-content:center">
        <button class="btn" onclick="closeModal();CreditUI.openNew()">信用卡账单</button>
        <button class="btn ghost" onclick="closeModal();RepayUI.openLoanNew()">贷款 / 分期</button>
      </div>`);
  },
  openLoanNew() {
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    openModal(`
      <h4>新建贷款 / 分期计划</h4>
      <div class="field"><label>名称（如 房贷/车贷）</label><input id="rp-name" type="text" placeholder="房贷"></div>
      <div class="field"><label>本金总额</label><input id="rp-total" type="number" step="0.01" placeholder="500000"></div>
      <div class="field"><label>年利率（%）</label><input id="rp-rate" type="number" step="0.01" placeholder="3.9"></div>
      <div class="field"><label>期数（月）</label><input id="rp-months" type="number" placeholder="360"></div>
      <div class="field"><label>开始月份</label><input id="rp-start" type="month"></div>
      <div class="field"><label>扣款账户</label><select id="rp-pool" class="sel">${pools.map(p => `<option value="${p.id}">${p.name}·${p.tail}</option>`).join('')}</select></div>
      <button class="btn block" onclick="RepayUI.saveNew()">生成计划（自动算月供）</button>`);
  },
  async saveNew() {
    const body = {
      name: document.getElementById('rp-name').value.trim(),
      total: Number(document.getElementById('rp-total').value),
      annual_rate: Number(document.getElementById('rp-rate').value) || 0,
      months: Number(document.getElementById('rp-months').value),
      start_month: document.getElementById('rp-start').value || null,
      pool_id: Number(document.getElementById('rp-pool').value)
    };
    if (!body.name || !body.total || body.total <= 0 || !body.months || body.months <= 0) return toast('名称/本金/期数必填', true);
    try {
      const r = await post('/repayments', body);
      closeModal(); toast(`计划已创建，月供 ¥${fmt(r.plan.monthly)}`); this.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  },
  async pay(id) {
    if (!(await appConfirm('确认从扣款账户扣除一期月供？'))) return;
    try { await post('/repayments/' + id + '/pay', {}); toast('已还一期'); this.load(); PoolUI.load(); Overview.load(); Ledger.reload(); }
    catch (e) { toast(e.message, true); }
  },
  async edit(id) {
    const plans = await api('/repayments');
    const p = plans.find(x => x.id === id);
    if (!p) return;
    openModal(`
      <h4>编辑 ${p.name}</h4>
      <div class="field"><label>名称</label><input id="rp-name" type="text" value="${p.name}"></div>
      <div class="field"><label>本金总额</label><input id="rp-total" type="number" step="0.01" value="${p.total}"></div>
      <div class="field"><label>年利率（%）</label><input id="rp-rate" type="number" step="0.01" value="${p.annual_rate}"></div>
      <div class="field"><label>期数</label><input id="rp-months" type="number" value="${p.months}"></div>
      <div class="field"><label>已还期数</label><input id="rp-paid" type="number" value="${p.paid_months}"></div>
      <button class="btn block" onclick="RepayUI.saveEdit(${id})">保存</button>`);
  },
  async saveEdit(id) {
    const body = {
      name: document.getElementById('rp-name').value.trim(),
      total: Number(document.getElementById('rp-total').value),
      annual_rate: Number(document.getElementById('rp-rate').value) || 0,
      months: Number(document.getElementById('rp-months').value),
      paid_months: Number(document.getElementById('rp-paid').value) || 0
    };
    try { await put('/repayments/' + id, body); closeModal(); toast('已保存'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该还款计划？'))) return;
    try { await del('/repayments/' + id); toast('已删除'); this.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── M7.2 储蓄目标 ──────────────────────────────────────
function goalMonthsLeft(deadline) {
  if (!deadline) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const d = new Date(deadline + 'T00:00:00');
  const m = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  return m < 0 ? 0 : m;
}
function goalMonthlySuggest(g) {
  if (!g.deadline) return null;
  const m = goalMonthsLeft(g.deadline);
  if (m <= 0) return null; // 已到期
  return Math.max(0, (g.target_amount - g.current_amount) / m);
}
const GoalUI = {
  open() {
    document.getElementById('goal-view').style.display = '';
    ViewStack.open('goal-view', () => { document.getElementById('goal-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const goals = await api('/goals');
    const pools = PoolUI.list;
    const pname = id => (pools.find(p => p.id === id) || {}).name || '—';
    // 总览小卡
    const ov = document.getElementById('ov-goals');
    if (ov) ov.innerHTML = goals.length ? goals.slice(0, 4).map(g => {
      const pct = Math.min(100, g.current_amount / g.target_amount * 100);
      return `<div class="mini-item"><div style="flex:1;min-width:0"><span style="font-weight:600">${g.name}</span>
        <div style="display:flex;align-items:center;gap:6px;margin:4px 0 2px"><div class="bdg-progress" style="flex:1"><div style="height:100%;width:${pct}%;background:var(--key);border-radius:5px"></div></div><span style="font-size:11px;font-weight:600;color:var(--key);min-width:38px;text-align:right">${pct.toFixed(0)}%</span></div>
        <div style="font-size:11px;color:var(--dim)">${fmt(g.current_amount)}/${fmt(g.target_amount)}${g.status === 'done' ? ' · 已完成' : ''}</div></div></div>`;
    }).join('') : '<div class="empty">暂无储蓄目标，点「管理」创建</div>';
    // 资产域小卡（重构迁入）
    const as = document.getElementById('as-goals');
    if (as) as.innerHTML = goals.length ? goals.map(g => {
      const pct = Math.min(100, g.current_amount / g.target_amount * 100);
      return `<div class="mini-item"><div style="flex:1;min-width:0"><span style="font-weight:600">${g.name}</span>
        <div style="display:flex;align-items:center;gap:6px;margin:4px 0 2px"><div class="bdg-progress" style="flex:1"><div style="height:100%;width:${pct}%;background:var(--key);border-radius:5px"></div></div><span style="font-size:11px;font-weight:600;color:var(--key);min-width:38px;text-align:right">${pct.toFixed(0)}%</span></div>
        <div style="font-size:11px;color:var(--dim)">${fmt(g.current_amount)}/${fmt(g.target_amount)}${g.status === 'done' ? ' · 已完成' : ''}</div>
        ${goalMonthlySuggest(g) ? `<div style="font-size:11px;color:var(--key)">每月建议 ¥${fmt(goalMonthlySuggest(g))}</div>` : ''}</div></div>`;
    }).join('') : '<div class="empty">暂无储蓄目标，点「管理」创建</div>';
    // 全屏
    document.getElementById('goal-body').innerHTML = goals.length ? goals.map(g => {
      const pct = Math.min(100, g.current_amount / g.target_amount * 100);
      return `
      <div class="card">
        <div class="card-title">${g.name} <span class="${g.status === 'done' ? 'up' : ''}">${g.status === 'done' ? '已达成' : '进行中'}</span>
          ${g.deadline ? `<span class="hint" style="float:right">目标日 ${g.deadline}</span>` : ''}</div>
        <div style="font-size:12.5px;line-height:1.9">已存 <b>${fmt(g.current_amount)}</b> / ${fmt(g.target_amount)}（${pct.toFixed(1)}%）<br>
          ${g.pool_id ? `关联账户 ${pname(g.pool_id)}` : '未关联账户'}
          ${g.deadline ? ` · 距目标日 ${goalMonthsLeft(g.deadline)} 个月` : ''}</div>
        ${goalMonthlySuggest(g) ? `<div class="hint" style="margin-top:4px">每月建议存 <b class="up">¥${fmt(goalMonthlySuggest(g))}</b>（${goalMonthsLeft(g.deadline)} 个月达成）</div>` : g.deadline ? '<div class="hint" style="margin-top:4px">目标日期已到，可调整目标日或金额</div>' : ''}
        <div class="bdg-progress" style="margin-top:6px"><div style="height:100%;width:${pct}%;background:${pct >= 100 ? 'var(--key)' : '#e8a13a'};border-radius:5px"></div></div>
        ${g.status !== 'done' ? `<div class="op-row" style="margin-top:8px">
          <button class="btn" onclick="GoalUI.deposit(${g.id})">存入</button>
          <button class="btn ghost" onclick="GoalUI.edit(${g.id})">编辑</button></div>` : ''}
        <button class="btn danger ghost" style="margin-top:6px" onclick="GoalUI.del(${g.id})">删除目标</button>
      </div>`;
    }).join('') : '<div class="empty">暂无储蓄目标，点右上角新建</div>';
  },
  openNew() {
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    openModal(`
      <h4>新建储蓄目标</h4>
      <div class="field"><label>目标名称（如 买车基金/旅行）</label><input id="gl-name" type="text" placeholder="买车基金"></div>
      <div class="field"><label>目标金额</label><input id="gl-target" type="number" step="0.01" placeholder="100000"></div>
      <div class="field"><label>目标日期</label><input id="gl-deadline" type="date"></div>
      <div class="field"><label>关联账户（存入时扣款）</label><select id="gl-pool" class="sel">${pools.map(p => `<option value="${p.id}">${p.name}·${p.tail}</option>`).join('')}</select></div>
      <button class="btn block" onclick="GoalUI.saveNew()">创建目标</button>`);
  },
  async saveNew() {
    const body = {
      name: document.getElementById('gl-name').value.trim(),
      target_amount: Number(document.getElementById('gl-target').value),
      deadline: document.getElementById('gl-deadline').value || null,
      pool_id: Number(document.getElementById('gl-pool').value)
    };
    if (!body.name || !body.target_amount || body.target_amount <= 0) return toast('名称/目标金额必填', true);
    try { await post('/goals', body); closeModal(); toast('目标已创建'); this.load(); Overview.load(); }
    catch (e) { toast(e.message, true); }
  },
  async deposit(id) {
    const goals = await api('/goals');
    const g = goals.find(x => x.id === id);
    if (!g) return;
    const pools = PoolUI.list.filter(p => p.kind === 'asset');
    openModal(`
      <h4>存入「${g.name}」</h4>
      <div style="font-size:12.5px;color:var(--dim);margin-bottom:10px">已存 ${fmt(g.current_amount)} / ${fmt(g.target_amount)}</div>
      <div class="field"><label>存入金额</label><input id="gp-amount" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>扣款账户</label><select id="gp-pool" class="sel">${pools.map(p => `<option value="${p.id}" ${p.id === g.pool_id ? 'selected' : ''}>${p.name}·${p.tail}（余额 ${fmt(p.balance)}）</option>`).join('')}</select></div>
      <button class="btn block" onclick="GoalUI.doDeposit(${id})">确认存入</button>`);
  },
  async doDeposit(id) {
    const amount = Number(document.getElementById('gp-amount').value);
    const pool_id = Number(document.getElementById('gp-pool').value);
    if (!amount || amount <= 0) return toast('请输入金额', true);
    try {
      await post('/goals/' + id + '/deposit', { amount, pool_id });
      closeModal(); toast('已存入'); this.load(); PoolUI.load(); Overview.load(); Ledger.reload();
    } catch (e) { toast(e.message, true); }
  },
  async edit(id) {
    const goals = await api('/goals');
    const g = goals.find(x => x.id === id);
    if (!g) return;
    openModal(`
      <h4>编辑「${g.name}」</h4>
      <div class="field"><label>名称</label><input id="gl-name" type="text" value="${g.name}"></div>
      <div class="field"><label>目标金额</label><input id="gl-target" type="number" step="0.01" value="${g.target_amount}"></div>
      <div class="field"><label>目标日期</label><input id="gl-deadline" type="date" value="${g.deadline || ''}"></div>
      <button class="btn block" onclick="GoalUI.saveEdit(${id})">保存</button>`);
  },
  async saveEdit(id) {
    const body = {
      name: document.getElementById('gl-name').value.trim(),
      target_amount: Number(document.getElementById('gl-target').value),
      deadline: document.getElementById('gl-deadline').value || null
    };
    try { await put('/goals/' + id, body); closeModal(); toast('已保存'); this.load(); Overview.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该目标？'))) return;
    try { await del('/goals/' + id); toast('已删除'); this.load(); Overview.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// ── M7.2 现金流预测 ────────────────────────────────────
const ForecastUI = {
  open() {
    document.getElementById('forecast-view').style.display = '';
    ViewStack.open('forecast-view', () => { document.getElementById('forecast-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const [recurring, budgets, records] = await Promise.all([
      api('/recurring').catch(() => []),
      api('/budgets?month=' + new Date().toISOString().slice(0, 7)).catch(() => null),
      api('/records?limit=500').catch(() => [])
    ]);
    // 近3月均收支（排除资金/转移类）
    const byMonth = {};
    for (const r of records) {
      const m = (r.created_at || '').slice(0, 7);
      if (!m || (r.cat_path || '').startsWith('资金/')) continue;
      byMonth[m] = byMonth[m] || { in: 0, out: 0 };
      if (r.direction === 'income') byMonth[m].in += r.amount; else byMonth[m].out += r.amount;
    }
    const months = Object.keys(byMonth).sort().slice(-3);
    const avg = { in: 0, out: 0 };
    for (const m of months) { avg.in += byMonth[m].in; avg.out += byMonth[m].out; }
    if (months.length) { avg.in /= months.length; avg.out /= months.length; }
    // 周期固定项
    const d0 = new Date();
    const ym = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
    const fix = recurring.filter(r => r.enabled === 1 && (r.last_done_month || '') !== ym);
    const fixIn = fix.filter(r => r.direction === 'income').reduce((s, r) => s + r.amount, 0);
    const fixOut = fix.filter(r => r.direction === 'expense').reduce((s, r) => s + r.amount, 0);
    const series = [];
    for (let i = 1; i <= 6; i++) {
      const dt = new Date(d0.getFullYear(), d0.getMonth() + i, 1);
      const mm = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
      const inc = r2(avg.in + fixIn), out = r2(avg.out + fixOut);
      series.push({ month: mm, income: inc, expense: out, balance: r2(inc - out) });
    }
    let chart = '';
    if (typeof echarts !== 'undefined') {
      chart = '<div id="fc-chart" style="height:210px;margin-top:10px"></div>';
      setTimeout(() => {
        const el = document.getElementById('fc-chart');
        if (!el) return;
        const c = echarts.init(el);
        c.setOption({
          grid: { left: 44, right: 12, top: 18, bottom: 26 },
          legend: { data: ['收入', '支出'], textStyle: { fontSize: 10 } },
          xAxis: { type: 'category', data: series.map(s => s.month.slice(5)), axisLabel: { fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { fontSize: 9 } },
          series: [
            { name: '收入', type: 'bar', data: series.map(s => s.income), itemStyle: { color: '#c23a3a' }, barWidth: '30%' },
            { name: '支出', type: 'bar', data: series.map(s => s.expense), itemStyle: { color: '#2f7d5d' }, barWidth: '30%' }
          ]
        });
      }, 30);
    }
    const cum = [];
    let acc = 0;
    for (const s of series) { acc = r2(acc + s.balance); cum.push({ month: s.month, balance: s.balance, cum: acc }); }
    document.getElementById('forecast-body').innerHTML = `
      <div class="rep-hero"><div><div class="hint">月均收入（近3月）</div><div class="rep-num up">${fmt(avg.in)}</div></div>
      <div><div class="hint">月均支出</div><div class="rep-num down">${fmt(avg.out)}</div></div></div>
      <div class="card"><div class="card-title">未来 6 个月预测（均值+周期固定项）</div>${chart || '<div class="hint">图表库未加载</div>'}</div>
      <div class="card"><div class="card-title">逐月明细</div>
        ${cum.map(c => `<div class="mini-item"><div style="flex:1">${c.month}</div>
          <span style="font-size:12px"><span class="up">+${fmt(c.income)}</span> <span class="down">−${fmt(c.expense)}</span>
          <b class="${c.balance >= 0 ? 'up' : 'down'}" style="margin-left:6px">${c.balance >= 0 ? '+' : ''}${fmt(c.balance)}</b></span></div>`).join('')}
        <div class="mini-item" style="font-weight:700"><div style="flex:1">6 个月累计结余</div><span class="${acc >= 0 ? 'up' : 'down'}">${acc >= 0 ? '+' : ''}${fmt(acc)}</span></div>
      </div>
      <div class="hint" style="padding:0 14px 14px">说明：预测=近 3 个月实际收支均值 + 周期记账固定项；不计入一次性大额收支。</div>`;
  }
};

// ── M7.2 投资收益分析（XIRR）───────────────────────────
const XirrUI = {
  open(assetId) {
    this.assetId = assetId;
    document.getElementById('xirr-view').style.display = '';
    ViewStack.open('xirr-view', () => { document.getElementById('xirr-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    let flows, xr;
    try {
      [flows, xr] = await Promise.all([
        api('/invest-cashflows?asset_id=' + this.assetId),
        api('/invest-cashflows/xirr?asset_id=' + this.assetId)
      ]);
    } catch (e) {
      document.getElementById('xirr-body').innerHTML =
        '<div class="empty">加载失败：' + e.message + '（请确认投资资产存在）</div>';
      return;
    }
    const totalIn = flows.reduce((s, f) => s + Math.max(0, f.amount), 0);
    const totalOut = flows.reduce((s, f) => s + Math.min(0, f.amount), 0);
    const gain = r2(xr.market - totalIn + totalOut);
    document.getElementById('xirr-body').innerHTML = `
      <div class="rep-hero">
        <div><div class="hint">${xr.asset}（${xr.kind}）当前市值</div><div class="rep-num up">${fmt(xr.market)}</div></div>
        <div><div class="hint">累计收益（含赎回）</div><div class="rep-num ${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : ''}${fmt(gain)}</div></div>
        <div class="rep-bal">XIRR 年化收益率 <b class="${(xr.xirr_pct ?? 0) >= 0 ? 'up' : 'down'}">${xr.xirr_pct === null ? '数据不足' : xr.xirr_pct + '%'}</b>
          <span class="hint">投入 ${fmt(xr.invested)} · 已赎回 ${fmt(xr.redeemed)}</span></div>
      </div>
      <div class="card"><div class="card-title">现金流记录 <span class="hint">正=投入 · 负=赎回</span>
        <button class="btn ghost" style="float:right" onclick="XirrUI.add()">+ 记录</button></div>
        ${flows.length ? flows.map(f => `
          <div class="mini-item"><div style="flex:1;min-width:0"><span style="font-weight:600">${f.date}</span>
            <span style="font-size:11px;color:var(--dim)">${f.note || ''}</span></div>
          <span class="${f.amount >= 0 ? 'amt-out' : 'amt-in'}">${f.amount >= 0 ? '+' : '−'}${fmt(Math.abs(f.amount))}</span>
          <button class="btn xs ghost" onclick="XirrUI.del(${f.id})">删</button></div>`).join('') : '<div class="empty">暂无现金流记录，至少 2 条（如买入/加仓）才能计算 XIRR</div>'}
      </div>
      <div class="hint" style="padding:0 14px 14px">口径：XIRR 以现金流日期精确计算年化内部收益率；当前市值视为期末赎回现金流。仅投入未产生现金流或现金流<2 条时不计算。</div>`;
  },
  add() {
    openModal(`
      <h4>记录现金流</h4>
      <div class="field"><label>日期</label><input id="cf-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>金额（投入填正数，赎回填负数）</label><input id="cf-amount" type="number" step="0.01" placeholder="10000"></div>
      <div class="field"><label>备注</label><input id="cf-note" type="text" placeholder="买入/加仓/赎回"></div>
      <button class="btn block" onclick="XirrUI.save()">保存</button>`);
  },
  async save() {
    const body = {
      asset_id: this.assetId,
      date: document.getElementById('cf-date').value,
      amount: Number(document.getElementById('cf-amount').value),
      note: document.getElementById('cf-note').value.trim() || null
    };
    if (!body.date || !body.amount || isNaN(body.amount)) return toast('日期/金额必填', true);
    try { await post('/invest-cashflows', body); closeModal(); toast('已记录'); this.load(); }
    catch (e) { toast(e.message, true); }
  },
  async del(id) {
    if (!(await appConfirm('确认删除该条现金流？'))) return;
    try { await del('/invest-cashflows/' + id); toast('已删除'); this.load(); }
    catch (e) { toast(e.message, true); }
  }
};

// M7.2 主题初始化（文件末尾：确保所有 const 已定义）

// ── 视图返回栈：二级页返回（左滑跟手滑动 + 系统返回键/浏览器后退）──
const ViewStack = {
  stack: [],
  open(id, closeFn) {
    if (this.stack.length && this.stack[this.stack.length - 1].id === id) return;
    const v = document.getElementById(id);
    if (v) { v.style.transform = ''; v.style.opacity = ''; }
    this.stack.push({ id, close: closeFn });
    try { history.pushState({ v: id }, '', '#' + id); } catch (e) {}
  },
  _backing: false,
  close() {
    if (!this.stack.length) return;
    const top = this.stack.pop();
    top.close();
    this._backing = true;
    try { history.back(); } catch (e) { this._backing = false; }
  },
  _pop(silent) {
    if (this._backing) { this._backing = false; return true; }
    const m = document.querySelector('.modal-mask');
    if (m && getComputedStyle(m).display !== 'none') { closeModal(); return true; }
    if (!this.stack.length) return false;
    const top = this.stack.pop();
    top.close();
    return true;
  }
};
window.addEventListener('popstate', () => ViewStack._pop());
// 原生返回键入口（MainActivity 调用）：返回 true=已消费返回键，false=无内容可退
window.__handleBack = function () { return ViewStack._pop(true) ? true : false; };
// 左缘右滑：跟手位移 + 松手回弹/滑出
(function () {
  let gx = null, gy = null, el = null, moving = false;
  const VIEW_IDS = new Set(['book-report-view','report-view','pool-detail-view','arap-view','credit-view','repay-view','goal-view','forecast-view','xirr-view','trend-view','portfolio-view','paycal-view']);
  document.addEventListener('touchstart', function (e) {
    const t = e.touches[0];
    if (t.clientX <= 28 && ViewStack.stack.length) {
      const top = ViewStack.stack[ViewStack.stack.length - 1];
      const v = document.getElementById(top.id);
      if (!v || !VIEW_IDS.has(top.id)) return;
      gx = t.clientX; gy = t.clientY; el = v; moving = true;
      v.style.transition = 'none';
    }
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!moving) return;
    const t = e.touches[0];
    let dx = t.clientX - gx;
    if (dx < 0) dx = 0;
    el.style.transform = 'translateX(' + dx + 'px)';
    el.style.opacity = String(Math.max(0.35, 1 - dx / 340));
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', function (e) {
    if (!moving) return;
    moving = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - gx, dy = t.clientY - gy;
    const v = el; gx = null; gy = null; el = null;
    const ok = dx > 88 && Math.abs(dy) < dx * 0.7;
    v.style.transition = 'transform .2s ease, opacity .2s ease';
    if (ok) {
      v.style.transform = 'translateX(100%)';
      v.style.opacity = '0';
      setTimeout(function () {
        v.style.transform = ''; v.style.opacity = '';
        ViewStack.close();
      }, 200);
    } else {
      v.style.transform = 'translateX(0)';
      v.style.opacity = '1';
    }
  }, { passive: true });
})();

ThemeUI.init();

// ── M7.1 净资产趋势（完整视图）─────────────────────────
const NetTrendUI = {
  daysVal: 90,
  open() {
    document.getElementById('trend-view').style.display = '';
    ViewStack.open('trend-view', () => { document.getElementById('trend-view').style.display = 'none'; });
    document.querySelectorAll('#trend-view .seg-btn').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.days) === this.daysVal));
    this.load();
  },
  close() { ViewStack.close(); },
  days(d) {
    this.daysVal = d;
    document.querySelectorAll('#trend-view .seg-btn').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.days) === d));
    this.load();
  },
  async load() {
    const body = document.getElementById('trend-body');
    try {
      const r = await api('/net-trend?days=' + this.daysVal);
      if (!r.count) {
        body.innerHTML = '<div class="empty" style="margin:40px 16px">暂无净值快照：每日打开应用会自动记录当日净资产，连续使用数日后即可查看趋势</div>';
        return;
      }
      const range = this.daysVal ? `近 ${this.daysVal} 日` : '全部历史';
      const pts = r.points;
      const dates = pts.map(p => p.date.slice(5));
      let chart = '';
      if (typeof echarts !== 'undefined') {
        chart = '<div id="nt-chart" style="height:240px;margin-top:10px"></div>';
        setTimeout(() => {
          const el = document.getElementById('nt-chart');
          if (!el) return;
          const c = echarts.init(el);
          c.setOption({
            grid: { left: 46, right: 12, top: 20, bottom: 24 },
            legend: { data: ['净资产', '现金', '投资', '固定'], textStyle: { fontSize: 9 } },
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 9, interval: Math.max(0, Math.floor(dates.length / 8) - 1) } },
            yAxis: { type: 'value', axisLabel: { fontSize: 9, formatter: v => (v >= 10000 ? (v / 10000) + 'w' : v) } },
            series: [
              { name: '净资产', type: 'line', data: pts.map(p => p.net), smooth: true, lineStyle: { width: 2.5 }, itemStyle: { color: '#2d6a4f' } },
              { name: '现金', type: 'line', data: pts.map(p => p.cash), smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#c23a3a' } },
              { name: '投资', type: 'line', data: pts.map(p => p.invest), smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#e8a13a' } },
              { name: '固定', type: 'line', data: pts.map(p => p.fixed), smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#7a5a3a' } }
            ]
          });
        }, 30);
      }
      body.innerHTML = `
        <div class="rep-hero">
          <div><div class="hint">${range} 净资产</div><div class="rep-num up">¥${fmt(r.last.net)}</div></div>
          <div><div class="hint">区间变动</div><div class="rep-num ${r.change >= 0 ? 'up' : 'down'}">${r.change >= 0 ? '+' : ''}${fmt(r.change)}</div></div>
          <div class="rep-bal">首日 ¥${fmt(r.first.net)} → 最新 ¥${fmt(r.last.net)}
            ${r.change_pct !== null ? `<span class="${r.change_pct >= 0 ? 'up' : 'down'}">（${r.change_pct >= 0 ? '+' : ''}${r.change_pct}%）</span>` : ''}
            · ${r.count} 个记录日</div>
        </div>
        <div class="card"><div class="card-title">净资产与构成趋势</div>${chart || '<div class="hint">图表库未加载</div>'}</div>
        <div class="card"><div class="card-title">构成明细 <span class="hint">现金 / 投资 / 固定</span></div>
          ${pts.slice(-14).reverse().map(p => `
            <div class="mini-item"><div style="flex:1">${p.date}</div>
              <span style="font-size:12px"><span class="up">现 ${fmt(p.cash)}</span> · <span style="color:#e8a13a">投 ${fmt(p.invest)}</span> · <span style="color:#7a5a3a">固 ${fmt(p.fixed)}</span>
              <b class="up" style="margin-left:6px">${fmt(p.net)}</b></span></div>`).join('')}
        </div>
        <div class="hint" style="padding:0 14px 14px">口径：净资产=现金账户净值（资产-负债）+投资市值+固定资产估值；每日打开应用自动记录一条快照。</div>`;
    } catch (e) {
      body.innerHTML = '<div class="empty">加载失败：' + e.message + '</div>';
    }
  }
};

// ── 批A 快捷记账模板 ──────────────────────────────────
const TplUI = {
  list: [],
  async load() {
    try { this.list = await api('/templates'); } catch (_) { this.list = []; }
    const bar = document.getElementById('tpl-bar');
    if (!bar) return;
    bar.innerHTML = this.list.length ? this.list.map(t => `
      <span class="tpl-item ${t.direction}" onclick="TplUI.run(${t.id})">
        ${t.name} <span class="amt">${t.direction === 'income' ? '+' : '−'}${fmt(t.amount)}</span>
        <span class="del" onclick="event.stopPropagation();TplUI.edit(${t.id})">✎</span>
      </span>`).join('') : '<span class="hint">无模板，点「＋ 模板」创建</span>';
  },
  async run(id) {
    const t = this.list.find(x => x.id === id);
    if (!t) return;
    if (!(await appConfirm(`一键记账：${t.name} ${t.direction === 'income' ? '+' : '−'}¥${fmt(t.amount)} → 入账「${PoolUI.list.find(p => p.id === t.pool_id)?.name || ''}」？`))) return;
    try {
      await post('/records', { direction: t.direction, amount: t.amount, cat_path: t.cat_path, cat_leaf_id: t.cat_leaf_id, pool_id: t.pool_id, remark: t.remark || null, book_id: CURRENT_BOOK });
      toast(`已记 ${t.name} ${fmt(t.amount)}`); Ledger.reload(); PoolUI.load(); Overview.load(); BudgetUI.load();
    } catch (e) { toast(e.message, true); }
  },
  openForm(t) {
    const pools = PoolUI.list;
    const cats = Ledger.tree.filter(c => c.lvl === 2);
    openModal(`
      <h4>${t ? '编辑模板' : '新建快捷模板'}</h4>
      <div class="field"><label>名称</label><input id="tpl-name" value="${t?.name || ''}" placeholder="如 早餐"></div>
      <div class="field"><label>金额</label><input id="tpl-amount" type="number" step="0.01" value="${t?.amount ?? ''}"></div>
      <div class="field"><label>方向</label><select id="tpl-dir">
        <option value="expense" ${t?.direction === 'income' ? '' : 'selected'}>支出</option>
        <option value="income" ${t?.direction === 'income' ? 'selected' : ''}>收入</option>
      </select></div>
      <div class="field"><label>分类</label><select id="tpl-cat">
        ${cats.filter(c => !t || c.direction === t.direction).map(c => `<option value="${c.id}" ${(t?.cat_leaf_id === c.id || (!t && c.name === '正餐')) ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select></div>
      <div class="field"><label>入账账户</label><select id="tpl-pool">
        ${pools.filter(p => p.kind === 'asset').map(p => `<option value="${p.id}" ${t?.pool_id === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select></div>
      <div class="field"><label>备注（可选）</label><input id="tpl-remark" value="${t?.remark || ''}"></div>
      <button class="btn block" onclick="TplUI.save(${t?.id || 0})">保存</button>`);
  },
  async save(id) {
    const c2 = Ledger.tree.find(c => c.id === Number(document.getElementById('tpl-cat').value));
    const body = {
      name: document.getElementById('tpl-name').value.trim(),
      amount: parseFloat(document.getElementById('tpl-amount').value),
      direction: document.getElementById('tpl-dir').value,
      cat_path: [document.getElementById('tpl-dir').value === 'expense' ? '支出' : '收入', c2?.name].filter(Boolean).join('/'),
      cat_leaf_id: c2?.id || null,
      pool_id: Number(document.getElementById('tpl-pool').value),
      remark: document.getElementById('tpl-remark').value.trim() || null
    };
    if (!body.name || isNaN(body.amount) || body.amount < 0 || !body.cat_path.includes('/')) return toast('名称/金额/分类必填', true);
    try {
      if (id) await put('/templates/' + id, body); else await post('/templates', body);
      closeModal(); toast('模板已保存'); this.load();
    } catch (e) { toast(e.message, true); }
  },
  async edit(id) {
    const t = this.list.find(x => x.id === id);
    if (!t) return;
    if (await appConfirm(`「${t.name}」：\n确认要删除该模板吗？\n（点取消可编辑）`)) {
      del('/templates/' + id).then(() => { toast('已删除'); this.load(); }).catch(e => toast(e.message, true));
    } else {
      this.openForm(t);
    }
  }
};

// ── 批A 自定义标签 ───────────────────────────────────
const TagUI = {
  allTags: [],
  async load() {
    try { this.allTags = await api('/tags'); } catch (_) { this.allTags = []; }
    this.fillFilter();
  },
  fillFilter() {
    const sel = document.getElementById('rec-f-tag');
    if (!sel) return;
    sel.innerHTML = '<option value="">全部标签</option>' + this.allTags.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  },
  openManage() {
    openModal(`
      <h4>标签管理 <span class="hint">${this.allTags.length} 个</span></h4>
      <div id="tag-list">
        ${this.allTags.map(t => `<div class="mini-item">
          <div style="flex:1"><span class="tag-chip" style="background:${t.color}">${t.name}</span> <span class="dim-s">${t.usage} 条</span></div>
          <input type="color" value="${t.color}" onchange="TagUI.setColor(${t.id}, this.value)" style="width:30px;height:26px;border:none;background:none">
          <button class="btn xs ghost" onclick="TagUI.del(${t.id})">删</button>
        </div>`).join('') || '<div class="empty">暂无标签</div>'}
      </div>
      <div class="field" style="margin-top:10px"><label>新标签名</label><input id="tag-new" placeholder="如 出差 / 家庭 / 医疗"></div>
      <button class="btn block" onclick="TagUI.add()">添加标签</button>`);
  },
  async add() {
    const name = document.getElementById('tag-new').value.trim();
    if (!name) return toast('请输入标签名', true);
    try { await post('/tags', { name }); toast('已添加'); closeModal(); await this.load(); this.openManage(); }
    catch (e) { toast(e.message, true); }
  },
  async setColor(id, color) {
    try { await put('/tags/' + id, { color }); await this.load(); } catch (e) { /* 忽略 */ }
  },
  async del(id) {
    if (!(await appConfirm('删除标签？关联流水不受影响。'))) return;
    try { await del('/tags/' + id); toast('已删除'); await this.load(); this.openManage(); }
    catch (e) { toast(e.message, true); }
  }
};

// 记账表单标签选择 + 附件 + 记忆上次选择
const RecForm = {
  selTagIds: new Set(),
  attachDataURL: null,
  async openTagPicker() {
    if (!TagUI.allTags.length) { toast('暂无标签，可在「分类管理」旁建标签', true); return; }
    openModal(`
      <h4>选择标签（可多选）</h4>
      <div class="chips" style="flex-wrap:wrap">
        ${TagUI.allTags.map(t => `<span class="chip ${this.selTagIds.has(t.id) ? 'active' : ''}" onclick="RecForm.toggleTag(${t.id}, this)">${t.name}</span>`).join('')}
      </div>
      <button class="btn block" onclick="RecForm.closeTagPicker()">确定</button>`);
  },
  toggleTag(id, el) {
    if (this.selTagIds.has(id)) { this.selTagIds.delete(id); el.classList.remove('active'); }
    else { this.selTagIds.add(id); el.classList.add('active'); }
  },
  closeTagPicker() { closeModal(); this.renderTagChips(); },
  renderTagChips() {
    const box = document.getElementById('rec-tags');
    if (!box) return;
    box.innerHTML = [...this.selTagIds].map(id => {
      const t = TagUI.allTags.find(x => x.id === id);
      return t ? `<span class="chip active" style="background:${t.color};color:#fff">${t.name} ×</span>` : '';
    }).join('') + `<span class="chip" onclick="RecForm.openTagPicker()">＋ 标签</span>`;
  },
  pickAttach() {
    const inp = document.getElementById('rec-attach');
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      if (!f.type.startsWith('image/')) return toast('仅支持图片', true);
      const reader = new FileReader();
      reader.onload = () => {
        this.attachDataURL = reader.result;
        const n = document.getElementById('rec-attach-name');
        if (n) n.textContent = '已选 ' + f.name + (f.size > 300 * 1024 ? '（较大，将压缩）' : '');
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  },
  remember() {
    try {
      const k = 'at_last_form';
      const last = JSON.parse(localStorage.getItem(k) || '{}');
      if (last.dir) this.direction = last.dir;
      if (last.poolId) Ledger.poolId = last.poolId;
      if (last.l2) { Ledger.sel.l2 = last.l2; Ledger.renderCats(); }
    } catch (_) {}
  }
};

// ── 批B 年终奖 / 年度汇总 / 调薪预览 ──────────────────
const SalaryTaxUI = {
  async openBonus() {
    const rows = await api('/salary/bonus').catch(() => []);
    openModal(`
      <h4>年终奖 / 13薪 <span class="hint">独立于月工资记录</span></h4>
      <div class="field"><label>发放月份</label><input id="bn-month" type="month" value="${new Date().toISOString().slice(0, 7)}"></div>
      <div class="field"><label>类型</label><select id="bn-type">
        <option value="bonus">年终奖</option><option value="13th">13薪</option>
      </select></div>
      <div class="field"><label>金额</label><input id="bn-amount" type="number" step="0.01" placeholder="如 10000"></div>
      <div class="field"><label>备注</label><input id="bn-remark" placeholder="可选"></div>
      <button class="btn block" onclick="SalaryTaxUI.saveBonus()">添加</button>
      <div class="card-title" style="margin-top:14px">已记录</div>
      <div id="bn-list">
        ${rows.length ? rows.map(b => `<div class="bonus-item">
          <span>${b.month}</span><span class="tag-chip" style="background:#2f7d5d">${b.type === '13th' ? '13薪' : '年终奖'}</span>
          <b class="up">¥${fmt(b.amount)}</b>
          <span class="hint">个税参考 ¥${fmt(b.bonus_tax)}</span>
          <span class="hint" style="cursor:pointer" onclick="SalaryTaxUI.delBonus(${b.id})">删</span>
        </div>`).join('') : '<div class="empty">暂无记录</div>'}
      </div>`);
  },
  async saveBonus() {
    const month = document.getElementById('bn-month').value;
    const amount = parseFloat(document.getElementById('bn-amount').value);
    if (!month || isNaN(amount) || amount <= 0) return toast('月份和金额必填', true);
    try {
      const r = await post('/salary/bonus', {
        month, type: document.getElementById('bn-type').value,
        amount, remark: document.getElementById('bn-remark').value.trim() || null
      });
      // 同步记账到资金池（默认池1）
      await post('/records', { direction: 'income', amount, cat_path: '收入/年终奖', cat_leaf_id: null, pool_id: 1, remark: month + ' ' + (r.bonus.type === '13th' ? '13薪' : '年终奖'), book_id: CURRENT_BOOK }).catch(() => {});
      toast('已添加并记账'); closeModal(); this.openBonus(); PoolUI.load(); Overview.load();
    } catch (e) { toast(e.message, true); }
  },
  async delBonus(id) {
    if (!(await appConfirm('删除该年终奖记录？对应记账不自动撤销（可到记账页撤销）。'))) return;
    try { await del('/salary/bonus/' + id); toast('已删除'); this.openBonus(); }
    catch (e) { toast(e.message, true); }
  },
  async openYearSummary() {
    const year = (document.getElementById('sal-month').value || '2026-09').slice(0, 4);
    try {
      const o = await api('/salary/year-summary?year=' + year);
      openModal(`
        <h4>${year} 年度工资汇总</h4>
        <div class="forecast-box">
          <div class="row"><span>计薪月数</span><b>${o.months} 个月</b></div>
          <div class="row"><span>应发合计</span><b>¥${fmt(o.grossTotal)}</b></div>
          <div class="row"><span>实发合计</span><b class="up">¥${fmt(o.netTotal)}</b></div>
          <div class="row"><span>五险一金个人合计</span><span>¥${fmt(o.personalIns)}</span></div>
          <div class="row"><span>公积金合计(个人+单位)</span><span>¥${fmt(o.fundTotal)}</span></div>
          <div class="row"><span>个税合计（参考）</span><span>¥${fmt(o.taxTotal)}</span></div>
          <div class="row"><span>年终奖/13薪合计</span><b class="up">¥${fmt(o.bonusTotal)}</b></div>
          <div class="row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px"><span>四标签</span>
            <span>良好 ${o.tags.good} · 优秀 ${o.tags.excellent} · 高温 ${o.tags.hot} · 大病 ${o.tags.ill}</span></div>
        </div>
        ${o.taxSeries && o.taxSeries.length ? `<div class="hint" style="margin-top:8px">月度个税：${o.taxSeries.map(t => t.month.slice(5) + '月¥' + fmt(t.tax)).join('、')}</div>` : ''}`);
    } catch (e) { toast('年度汇总加载失败', true); }
  },
  async openForecast() {
    const month = (document.getElementById('sal-month').value || '2026-09');
    openModal(`
      <h4>调薪影响预览 <span class="hint">模拟全年到手变化</span></h4>
      <div class="field"><label>生效月份</label><input id="fc-from" type="month" value="${month}"></div>
      <div class="field"><label>新良好基准（可选）</label><input id="fc-good" type="number" step="0.01" placeholder="如 4000"></div>
      <div class="field"><label>新社保基数（可选）</label><input id="fc-base" type="number" step="0.01" placeholder="如 4900"></div>
      <button class="btn block" onclick="SalaryTaxUI.runForecast()">模拟</button>
      <div id="fc-out"></div>`);
  },
  async runForecast() {
    try {
      const o = await post('/salary/forecast', {
        new_good_base: parseFloat(document.getElementById('fc-good').value) || undefined,
        new_social_base: parseFloat(document.getElementById('fc-base').value) || undefined,
        from_month: document.getElementById('fc-from').value
      });
      const box = document.getElementById('fc-out');
      const cur = o.current_gross || o.gross;
      const delta = o.gross - cur;
      box.innerHTML = `
        <div class="forecast-box">
          <div class="row"><span>新基准</span><b>良好 ¥${fmt(o.good_base)}</b></div>
          <div class="row"><span>新社保基数</span><span>¥${fmt(o.social_base)}</span></div>
          <div class="row"><span>新应发（自动折算）</span><b>¥${fmt(o.gross)}</b>
            <span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}¥${fmt(delta)}/月</span></div>
          <div class="row"><span>模拟月份</span><span>${o.simMonths} 个月（${o.from} 起）</span></div>
          <div class="row"><span>模拟期应发合计</span><span>¥${fmt(o.simGross)}</span></div>
          <div class="row"><span>模拟期个税合计</span><span>¥${fmt(o.simTax)}</span></div>
          <div class="row"><span>模拟期到手合计（估）</span><b class="up">¥${fmt(o.simNet)}</b></div>
          <div class="row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px"><span>全年总计（估）</span>
            <span>应发 ¥${fmt(o.yearTotal.gross)} · 到手 ¥${fmt(o.yearTotal.net)}</span></div>
        </div>
        <div class="hint" style="margin-top:6px">历史月沿用原实发，估算仅影响 ${o.from} 起月份；确认后请到「设置→调薪」正式登记新基准。</div>`;
    } catch (e) { toast(e.message, true); }
  }
};

// ── 批C 财务健康度 / 应急基金 ──────────────────────────
const HealthUI = {
  async load() {
    const box = document.getElementById('ov-health');
    if (!box) return;
    try {
      const o = await api('/finance/health');
      const grade = o.total >= 80 ? '优' : o.total >= 60 ? '良' : o.total >= 40 ? '中' : '待改善';
      const color = o.total >= 60 ? 'var(--up)' : 'var(--down)';
      box.innerHTML = `
        <div class="health-score">
          <div class="health-ring" style="background:conic-gradient(${color} ${o.total * 3.6}deg, var(--bg2) 0deg)">
            <span style="background:var(--bg);border-radius:50%;width:48px;height:48px;display:flex;align-items:center;justify-content:center">${o.total}</span>
          </div>
          <div class="health-items">
            <div class="sc"><span>结余率</span><b>${(o.items[0].value * 100).toFixed(0)}%</b></div>
            <div class="sc"><span>负债率</span><b>${(o.items[1].value * 100).toFixed(0)}%</b></div>
            <div class="sc"><span>应急金</span><b>${o.items[2].value >= 99 ? '充足' : o.items[2].value.toFixed(1) + ' 个月'}</b></div>
            <div class="sc" style="margin-top:2px"><span>综合评级</span><b style="color:${color}">${grade}</b></div>
          </div>
        </div>`;
    } catch (e) { box.innerHTML = '<span class="dim-s">暂无数据</span>'; }
  },
  async open() {
    try {
      const o = await api('/finance/health');
      const items = o.items.map(it => {
        const v = it.key === 'efund' ? (it.value >= 99 ? '充足' : it.value.toFixed(1) + ' 个月') : (it.value * 100).toFixed(1) + '%';
        const color = it.score >= 60 ? 'var(--up)' : 'var(--down)';
        return `<div class="tax-row"><span>${it.name} <span class="hint">${it.detail}</span></span><b style="color:${color}">${v} · ${it.score}分</b></div>`;
      }).join('');
      openModal(`
        <h4>财务健康度 <span class="hint">综合 ${o.total} 分</span></h4>
        <div class="forecast-box">${items}</div>
        <div class="hint" style="margin-top:8px">结余率 50% 满分 · 负债率 ≤60% 满分 · 应急金 6 个月满分</div>`);
    } catch (e) { toast('加载失败', true); }
  },
  async emergency() {
    try {
      const o = await api('/finance/emergency');
      const pct3 = o.cash >= o.target3 ? 100 : Math.round(o.cash / o.target3 * 100);
      const pct6 = o.cash >= o.target6 ? 100 : Math.round(o.cash / o.target6 * 100);
      openModal(`
        <h4>应急基金建议</h4>
        <div class="emerg-box">
          <div class="row"><span>月均支出（近3-6月取高）</span><b>¥${fmt(o.monthly)}</b></div>
          <div class="row"><span>当前现金（资产账户）</span><b class="up">¥${fmt(o.cash)}</b></div>
          <div class="row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>3 个月建议额度</span><span>¥${fmt(o.target3)}（已备 ${pct3}%）</span></div>
          <div class="row"><span>6 个月建议额度</span><span>¥${fmt(o.target6)}（已备 ${pct6}%）</span></div>
          <div class="row"><span>3 个月缺口</span><b class="${o.gap3 > 0 ? 'down' : 'up'}">${o.gap3 > 0 ? '¥' + fmt(o.gap3) : '已达标'}</b></div>
        </div>
        <div class="hint" style="margin-top:8px">应急金建议覆盖 3-6 个月固定支出，优先放在流动性好的账户。</div>`);
    } catch (e) { toast('加载失败', true); }
  }
};

// ── 批C 投资持仓总览 ──────────────────────────────────
const PortfolioUI = {
  async open() {
    document.getElementById('portfolio-view').style.display = 'block';
    ViewStack.open('portfolio-view', () => { document.getElementById('portfolio-view').style.display = 'none'; });
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const box = document.getElementById('pf-body');
    try {
      const o = await api('/invest/portfolio');
      const pct = o.totalRate * 100;
      box.innerHTML = `
        <div class="pf-sum">
          <div class="box"><div class="v">${fmt(o.totalValue)}</div><div class="dim-s">市值</div></div>
          <div class="box"><div class="v ${o.totalProfit >= 0 ? 'up' : 'down'}">${o.totalProfit >= 0 ? '+' : ''}${fmt(o.totalProfit)}</div><div class="dim-s">盈亏</div></div>
          <div class="box"><div class="v ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</div><div class="dim-s">收益率</div></div>
        </div>
        ${Object.entries(o.byKind).map(([k, v]) => `<div class="tax-row"><span>${k}</span><b>¥${fmt(v)}</b></div>`).join('') || '<div class="empty">暂无投资资产</div>'}
        <div class="card-title" style="margin:14px 0 6px">明细</div>
        ${o.rows.map(r => `
          <div class="pc-day">
            <div class="row"><span>${r.kind_name} · ${r.name}</span>
              <b class="${r.profit >= 0 ? 'up' : 'down'}">${r.profit >= 0 ? '+' : ''}${fmt(r.profit)}</b></div>
            <div class="row"><span class="dim-s">成本 ¥${fmt(r.cost)} → 市值 ¥${fmt(r.value)}</span>
              <span class="dim-s">${(r.profit_rate * 100).toFixed(2)}%</span></div>
            ${r.interest !== null ? `<div class="row"><span class="dim-s">到期利息(估) ¥${fmt(r.interest)}</span>
              <span class="dim-s">${r.days_left !== null ? (r.days_left > 0 ? r.days_left + ' 天后到期' : '已到期') : ''}</span></div>` : ''}
          </div>`).join('') || ''}`;
    } catch (e) { box.innerHTML = '<div class="empty">加载失败</div>'; }
  }
};

// ── 批C 还款日历 ──────────────────────────────────────
const PayCalUI = {
  async open() {
    document.getElementById('paycal-view').style.display = 'block';
    ViewStack.open('paycal-view', () => { document.getElementById('paycal-view').style.display = 'none'; });
    const inp = document.getElementById('pc-month');
    if (!inp.value) inp.value = new Date().toISOString().slice(0, 7);
    this.load();
  },
  close() { ViewStack.close(); },
  async load() {
    const box = document.getElementById('pc-body');
    const month = document.getElementById('pc-month').value;
    try {
      const o = await api('/pay-calendar?month=' + month);
      if (!o.count) { box.innerHTML = '<div class="empty">本月无待还账单</div>'; return; }
      const byDay = {};
      for (const r of o.rows) { (byDay[r.date] = byDay[r.date] || []).push(r); }
      box.innerHTML = `
        <div class="pf-sum" style="margin-bottom:10px">
          <div class="box"><div class="v">${o.count}</div><div class="dim-s">待还笔数</div></div>
          <div class="box"><div class="v down">¥${fmt(o.total)}</div><div class="dim-s">合计</div></div>
        </div>
        ${Object.entries(byDay).map(([d, rows]) => `
          <div class="pc-day">
            <div class="d">${d.slice(5)} <span class="hint">${d.slice(0, 4)}</span></div>
            ${rows.map(r => `<div class="row"><span>${r.label}</span><b class="down">¥${fmt(r.amount)}</b></div>`).join('')}
          </div>`).join('')}`;
    } catch (e) { box.innerHTML = '<div class="empty">加载失败</div>'; }
  }
};

// ── 债务域（宫格 · P3 填充）────────────────────────────
const DebtUI = {
  async load() {
    try {
      const [ov, bills, repays, pools] = await Promise.all([
        api('/overview'), api('/credit-bills'), api('/repayments').catch(() => ({ rows: [] })), api('/pools')
      ]);
      // 负债概览
      const cr = bills.filter(b => b.status !== 'paid');
      const crTotal = cr.reduce((s, b) => s + (b.amount - b.paid_amount), 0);
      const crOver = cr.filter(b => b.status === 'overdue').length;
      document.getElementById('db-overview').innerHTML = `
        <div class="pf-sum">
          <div class="box"><div class="v down">¥${fmt(ov.total_debt)}</div><div class="dim-s">总负债</div></div>
          <div class="box"><div class="v">${cr.length}</div><div class="dim-s">未还账单</div></div>
          <div class="box"><div class="v ${crOver ? 'down' : ''}">${crOver}</div><div class="dim-s">逾期</div></div>
          <div class="box"><div class="v">¥${fmt(crTotal)}</div><div class="dim-s">本月待还</div></div>
        </div>`;
      // 信用卡账单 · 还款计划（按还款日排序 + 逾期可视化）
      const rows = bills.slice().sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
      document.getElementById('db-credit').innerHTML = rows.length ? rows.map(b => {
        const remain = b.amount - b.paid_amount;
        const st = b.status === 'paid' ? '<span class="pill ok">已还</span>'
          : b.status === 'overdue' ? '<span class="pill bad">逾期</span>'
          : '<span class="pill">待还</span>';
        return `<div class="mini-item">
          <span>${b.name || b.card_name || '信用卡'} · 还款日 ${b.due_date || '—'} ${st}</span>
          <span class="down">¥${fmt(remain)}</span>
        </div>`;
      }).join('') : '<div class="empty">暂无信用卡账单</div>';
      // 贷款 / 分期
      const rr = (repays && repays.rows) || [];
      document.getElementById('db-repay').innerHTML = rr.length ? rr.map(r => `
        <div class="mini-item">
          <span>${r.name || '贷款'}<span class="dim-s"> · ${r.type || ''}</span></span>
          <span>月供 <b class="down">¥${fmt(r.monthly)}</b> · 剩 ${r.remain_months ?? '—'} 期</span>
        </div>`).join('') : '<div class="empty">暂无贷款/分期计划</div>';
      // 负债账户
      const neg = (pools.rows || pools || []).filter(p => (p.is_debt && p.balance < 0) || p.balance < 0);
      document.getElementById('db-pools').innerHTML = neg.length ? neg.map(p => `
        <div class="mini-item">
          <span>${p.name}<span class="dim-s"> · 还款日 ${p.due_day || '—'}</span></span>
          <span class="down">¥${fmt(Math.abs(p.balance))}</span>
        </div>`).join('') : '<div class="empty">暂无负债账户（余额为负的账户）</div>';
      // 往来账款（应收/应付 全局汇总）
      try {
        const a = await api('/biz/arap/summary');
        document.getElementById('db-arap').innerHTML = `
          <div class="pf-sum">
            <div class="box"><div class="v" style="color:#d94a4a">¥${fmt(a.receivable_open)}</div><div class="dim-s">应收未收</div></div>
            <div class="box"><div class="v down">¥${fmt(a.payable_open)}</div><div class="dim-s">应付未付</div></div>
            <div class="box"><div class="v ${a.net_receivable >= 0 ? '' : 'down'}">¥${fmt(a.net_receivable)}</div><div class="dim-s">净应收</div></div>
            <div class="box"><div class="v ${a.overdue_count ? 'down' : ''}">${a.overdue_count}笔</div><div class="dim-s">已逾期</div></div>
          </div>`;
      } catch (e) {
        document.getElementById('db-arap').innerHTML = '<div class="empty">暂无资金往来记录</div>';
      }
    } catch (e) {
      document.getElementById('db-overview').innerHTML = '<div class="empty">加载失败</div>';
    }
  }
};

// ── 保障域（宫格 · 重构 P4 保单台账）────────────────────
const InsUI = {
  rows: [],
  async load() {
    try {
      const { rows } = await api('/insurance');
      this.rows = rows || [];
      this.renderList();
      this.renderSummary();
      this.renderRenew();
      // 宫格摘要
      const dom = document.getElementById('ov-dom-ins');
      if (dom) {
        const totalPremium = this.rows.reduce((s2, p) => s2 + (p.premium || 0), 0);
        dom.textContent = this.rows.length ? `${this.rows.length} 单 · 年保费 ¥${fmt(totalPremium)}` : '未配置';
      }
    } catch (e) {
      document.getElementById('in-policies').innerHTML = '<div class="empty">加载失败</div>';
    }
  },
  renderList() {
    const box = document.getElementById('in-policies');
    if (!box) return;
    box.innerHTML = this.rows.length ? this.rows.map(p => {
      const dl = p.days_left;
      const renewTag = p.renew_date
        ? (dl < 0 ? '<span class="pill bad">已过期</span>'
          : dl <= 30 ? `<span class="pill warn">${dl} 天后续</span>`
          : `<span class="pill">${dl} 天后续</span>`)
        : '';
      return `<div class="mini-item">
        <div style="flex:1;min-width:0">
          <span style="font-weight:600">${p.insurer} · ${p.name}</span>
          <span class="dim-s"> · ${p.kind}</span>
          <div class="hint">保额 ¥${fmt(p.amount)} · 年保费 <b class="down">¥${fmt(p.premium)}</b>
            ${p.beneficiary ? ' · 受益人 ' + p.beneficiary : ''} ${renewTag}</div>
          <div class="hint">${p.start_date ? '起保 ' + p.start_date : ''}${p.end_date ? ' · 到期 ' + p.end_date : ''}${p.renew_date ? ' · 续费日 ' + p.renew_date : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          <button class="btn ghost xs" onclick="InsUI.pay(${p.id})">缴保费</button>
          <div><button class="btn ghost xs" onclick="InsUI.edit(${p.id})">改</button>
          <button class="btn danger ghost xs" onclick="InsUI.del(${p.id})">删</button></div>
        </div>
      </div>`;
    }).join('') : '<div class="empty">暂无保单，点击右上角「+ 保单」添加</div>';
  },
  renderSummary() {
    const box = document.getElementById('in-summary');
    if (!box) return;
    const byKind = {};
    for (const p of this.rows) byKind[p.kind] = (byKind[p.kind] || 0) + (p.amount || 0);
    const totalPremium = this.rows.reduce((s2, p) => s2 + (p.premium || 0), 0);
    const kinds = Object.keys(byKind);
    if (!kinds.length) { box.innerHTML = '<div class="empty">添加保单后显示</div>'; return; }
    box.innerHTML = `
      <div class="pf-sum" style="margin-bottom:8px">
        <div class="box"><div class="v">${this.rows.length}</div><div class="dim-s">保单数</div></div>
        <div class="box"><div class="v down">¥${fmt(totalPremium)}</div><div class="dim-s">年保费</div></div>
        <div class="box"><div class="v up">¥${fmt(Object.values(byKind).reduce((a, b) => a + b, 0))}</div><div class="dim-s">总保额</div></div>
      </div>
      ${kinds.map(k => `<div class="mini-item"><span>${k}</span><span class="up">¥${fmt(byKind[k])}</span></div>`).join('')}
      <div class="hint" style="margin-top:6px">保障缺口参考：重疾保额建议 ≥ 3 年收入；寿险 ≥ 房贷等长期负债 + 家庭 5 年支出；医疗建议 ≥ 50 万。仅供自检。</div>`;
  },
  renderRenew() {
    const box = document.getElementById('in-renew');
    if (!box) return;
    const renew = this.rows.filter(p => p.renew_date).sort((a, b) => (a.renew_date || '').localeCompare(b.renew_date || ''));
    box.innerHTML = renew.length ? renew.map(p => {
      const dl = p.days_left;
      return `<div class="mini-item">
        <span>${p.insurer} · ${p.name}</span>
        <span>${p.renew_date} <b class="down">¥${fmt(p.premium)}</b>
          <span class="${dl < 0 ? 'pill bad' : dl <= 30 ? 'pill warn' : 'pill'}">${dl < 0 ? '已过期' : dl + ' 天后'}</span></span>
      </div>`;
    }).join('') : '<div class="empty">暂无到期保单（设置续费日后显示）</div>';
  },
  formHtml(p) {
    const pools = PoolUI.list;
    return `
      <h4>${p ? '编辑保单' : '新建保单'}</h4>
      <div class="field"><label>保险公司</label><input id="in-insurer" type="text" placeholder="如 中国人寿" value="${p ? (p.insurer || '') : ''}"></div>
      <div class="field"><label>保单名称</label><input id="in-name" type="text" placeholder="如 重疾险-终身" value="${p ? (p.name || '') : ''}"></div>
      <div class="field"><label>险种</label>
        <div class="chips" id="in-kind-chips">
          ${['重疾', '医疗', '意外', '寿险', '财产', '其他'].map(k =>
            `<button class="chip ${p && p.kind === k ? 'active' : !p && k === '重疾' ? 'active' : ''}" onclick="segSel(this);document.getElementById('in-kind').value='${k}'">${k}</button>`).join('')}
        </div>
        <input type="hidden" id="in-kind" value="${p ? (p.kind || '重疾') : '重疾'}">
      </div>
      <div class="field"><label>保额（元）</label><input id="in-amount" type="number" step="0.01" placeholder="500000" value="${p ? (p.amount || '') : ''}"></div>
      <div class="field"><label>年保费（元）</label><input id="in-premium" type="number" step="0.01" placeholder="5000" value="${p ? (p.premium || '') : ''}"></div>
      <div class="field"><label>起保日期</label><input id="in-start" type="date" value="${p ? (p.start_date || '') : ''}"></div>
      <div class="field"><label>到期日期</label><input id="in-end" type="date" value="${p ? (p.end_date || '') : ''}"></div>
      <div class="field"><label>下次续费日期</label><input id="in-renew-date" type="date" value="${p ? (p.renew_date || '') : ''}">
        <span class="hint">续费日会进入总览财务日历 + 保障续费提醒</span></div>
      <div class="field"><label>缴费账户</label>
        <div class="chips" id="in-pool"></div></div>
      <div class="field"><label>受益人（可选）</label><input id="in-beneficiary" type="text" placeholder="配偶 / 子女" value="${p ? (p.beneficiary || '') : ''}"></div>
      <div class="field"><label>备注（可选）</label><input id="in-remark" type="text" value="${p ? (p.remark || '') : ''}"></div>
      <button class="btn block" onclick="InsUI.save(${p ? p.id : 0})">${p ? '保存修改' : '添加保单'}</button>`;
  },
  openNew() {
    openModal(this.formHtml(null));
    this.renderPoolChips();
  },
  edit(id) {
    const p = this.rows.find(x => x.id === id);
    if (!p) return;
    openModal(this.formHtml(p));
    this.renderPoolChips(p.pay_pool_id);
  },
  renderPoolChips(selId) {
    const box = document.getElementById('in-pool');
    if (!box) return;
    const pools = (PoolUI.list || []).filter(p => p.kind === 'asset');
    box.innerHTML = pools.length ? pools.map(c =>
      `<button class="chip ${c.id === selId ? 'active' : ''}" onclick="segSel(this);this.dataset.sel='${c.id}'">${c.name}·${c.tail}</button>`).join('')
      : '<span class="hint">暂无资金账户</span>';
  },
  pickPool() {
    const el = document.querySelector('#in-pool .chip.active');
    return el ? Number(el.dataset.sel) : null;
  },
  async save(id) {
    const insurer = document.getElementById('in-insurer').value.trim();
    const name = document.getElementById('in-name').value.trim();
    const kind = document.getElementById('in-kind').value;
    const amount = Number(document.getElementById('in-amount').value) || 0;
    const premium = Number(document.getElementById('in-premium').value) || 0;
    const start_date = document.getElementById('in-start').value || null;
    const end_date = document.getElementById('in-end').value || null;
    const renew_date = document.getElementById('in-renew-date').value || null;
    const beneficiary = document.getElementById('in-beneficiary').value.trim() || null;
    const remark = document.getElementById('in-remark').value.trim() || null;
    const pay_pool_id = this.pickPool();
    if (!insurer || !name) { toast('保险公司与保单名称必填', true); return; }
    if (amount <= 0) { toast('请填写保额', true); return; }
    if (premium <= 0) { toast('请填写年保费', true); return; }
    if (renew_date && end_date && renew_date > end_date) { toast('续费日期不能晚于到期日期', true); return; }
    const body = { insurer, name, kind, amount, premium, start_date, end_date, renew_date, pay_pool_id, beneficiary, remark };
    try {
      if (id) await put('/insurance/' + id, body);
      else await post('/insurance', body);
      closeModal();
      toast('保单已保存');
      this.load();
      RemindUI.load().catch(() => {});
    } catch (e) { toast('保存失败: ' + e.message, true); }
  },
  async del(id) {
    if (!await appConfirm('删除该保单？相关记账记录不受影响。')) return;
    await del('/insurance/' + id);
    toast('已删除');
    this.load();
  },
  async pay(id) {
    const p = this.rows.find(x => x.id === id);
    if (!p) return;
    const pools = (PoolUI.list || []).filter(x => x.kind === 'asset');
    openModal(`
      <h4>缴保费 · ${p.name}</h4>
      <div style="font-size:12.5px;line-height:1.9">年保费 <b class="down">¥${fmt(p.premium)}</b> · 续费日 ${p.renew_date || '—'}</div>
      <div class="field"><label>缴费账户</label>
        <div class="chips" id="in-pay-pool">${pools.length ? pools.map(c =>
          `<button class="chip ${c.id === p.pay_pool_id ? 'active' : ''}" onclick="segSel(this);this.dataset.sel='${c.id}'">${c.name}·${c.tail}</button>`).join('') : '<span class="hint">暂无资金账户</span>'}</div>
      </div>
      <div class="field"><label>缴费日期</label><input id="in-pay-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>备注（可选）</label><input id="in-pay-remark" type="text" value="保费 · ${p.name}"></div>
      <button class="btn block" onclick="InsUI.payConfirm(${p.id})">确认缴费并记账</button>
      <div class="hint" style="margin-top:8px">确认后自动生成一条支出记录（分类：保险），并从所选账户扣减；续费日自动顺延一年。</div>`);
  },
  async payConfirm(id) {
    const el = document.querySelector('#in-pay-pool .chip.active');
    const pool_id = el ? Number(el.dataset.sel) : null;
    if (!pool_id) { toast('请选择缴费账户', true); return; }
    const pay_date = document.getElementById('in-pay-date').value;
    const remark = document.getElementById('in-pay-remark').value.trim() || null;
    try {
      await post('/insurance/' + id + '/pay', { pool_id, pay_date, remark });
      closeModal();
      toast('缴费已记账，续费日顺延一年');
      this.load();
      RemindUI.load().catch(() => {});
    } catch (e) { toast('缴费失败: ' + e.message, true); }
  }
};

// ── 财务日历（总览增强 · 重构 P2）──────────────────────
const CalendarUI = {
  month: '',
  showAmount: false,  // 切换：待办模式 / 金额模式
  async load() {
    const t = new Date();
    if (!this.month) this.month = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
    await this.render();
  },
  async render() {
    const box = document.getElementById('ov-calendar');
    if (!box) return;
    let rows = [];
    try { rows = (await api('/pay-calendar?month=' + this.month)).rows || []; }
    catch (e) { box.innerHTML = '<div class="empty">日历加载失败</div>'; return; }
    const byDate = {};
    for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r);
    const [y, m] = this.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const startDow = (first.getDay() + 6) % 7;
    const days = new Date(y, m, 0).getDate();
    const t = new Date();
    const todayKey = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    const tc = { credit: '#d94a4a', repay: '#b0452e', arap: '#e08a2e', recur: '#2d6a4f', salary: '#2d6a4f', ins: '#7c6ad0' };
    // 金额模式：查当月每日收支
    let dayIncome = {}, dayExpense = {};
    if (this.showAmount) {
      try {
        const allRecs = await api('/records?from=' + this.month + '-01&to=' + this.month + '-' + String(days).padStart(2, '0') + '&limit=100000');
        for (const r of allRecs) {
          const day = (r.created_at || '').slice(0, 10);
          if (r.direction === 'income') dayIncome[day] = (dayIncome[day] || 0) + r.amount;
          else dayExpense[day] = (dayExpense[day] || 0) + r.amount;
        }
      } catch(e) {}
    }
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell empty"></div>');
    for (let d = 1; d <= days; d++) {
      const key = `${this.month}-${String(d).padStart(2, '0')}`;
      const evs = byDate[key] || [];
      const isToday = key === todayKey;
      let bottom = '';
      if (this.showAmount) {
        const inc = dayIncome[key] || 0, exp = dayExpense[key] || 0;
        bottom = (inc > 0 || exp > 0)
          ? `<div style="font-size:8px;line-height:1.2;text-align:center">
              ${inc > 0 ? `<div style="color:#d33a3a">+${fmt(inc)}</div>` : ''}
              ${exp > 0 ? `<div style="color:#2d6a4f">-${fmt(exp)}</div>` : ''}
            </div>` : '';
      } else {
        bottom = `<div class="cal-dots">${evs.slice(0, 3).map(e => `<i style="background:${tc[e.type] || '#9aa5b1'}"></i>`).join('')}${evs.length > 3 ? '<i class="more">+</i>' : ''}</div>`;
      }
      cells.push(`<div class="cal-cell${isToday ? ' today' : ''}" onclick="CalendarUI.showDay('${key}')">
        <div class="cal-d">${d}</div>
        ${bottom}
      </div>`);
    }
    const remain = 42 - startDow - days;
    for (let i = 0; i < remain; i++) cells.push('<div class="cal-cell empty"></div>');
    const total = rows.reduce((s, r) => s + r.amount, 0);
    box.innerHTML = `
      <div class="cal-head">
        <button class="btn ghost xs" onclick="CalendarUI.shift(-1)">‹</button>
        <b>${y}年${m}月</b>
        <button class="btn ghost xs" onclick="CalendarUI.shift(1)">›</button>
        <button class="btn ghost xs" onclick="CalendarUI.today()">今</button>
        <button class="btn ghost xs" onclick="CalendarUI.toggleAmount()">${this.showAmount ? '待办' : '金额'}</button>
      </div>
      <div class="cal-week">${['一', '二', '三', '四', '五', '六', '日'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-sum">本月待办 <b>${rows.length}</b> 项 · 合计 <b class="down">¥${fmt(total)}</b>
        <span class="hint">· 点日期看当日明细${this.showAmount ? ' · 红收绿支' : ' · 含还款/应付/周期/工资/保费'}</span></div>
      <div class="cal-day-list" id="cal-day-list"></div>`;
  },
  toggleAmount() {
    this.showAmount = !this.showAmount;
    this.render();
  },
  shift(d) {
    const [y, m] = this.month.split('-').map(Number);
    const d0 = new Date(y, m - 1 + d, 1);
    this.month = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0');
    this.render();
  },
  today() {
    const t = new Date();
    this.month = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
    this.render();
  },
  async showDay(key) {
    const rows = (await api('/pay-calendar?month=' + key.slice(0, 7))).rows || [];
    const evs = rows.filter(r => r.date === key);
    const list = document.getElementById('cal-day-list');
    if (!list) return;
    if (!evs.length) { list.innerHTML = '<div class="empty" style="margin-top:6px">当日无待办事项</div>'; return; }
    list.innerHTML = `<div class="cal-day-title">${key} 待办</div>` + evs.map(e => `
      <div class="mini-item"><span>${e.label}</span><span class="down">¥${fmt(e.amount)}</span></div>`).join('');
  }
};

// ── 流水查询全屏页（M7.3）──────────────────────────────
const LedgerQueryUI = {
  month: '',
  open() {
    const now = new Date();
    this.month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    openModal(`
      <div style="min-width:90vw;max-height:85vh;overflow-y:auto">
      <div class="page-head">
        <h3>流水查询</h3>
        <button class="btn ghost" onclick="closeModal()">关闭</button>
      </div>
      <div class="card">
        <div class="card-title">筛选</div>
        <input id="lq-q" type="search" placeholder="搜索备注或分类关键词…" oninput="LedgerQueryUI.search()">
        <div class="filter-row">
          <select id="lq-dir" class="sel" onchange="LedgerQueryUI.search()">
            <option value="">全部方向</option>
            <option value="expense">支出</option>
            <option value="income">收入</option>
          </select>
          <span class="fdate"><label>开始</label><input id="lq-from" type="date" class="sel" onchange="LedgerQueryUI.search()"></span>
          <span class="fdate"><label>结束</label><input id="lq-to" type="date" class="sel" onchange="LedgerQueryUI.search()"></span>
          <button class="btn ghost xs" onclick="LedgerQueryUI.clearFilter()">重置</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">按月浏览</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <button class="btn ghost xs" onclick="LedgerQueryUI.prevMonth()">‹ 上月</button>
          <span style="flex:1;text-align:center;font-weight:600" id="lq-title">${this.month}</span>
          <button class="btn ghost xs" onclick="LedgerQueryUI.nextMonth()">下月 ›</button>
        </div>
        <div id="lq-list" class="mini-list"><div class="empty">加载中…</div></div>
      </div>
      </div>
    `);
    this.search();
  },
  async search() {
    const q = (document.getElementById('lq-q').value || '').trim();
    const dir = document.getElementById('lq-dir').value;
    const from = document.getElementById('lq-from').value;
    const to = document.getElementById('lq-to').value;
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (dir) p.set('direction', dir);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('book_id', CURRENT_BOOK);
    // 如果没选日期范围，默认用当前浏览月
    if (!from && !to) {
      p.set('from', this.month + '-01');
      const [y, m] = this.month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      p.set('to', this.month + '-' + String(lastDay).padStart(2, '0'));
    }
    try {
      const rows = await api('/records?' + p.toString());
      this.render(rows);
    } catch (e) {
      document.getElementById('lq-list').innerHTML = '<div class="empty">加载失败</div>';
    }
  },
  render(rows) {
    const pools = PoolUI.list;
    const pname = id => (pools.find(p => p.id === id) || {}).name || '—';
    const inc = rows.filter(r => r.direction === 'income').reduce((s, r) => s + r.amount, 0);
    const exp = rows.filter(r => r.direction === 'expense').reduce((s, r) => s + r.amount, 0);
    document.getElementById('lq-list').innerHTML = rows.length
      ? `<div class="hint" style="margin-bottom:8px">共 ${rows.length} 笔 · 收 <span class="up">¥${fmt(inc)}</span> · 支 <span class="down">¥${fmt(exp)}</span></div>` + rows.map(r => `
        <div class="mini-item">
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:600">${r.cat_path}
              ${(r.tags || []).map(t => `<span class="tag-chip" style="background:${t.color || '#2f7d5d'}">${t.name}</span>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--dim)">${(r.created_at || '').slice(0, 16)} · ${pname(r.pool_id)}${r.remark ? ' · ' + r.remark : ''}</div>
          </div>
          <span class="${r.direction === 'income' ? 'amt-in' : 'amt-out'}">${r.direction === 'income' ? '+' : '−'}${fmt(r.amount)}</span>
        </div>`).join('')
      : '<div class="empty">本月无流水</div>';
  },
  prevMonth() {
    const [y, m] = this.month.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    this.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    document.getElementById('lq-title').textContent = this.month;
    this.search();
  },
  nextMonth() {
    const [y, m] = this.month.split('-').map(Number);
    const d = new Date(y, m, 1);
    this.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    document.getElementById('lq-title').textContent = this.month;
    this.search();
  },
  clearFilter() {
    document.getElementById('lq-q').value = '';
    document.getElementById('lq-dir').value = '';
    document.getElementById('lq-from').value = '';
    document.getElementById('lq-to').value = '';
    this.search();
  }
};
