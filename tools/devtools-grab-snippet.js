/* ════════════════════════════════════════════════════════════════════════
 *  mfood 財務頁 —— 一鍵抽取「全部」明細（貼落 DevTools Console 即可）v3
 *
 *  用法：
 *    1. 喺 mfood 財務對帳頁開 DevTools → Console
 *    2. 全文複製貼落去 → Enter
 *    3. 佢會自動：攔回應 → 代撳「查看詳情」→ **自動翻頁到底** → 複製 JSON
 *
 *  🔴 v2 為什麼要改（2026-09-28 第十四次真機實證）：
 *      v1 只拿到 **20 列**，但平台聲稱 **32 筆** —— 因為只讀了第一頁。
 *      而「自己重放請求翻頁」係**行唔通**嘅，真機 log 實證：
 *        Access to fetch at '…/_get-order-summary-list' from origin
 *        'https://merchant.mfoodapp.com' has been blocked by CORS policy:
 *        … 'Access-Control-Allow-Origin' must not be '*' when the request's
 *        credentials mode is 'include'.
 *        mfood-inject.js:1335 POST … net::ERR_FAILED
 *
 *      ⇒ 跨域 + `credentials:'include'` + 平台回 `ACAO: *`
 *        ＝ 瀏覽器**規範上一定拒絕**。自己發請求永遠冇得救。
 *
 *      ✅ 唯一可行：**叫頁面自己發**。我哋只代撳 UI（下一頁），繼續搭便車。
 *         頁面自己嘅請求係同源環境發出嘅，完全唔受 CORS 限制。
 *
 *  ⚠️ 貼之前請確認頁面已經按過「查詢」，明細表已經顯示出嚟。
 *
 *  ── 🔴 v3 加咗啲乜（2026-09-28 第十六次真機，使用者點醒）─────────────
 *      「拿不到 32 條是因為, paging 我沒選到 50一頁,
 *       但是當我用立即對帳, 應該是你也要幫忙按到才行.」
 *
 *      ⇒ v2 識得翻頁，但**冇先把「每頁筆數」拉到最大**。
 *        平台預設 20項/頁 ⇒ 一個月 32 筆要翻兩頁；一旦「下一頁」掣搵唔到
 *        （彈窗分頁器結構唔同／懶加載），就只會得返第一頁嘅 20 列。
 *
 *      ⇒ v3 一開波就**代撳** `el-pagination__sizes` 嗰個下拉，揀最大（實測 50）
 *        ⇒ 32 筆一頁晒，翻頁變成後備而唔係必需。
 * ════════════════════════════════════════════════════════════════════════ */
(async function grabAllFinanceRows() {
  const TAG = '[rawgrab]';
  const IS_DETAIL = (u) => /_get-order-summary(-list|-data)?/i.test(String(u));
  const IS_LIST = (u) => /\/summarys?\/_list|\/summary\/list/i.test(String(u));
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };

  console.log(TAG, 'v2 開始（會自動翻頁，請勿手動操作頁面）…');

  const store = { detail: [], list: [], seen: [] };

  // ── 由一個 detail 回應抽出 result 列（兼容有／冇 data 包裝）──
  function rowsOf(body) {
    const p =
      body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? body.data
        : body;
    return p && Array.isArray(p.result) ? p.result : [];
  }

  // ── 把回應塞入帳本（以 tradeNo 去重，跨頁累積）──
  const byTradeNo = new Map();
  const noTradeNo = [];
  function absorb(rows) {
    rows.forEach((r) => {
      const k = r && r.tradeNo != null ? String(r.tradeNo) : null;
      if (k) byTradeNo.set(k, r);
      else noTradeNo.push(r);
    });
  }
  function allRows() {
    return Array.from(byTradeNo.values()).concat(noTradeNo);
  }

  // --- 掣 1: 包裝 fetch ---
  const of = window.fetch;
  window.fetch = function (input, init) {
    const u = (input && input.url) || input;
    return of.apply(this, arguments).then((res) => {
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('text')) {
          res.clone().text().then((t) => {
            let body; try { body = JSON.parse(t); } catch (e) { body = t; }
            store.seen.push(abs(u));
            if (IS_LIST(u)) store.list.push({ url: abs(u), body });
            if (IS_DETAIL(u)) {
              store.detail.push({ url: abs(u), body });
              absorb(rowsOf(body));
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return res;
    });
  };

  // --- 掣 2: 包裝 XHR ---
  const OX = window.XMLHttpRequest;
  if (OX && OX.prototype) {
    const oOpen = OX.prototype.open, oSend = OX.prototype.send;
    OX.prototype.open = function (m, u) { try { this.__gUrl = u; } catch (e) {} return oOpen.apply(this, arguments); };
    OX.prototype.send = function () {
      const self = this;
      try {
        self.addEventListener('load', function () {
          try {
            let body = self.responseType === 'json' ? self.response : self.responseText;
            if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
            store.seen.push(abs(self.__gUrl));
            if (IS_LIST(self.__gUrl)) store.list.push({ url: abs(self.__gUrl), body });
            if (IS_DETAIL(self.__gUrl)) {
              store.detail.push({ url: abs(self.__gUrl), body });
              absorb(rowsOf(body));
            }
          } catch (e) {}
        });
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickText = (txts) => {
    const els = Array.from(document.querySelectorAll('button,a,span,li,div'));
    const hit = els.find((b) => {
      const t = (b.textContent || '').trim();
      return txts.includes(t) && b.offsetParent !== null;
    });
    if (hit) { hit.click(); return (hit.textContent || '').trim(); }
    return null;
  };

  // ── 代按「查詢」令第一頁出來 ──
  const q = clickText(['查詢', '查询', '搜索', '搜尋']);
  console.log(TAG, q ? `已代按「${q}」` : '⚠️ 搵唔到查詢掣（請自己撳一次）');

  // ── 等第一頁 ──
  for (let i = 0; i < 40 && allRows().length === 0; i++) await sleep(1000);
  if (!allRows().length) {
    console.error(TAG, '❌ 等唔到明細。請先喺頁面撳「查看詳情」，再跑多次。');
    console.error(TAG, '已攔到嘅 URL：', store.seen.slice(-8));
    return;
  }
  console.log(TAG, `第一頁：${allRows().length} 列`);

  // ── 🔴🔴 v3：先把「每頁筆數」撳到最大（50項/頁）────────────────────
  //    平台預設 20 ⇒ 一個月 32 筆只會出 20。撳到 50 就一頁晒。
  //    ⚠️ 一定要喺**翻頁之前**做：翻頁係後備，每頁筆數先係主線。
  const SIZE_RE = /(\d+)\s*(?:項|條|条|筆)\s*\/\s*頁/;
  const vis = (el) => !!(el && el.offsetParent !== null);

  function findPageSizeSelects() {
    return Array.from(document.querySelectorAll('.el-select')).filter((s) => {
      if (!vis(s)) return false;
      // 多選型（商家選擇器）一定要排除 —— 撳落去會彈商家名
      if (s.querySelector('.el-select__tags')) return false;
      const inp = s.querySelector('input');
      const txt = (inp && inp.value) || '';
      const inSizes = !!s.closest('.el-pagination__sizes');
      return SIZE_RE.test(txt) || inSizes;
    });
  }

  async function boostPageSize() {
    const sels = findPageSizeSelects();
    if (!sels.length) {
      console.warn(TAG, '⚠️ 搵唔到「每頁筆數」下拉 —— 沿用而家嘅每頁筆數（靠翻頁補）');
      return null;
    }
    let applied = null;
    for (const s of sels) {
      try {
        const inp = s.querySelector('input');
        const cur = SIZE_RE.exec((inp && inp.value) || '');
        if (cur && Number(cur[1]) >= 50) { applied = Number(cur[1]); continue; }
        s.click();
        if (inp) inp.click();
        await sleep(400);
        // 撳最大嗰個「N項/頁」
        const opts = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
          .filter(vis)
          .map((o) => ({ o, m: SIZE_RE.exec((o.textContent || '').trim()) }))
          .filter((x) => x.m)
          .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
        if (!opts.length) { console.warn(TAG, '⚠️ 下拉開咗但冇「N項/頁」選項'); continue; }
        opts[0].o.click();
        applied = Number(opts[0].m[1]);
        console.log(TAG, `已代撳「每頁筆數」→ ${applied}項/頁`);
        await sleep(800);
      } catch (e) {
        console.warn(TAG, '撳「每頁筆數」出錯：', e && e.message);
      }
    }
    return applied;
  }

  const beforeBoost = allRows().length;
  await boostPageSize();
  // 等平台用新 pageSize 重新發一次（最多 12 秒）
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    if (allRows().length > beforeBoost) break;
  }
  console.log(TAG, `拉大每頁筆數後：${allRows().length} 列`);

  // ── 平台聲稱總數（由回應嘅 total 或 _data 嘅 orderCount 取）──
  let claimed = null;
  for (let i = store.detail.length - 1; i >= 0 && claimed == null; i--) {
    const b = store.detail[i].body;
    const p = b && b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : b;
    if (p && p.total != null) claimed = Number(p.total);
  }
  for (let i = store.list.length - 1; i >= 0 && claimed == null; i--) {
    const b = store.list[i].body;
    const p = b && b.data ? b.data : b;
    if (p && p.orderCount != null) claimed = Number(p.orderCount);
  }
  console.log(TAG, `平台聲稱總數：${claimed == null ? '未知' : claimed}`);

  // ── 🔴 自動翻頁：搵 el-pagination 嘅「下一頁」掣，撳到撳唔到為止 ──
  //    關鍵：**由頁面自己發請求**（同源，唔受 CORS 限制），我哋繼續搭便車。
  function findNextPageBtn() {
    // Element-UI 分頁：.btn-next
    const direct = document.querySelector('.el-pagination .btn-next');
    if (direct) return direct;
    // 後備：搵「>」字樣嘅掣
    const els = Array.from(document.querySelectorAll('.el-pagination button, .el-pager li'));
    return els.find((b) => {
      const t = (b.textContent || '').trim();
      return t === '>' || t === '›' || /next/i.test(b.className || '');
    }) || null;
  }

  let page = 1;
  const MAX_PAGES = 30;
  while (page < MAX_PAGES) {
    const before = allRows().length;
    const btn = findNextPageBtn();
    if (!btn) { console.log(TAG, '冇分頁掣（或者已經到最後一頁）'); break; }
    // 已到最後一頁 / 被禁用
    if (btn.disabled || /is-disabled/.test(btn.className || '')) {
      console.log(TAG, '下一頁掣已停用 ⇒ 到底'); break;
    }
    btn.click();
    page++;
    // 等新一頁回應（最多 12 秒）
    let got = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (allRows().length > before) { got = true; break; }
    }
    console.log(TAG, `第 ${page} 頁：累計 ${allRows().length} 列${got ? '' : '（冇新數據）'}`);
    if (!got) break;
    if (claimed != null && allRows().length >= claimed) break;
  }

  const rows = allRows();
  const simplified = rows.map((r) => ({
    tradeNo: r.tradeNo ?? null,
    subsidyStoreReceiveAmtn: r.subsidyStoreReceiveAmtn ?? null,
    storeReceiveAmtn: r.storeReceiveAmtn ?? null,
    storeBusinessAmtn: r.storeBusinessAmtn ?? null,
    platformServiceFee: r.platformServiceFee ?? null,
    orderTime: r.orderTime ?? null,
  }));

  const sum = simplified.reduce((a, x) => a + (Number(x.subsidyStoreReceiveAmtn) || 0), 0);

  const out = {
    說明: 'mfood 財務頁原始明細（頁面直接攔截 ＋ 自動翻頁累積，未經配對／篩選）',
    抓取時間: new Date().toISOString(),
    頁面: location.href,
    平台聲稱總數: claimed,
    實際列數: rows.length,
    收到頁數: page,
    加總_subsidyStoreReceiveAmtn: Number(sum.toFixed(2)),
    第一列全部欄位: Object.keys(rows[0] || {}),
    簡化列: simplified,
    原始列: rows,
  };

  const text = JSON.stringify(out, null, 2);

  try {
    await navigator.clipboard.writeText(text);
    console.log(TAG, `✅ 已複製 ${rows.length} 列（平台聲稱 ${claimed}）JSON 到剪貼板。`);
  } catch (e) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mfood-finance-raw-' + Date.now() + '.json';
    a.click();
    console.log(TAG, `✅ 剪貼板唔得，已改成下載（${rows.length} 列）。`);
  }

  console.log(TAG, `Σ subsidyStoreReceiveAmtn = ${sum.toFixed(2)}`);
  console.log(TAG, '首 3 列：');
  simplified.slice(0, 3).forEach((x, i) =>
    console.log(`  [${i + 1}] ${x.tradeNo} → subsidy=${x.subsidyStoreReceiveAmtn}`));
  if (claimed != null && rows.length < claimed) {
    console.warn(TAG, `⚠️ 仲差 ${claimed - rows.length} 列。可以手動撳下一頁再跑多次（會累加去重）。`);
  }
  console.log(TAG, '（完整物件已掛喺 window.__RAWGRAB_OUT__）');
  window.__RAWGRAB_OUT__ = out;
})();
