"use strict";

/* ==========================================================================
   Transaction Grabber popup —— 登入前移 redesign 版（2026-09-29）
   --------------------------------------------------------------------------
   三個視圖（照確認稿 grabber-login-first-redesign-2026-09-29.html）：
     view-main    主面板（門店列 + 總控 + 平台卡 + 統計 + 雙平台日誌）
     view-detail  訂單明細（兩平台訂單卡 + Mpay 最近交易）
     view-wizard  設定精靈（門店識別→驗證門店 / mfood 帳密 / 澳覓帳密 / 頻率）

   🔴 功能完整性規則：舊版每一個掣都必須有去處 ——
     · 手動測試全部收進 header「⋯」工具選單（常規區 vs 危險區）
     · 對帳設定（商家名／自動對帳／立即對帳）收進選單展開區
     · startDate／interval 收進精靈第 4 步；interval 也可在總控列點提示修改
     · Mpay 手動刷新搬去明細視圖
   ========================================================================== */

const GRAB_UI = [
  {
    key: 'mfood',
    label: 'mfood',
    prefix: 'MFOOD',
    p: 'mf',
    site: 'merchant.mfoodapp.com',
    orderPath: '/#/trade/tackout',
    financePath: '/#/finance/tackout-check',
  },
  {
    key: 'aomi',
    label: '澳覓',
    prefix: 'AOMI',
    p: 'am',
    site: 'merchant.aomiapp.com',
    orderPath: '/#/orderManage/storesTakeoutOrderRecord',
    financePath: '/#/qrAccountmanage/takeoutAccountManage/takeoutAccount',
  },
  // 🔴🔴 2026-10-02：恢復 MacauPay 做主面板第三張卡（方案 A）。
  //    legacy=true ⇒ 唔係 GRAB_SOURCES 框架嘅平台，無獨立登入／無訂單頁／無對帳頁，
  //    cardHtml 會用簡化版渲染，dashboard 改由 background 嘅 grabMpayDashboard() 提供。
  {
    key: 'mpay',
    label: 'MacauPay',
    prefix: 'MPAY',
    p: 'mp',
    site: 'msp.macaupay.com.mo',
    orderPath: '—',
    financePath: '—',
    legacy: true,
  },
];

const GRAB_SRC_LABEL = { mpay: 'MacauPay', mfood: 'mfood', aomi: '澳覓' };
const grabSrcLabel = (k) => GRAB_SRC_LABEL[k] || k;

const STALE_MS = 10 * 60 * 1000;
const ORDER_STATE_LABEL = {
  observed: '只記錄',
  held: '待同步',
  pending: '待送出',
  sending: '送出中',
  sent: '已送出',
  failed: '送出失敗',
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtShort(v) {
  if (!v) return '—';
  const t = Date.parse(String(v).replace(' ', 'T'));
  if (!isFinite(t)) return String(v);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relative(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!isFinite(diff)) return '';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  return `${Math.round(min / 60)} 小時前`;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

// ---- 全域狀態 ---------------------------------------------------------------

const dash = { mfood: null, aomi: null };
let logFilter = 'all';
let storeLookup = { id: null, at: 0, ok: false, name: null };
const STORE_LOOKUP_RETRY_MS = 30 * 1000;

// ---- 視圖切換 ---------------------------------------------------------------

function showView(name) {
  ['main', 'detail', 'wizard'].forEach((v) => {
    const el = $('view-' + v);
    if (el) el.hidden = v !== name;
  });
  if (name !== 'main') closeMenu();
}

// ---- 門店查名（主面板門店列 + 精靈共用） --------------------------------------
//
// 🔴 舊版教訓：回應返嚟時輸入框可能已改成另一個 ID ⇒ 顯示店名前一定要
//    核對「回應係咪仲對應住而家嘅值」。

function lookupStore(storeId, expectElId) {
  const id = String(storeId || '').trim();
  if (!id) return Promise.resolve(null);
  const now = Date.now();
  if (!expectElId && storeLookup.id === id) {
    if (storeLookup.ok) return Promise.resolve(storeLookup);
    if (now - storeLookup.at < STORE_LOOKUP_RETRY_MS) return Promise.resolve(null);
  }
  storeLookup = { id: id, at: now, ok: false, name: null };
  return send({ type: 'GRAB_LOOKUP_STORE', storeId: id }).then((r) => {
    if (r && r.ok && r.storeName) {
      storeLookup = { id: id, at: Date.now(), ok: true, name: String(r.storeName) };
      return storeLookup;
    }
    storeLookup = {
      id: id,
      at: Date.now(),
      ok: false,
      name: null,
      reason: (r && r.reason) || '查唔到店名',
    };
    return storeLookup;
  });
}

function renderStoreBars() {
  const g = globalCache;
  const id = String(g.storeId || '').trim();
  const conn = $('storeConn');
  const connDet = $('storeConnDet');
  const ok = id && storeLookup.ok && storeLookup.id === id;
  const bad = id && storeLookup.id === id && !storeLookup.ok;

  const nameTxt = ok ? storeLookup.name : id ? '未驗證門店' : '未設定門店';
  const idTxt = id || '按「切換」輸入 Store ID';
  const connHtml = ok
    ? '<span class="cdot"></span>已連線'
    : bad
      ? '<span class="cdot"></span>連線失敗'
      : '<span class="cdot"></span>未驗證';

  if ($('storeNameTop')) {
    $('storeNameTop').textContent = nameTxt;
    $('storeIdTop').textContent = idTxt;
    $('storeNameTop').title = ok ? 'Store ID：' + id : '';
    conn.className = 'conn' + (ok ? ' ok' : bad ? ' bad' : '');
    conn.innerHTML = connHtml;
  }
  if ($('storeNameDet')) {
    $('storeNameDet').textContent = nameTxt;
    $('storeIdDet').textContent = idTxt;
    connDet.className = 'conn' + (ok ? ' ok' : bad ? ' bad' : '');
    connDet.innerHTML = connHtml;
  }
  // 主面板副標跟平台啟用狀態變
  const enabledKeys = GRAB_UI.filter((s) => dash[s.key] && dash[s.key].hasCreds).map((s) => s.label);
  const sub = $('mainSub');
  if (sub) {
    sub.textContent = enabledKeys.length
      ? enabledKeys.join(' ＋ ') + ' → macau-pos'
      : '尚未設定平台 · 按「切換」設定';
  }
}

// ---- 平台卡 -----------------------------------------------------------------

function cardHtml(s) {
  const d = dash[s.key];
  const has = !!(d && d.hasCreds);
  if (!has) {
    // 未啟用：降格灰卡（唔好報錯 —— 冇用呢個平台係正常狀態）
    return `
      <div class="pcard dim">
        <div class="phead">
          <span class="pdot off"></span>
          <div style="min-width:0">
            <div class="pname" style="color:var(--text3)">${escapeHtml(s.label)}</div>
            <div class="phost">未啟用 · 此門店未使用</div>
          </div>
          <label class="sw off"><input type="checkbox" data-push="${s.key}" disabled><span class="sl"></span></label>
        </div>
        <div class="pfoot">
          <span class="lg">Mpay 批核等不相關功能已一併收起</span>
          <button class="btn sm" data-configure="${s.key}">設定帳號</button>
        </div>
      </div>`;
  }

  const settings = (d && d.settings) || {};
  const state = (d && d.state) || {};

  // 🔴🔴 2026-10-02：MacauPay（legacy）簡化卡 —— 無獨立登入、無訂單頁／對帳頁，
  //    改用 mpay 專屬狀態（最後抓取時間 / 狀態 / error）＋「手動刷新」掣。
  if (s.legacy) {
    const mp = (d && d.mpay) || {};
    const statusHtml = mp.error
      ? `<span class="bad">抓取失敗：${escapeHtml(mp.error)}</span>`
      : mp.isTimerActive
        ? `<span class="hl">自動擷取中</span>` + (mp.lastGrabTime ? ` · 最後 ${escapeHtml(mp.lastGrabTime)}` : '')
        : mp.lastGrabTime
          ? `<span class="lg">已停止 · 最後 ${escapeHtml(mp.lastGrabTime)}</span>`
          : `<span class="lg">尚未啟動</span>`;
    return `
      <div class="pcard">
        <div class="phead">
          <span class="pdot ${mp.error ? 'err' : mp.isTimerActive ? 'ok' : 'wait'}"></span>
          <div style="min-width:0">
            <div class="pname">${escapeHtml(s.label)}</div>
            <div class="phost">${escapeHtml(s.site)}</div>
          </div>
          <label class="sw ${settings.pushEnabled ? '' : 'off'}">
            <input type="checkbox" data-push="${s.key}" ${settings.pushEnabled ? 'checked' : ''}>
            <span class="sl"></span>
          </label>
        </div>
        <div class="kv">
          <span class="k">擷取狀態</span><span class="v">${statusHtml}</span>
          <span class="k">本機紀錄</span><span class="v">${d.listLength != null ? d.listLength : 0} 筆</span>
          <span class="k">同步目標</span><span class="v mono">Supabase · macau-pos 總帳</span>
        </div>
        <div class="pfoot">
          <span class="lg">舊後台直抓鏈（msp.macaupay.com.mo）</span>
          <button class="btn ghost sm" data-refresh="${s.key}">手動刷新</button>
        </div>
      </div>`;
  }

  const orders = d.orders || {};
  const list = Object.keys(orders).map((k) => orders[k]);
  let sentCount = 0;
  list.forEach((o) => {
    if (o.state === 'sent') sentCount++;
  });

  // 登入狀態：來自 background 嘅 state.login（login.js 回報）
  const login = d.login || null;
  let loginHtml;
  if (login && login.ok === true) {
    loginHtml =
      `<span class="hl">已登入</span>` +
      (login.at ? ` · ${escapeHtml(relative(login.at))}` : '') +
      (login.stage === 'already' ? '（原本已登入）' : '');
  } else if (login && login.ok === false) {
    loginHtml = `<span class="bad">${escapeHtml(
      login.error || (login.stage === 'no-creds' ? '未設定帳密' : '登入失敗'),
    )}</span>`;
  } else {
    loginHtml = `<span style="color:var(--text3)">尚未測試 · 按「重新登入」驗證</span>`;
  }

  const lastCap = state.lastListCaptureAt;
  const lg = lastCap
    ? `<span class="lg ${Date.now() - Date.parse(lastCap) > STALE_MS ? 'err' : 'ok'}">最後擷取 ${escapeHtml(
        fmtTime(lastCap),
      )}（${escapeHtml(relative(lastCap))}）</span>`
    : `<span class="lg">尚未擷取 · 開始後會自動開頁登入</span>`;

  return `
    <div class="pcard">
      <div class="phead">
        <span class="pdot ${login && login.ok === true ? 'ok' : login && login.ok === false ? 'err' : 'wait'}"></span>
        <div style="min-width:0">
          <div class="pname">${escapeHtml(s.label)}</div>
          <div class="phost">${escapeHtml(s.site)}</div>
        </div>
        <label class="sw ${settings.pushEnabled ? '' : 'off'}">
          <input type="checkbox" data-push="${s.key}" ${settings.pushEnabled ? 'checked' : ''}>
          <span class="sl"></span>
        </label>
      </div>
      <div class="kv">
        <span class="k">登入狀態</span><span class="v">${loginHtml}</span>
        <span class="k">訂單頁</span><span class="v mono" title="${escapeHtml(s.site + s.orderPath)}">${escapeHtml(s.orderPath)}</span>
        <span class="k">對帳頁</span><span class="v mono" title="${escapeHtml(s.site + s.financePath)}">${escapeHtml(s.financePath)}</span>
        <span class="k">本次擷取</span><span class="v">${list.length} 筆 · 已推送 ${sentCount}</span>
      </div>
      ${dupTabHtml(d)}
      <div class="pfoot">
        ${lg}
        <button class="btn ghost sm" data-relogin="${s.key}">重新登入</button>
      </div>
    </div>`;
}

/**
 * 同平台開咗多過一個分頁嘅警示（2026-09-30 使用者真機）。
 *
 * 使用者原話：「我需要同時讓多個頁面各自獨立運行才能正常操作…但似乎無法正常運作。」
 *
 * ## 為什麼一定要出聲（唔可以靜靜地唔理）
 * 擴充功能嘅設計係「每個平台一組分頁」：
 *   · 訂單頁 1 個（攔列表／詳情請求）
 *   · 對帳頁 1 個（攔財務請求）
 * 多開一個同平台分頁**唔會**令佢「各自獨立運行」——而係：
 *   ① `state.tabId` 只認最後 `PAGE_READY` 嗰個 ⇒ 設篩選／代按查詢會送去另一個；
 *   ② `tabs[0]` 揀邊個取決於 Chrome 排序 ⇒ 症狀係「有時得有時唔得」。
 *
 * ⇒ 呢個係**必須由使用者糾正**嘅事項（擴充功能禁唔到人開分頁），
 *   所以唯一負責嘅做法就係：講清楚、講到佢知點做。
 *
 * ⚠️ `openTabCount === null` = 查唔到（測試環境／冇權限）⇒ 唔出警示，
 *    亦**唔可以**當 0（會變成假安心）。
 */
function dupTabHtml(d) {
  const info = d && d.tabInfo;
  // 查唔到 ⇒ 唔出警示（`unknown` 唔可以當 0）
  if (!info || info.unknown) return '';
  const order = Number(info.order) || 0;
  const finance = Number(info.finance) || 0;
  /**
   * 🔴🔴 2026-09-30 修正（使用者真機）：
   *   舊寫法用「分頁總數 > 1」做判準 ⇒ 但**正常狀態本身就係 2 張**
   *   （1 張訂單頁 ＋ 1 張對帳頁）⇒ 警示永遠唔走。
   *   使用者原話：「不明白為什麼會長時間顯示出來，不是應該 detect 到
   *   有多個頁面才需要提示嗎?」—— 佢講得對，舊判準係錯嘅。
   *
   *   真正需要提示 = **同一個用途**開咗多過一張（order > 1 或 finance > 1）。
   *   其他分頁（例如 `merchant.o2o.mfoodapp.com`）唔會影響命令分派
   *   （命令而家一律按 URL 認分頁），所以唔警示。
   */
  if (order <= 1 && finance <= 1) return '';

  const label = (k) =>
    k === 'order' ? '訂單頁' : k === 'finance' ? '對帳頁' : k === 'login' ? '登入頁' : '其他';
  const lines = (info.tabs || [])
    .map((t) => `${label(t.kind)} · ${escapeHtml(String(t.url || '').split('?')[0])}`)
    .join('<br>');

  const title =
    order > 1
      ? `⚠ 訂單頁開咗 ${order} 張`
      : `⚠ 對帳頁開咗 ${finance} 張`;

  return `
      <div class="dupwarn">
        <div class="dw-t">${title}</div>
        <div class="dw-b">
          此平台只可以留 <b>1 個訂單頁</b> 同 <b>1 個對帳頁</b>。同一個用途開多過一張，會令擴充功能有時揀錯分頁，出現「有時掃到、有時掃唔到」。<br>
          目前開住：<br><span class="mono">${lines}</span><br>
          請閂掉多餘嘅，再於該分頁按 F5。
        </div>
      </div>`;
}

function renderCards() {
  const box = $('cards');
  if (!box) return;
  box.innerHTML = GRAB_UI.map(cardHtml).join('');
}

// ---- 統計 + 日誌 ------------------------------------------------------------

function renderStats() {
  let sent = 0;
  let dup = 0;
  let fail = 0;
  let pend = 0;
  GRAB_UI.forEach((s) => {
    const d = dash[s.key];
    if (!d) return;
    const counters = (d.state && d.state.counters) || {};
    dup += Number(counters.duplicatesSkipped) || 0;
    const orders = d.orders || {};
    Object.keys(orders).forEach((k) => {
      const st = orders[k].state;
      if (st === 'sent') sent++;
      else if (st === 'failed') fail++;
      else if (st === 'held' || st === 'pending' || st === 'sending') pend++;
    });
  });
  if ($('stSent')) $('stSent').textContent = sent;
  if ($('stDup')) $('stDup').textContent = dup;
  if ($('stFail')) {
    $('stFail').textContent = fail;
    $('stFail').className = 'v' + (fail > 0 ? ' errv' : '');
  }
  if ($('stPend')) $('stPend').textContent = pend;
}

function renderLogs() {
  const box = $('logList');
  if (!box) return;
  let all = [];
  GRAB_UI.forEach((s) => {
    const d = dash[s.key];
    if (d && Array.isArray(d.log)) {
      all = all.concat(d.log.map((e) => Object.assign({ _src: s.key }, e)));
    }
  });
  all.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const filtered = logFilter === 'all' ? all : all.filter((e) => e._src === logFilter);
  const shown = filtered.slice(0, 40);

  if ($('logCount')) $('logCount').textContent = all.length ? `共 ${all.length} 筆` : '—';

  if (shown.length === 0) {
    const why =
      logFilter !== 'all' && !(dash[logFilter] && dash[logFilter].hasCreds)
        ? '此平台未啟用 · 按「設定帳號」補設'
        : '尚無事件';
    box.innerHTML = `<div class="lempty">${escapeHtml(why)}</div>`;
    return;
  }

  box.innerHTML = shown
    .map((item) => {
      const level = item.level || 'info';
      const cls =
        level === 'new' ? 'new' : level === 'push_ok' ? 'ok' : level === 'error' ? 'err' : 'info';
      return `<div class="litem">
        <span class="ldot ${cls}"></span>
        <span class="lmsg"><b>[${escapeHtml(grabSrcLabel(item._src))}]</b> ${escapeHtml(item.summary || '')}</span>
        <span class="ltime">${escapeHtml(fmtTime(item.at))}</span>
      </div>`;
    })
    .join('');
}

// ---- 總控列 -----------------------------------------------------------------

function renderRunCtl() {
  const enabled = GRAB_UI.filter((s) => dash[s.key] && dash[s.key].hasCreds);
  const active = enabled.length > 0 && enabled.every((s) => dash[s.key].settings && dash[s.key].settings.autoRefresh);
  const st = $('runState');
  if (st) {
    st.className = 'state' + (active ? ' on' : '');
    st.innerHTML =
      '<span class="cdot"></span>' +
      (active
        ? enabled.length > 1
          ? '全部運行中'
          : `運行中（1 個平台）`
        : enabled.length
          ? '已停止'
          : '未設定平台');
  }
  const hint = $('runHint');
  if (hint && !hintEditing) {
    const secs = (globalCache.intervalSecs || 30) + ' 秒';
    const lastCap = enabled
      .map((s) => dash[s.key] && dash[s.key].state && dash[s.key].state.lastListCaptureAt)
      .filter(Boolean)
      .sort()
      .pop();
    hint.textContent = active
      ? `每 ${secs} · 上次 ${lastCap ? relative(lastCap) : '—'}`
      : `按「開始」自動登入並開始掃描（每 ${secs}）`;
  }
  const btn = $('btnRun');
  if (btn) {
    btn.textContent = active ? '暫停' : '開始';
    btn.className = 'btn sm' + (active ? '' : ' pri');
  }
  return active;
}

let hintEditing = false;

function wireRunCtl() {
  // 門店列「切換」＝ 開設定精靈（改 Store ID / 帳密 / 頻率）
  // 🔴 兩粒掣（主面板 #btnSwitchStore、明細 #btnDetailSwitch）都要接，
  //    2026-09-30 實案：兩粒都冇接線 ⇒ 精靈冇入口。
  $('btnSwitchStore').addEventListener('click', () => openWizard());
  $('btnDetailSwitch').addEventListener('click', () => openWizard());

  // 🔴🔴 2026-09-30：訂單明細入口。`#view-detail` 同 `renderDetail()` 一直都存在，
  //    但**從來冇任何掣／任何路徑**入得去（連 `#btnOrders` 都冇喺 HTML 出現過）
  //    ⇒ 使用者真機問「我怎樣看到訂單明細?」。
  //    ⚠️ 一定要用**字面 id**（唔可以 forEach 包住），否則靜態掃描驗唔到接線。
  $('btnOrders').addEventListener('click', () => {
    showView('detail');
    renderDetail();
  });

  $('btnRun').addEventListener('click', () => {
    const active = renderRunCtl();
    const secs = Math.max(5, Number(globalCache.intervalSecs) || 30);
    if (!active) {
      chrome.runtime.sendMessage({ action: 'updateTimer', intervalSecs: secs });
      send({ type: 'GRAB_APPLY_INTERVAL', secs: secs })
        .then(() => send({ type: 'GRAB_SET_AUTOMATION', enabled: true }))
        .then(() => refreshAll());
    } else {
      chrome.runtime.sendMessage({ action: 'stopTimer' });
      send({ type: 'GRAB_APPLY_INTERVAL', secs: 0 })
        .then(() => send({ type: 'GRAB_SET_AUTOMATION', enabled: false }))
        // 🔴🔴 2026-10-02：一齊清走對帳鎖／累加器，並叫對帳中嘅分頁切返訂單頁
        .then(() => send({ type: 'GRAB_STOP_ALL' }))
        .then(() => refreshAll());
    }
  });

  $('runHint').addEventListener('click', () => {
    if (hintEditing) return;
    hintEditing = true;
    const hint = $('runHint');
    const cur = Math.max(5, Number(globalCache.intervalSecs) || 30);
    hint.innerHTML = `<span class="hintedit"><input type="number" id="hintSecs" value="${cur}" min="5">
      <button id="hintOk">確定</button></span>`;
    const input = $('hintSecs');
    input.focus();
    input.select();
    const apply = () => {
      const secs = Math.max(5, parseInt(input.value, 10) || 30);
      chrome.storage.local.set({ currentIntervalSecs: secs });
      globalCache.intervalSecs = secs;
      send({ type: 'GRAB_APPLY_INTERVAL', secs: secs }).then(() => {
        // 跑動中就一併更新 Mpay 的 alarm 節拍
        chrome.storage.local.get(['isTimerActive'], (r) => {
          if (r.isTimerActive) {
            chrome.runtime.sendMessage({ action: 'updateTimer', intervalSecs: secs });
          }
        });
      });
      hintEditing = false;
      renderRunCtl();
    };
    $('hintOk').addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
      if (e.key === 'Escape') {
        hintEditing = false;
        renderRunCtl();
      }
    });
  });
}

// ---- 工具選單 ---------------------------------------------------------------

function closeMenu() {
  const m = $('toolMenu');
  if (m) {
    m.hidden = true;
    $('menuBtn').classList.remove('on');
    $('financeSub').hidden = true;
    $('devSub').hidden = true;
  }
}

function wireMenu() {
  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('toolMenu');
    m.hidden = !m.hidden;
    $('menuBtn').classList.toggle('on', !m.hidden);
    if (!m.hidden) prefillFinanceSub();
  });
  document.addEventListener('click', (e) => {
    const m = $('toolMenu');
    if (m && !m.hidden && !m.contains(e.target) && e.target !== $('menuBtn')) closeMenu();
  });

  $('miRescan').addEventListener('click', () => {
    closeMenu();
    send({ type: 'GRAB_RESCAN_ALL' });
  });

  $('miLoginAll').addEventListener('click', () => {
    closeMenu();
    $('miLoginAll').querySelector('.ml').textContent = '測試登入中…';
    send({ type: 'GRAB_LOGIN_TEST_ALL' }).then((r) => {
      $('miLoginAll').querySelector('.ml').textContent = '測試登入（全部平台）';
      const results = (r && r.results) || {};
      const lines = GRAB_UI.map((s) => {
        const x = results[s.key];
        if (!x) return `${s.label}：沒有回應`;
        if (x.ok) return `${s.label}：✓ ${x.stage === 'already' ? '原本已登入' : '登入成功'}`;
        return `${s.label}：✗ ${x.reason || '失敗'}`;
      });
      alert(lines.join('\n'));
    });
  });

  $('miOpenTabs').addEventListener('click', () => {
    closeMenu();
    send({ type: 'GRAB_OPEN_ADMIN_TABS' });
  });

  $('miExport').addEventListener('click', () => {
    closeMenu();
    send({ type: 'GRAB_EXPORT_LOG' }).then((r) => {
      if (!r || !r.ok) {
        alert('匯出失敗：' + ((r && r.reason) || '沒有回應'));
        return;
      }
      const blob = new Blob([r.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  });

  $('miFinance').addEventListener('click', (e) => {
    e.stopPropagation();
    $('financeSub').hidden = !$('financeSub').hidden;
    $('devSub').hidden = true;
  });
  $('miDev').addEventListener('click', (e) => {
    e.stopPropagation();
    $('devSub').hidden = !$('devSub').hidden;
    $('financeSub').hidden = true;
  });

  $('miResetSeen').addEventListener('click', () => {
    if (!confirm('清除去重記錄？\n\n已擷取過的訂單會被當成新單再推送一次（可能造成重複出單）。')) return;
    closeMenu();
    GRAB_UI.forEach((s) => send({ type: s.prefix + '_RESET_SEEN' }));
  });

  $('miClearLog').addEventListener('click', () => {
    if (!confirm('清空全部運行日誌？\n\n只刪除日誌紀錄，不影響訂單資料。')) return;
    closeMenu();
    GRAB_UI.forEach((s) => send({ type: s.prefix + '_CLEAR_LOG' })).then(() => refreshAll());
  });

  // 🔴 2026-09-30 使用者要求：「沒方法登出」
  //    清除本機全部憑證與識別（Store ID），回到首次設定精靈。
  //    ⚠️ 一定要講清楚「唔會刪平台嗰邊嘅任何嘢」——商家最怕嘅係連後台資料都被清。
  $('miLogout').addEventListener('click', () => {
    const ok = confirm(
      '登出並清除本機資料？\n\n' +
        '會刪除本機儲存嘅：\n' +
        '· Store ID（門店識別）\n' +
        '· mfood 與澳覓嘅帳號密碼\n' +
        '· 自動同步／對帳等設定\n\n' +
        '（平台後台嘅訂單資料唔會受影響）\n\n' +
        '清除後會回到首次設定精靈。要繼續嗎？',
    );
    if (!ok) return;
    closeMenu();
    const keys = [
      'machineId',
      'wizardDone',
      'startDate',
      'isTimerActive',
      'mfoodCreds',
      'aomiCreds',
      'mfoodLoginAt',
      'aomiLoginAt',
      'mfoodSettings',
      'aomiSettings',
      'mfoodState',
      'aomiState',
      'mfoodFinanceStoreName',
      'aomiFinanceStoreName',
    ];
    chrome.storage.local.remove(keys, () => {
      void chrome.runtime.lastError;
      chrome.runtime.sendMessage({ action: 'stopTimer' }, () => void chrome.runtime.lastError);
      GRAB_UI.forEach((s) => send({ type: s.prefix + '_SAVE_SETTINGS', patch: { autoRefresh: false } }));
      // 重設本機快取，等刷新唔會攞返舊資料
      globalCache.storeId = '';
      globalCache.startDate = '';
      storeLookup = { id: null, at: 0, ok: false, name: null };
      dash.mfood = null;
      dash.aomi = null;
      wiz.store = { ok: false, name: null };
      GRAB_UI.forEach((s) => {
        wiz[s.key] = { skip: false };
      });
      // 🔴 `wizardOpen()` 會由 storage 讀返值 —— 一定要喺 `remove()` **回呼之後**
      //    先叫佢，否則讀到舊 Store ID（實測捉到：登出後精靈仲顯示舊門店）。
      openWizard();
      alert('已清除本機資料。請重新輸入 Store ID 與平台帳密。');
      refreshAll();
    });
  });
}

// ---- 對帳設定（選單展開區）---------------------------------------------------
//
// 🔴 結果顯示照搬舊版（2026-09-28 十六次真機嘅教訓全在裡面）：
//    「抄到 < 平台」一定要彈紅字；失敗要帶 URL／HTTP 碼／有冇簽章。

function settleViaLabel(via) {
  switch (via) {
    case 'network-event':
      return '網絡攔截';
    case 'network-ask':
      return '網絡（回溯）';
    case 'periods-map':
      return '帳期列表配對';
    case 'periods-only':
      return '帳期唯一';
    case 'dom':
      return 'DOM 保底';
    default:
      return String(via || '未知');
  }
}

function showSettleResult(hintEl, r) {
  if (!hintEl) return;
  if (!r) {
    hintEl.textContent = '沒有回應 —— 請重新載入擴充功能後再試';
    hintEl.style.color = 'var(--red)';
    return;
  }
  if (r.ok && r.skipped) {
    hintEl.textContent = r.reason || '未到對帳時間';
    hintEl.style.color = '';
    return;
  }
  if (!r.ok) {
    let msg = '對帳失敗：' + (r.reason || '未知原因');
    if (r.via) msg += `（id 來源: ${settleViaLabel(r.via)}）`;
    const dbg = [];
    if (r.requestUrl) dbg.push('URL ' + r.requestUrl);
    if (r.requestStatus) dbg.push('碼 ' + r.requestStatus);
    if (typeof r.hasSignature === 'boolean') dbg.push(r.hasSignature ? '有簽章' : '⚠️ 冇簽章標頭');
    if (r.mainWorldTemplate === false || r.hadBodyTemplate === false) dbg.push('⚠️ MAIN world 冇請求範本');
    if (r.step) dbg.push('步驟 ' + r.step);
    if (dbg.length) msg += ' 〔' + dbg.join('、') + '〕';
    hintEl.textContent = msg;
    hintEl.style.color = 'var(--red)';
    return;
  }
  const parts = [`帳期 ${r.period || '—'}`];
  if (typeof r.receive === 'number') {
    parts.push(`實收 ${r.receive}`);
    if (typeof r.should === 'number') parts.push(`應收 ${r.should}`);
  }
  parts.push(`平台 ${r.pushed || 0} 筆`);
  if (typeof r.grabbed === 'number') {
    if (typeof r.grabbedTotal === 'number' && r.grabbed < r.grabbedTotal) {
      parts.push(`⚠️ 只抄到 ${r.grabbed} / 平台 ${r.grabbedTotal} 筆`);
    } else {
      parts.push(`抄到 ${r.grabbed} 筆`);
    }
  }
  parts.push(`更新 ${r.updated || 0} 張單`);
  if (r.notFound && r.notFound.length) parts.push(`${r.notFound.length} 筆未配對`);
  if (r.source === 'list-inline') parts.push('（直接讀取，無重放）');
  if (r.source === 'list-inline+replay') parts.push('（直讀金額＋重放明細）');
  if (r.source === 'page-capture') parts.push('（搭便車讀取，無重放）');
  if (r.via) parts.push(`(id 來源: ${settleViaLabel(r.via)})`);
  if (r.pageSize) parts.push(r.downgraded ? `pageSize ${r.pageSize}（已降級）` : `pageSize ${r.pageSize}`);
  if (typeof r.total === 'number' && r.pushed && r.total > r.pushed) {
    parts.push(`⚠️ 平台總數 ${r.total} > 實得 ${r.pushed}`);
  }
  hintEl.textContent = '✓ ' + parts.join(' · ');
  hintEl.style.color = 'var(--green)';
}

function prefillFinanceSub() {
  chrome.storage.local.get(['mfoodFinanceStoreName', 'aomiFinanceStoreName'], (r) => {
    const mf = $('financeStoreName');
    const ao = $('aomiFinanceStoreName');
    if (mf) mf.value = r.mfoodFinanceStoreName || '';
    if (ao && document.activeElement !== ao) ao.value = r.aomiFinanceStoreName || '';
    // 已選過但清單未載入 → 收埋清單，避免一開選單就見住一堆選項
    const list = $('storeOptList');
    if (list) list.hidden = true;
    if ($('storeOptHint') && !r.mfoodFinanceStoreName) {
      $('storeOptHint').textContent = '撳「載入商家」由後台列出可選店家，再撳一下選定';
      $('storeOptHint').style.color = '';
    }
  });
  if (dash.mfood && $('autoSettle')) $('autoSettle').checked = !!dash.mfood.settings.autoSettle;
  if (dash.aomi && $('aomiAutoSettle')) $('aomiAutoSettle').checked = !!dash.aomi.settings.autoSettle;
}

/**
 * 🔴🔴 2026-09-30：把 mfood 商家下拉嘅**真實選項**畫成可撳清單。
 *
 * 為咩要佢（使用者原話）：「你需要給商家在extension 上, 選擇用那家店,
 * 去做mfood 對帳」——原本只有一個自由文字框，商家要手打後台那串長名
 * （例如「表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)」），真機 80/80 都對唔上。
 *
 * ⚠️ 一定要**分清楚**三種情況，唔可以當同一種（同 setStore 失敗訊息同一個紀律）：
 *   ① 讀取失敗（冇財務頁／搵唔到下拉）→ 報失敗，但**仍然保留手動輸入**；
 *   ② 讀到但 0 個選項 → 講清楚係「遠端搜尋未返」，唔好叫商家去核對名稱；
 *   ③ 讀到 N 個選項 → 畫清單，商家撳一下就選定。
 */
function renderStoreOptions(res, target) {
  // 🔴 兩個入口共用同一支（主面板 #financeStoreName／精靈 #wizMfoodFinance）。
  //    `target` ＝ {input, list, hint, isWizard}。
  const t = target || {
    input: $('financeStoreName'),
    list: $('storeOptList'),
    hint: $('storeOptHint'),
  };
  const hint = t.hint;
  const list = t.list;
  if (!hint || !list) return;

  const r = res || {};
  const opts = Array.isArray(r.options) ? r.options : [];

  if (!r.ok) {
    list.hidden = true;
    hint.textContent =
      '✗ 載入失敗：' + (r.reason || '沒有回應') + '（仍可手動輸入商家名）';
    hint.style.color = 'var(--red)';
    // 失敗時把手動輸入打開，商家唔會卡死
    if (t.input) t.input.readOnly = false;
    return;
  }

  if (!opts.length) {
    list.hidden = true;
    hint.textContent =
      '⚠ 後台回報 0 個可選店家：' +
      (r.emptyReason || '商家清單可能係遠端搜尋，要打關鍵字先返') +
      '（仍可手動輸入商家名）';
    hint.style.color = 'var(--amber, #b26a00)';
    if (t.input) t.input.readOnly = false;
    return;
  }

  const cur = String(r.current || '');
  hint.textContent = '後台有 ' + opts.length + ' 個可選店家，撳一下選定（可再撳「載入商家」更新）';
  hint.style.color = '';

  list.innerHTML = opts
    .map(
      (name) =>
        `<button class="btn sm" data-store="${escapeHtml(name)}" ` +
        `style="text-align:left;justify-content:flex-start;${name === cur ? 'border-color:var(--accent);color:var(--accent)' : ''}">` +
        `${name === cur ? '✓ ' : ''}${escapeHtml(name)}</button>`,
    )
    .join('');
  list.hidden = false;

  // 🔴 一定要用**元素委派**（唔可以逐個 addEventListener）——
  //    新按鈕每次重新渲染，逐個綁會漏／會有殘留監聽。
  list.onclick = (e) => {
    const btn = e.target.closest('button[data-store]');
    if (!btn) return;
    const name = btn.getAttribute('data-store') || '';
    if (t.input) {
      t.input.value = name;
      t.input.readOnly = true;
    }
    chrome.storage.local.set({ mfoodFinanceStoreName: name });
    hint.textContent = '✓ 已選：' + name;
    hint.style.color = 'var(--green)';
    // 重畫一次，令打勾移到新選嘅嗰個
    renderStoreOptions({ ok: true, options: opts, current: name }, t);
  };
}

/** 精靈版目標（同主面板共用 `renderStoreOptions`）。 */
function wizStoreTarget() {
  return {
    input: $('wizMfoodFinance'),
    list: $('wizStoreOptList'),
    hint: $('wizStoreOptHint'),
  };
}

/** 讀後台商家清單，畫入指定目標。 */
function fetchStoreOptions(target) {
  const t = target || { input: $('financeStoreName'), list: $('storeOptList'), hint: $('storeOptHint') };
  if (t.hint) {
    t.hint.textContent = '讀取後台商家清單中…（要開住 mfood 財務對帳頁）';
    t.hint.style.color = '';
  }
  send({ type: 'GRAB_MFOOD_STORE_OPTIONS' }).then((r) => renderStoreOptions(r, t));
}

function loadStoreOptions() {
  const btn = $('loadStoreOptions');
  const t = { input: $('financeStoreName'), list: $('storeOptList'), hint: $('storeOptHint') };
  if (btn) btn.disabled = true;
  // ⚠️ 一定要**讀完才 enable 返**（唔可以即刻 enable）——
  //    否則商家可以連撳，兩個請求同時開下拉會撳錯 popper。
  fetchStoreOptions(t).then(() => {
    if (btn) btn.disabled = false;
  });
}

/** 精靈版「載入商家」。 */
function loadWizStoreOptions() {
  const btn = $('wizLoadStoreOptions');
  if (btn) btn.disabled = true;
  fetchStoreOptions(wizStoreTarget()).then(() => {
    if (btn) btn.disabled = false;
  });
}

function wireFinanceSub() {
  // 🔴 商家名改為「由後台清單揀」——`#financeStoreName` 係唯讀顯示欄，
  //    change 唔會再由使用者打字觸發（但仍然保留 handler 作安全網）。
  $('financeStoreName').addEventListener('change', (e) => {
    chrome.storage.local.set({ mfoodFinanceStoreName: e.target.value.trim() });
  });
  $('loadStoreOptions').addEventListener('click', loadStoreOptions);
  $('aomiFinanceStoreName').addEventListener('change', (e) => {
    chrome.storage.local.set({ aomiFinanceStoreName: e.target.value.trim() });
  });
  $('autoSettle').addEventListener('change', (e) => {
    send({ type: 'GRAB_SET_AUTO_SETTLE', sourceKey: 'mfood', enabled: !!e.target.checked });
  });
  $('aomiAutoSettle').addEventListener('change', (e) => {
    send({ type: 'GRAB_SET_AUTO_SETTLE', sourceKey: 'aomi', enabled: !!e.target.checked });
  });
  $('settleNowBtn').addEventListener('click', () => {
    const btn = $('settleNowBtn');
    const hint = $('settleHint');
    btn.disabled = true;
    hint.textContent = '對帳中…（要開住 mfood 財務對帳頁）';
    hint.style.color = '';
    send({ type: 'GRAB_SETTLE_NOW' }).then((r) => {
      btn.disabled = false;
      showSettleResult(hint, r);
    });
  });
  $('aomiSettleNowBtn').addEventListener('click', () => {
    const btn = $('aomiSettleNowBtn');
    const hint = $('aomiSettleHint');
    btn.disabled = true;
    hint.textContent = '對帳中…（要開住澳覓對帳頁）';
    hint.style.color = '';
    send({ type: 'GRAB_SETTLE_AOMI_NOW' }).then((r) => {
      btn.disabled = false;
      showSettleResult(hint, r);
    });
  });
}

// ---- 開發者工具（選單展開區）-------------------------------------------------

function copyOrDownload(text, filename) {
  const tryClipboard =
    navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('no clipboard'));
  return tryClipboard
    .then(() => 'copied')
    .catch(() => {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return 'downloaded';
    });
}

function devHint(text, color) {
  const el = $('devHint');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '';
}

function fakeOrderCount() {
  const el = $('fakeOrderCount');
  const n = parseInt((el && el.value) || '1', 10);
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(20, n);
}

function sendFakeOrder(source, btn) {
  const count = fakeOrderCount();
  const countEl = $('fakeOrderCount');
  if (countEl && String(countEl.value) !== String(count)) countEl.value = String(count);
  chrome.storage.local.set({ fakeOrderCount: count });

  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '推送中…';
  send({ type: 'GRAB_BUILD_FAKE_ORDER', source: source, count: count }).then((res) => {
    btn.disabled = false;
    btn.textContent = old;
    const r = res || {};
    if (!r.ok) {
      alert('推送失敗\n\n' + (r.error || '未知原因'));
      return;
    }
    // 🔴 唔可以見到 ok:true 就當已推送 —— 要睇 created
    let info = null;
    try {
      info = JSON.parse(r.response);
    } catch (e) {
      info = null;
    }
    const created =
      typeof r.created === 'number'
        ? r.created
        : info && typeof info.created === 'number'
          ? info.created
          : null;
    const nos = Array.isArray(r.nos) && r.nos.length ? r.nos.join('、') : r.localOrderNo || '(未知)';
    const rejected = info && Array.isArray(info.rejected) ? info.rejected : [];
    const warnings = info && Array.isArray(info.warnings) ? info.warnings : [];
    const lines = ['POS 建立：' + (created === null ? '(未知)' : created + ' / ' + count + ' 張'), '單號：' + nos];
    if (rejected.length) {
      lines.push('被拒：' + rejected.slice(0, 3).map((x) => x.externalOrderId + '（' + x.reason + '）').join('\n      '));
    }
    if (warnings.length) lines.push('提示：' + warnings.slice(0, 3).join('\n      '));
    if (created === 0) {
      alert('⚠️ POS 收到 0 張單 —— 推送內容有問題\n\n' + lines.join('\n') + '\n\nPOS 回應：' + (r.response || '(冇)'));
    } else {
      alert('✅ 已推送假訂單（' + count + ' 張）\n\n' + lines.join('\n'));
    }
  });
}

function fmtRange(applied) {
  if (!applied || applied.startTime == null) return '指定日期';
  const f = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  };
  return `${f(applied.startTime)} ~ ${f(applied.endTime)}`;
}

function wireDevSub() {
  $('fakeOrderMfood').addEventListener('click', function () {
    sendFakeOrder('mfood', this);
  });
  $('fakeOrderAomi').addEventListener('click', function () {
    sendFakeOrder('aomi', this);
  });

  $('clearAllOrders').addEventListener('click', function () {
    if (!confirm('清除兩個平台已擷取的所有訂單與品項？\n\n（去重記錄保留，不會重複推送）')) return;
    send({ type: 'GRAB_CLEAR_ALL_ORDERS' }).then((r) => {
      devHint(r && r.ok ? '✓ 已清除' : '✗ 失敗：' + ((r && r.reason) || ''), r && r.ok ? 'var(--green)' : 'var(--red)');
      refreshAll();
    });
  });

  $('syncRangeNow').addEventListener('click', function () {
    chrome.storage.local.get(['startDate'], (r) => {
      const start = r.startDate;
      if (!start) {
        alert('請先在設定精靈「只同步此日後」選一個日期');
        return;
      }
      if (
        !confirm(
          `要在 mfood 與澳覓的頁面上套用日期區間嗎？\n\n` +
            `· 起始：${start}\n· 結束：今天\n` +
            `· mfood：直接用 API 重放列表請求（最準）\n` +
            `· 澳覓：走遍 4 個狀態，每個都回讀驗證\n\n` +
            `過程中頁面會自己操作，大約需要 15 秒，請暫時不要動它。`,
        )
      ) {
        return;
      }
      const btn = this;
      btn.disabled = true;
      btn.textContent = '抓取中…';
      send({ type: 'GRAB_SYNC_RANGE', startDate: start }).then((res) => {
        btn.disabled = false;
        btn.textContent = '套用日期並抓全部';
        const rs = (res && res.results) || [];
        const lines = rs.map((x) => {
          if (!x.ok) return `${grabSrcLabel(x.source)}：失敗 — ${x.reason || '未知原因'}`;
          if (x.via === 'api') {
            const got = x.rows || 0;
            const total = x.total == null ? null : Number(x.total);
            return (
              `${grabSrcLabel(x.source)}：以 API 套用 ${fmtRange(x.applied)}，取得 ${got} 張單` +
              (total == null ? '' : `（平台總數 ${total}）`) +
              (total != null && got < total ? ` ⚠️ 少 ${total - got} 張` : '')
            );
          }
          const total = Array.isArray(x.types) ? x.types.length : 0;
          const okCount = typeof x.verifiedTypes === 'number' ? x.verifiedTypes : 0;
          return (
            `${grabSrcLabel(x.source)}：操作頁面完成，共 ${x.pages || 0} 頁` +
            (total > 0 ? `（回讀驗證 ${okCount}/${total} 個狀態）` : '')
          );
        });
        devHint(lines.join('\n') || '完成', 'var(--green)');
      });
    });
  });

  $('settleDomDump').addEventListener('click', function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = '診斷中…';
    send({ type: 'GRAB_SETTLE_DOMDUMP' }).then((r) => {
      btn.disabled = false;
      btn.textContent = '對帳頁結構診斷';
      if (!r || !r.ok) {
        devHint('診斷失敗：' + ((r && r.reason) || '沒有回應'), 'var(--red)');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyOrDownload(JSON.stringify(r, null, 2), `mfood-finance-dom-${stamp}.json`).then((how) => {
        devHint(how === 'copied' ? '✓ 結構已複製' : '✓ 結構已下載', 'var(--green)');
      });
    });
  });

  $('settleForensic').addEventListener('click', function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = '取證中…';
    send({ type: 'GRAB_FINANCE_FORENSIC' }).then((r) => {
      btn.disabled = false;
      btn.textContent = '財務請求 host 取證';
      if (!r || !r.ok) {
        devHint('取證失敗：' + ((r && r.reason) || '沒有回應'), 'var(--red)');
        return;
      }
      const seen = Array.isArray(r.seenUrls) ? r.seenUrls : [];
      const hosts = {};
      seen.forEach((s) => {
        try {
          hosts[new URL(s.url).origin] = (hosts[new URL(s.url).origin] || 0) + 1;
        } catch (e) {
          hosts['(相對路徑)'] = (hosts['(相對路徑)'] || 0) + 1;
        }
      });
      const verdict =
        Object.keys(hosts).length && !Object.keys(hosts).some((h) => h === r.pageOrigin)
          ? '🔴 請求 host 同頁面 origin 唔同 —— 重放要用請求 host！'
          : '請求 host 同頁面 origin 一致（或未捕捉到）';
      const text = JSON.stringify({ pageOrigin: r.pageOrigin, 請求Host統計: hosts, 判定: verdict, seenUrls: seen }, null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyOrDownload(text, `mfood-finance-forensic-${stamp}.json`).then((how) => {
        devHint((how === 'copied' ? '✓ 已複製：' : '✓ 已下載：') + verdict, /🔴/.test(verdict) ? 'var(--red)' : 'var(--green)');
      });
    });
  });

  $('dumpAllOrders').addEventListener('click', function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = '讀取中…';
    send({ type: 'GRAB_FINANCE_RAW' }).then((r) => {
      btn.disabled = false;
      btn.textContent = '拿全部訂單（複製 JSON）';
      if (!r || !r.ok) {
        devHint(r && r.hint ? r.hint : '讀取失敗：' + ((r && r.reason) || '沒有回應'), 'var(--red)');
        return;
      }
      const periodRows = Array.isArray(r.periodRows) ? r.periodRows : [];
      const detailRows = Array.isArray(r.detailRows) ? r.detailRows : [];
      const summary = {
        說明: '以下為平台原始資料，未經任何配對／篩選',
        讀取時間: r.capturedAt ? new Date(r.capturedAt).toLocaleString() : null,
        帳期列數: periodRows.length,
        帳期列: periodRows,
        明細列: detailRows,
      };
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyOrDownload(JSON.stringify(summary, null, 2), `mfood-orders-raw-${stamp}.json`).then((how) => {
        if (!periodRows.length && !detailRows.length) {
          devHint('⚠ 目前冇攔截到任何資料 —— 請先「立即對帳」，再撳呢個掣', 'var(--amber)');
        } else {
          devHint((how === 'copied' ? '✓ 已複製：' : '✓ 已下載：') + `帳期 ${periodRows.length} 列、明細 ${detailRows.length} 列`, 'var(--green)');
        }
      });
    });
  });

  $('copyDiag').addEventListener('click', function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = '匯出中…';
    send({ type: 'GRAB_DIAGNOSTICS' }).then((blob) => {
      btn.disabled = false;
      btn.textContent = '複製診斷';
      if (!blob) {
        devHint('匯出失敗，請稍後再試', 'var(--red)');
        return;
      }
      let text = JSON.stringify(blob, null, 2);
      if (text.length > 400000) text = text.slice(0, 400000) + '\n…（內容過長已截斷）';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyOrDownload(text, `grabber-diagnostics-${stamp}.json`).then((how) => {
        devHint(how === 'copied' ? '✓ 診斷已複製' : '✓ 診斷已下載', 'var(--green)');
      });
    });
  });

  // 還原上次填嘅假訂單張數
  chrome.storage.local.get(['fakeOrderCount'], (r) => {
    const el = $('fakeOrderCount');
    if (!el) return;
    const n = parseInt(r.fakeOrderCount, 10);
    if (isFinite(n) && n >= 1) el.value = String(Math.min(20, n));
  });
}

// ---- 平台卡互動（事件委派，2 秒重建都唔會甩） ----------------------------------

function wireCards() {
  const box = $('cards');
  box.addEventListener('click', (e) => {
    const relogin = e.target.closest('[data-relogin]');
    if (relogin) {
      const key = relogin.getAttribute('data-relogin');
      const old = relogin.textContent;
      relogin.disabled = true;
      relogin.textContent = '登入中…';
      send({ type: 'GRAB_LOGIN_TEST_ONE', sourceKey: key }).then((r) => {
        relogin.disabled = false;
        relogin.textContent = old;
        if (!r || !r.ok) {
          alert(`${grabSrcLabel(key)} 自動登入失敗：\n${(r && r.reason) || '未知原因'}`);
        }
        refreshAll();
      });
      return;
    }
    const cfg = e.target.closest('[data-configure]');
    if (cfg) {
      openWizard();
    }
    // 🔴🔴 2026-10-02：MacauPay（legacy）卡片嘅「手動刷新」＝ 觸發舊後台直抓鏈
    const rf = e.target.closest('[data-refresh]');
    if (rf) {
      chrome.runtime.sendMessage({ action: 'manualGrab' });
      devHint('已要求 MacauPay 抓取一次', 'var(--green)');
    }
  });
  box.addEventListener('change', (e) => {
    const sw = e.target.closest('[data-push]');
    if (!sw || sw.disabled) return;
    const key = sw.getAttribute('data-push');
    const src = GRAB_UI.find((s) => s.key === key);
    if (!src) return;
    send({ type: src.prefix + '_SAVE_SETTINGS', patch: { pushEnabled: !!sw.checked } }).then(() =>
      refreshAll(),
    );
  });
}

// ---- 訂單明細視圖 -----------------------------------------------------------

function orderStateBadge(st) {
  if (st === 'sent') return '<span class="ost"><span class="cdot"></span>已推送</span>';
  if (st === 'failed') return '<span class="ost bad"><span class="cdot" style="background:var(--red)"></span>推送失敗</span>';
  if (st === 'held' || st === 'pending' || st === 'sending')
    return `<span class="ost wait"><span class="cdot" style="background:#e8a33d"></span>${escapeHtml(
      ORDER_STATE_LABEL[st] || st,
    )}</span>`;
  return `<span class="ost mute">${escapeHtml(ORDER_STATE_LABEL[st] || st || '—')}</span>`;
}

function renderDetail() {
  const box = $('dList');
  if (!box) return;
  let all = [];
  GRAB_UI.forEach((s) => {
    const d = dash[s.key];
    if (!d) return;
    const orders = d.orders || {};
    const settleMap = d.settleMap || (d.state && d.state.settleMap) || {};
    Object.keys(orders).forEach((k) => {
      all.push(Object.assign({ _src: s.key, _srcLabel: s.label, _settle: settleMap[k] || settleMap[orders[k].tradeNo || k] }, orders[k]));
    });
  });
  all.sort((a, b) => (Date.parse(String(b.at || '').replace(' ', 'T')) || 0) - (Date.parse(String(a.at || '').replace(' ', 'T')) || 0));
  all = all.slice(0, 60);

  if ($('dCount')) $('dCount').textContent = all.length ? `共 ${all.length} 筆` : '—';

  if (all.length === 0) {
    box.innerHTML = '<div class="empty">尚未擷取到訂單<br>按主面板「開始」後會自動登入並開始擷取</div>';
    return;
  }

  box.innerHTML = all
    .map((o) => {
      const orderNo = String(o.tradeNo || o.id || '');
      const seqRaw = o.seq ? String(o.seq).replace(/^#/, '') : '';
      const itemNames = (o.items || [])
        .map((it) => {
          const n = it.displayName || it.name;
          if (!n) return null;
          const sp = (it.specs || []).filter(Boolean);
          return sp.length > 0 ? `${n}（${sp.join('/')}）` : n;
        })
        .filter(Boolean);
      const meta = [fmtShort(o.at), seqRaw ? `訂單編號 #${seqRaw}` : '', itemNames.length ? `${itemNames.length} 個品項` : '']
        .filter(Boolean)
        .join(' · ');

      const itemRows = (o.items || [])
        .map((it) => {
          const n = it.displayName || it.name;
          if (!n) return '';
          const sp = (it.specs || []).filter(Boolean).join('/');
          const qty = Number(it.quantity) || 1;
          const price = it.unitPrice != null && isFinite(Number(it.unitPrice)) ? Number(it.unitPrice).toFixed(2) : '';
          return `<div class="irow">
            <span class="iname" title="${escapeHtml(n + (sp ? `（${sp}）` : ''))}">${escapeHtml(n)}</span>
            <span class="iqty">×${qty}</span>
            <span class="iprice">${escapeHtml(price)}</span>
          </div>${sp ? `<div class="irow"><span class="iqty" style="grid-column:2/4;text-align:right">${escapeHtml(sp)}</span></div>` : ''}`;
        })
        .join('');

      const turnover = o.amount != null && isFinite(Number(o.amount)) ? Number(o.amount).toFixed(2) : null;
      const settle = o._settle && o._settle.receive != null && isFinite(Number(o._settle.receive));
      const turnoverRow = turnover
        ? `<div class="sline strong"><span class="k">營業額（MOP）</span><span class="v">${turnover}</span></div>`
        : '';
      const settleRow = settle
        ? `<div class="sline strong net"><span class="k">實收（MOP）</span><span class="v">${Number(o._settle.receive).toFixed(2)}</span></div>`
        : turnover
          ? '<div class="sline"><span class="k">實收（MOP）</span><span class="v">待對帳</span></div>'
          : '';

      const errRow =
        o.state === 'failed' && o.error
          ? `<div class="oerr" title="${escapeHtml(o.error)}">✗ ${escapeHtml(o.error)}</div>`
          : '';
      const retryBtn =
        o.state === 'failed'
          ? `<button class="btn sm dang" data-retry="${escapeHtml(o._src)}" data-no="${escapeHtml(orderNo)}">重試</button>`
          : '';

      return `<div class="ocard">
        <div class="ohead">
          <div class="onumwrap">
            <span class="osrc ${o._src === 'mfood' ? 'm' : 'a'}">${escapeHtml(o._srcLabel)}</span>
            <span class="ono" title="${escapeHtml(orderNo)}">${escapeHtml(orderNo || '—')}</span>
          </div>
          ${orderStateBadge(o.state)}
        </div>
        <div class="ometa">${escapeHtml(meta)}</div>
        ${itemRows ? `<div class="itbl">${itemRows}</div>` : ''}
        ${turnoverRow || settleRow ? `<div class="osum">${turnoverRow}${settleRow}</div>` : ''}
        ${errRow || retryBtn ? `<div class="ofoot"><span class="ostate ${o.state === 'failed' ? 'err' : 'ok'}">${o.state === 'failed' ? '未寫入 POS' : 'POS 已入單'}</span>${retryBtn}</div>` : ''}
      </div>`;
    })
    .join('');
}

// 🔴🔴 2026-09-30 使用者真機回報（截圖）：「我一打開就這樣，沒方法登出，我也設不了account」
//    根因：`wizardOpen()` 係唯一定義，但 `wireCards()` / `wireDetail()` 都係叫 `openWizard()`，
//    而 `openWizard` **從來冇定義過** ⇒ 一撳「設定帳號」/「切換」即刻 ReferenceError，
//    精靈永遠入唔到 ⇒ 使用者永遠設唔到帳密、亦冇任何方法改門店。
//    ⚠️ 上次嘅接線核對只查「$() 攞嘅 id 有冇喺 HTML」（正向），
//       冇查「HTML 嘅 id 有冇被 $() 攞過」（反向）⇒ 兩粒「切換」掣完全漏網。
//    ⇒ 已加別名（唔改叫法，避免又漏一邊），並喺測試加反向檢查。
const openWizard = wizardOpen;

function wireDetail() {
  $('btnBackMain').addEventListener('click', () => showView('main'));
  // ⚠️ `btnDetailSwitch` 嘅接線喺 wireRunCtl()（同 btnSwitchStore 一齊）——
  //    唔好喺呢度再接一次，否則開兩次精靈。
  $('mpRefresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'manualGrab' });
    devHintClear();
  });
  $('dList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-retry]');
    if (!btn) return;
    const key = btn.getAttribute('data-retry');
    const src = GRAB_UI.find((s) => s.key === key);
    if (!src) return;
    btn.disabled = true;
    btn.textContent = '重試中…';
    /**
     * 🔴🔴 2026-09-30 修正：舊寫法送 `<PREFIX>_RESCAN` —— 只係叫後台按一次
     *     「查詢」，**唔會**重置重試配額、**唔會**放行去重名冊 `seen`
     *     ⇒ 配額用完（10 次）之後，撳呢個掣完全冇用（真機：卡片一直「推送失敗」）。
     *     ⇒ 改送 `_RETRY_PUSH`：重置配額 ＋ 放行 seen ＋ 即刻重新查詢。
     */
    send({ type: src.prefix + '_RETRY_PUSH' }).then((r) => {
      if (r && r.ok === false) {
        btn.disabled = false;
        btn.textContent = '重試';
        devHintClear();
        return;
      }
      refreshAll();
    });
  });
}

function devHintClear() {
  const t = $('mpTimer');
  if (t) t.textContent = '已要求刷新';
}

function renderMpay() {
  const box = $('mpList');
  if (!box) return;
  const t = $('mpTimer');
  chrome.storage.local.get(['lastGrabbedData', 'lastGrabTime', 'fetchStatus', 'error', 'isTimerActive', 'nextRefreshTime', 'currentIntervalSecs'], (r) => {
    if (t) {
      if (r.error) {
        t.textContent = '上次抓取失敗';
        t.style.color = 'var(--red)';
      } else if (r.isTimerActive && r.nextRefreshTime) {
        const diff = Math.max(0, r.nextRefreshTime - Date.now());
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        t.textContent = `下次 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        t.style.color = '';
      } else {
        t.textContent = r.lastGrabTime ? `最後 ${r.lastGrabTime}` : '未啟動';
        t.style.color = '';
      }
    }
    if (!box) return;
    const list = r.lastGrabbedData && r.lastGrabbedData.list;
    if (!list || !list.length) {
      box.innerHTML = '<div class="empty">尚無資料 · 按「手動刷新」抓一次</div>';
      return;
    }
    box.innerHTML = list
      .slice(0, 50)
      .map((tx) => {
        const ok = tx.transStatus === '01';
        const st = ok ? '交易成功' : tx.transStatus === '04' ? '取消/失敗' : `其他(${tx.transStatus})`;
        return `<div class="mprow">
          <span class="osrc p">Mpay</span>
          <span style="min-width:0">
            <span class="mpno" title="${escapeHtml(tx.payordNo)}">${escapeHtml(tx.payordNo)}</span>
            <span class="mpmeta">${escapeHtml(tx.orderTime || '')} · ${escapeHtml(tx.storeName || tx.merchantNameCh || '')} · ${escapeHtml(st)}</span>
          </span>
          <span class="mpamt">${escapeHtml(tx.orderAmt || '')} ${escapeHtml(tx.orderCcy || '')}</span>
        </div>`;
      })
      .join('');
  });
}

// ---- 設定精靈 ---------------------------------------------------------------

const wiz = {
  store: { ok: false, name: null },
  mfood: { skip: false },
  aomi: { skip: false },
};

function wizardOpen() {
  // 讀既有設定 → 填入
  chrome.storage.local.get(['machineId', 'startDate', 'currentIntervalSecs', 'mfoodFinanceStoreName', 'aomiFinanceStoreName'], (r) => {
    $('wizStoreId').value = r.machineId || '';
    $('wizStartDate').value = r.startDate || '';
    $('wizInterval').value = Math.max(5, Number(r.currentIntervalSecs) || 30);
    $('wizMfoodFinance').value = r.mfoodFinanceStoreName || '';
    $('wizAomiFinance').value = r.aomiFinanceStoreName || '';
    // 每次開精靈都收返清單（避免殘留上次嘅選項／打勾）
    const wl = $('wizStoreOptList');
    if (wl) wl.hidden = true;
    if ($('wizStoreOptHint') && !r.mfoodFinanceStoreName) {
      $('wizStoreOptHint').textContent = '撳「載入商家」由後台列出可選店家，再撳一下選定';
      $('wizStoreOptHint').style.color = '';
    }

    const id = String(r.machineId || '').trim();
    if (id && storeLookup.ok && storeLookup.id === id) {
      wiz.store = { ok: true, name: storeLookup.name };
      renderWizStore();
    } else if (id) {
      lookupStore(id).then((res) => {
        if (res && res.ok && String($('wizStoreId').value).trim() === id) {
          wiz.store = { ok: true, name: res.name };
        }
        renderWizStore();
      });
    } else {
      wiz.store = { ok: false, name: null };
    }
    renderWizStore();
  });

  // 憑證現況（只回 username，唔回密碼）
  GRAB_UI.forEach((s) => {
    if (s.legacy) return; // 🔴🔴 2026-10-02：MacauPay 無帳密，跳過免污染澳覓欄位
    send({ type: 'GRAB_GET_CREDENTIALS', sourceKey: s.key }).then((r) => {
      if (!r || !r.ok) return;
      const has = !!r.configured;
      wiz[s.key].skip = false;
      $(`wbody${s.key === 'mfood' ? 'Mfood' : 'Aomi'}`).style.display = '';
      $(`wiz${s.key === 'mfood' ? 'Mfood' : 'Aomi'}User`).value = r.username || '';
      const chip = $(`wcard${s.key === 'mfood' ? 'Mfood' : 'Aomi'}`).querySelector('.skipchip');
      if (chip) {
        chip.textContent = has ? '已設定帳密' : '未設定';
        chip.className = 'skipchip' + (has ? ' used' : '');
      }
      if (s.key === 'mfood' && dash.mfood) $('wizMfoodAutoSettle').checked = !!dash.mfood.settings.autoSettle;
      if (s.key === 'aomi' && dash.aomi) $('wizAomiAutoSettle').checked = !!dash.aomi.settings.autoSettle;
      renderWizSteps();
    });
  });

  showView('wizard');
  renderWizStore();
  renderWizSteps();
}

function renderWizStore() {
  const res = $('wizStoreRes');
  const chip = $('wizStoreChip');
  if (wiz.store.ok) {
    res.className = 'vres ok';
    res.innerHTML = `<span class="cdot"></span><span class="vn">${escapeHtml(wiz.store.name)}</span><span class="vbadge">已驗證</span>`;
    chip.textContent = '✓ 已驗證';
    chip.className = 'skipchip used';
    chip.style.cssText = 'border-color:var(--green-l);color:var(--green);background:var(--green-s)';
  } else {
    res.className = 'vres idle';
    res.innerHTML = `<span class="cdot"></span><span class="vn">輸入後按「驗證門店」確認店名</span><span></span>`;
    chip.textContent = '未驗證';
    chip.className = 'skipchip';
    chip.style.cssText = '';
  }
  renderWizSteps();
}

function renderWizSteps() {
  const storeDone = wiz.store.ok;
  const mfoodDone = wiz.mfood.skip || !!(dash.mfood && dash.mfood.hasCreds);
  const aomiDone = wiz.aomi.skip || !!(dash.aomi && dash.aomi.hasCreds);
  const interval = parseInt($('wizInterval').value, 10);
  const rateDone = isFinite(interval) && interval >= 5;

  const flags = { store: storeDone, mfood: mfoodDone, aomi: aomiDone, rate: rateDone };
  let currentSet = false;
  document.querySelectorAll('#wsteps .wstep-i').forEach((el) => {
    const key = el.getAttribute('data-step');
    const done = flags[key];
    el.classList.toggle('done', !!done);
    const isCurrent = !done && !currentSet;
    if (isCurrent) currentSet = true;
    el.classList.toggle('on', isCurrent);
    const num = el.querySelector('.wnum');
    num.className = 'wnum' + (done ? '' : isCurrent ? '' : '');
    num.textContent = done ? '✓' : num.textContent.replace('✓', '') || num.textContent;
  });
  // 重寫編號（✓ 之後還原數字）
  const nums = { store: '1', mfood: '2', aomi: '3', rate: '4' };
  document.querySelectorAll('#wsteps .wstep-i').forEach((el) => {
    const key = el.getAttribute('data-step');
    const num = el.querySelector('.wnum');
    num.textContent = flags[key] ? '✓' : nums[key];
    if (wiz[key] && wiz[key].skip) num.classList.add('skip');
    else num.classList.remove('skip');
  });
}

function wireWizard() {
  // 🔴🔴 2026-09-30：精靈版「載入商家」（同主面板共用 fetchStoreOptions）。
  //    ⚠️ 一定要用**字面 id**（唔可以 forEach 包住），否則 popup-render
  //       嘅反向接線掃描驗唔到（2026-09-30 v1.76 就係咁漏咗整個精靈入口）。
  $('wizLoadStoreOptions').addEventListener('click', loadWizStoreOptions);

  $('wizVerifyBtn').addEventListener('click', () => {
    const id = String($('wizStoreId').value || '').trim();
    if (!id) {
      wiz.store = { ok: false, name: null };
      const res = $('wizStoreRes');
      res.className = 'vres idle';
      res.innerHTML = '<span class="cdot"></span><span class="vn">請先輸入 Store ID</span><span></span>';
      renderWizStore();
      return;
    }
    const btn = $('wizVerifyBtn');
    btn.disabled = true;
    btn.textContent = '驗證中…';
    const res = $('wizStoreRes');
    res.className = 'vres idle';
    res.innerHTML = '<span class="cdot"></span><span class="vn">向 macau-pos 查詢中…</span><span></span>';
    lookupStore(id, 'wizStoreId').then((r) => {
      btn.disabled = false;
      btn.textContent = '驗證門店';
      // 🔴 回應返嚟時輸入框可能已改 —— 核對
      if (String($('wizStoreId').value || '').trim() !== id) return;
      if (r && r.ok) {
        wiz.store = { ok: true, name: r.name };
      } else {
        wiz.store = { ok: false, name: null };
        res.className = 'vres err';
        res.innerHTML = `<span class="cdot" style="background:var(--red)"></span><span class="vn">找不到此門店，請確認 Store ID${r && r.reason ? '（' + escapeHtml(r.reason) + '）' : ''}</span><span></span>`;
        renderWizSteps();
        return;
      }
      renderWizStore();
    });
  });
  // Store ID 手動改過 → 驗證狀態作廢
  $('wizStoreId').addEventListener('input', () => {
    if (wiz.store.ok) {
      wiz.store = { ok: false, name: null };
      renderWizStore();
    }
  });

  GRAB_UI.forEach((s) => {
    // 🔴🔴 2026-10-02：MacauPay 係 legacy 平台（無獨立登入／無精靈步驟），
    //    跳過免得 `cap` 跌入 'Aomi' 分支重複綁定澳覓掣。
    if (s.legacy) return;
    const cap = s.key === 'mfood' ? 'Mfood' : 'Aomi';
    const skipBtn = $(`wiz${cap}Skip`);
    skipBtn.addEventListener('click', () => {
      if (wiz[s.key].skip) {
        // 已跳過 → 補設
        wiz[s.key].skip = false;
        $(`wbody${cap}`).style.display = '';
        skipBtn.textContent = '跳過此平台';
        $(`wcard${cap}`).querySelector('.skipchip').textContent = '未設定';
        $(`wcard${cap}`).querySelector('.skipchip').className = 'skipchip';
      } else {
        if (!confirm(`跳過${s.label}？\n\n主面板會收起${s.label}的相關功能；之後可隨時回來補設。`)) return;
        wiz[s.key].skip = true;
        // 🔴 跳過＝清憑證（主面板以 hasCreds 判斷啟用）
        send({ type: 'GRAB_SET_CREDENTIALS', sourceKey: s.key, username: '', password: '' }).then(() => refreshAll());
        $(`wbody${cap}`).style.display = 'none';
        skipBtn.textContent = '設定帳號';
        const chip = $(`wcard${cap}`).querySelector('.skipchip');
        chip.textContent = '已跳過';
        chip.className = 'skipchip used';
      }
      renderWizSteps();
    });

    $(`wiz${cap}Test`).addEventListener('click', () => {
      const user = String($(`wiz${cap}User`).value || '').trim();
      const pass = String($(`wiz${cap}Pass`).value || '');
      const resEl = $(`wiz${cap}Res`);
      if (!user && !(dash[s.key] && dash[s.key].hasCreds)) {
        resEl.className = 'pres err';
        resEl.innerHTML = '<span class="cdot" style="background:var(--red)"></span>請先填帳號';
        return;
      }
      const btn = $(`wiz${cap}Test`);
      btn.disabled = true;
      btn.textContent = '登入中…';
      resEl.className = 'pres idle';
      resEl.innerHTML = '<span class="cdot"></span>開登入頁 → 自動填表提交…';
      send({ type: 'GRAB_SET_CREDENTIALS', sourceKey: s.key, username: user, password: pass })
        .then(() => send({ type: 'GRAB_LOGIN_TEST_ONE', sourceKey: s.key }))
        .then((r) => {
          btn.disabled = false;
          btn.textContent = '測試登入';
          if (r && r.ok) {
            resEl.className = 'pres ok';
            resEl.innerHTML = `<span class="cdot"></span>${r.stage === 'already' ? '原本已登入 · session 正常' : '測試登入成功 · session 已保存'}`;
          } else {
            resEl.className = 'pres err';
            resEl.innerHTML = `<span class="cdot" style="background:var(--red)"></span>登入失敗：${escapeHtml((r && r.reason) || '未知原因')}`;
          }
          refreshAll();
        });
    });
  });

  $('wizInterval').addEventListener('input', renderWizSteps);

  $('btnWizardCancel').addEventListener('click', () => {
    showView(globalCache.storeId ? 'main' : 'wizard');
    if (!globalCache.storeId) showView('wizard');
  });
  $('wizBack').addEventListener('click', () => {
    showView(globalCache.storeId ? 'main' : 'wizard');
  });

  $('wizFinish').addEventListener('click', () => {
    const storeId = String($('wizStoreId').value || '').trim();
    if (!storeId) {
      alert('請先填 Store ID');
      $('wizStoreId').focus();
      return;
    }
    const interval = Math.max(5, parseInt($('wizInterval').value, 10) || 30);
    const startDate = $('wizStartDate').value || '';

    // 憑證：有填先 save（冇填過 test 嘅都會照 save；密碼留空＝不變）
    const saves = GRAB_UI.map((s) => {
      if (s.legacy) return Promise.resolve(); // 🔴🔴 2026-10-02：MacauPay 唔經精靈設帳密
      const cap = s.key === 'mfood' ? 'Mfood' : 'Aomi';
      if (wiz[s.key].skip) return Promise.resolve();
      const user = String($(`wiz${cap}User`).value || '').trim();
      const pass = String($(`wiz${cap}Pass`).value || '');
      if (!user && !(dash[s.key] && dash[s.key].hasCreds)) return Promise.resolve();
      return send({ type: 'GRAB_SET_CREDENTIALS', sourceKey: s.key, username: user, password: pass });
    });

    Promise.all(saves)
      .then(() =>
        new Promise((resolve) => {
          chrome.storage.local.set(
            {
              machineId: storeId,
              startDate: startDate,
              currentIntervalSecs: interval,
              wizardDone: true,
              mfoodFinanceStoreName: String($('wizMfoodFinance').value || '').trim(),
              aomiFinanceStoreName: String($('wizAomiFinance').value || '').trim(),
            },
            () => resolve(),
          );
        }),
      )
      .then(() => send({ type: 'GRAB_APPLY_INTERVAL', secs: interval }))
      .then(() => send({ type: 'GRAB_SET_AUTOMATION', enabled: true }))
      .then(() => {
        globalCache.storeId = storeId;
        globalCache.intervalSecs = interval;
        chrome.runtime.sendMessage({ action: 'updateTimer', intervalSecs: interval });
        showView('main');
        refreshAll();
      });
  });
}

// ---- 全域快取 + 主迴圈 -------------------------------------------------------

const globalCache = { storeId: '', startDate: '', intervalSecs: 30 };

function refreshAll() {
  chrome.storage.local.get(['machineId', 'startDate', 'currentIntervalSecs'], (r) => {
    globalCache.storeId = r.machineId || '';
    globalCache.startDate = r.startDate || '';
    globalCache.intervalSecs = Number(r.currentIntervalSecs) || 30;

    // 門店名查詢（有守衛：查過成功唔重查）
    const id = String(globalCache.storeId || '').trim();
    if (id) {
      lookupStore(id).then(() => renderStoreBars());
    } else {
      renderStoreBars();
    }
  });

  Promise.all(
    GRAB_UI.map((s) => send({ type: s.prefix + '_GET_DASHBOARD' }).then((d) => [s.key, d])),
  ).then((pairs) => {
    pairs.forEach(([k, d]) => {
      dash[k] = d || null;
    });
    renderStoreBars();
    renderCards();
    renderStats();
    renderLogs();
    renderRunCtl();
    if (!$('view-detail').hidden) renderDetail();
  });

  renderMpay();
}

// ---- 啟動 -------------------------------------------------------------------

(function initVersion() {
  const el = $('ver');
  if (!el) return;
  try {
    const v = chrome.runtime.getManifest().version;
    if (v) el.textContent = 'v' + v;
  } catch (e) {
    /* ignore */
  }
})();

wireRunCtl();
wireMenu();
wireFinanceSub();
wireDevSub();
wireCards();
wireDetail();
wireWizard();

// 日誌頁籤
$('logTabs').addEventListener('click', (e) => {
  const lt = e.target.closest('.lt');
  if (!lt) return;
  document.querySelectorAll('#logTabs .lt').forEach((el) => el.classList.toggle('on', el === lt));
  logFilter = lt.getAttribute('data-log') || 'all';
  renderLogs();
});

// 首次開啟：未設定過 → 直接入精靈
chrome.storage.local.get(['machineId', 'wizardDone'], (r) => {
  if (!r.machineId && !r.wizardDone) {
    wizardOpen();
  } else {
    showView('main');
  }
});

refreshAll();
setInterval(refreshAll, 2000);
