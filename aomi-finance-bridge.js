/**
 * aomi-finance-bridge.js — isolated world content script（澳覓 財務／對帳）
 *
 * 掛載頁面：`https://merchant.aomiapp.com/*`（財務對帳 SPA 路由）
 *
 * ── 為什麼要獨立一支（唔可以塞入 aomi-bridge.js）────────────────────
 * `aomi-bridge.js` 掛喺澳覓**訂單管理**頁（同一個 origin，換 hash 唔會重新載入
 * ⇒ 一個 content script 會同時存在於兩頁）。
 * 但財務對帳頁要跑**完全另一套流程**：
 *   ① 揀帳期 → ② 撳「查看」→ ③ 抄明細（逐頁）→ ④ 返回列表 → 下一個帳期
 * 塞入 `aomi-bridge.js` 會令 `GRAB_RESCAN`（訂單查詢）撞到財務頁嘅「查詢」掣
 * ⇒ 兩套流程互相干擾。獨立一支，用唔同嘅 message 前綴（`AOMIFIN_`）就完全隔離。
 *
 * ── 🔴 單位 ─────────────────────────────────────────────────────────
 * 澳覓金額係**分（cents）**（`costAmount: 11542` 就係 MOP 115.42），
 * 一定要 **÷100**。同 `aomi-bridge.js` 一致（唔好似 mfood 咁當「元」）。
 *
 * ── 🔴 唔可以 F5（同 mfood 財務一致）──────────────────────────────
 * 全程只用 DOM 操作（揀帳期、按掣、翻頁）＋ 被動攔截。
 * 冇任何 `location.reload()`。
 *
 * ── 三條 API（2026-09-29 使用者實測）────────────────────────────────
 *   ① 已打款帳期列表：`.../settleService/hadSettlement`（list，已出帳）
 *   ② 未出帳帳期列表：`.../settleService/unSettlement`（list，未出帳）
 *   ③ 明細：`.../settleService/order/list`（`?accountId=…`，逐筆訂單）
 *
 *   🔴 三支回應**形狀完全一樣**（`detailMsg.list` 陣列），
 *      所以 MAIN world **只可以靠 URL 分類**（見 aomi-inject.js `classify()`）。
 *
 * ── 🔴🔴 使用者定案（2026-09-29，逐字）─────────────────────────────
 *   Q1 應收： 「就係我們已經 sync 過去的訂單, 使用的營業額即可」
 *   Q2/Q3 實收：「沒有, 這就是已經結算過後的金額, 就是商家能到手的金額了」
 *               「你就直接拿 costAmount 的吧」
 *   Q4 每頁筆數：「要, 不然後拿不了全部」⇒ 自己要代撳到最大
 *   Q5 had/unsettle：
 *      「其實, hadSettlement 和 unsettlement, 對於我們來說不太有意義,
 *        因為就算 settle 了, 還是沒 settle, 只要是在商家 set 的日期內,
 *        你都要去拿到… 能拿到, 還是要點進去查看才能拿到全部.
 *        跟 unsettle 的一樣.」
 *      ⇒ **兩條 API 都要行**，唔可以只行其中一條；
 *        而且「已結算」嘅帳期一樣要撳「查看」入去抄明細（列表層冇金額）。
 *   Q6 storeId：「跟 machineId」
 *   Q7 開始日期：「跟 startDate 一樣」
 *
 *   🔴 應結算金額 `estSettleAmt` **係假數**（平台 tooltip 自認：
 *      「應結算金額＝營業額−平台服務費−商家減配送費−活動扣款」，
 *      但實際上冇扣活動扣款）⇒ **一律唔用**，只認 `costAmount`。
 */

(function () {
  "use strict";

  // 🔴🔴 呢兩道 guard 缺一不可（同 mfood-finance-bridge.js 一字不差嘅教訓）。
  //
  //    成因：guard 用 `window.__XXX_INSTALLED__` 做記號，
  //    而 `window` 喺 content script（isolated）同頁面（MAIN）之間係同一個物件
  //    ⇒ 一旦呢支 bridge 被意外注入 MAIN world：
  //        MAIN 先跑 → 記號設 true → `onFinancePage` 等**從未定義**
  //        真正 isolated 跑 → 見到記號即 return → 但舊 listener 仍在
  //        ⇒ 收到訊息就叫 `onFinancePage()` ⇒ Uncaught ReferenceError
  //
  //    ⇒ 修法：guard 改成「**只有真係喺 extension context** 才設記號」。
  var IN_EXTENSION_CONTEXT = !!(
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.id
  );
  if (!IN_EXTENSION_CONTEXT) return;

  if (window.__AOMI_FINANCE_BRIDGE_INSTALLED__) return;
  window.__AOMI_FINANCE_BRIDGE_INSTALLED__ = true;

  var TAG = "[aomi/finance]";

  /** 財務對帳頁 route（SPA hash / path 特徵）。 */
  var FINANCE_HASH = "settle";

  /**
   * 🔴 每頁筆數要撳到幾多。
   *
   * 使用者 Q4：「要, 不然後拿不了全部」⇒ 我哋**代撳**到平台最大值。
   * 澳覓明細頁分頁器預設一般係 10 或 20；目標 50，上限 200 唔搏。
   */
  var PAGE_SIZE_TARGET = 50;
  var PAGE_SIZE_CAP = 200;
  var PAGE_SIZE_TEXT_RE = /(\d+)\s*(?:項|條|条|筆|笔)\s*\/?\s*(?:頁|页)/;

  /** 翻頁上限：防平台回錯 total 導致無限迴圈。 */
  var MAX_PAGES = 40;

  /** 一次同步最多行幾多個帳期（防頁面有幾十個帳期 ⇒ 跑幾個鐘）。 */
  var MAX_PERIODS = 24;

  // ══════════════════════════════════════════════════════════════════
  //  金額口徑
  // ══════════════════════════════════════════════════════════════════

  /**
   * 分 → 元（MOP），最多兩位小數。
   *
   * 🔴 刻意**唔 import** `aomi-bridge.js` 嘅同名函式：
   *    content script 之間冇 module 系統，各自一份係唯一可行做法。
   *    兩份都必須保持「null / "" → null；數字（含 0）→ 換算」嘅語意。
   */
  function centsToMop(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n) / 100;
  }

  /** 元（已經係元）→ 保留兩位。 */
  function mopRound(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  /**
   * 🔴🔴 由一個帳期／明細列抽出「實收金額（MOP 元）」。
   *
   * 使用者在 2026-09-29 明確指出：
   *   「應結算金額. 預計沒有減去一些東西, 所以是假的.」
   *   「你就直接拿 costAmount 的吧」
   *
   * ⇒ **只認 `costAmount`（分）**。
   *   · 刻意**唔**做 `estSettleAmt` fallback —— 寧願回 null（＝「未對帳」），
   *     都唔可以回一個偏多嘅假數（「有值但錯」係最難察覺嘅失敗模式）。
   *   · 亦唔用公式拼（平台口徑只有佢自己知）。
   *
   * @param {object} row
   * @returns {{mop:number|null, cents:number|null, key:string|null}}
   */
  function settleAmountOf(row) {
    if (!row || typeof row !== "object") return { mop: null, cents: null, key: null };
    var keys = ["costAmount", "costAmt", "costAmountFen"];
    for (var i = 0; i < keys.length; i++) {
      var v = row[keys[i]];
      if (v == null || v === "") continue;
      var n = Number(v);
      if (!isFinite(n)) continue;
      return { mop: centsToMop(n), cents: n, key: keys[i] };
    }
    return { mop: null, cents: null, key: null };
  }

  /** 營業額（應收）候選欄位 —— 使用者 Q1：「使用的營業額即可」。 */
  var GROSS_KEYS = [
    "totalAmout",
    "totalAmount",
    "businessAmount",
    "businessAmt",
    "orderAmount",
    "saleAmount",
  ];

  /** 由 row 抽「營業額（分）」→ MOP。 */
  function grossAmountOf(row) {
    if (!row || typeof row !== "object") return null;
    for (var i = 0; i < GROSS_KEYS.length; i++) {
      var v = row[GROSS_KEYS[i]];
      if (v == null || v === "") continue;
      var n = Number(v);
      if (isFinite(n)) return centsToMop(n);
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  通用工具（同 mfood-finance-bridge.js 同源）
  // ══════════════════════════════════════════════════════════════════

  function trimmed(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/^\s+|\s+$/g, "");
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /**
   * 呢個分頁係唔係財務對帳頁。
   *
   * 🔴 2026-09-29 真機修正：舊寫法淨係認 `settle` / `finance`，
   *    但澳覓前端 SPA 路由**完全冇 `settle` 字**（`settle` 只喺 API 路徑），
   *    實際路由係 `#/qrAccountmanage/takeoutAccountManage/takeoutAccount`
   *    （列表）同 `…/takeoutDetail?accountId=…`（明細）。
   *    ⇒ 舊寫法永遠 false，撳「立即對帳」永遠報「未開啟對帳頁」。
   *
   * 用**共同前綴** `takeoutAccountManage` 做特徵 ⇒ 列表同明細都算，
   * 走訪期間換 route 亦唔會誤判成「唔喺對帳頁」。
   */
  function onFinancePage() {
    var s = String(location.href || "");
    var h = String(location.hash || "");
    // ① 主判準：澳覓對帳模組（列表 + 明細共用前綴）
    if (/takeoutAccountManage/i.test(h) || /takeoutAccountManage/i.test(s)) return true;
    // ② 舊特徵保留（向後兼容：平台未來改路由返 `settle` 亦認得）
    if (/settle/i.test(h)) return true;
    return /\/settle|settleService|finance/i.test(s);
  }

  /** 係唔係可見（用嚟排除隱藏 tab／未展開嘅下拉）。 */
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * 找「文字剛好等於 / 包含目標」嘅可撳元素。
   *
   * 🔴 `maxLen` 好重要：冇咗它，「查看」會命中成頁最外層容器
   *    （`textContent` 含「查看」兩個字嘅大 div）⇒ 撳落去等於撳空白。
   */
  function findByText(pattern, opts) {
    opts = opts || {};
    var maxLen = opts.maxLen || 8;
    var root = opts.root || document;
    var nodes = root.querySelectorAll(
      opts.sel || 'button, a, [role="button"], span, div',
    );
    var best = null;
    var bestLen = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var txt = trimmed(el.textContent).replace(/\s+/g, "");
      if (!txt || txt.length > maxLen) continue;
      if (!pattern.test(txt)) continue;
      if (!visible(el)) continue;
      if (txt.length < bestLen) {
        best = el;
        bestLen = txt.length;
      }
    }
    return best;
  }

  // ══════════════════════════════════════════════════════════════════
  //  MAIN world 通訊通道（aomi-inject.js → 呢度）
  //
  //  澳覓財務 API 用 Alibaba 閘道簽章（X-Ca-Signature 涵蓋 method / path /
  //  query / nonce）⇒ **無法重放**。所以只可以「搭便車」：
  //  MAIN world 包裝頁面自己嘅 fetch/XHR，被動 clone 回應，經
  //  `window.postMessage`（命名空間 `__aomiFinance`）傳過嚟。
  // ══════════════════════════════════════════════════════════════════

  /** 最近收到嘅財務事件（by kind）。 */
  var financeEvents = {
    finance_periods: null, // 帳期列表（hadSettlement / unSettlement 合併）
    finance_detail_captured: null, // 明細（order/list）
    finance_last_request: null, // 最近一次 detail 請求（URL 診斷用）
  };

  /** 等待者：kind → [resolve...] */
  var financeWaiters = {};

  /**
   * 🔴 「明細回應」嘅流水號。
   *
   * 每抄到一批就 +1。用途：撳完「每頁筆數／下一頁」之後，
   * 要等「**新**嘅明細回應」，而唔可以用「清走事件再等」——
   * （清走事件會錯過撳之前已到嘅回應 ⇒ 白等成個 timeout）。
   */
  var detailCaptureSeq = 0;

  /** 防止並發：一次只跑一個對帳流程（popup 立即對帳 / 定時自動 / 明細頁「查詢」都共用）。 */
  var financeSyncing = false;

  /**
   * 🔴🔴 「到手嘅原始資料」帳本 —— 只加不減，跨頁累積。
   *
   * 使用者 2026-09-28 第十一次真機原話：
   *   「唔好配對，先將所有訂單拿喺手。」
   * ⇒ 另外存一份**未經篩選**嘅原始資料，供離線分析。
   *
   * 🔴 `detailRows` 一定要**跨頁累積**（唔可以新覆蓋舊）——
   *    即刻對帳會逐頁撳「下一頁」，覆蓋 = 只剩最後一頁
   *    （最經典嘅「有數但少一大截」）。
   */
  var rawFinanceCapture = {
    updatedAt: null,
    periodRows: [],
    detailRows: [],
    detailTotal: null,
    detailAccountId: null,
    firstRowKeys: [],
    periodRowKeys: [],
    detailPages: [],
  };

  /**
   * 清走「到手嘅明細列」—— 只喺**一輪新同步開始**、或**換帳期**時 call。
   *
   * 🔴 唔清就會撈埋上一輪／另一個帳期嘅列 ⇒ POS 寫入錯帳期
   *    （金額「有值但錯」，最難察覺）。
   */
  function resetDetailCapture() {
    rawFinanceCapture.detailRows = [];
    rawFinanceCapture.detailPages = [];
    rawFinanceCapture.detailTotal = null;
    rawFinanceCapture.detailAccountId = null;
    rawFinanceCapture.firstRowKeys = [];
  }

  /**
   * 明細列嘅去重 key。
   *
   * 🔴 翻頁時平台可能回重疊邊界（page1 尾 = page2 頭），
   *    冇 key 就會重複計數 ⇒ 營業額翻倍（比少數更難查）。
   *
   * @returns {string|null} null ＝ 認唔出，照樣照單全收（唔敢丟）。
   */
  function detailRowKey(row) {
    if (!row || typeof row !== "object") return null;
    var candidates = ["orderId", "tradeNo", "orderNo", "order_no", "id"];
    for (var i = 0; i < candidates.length; i++) {
      var v = row[candidates[i]];
      if (v != null && String(v) !== "") return "k:" + String(v);
    }
    try {
      return "h:" + JSON.stringify(row);
    } catch (e) {
      return null;
    }
  }

  /**
   * 把一批明細列**累積**入帳本（跨頁去重）。
   *
   * 🔴 換咗帳期（`accountId` 唔同）⇒ 清空重嚟，唔可以撈埋兩個帳期。
   */
  function mergeDetailRows(rows, payload) {
    detailCaptureSeq++;
    var aid = payload && payload.accountId ? String(payload.accountId) : null;
    if (
      aid &&
      rawFinanceCapture.detailAccountId &&
      rawFinanceCapture.detailAccountId !== aid
    ) {
      // 換帳期：上一批作廢
      rawFinanceCapture.detailRows = [];
      rawFinanceCapture.detailPages = [];
      rawFinanceCapture.detailTotal = null;
    }
    if (aid) rawFinanceCapture.detailAccountId = aid;

    var t = payload && payload.total != null ? payload.total : null;
    if (t != null) rawFinanceCapture.detailTotal = t;

    var seen = {};
    var existing = rawFinanceCapture.detailRows;
    for (var i = 0; i < existing.length; i++) {
      var k0 = detailRowKey(existing[i]);
      if (k0) seen[k0] = true;
    }
    for (var j = 0; j < rows.length; j++) {
      var k = detailRowKey(rows[j]);
      if (k && seen[k]) continue; // 🔴 去重，防翻頁重疊重複計數
      if (k) seen[k] = true;
      existing.push(rows[j]);
    }
    rawFinanceCapture.detailRows = existing;

    if (!rawFinanceCapture.firstRowKeys.length && existing.length) {
      var r0 = existing[0];
      if (r0 && typeof r0 === "object") {
        rawFinanceCapture.firstRowKeys =
          payload && Array.isArray(payload.firstRowKeys) && payload.firstRowKeys.length
            ? payload.firstRowKeys
            : Object.keys(r0);
      }
    }
    rawFinanceCapture.detailPages.push({
      at: Date.now(),
      got: rows.length,
      accumulated: existing.length,
      total: t == null ? null : t,
      accountId: aid,
    });
    if (rawFinanceCapture.detailPages.length > 60) {
      rawFinanceCapture.detailPages = rawFinanceCapture.detailPages.slice(-60);
    }
  }

  /**
   * 等「序號大過 `seq`」嘅**新**明細回應。
   *
   * @param {number} seq 撳掣**之前**嘅 `detailCaptureSeq`
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true ＝ 有新回應；false ＝ 等唔到
   */
  function waitDetailCaptureAfter(seq, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 6000);
    function step() {
      if (detailCaptureSeq > seq) return Promise.resolve(true);
      if (Date.now() >= deadline) return Promise.resolve(false);
      return sleep(120).then(step);
    }
    return step();
  }

  function emitFinance(kind, payload) {
    financeEvents[kind] = payload;

    // 🔴 順手把原始列存落「到手數據」帳本。只做**累積**，唔做篩選／配對。
    try {
      if (kind === "finance_periods" && payload && Array.isArray(payload.periods)) {
        rawFinanceCapture.periodRows = payload.periods.map(function (p) {
          return p && p.raw ? p.raw : p;
        });
        var pr0 = rawFinanceCapture.periodRows[0];
        rawFinanceCapture.periodRowKeys =
          pr0 && typeof pr0 === "object" ? Object.keys(pr0) : [];
        rawFinanceCapture.updatedAt = Date.now();
      }
      if (kind === "finance_detail_captured" && payload) {
        var rows = Array.isArray(payload.rawResult)
          ? payload.rawResult
          : Array.isArray(payload.result)
            ? payload.result
            : [];
        mergeDetailRows(rows, payload);
        rawFinanceCapture.updatedAt = Date.now();
      }
      if (kind === "finance_last_request" && payload) {
        // 冇做特別記錄，只係等 waiter 派發
      }
    } catch (e) {
      /* 帳本損壞唔可以拖冧主流程 */
    }

    var list = financeWaiters[kind];
    if (list && list.length) {
      financeWaiters[kind] = [];
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (e) {
          /* 單一 waiter 出錯唔可以拖冧其他 */
        }
      }
    }
  }

  /** 等一個財務事件（先睇有冇現成，冇才掛 waiter）。 */
  function waitFinance(kind, timeoutMs) {
    if (financeEvents[kind]) return Promise.resolve(financeEvents[kind]);
    return new Promise(function (resolve) {
      var t = setTimeout(function () {
        var arr = financeWaiters[kind] || [];
        var idx = arr.indexOf(wrap);
        if (idx >= 0) arr.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      function wrap(v) {
        clearTimeout(t);
        resolve(v);
      }
      if (!financeWaiters[kind]) financeWaiters[kind] = [];
      financeWaiters[kind].push(wrap);
    });
  }

  /** 清走**會過期**嘅事件（`finance_periods` 係對照表，刻意保留）。 */
  function clearFinanceEvents() {
    financeEvents.finance_last_request = null;
    financeEvents.finance_detail_captured = null;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__aomiFinance !== true) return;
    if (d.kind) emitFinance(d.kind, d.payload || null);
  });

  // 🔴 明細頁「查詢」掣 → 自動重抓並推 POS（唔使跳返列表 / 唔使撳 popup 立即對帳）
  //    （使用者 2026-09-29：喺對帳記錄頁點「查詢」就自動重新獲取並刷新一次最新對帳數據。）
  //
  //    🔴 只認**真人 click**（`ev.isTrusted`）—— `syncDetailPage` 內部撳「查詢」觸發
  //       重抓係 programmatic `.click()`（isTrusted=false），絕唔會觸發呢度，避免自 loop。
  //    🔴 只喺明細頁生效（`onDetailRoute()`）；列表頁點「查詢」唔關呢度事。
  var _aomiDetailQueryLast = 0;
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener(
      "click",
      function (ev) {
        if (!onDetailRoute()) return;
        var t = ev && ev.target;
        if (!t || !t.textContent) return;
        var txt = trimmed(String(t.textContent || "")).replace(/\s+/g, "");
        if (!/^查詢$|^查询$/.test(txt)) return;
        if (ev.isTrusted === false) return; // programmatic click（自己撳嘅）唔反應
        var now = Date.now();
        if (now - _aomiDetailQueryLast < 1500) return; // 防抖
        _aomiDetailQueryLast = now;
        try {
          chrome.runtime.sendMessage(
            { type: "GRAB_SETTLE_AOMI_NOW", manual: true, sourceKey: "aomi" },
            function () {
              if (chrome.runtime && chrome.runtime.lastError) {
                /* 後台無回應就忽略 */
              }
            },
          );
        } catch (e) {
          /* 忽略 */
        }
      },
      true,
    );
  }

  /** 叫 MAIN world 回報最近一次財務請求（診斷用）。 */
  function askLastFinanceRequest(timeoutMs) {
    var p = waitFinance("finance_last_request", timeoutMs || 1500);
    try {
      window.postMessage({ __aomiCmd: true, cmd: "finance_last_request" }, window.location.origin);
    } catch (e) {
      /* 忽略 */
    }
    return p;
  }

  // ══════════════════════════════════════════════════════════════════
  //  帳期列（列表層）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 由帳期列抽「帳期文字」。
   *
   * 澳覓格式實測係 `YYYY-MM-DD ~ YYYY-MM-DD`（或 `至`／`-`）。
   */
  function rowPeriodText(row) {
    var txt = String((row && row.textContent) || "");
    var m = txt.match(
      /(\d{4}-\d{2}-\d{2})\s*[~～\-至]\s*(\d{4}-\d{2}-\d{2})/,
    );
    if (m) return m[1] + " ~ " + m[2];
    // 亦可能係 `YYYY/MM/DD`
    var m2 = txt.match(/(\d{4}\/\d{1,2}\/\d{1,2})\s*[~～\-至]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (m2) return normDay(m2[1]) + " ~ " + normDay(m2[2]);
    return "";
  }

  /** `2026/9/1` → `2026-09-01`。 */
  function normDay(s) {
    var m = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(String(s));
    if (!m) return String(s);
    return (
      m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0")
    );
  }

  // ── 「帳期文字」錨點（唔依賴 class 名）──────────────────────────────
  //
  // 🔴 2026-09-29 真機實錄：澳覓對帳頁**唔係** Element-UI 表格 ——
  //    `.el-table__row` / `tbody tr` 全部唔中，但頁面上明明有帳期列表
  //    （使用者截圖：「未出帳單」／「已出帳單」兩組，每組係「時間｜帳單金額｜帳單信息」
  //      三欄，右欄 rowspan 跨多行，帳期寫 `2026-09-16至2026-09-29`）。
  //    硬靠 class 名，平台一改版就死。改用**人眼都見到嘅帳期文字**做錨點。

  /** 帳期區間文字（非 global ⇒ `test()` 冇 lastIndex 狀態問題）。 */
  var PERIOD_RANGE_RE =
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*[~～\-至]\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/;
  /** 同上（global ⇒ 用嚟數「一個容器內有幾個帳期」）。 */
  var PERIOD_RANGE_RE_G = new RegExp(PERIOD_RANGE_RE.source, "g");

  /** 呢個容器內有幾個帳期區間（用嚟防「撳到隔籬期」）。 */
  function countPeriods(el) {
    var txt = String((el && el.textContent) || "");
    var m = txt.match(PERIOD_RANGE_RE_G);
    return m ? m.length : 0;
  }

  /**
   * 由「帳期文字」反查帳期列。
   *
   * 做法：
   *   ① 搵出所有**最細**（冇子元素都含帳期文字）嘅帳期文字元素 ＝ 錨點
   *   ② 由錨點向上，搵「最接近、只含一個帳期、又含有『查看』掣」嘅祖先 ＝ 帳期列
   *   ③ 冇「查看」掣（例如「已打款」行未必有）⇒ 用最近嘅 element 祖先頂住
   */
  function listPeriodRowsByText() {
    var all = document.querySelectorAll("*");
    var anchors = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!PERIOD_RANGE_RE.test(String(el.textContent || ""))) continue;
      // 只留最細嗰層：唔可以有子元素都含帳期文字
      var deeper = false;
      for (var j = 0; j < el.children.length; j++) {
        if (PERIOD_RANGE_RE.test(String(el.children[j].textContent || ""))) {
          deeper = true;
          break;
        }
      }
      if (deeper) continue;
      anchors.push(el);
    }

    var out = [];
    var seen = {};
    for (var k = 0; k < anchors.length; k++) {
      var a = anchors[k];
      var period = rowPeriodText(a);
      if (!period || seen[period]) continue;

      var row = null;
      var p = a;
      for (var up = 0; up < 8 && p && p !== document.body; up++) {
        var n = countPeriods(p);
        // 🔴 跨過多個帳期 ⇒ 已經係「整個表格」層，唔可以再上
        //    （否則喺呢層撳「查看」會撳到第一個帳期，配錯帳）
        if (n > 1) break;
        if (n === 1 && findByText(/^查看$|查看詳情|查看明细|查看明細|詳情|明细|明細/, {
          root: p,
          maxLen: 6,
        })) {
          row = p;
          break;
        }
        p = p.parentElement;
      }
      if (!row) {
        // 冇「查看」掣（例如「已打款」）⇒ 用最近嘅 element 祖先頂住
        row = a.parentElement || a;
      }
      if (!visible(row)) continue;

      seen[period] = true;
      var parts = period.split(" ~ ");
      out.push({
        row: row,
        period: period,
        start: parts[0] || null,
        end: parts[1] || null,
      });
    }
    return out;
  }

  /**
   * 列出頁面上**全部**帳期列（去重）。
   *
   * 順序 ＝ DOM 順序（平台一般係「新 → 舊」）。
   *
   * 🔴 兩條路合併（2026-09-29 真機教訓）：
   *    ① class 選擇器 —— 平台係標準表格時最快最準
   *    ② 帳期文字反查 —— 平台**唔係**表格時唯一出路（真機就係咁）
   *    只行 ① 會「頁面明明有列表但回空」；只行 ② 就失去去重／固定欄處理嘅精度。
   *
   * 🔴 一定要**去重**：Element-UI 嘅固定欄（`el-table__fixed`）會複製一份
   *    表格 ⇒ 唔去重就抓兩次（重複推送、名冊被食）。
   * 🔴 一定要**防「一個容器含多個帳期」**：喺嗰層撳「查看」會撳到第一個期 ⇒ 配錯帳。
   */
  function listPeriodRows() {
    var out = [];
    var seen = {};

    function push(row, period) {
      if (!row || !period || seen[period]) return;
      // 防護：容器含多個帳期 ⇒ 唔可以當「一列」（會撳錯期）
      if (countPeriods(row) > 1) return;
      if (!visible(row)) return;
      seen[period] = true;
      var parts = period.split(" ~ ");
      out.push({
        row: row,
        period: period,
        start: parts[0] || null,
        end: parts[1] || null,
      });
    }

    // ① class 選擇器
    var rows = document.querySelectorAll(
      ".el-table__row, tbody tr, .el-table__body tr, [class*='table'] tr, .list-item, li",
    );
    for (var i = 0; i < rows.length; i++) {
      push(rows[i], rowPeriodText(rows[i]));
    }

    // ② 帳期文字反查（補漏）
    var byText = listPeriodRowsByText();
    for (var k = 0; k < byText.length; k++) {
      push(byText[k].row, byText[k].period);
    }

    return out;
  }

  /**
   * 撳某一列嘅「查看」掣。
   *
   * 🔴 使用者提供嘅真實 DOM（2026-09-29）：
   *    `<button type="button" class="el-button el-button--default el-button--medium">
   *       <span>查看</span></button>`
   *    ⇒ 認「查看」二字（maxLen 4 防命中大容器）。
   *    亦相容「查看詳情 / 詳情 / 明細」。
   */
  function clickDetailInRow(row) {
    var el = findByText(/^查看$|查看詳情|查看明细|查看明細|詳情|明细|明細/, {
      root: row,
      maxLen: 6,
    });
    if (!el) return { ok: false, reason: "呢一列冇「查看」按鈕" };
    try {
      el.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "撳「查看」失敗：" + ((e && e.message) || e) };
    }
  }

  /**
   * 由明細頁可見文字搵「帳期區間」（如果平台有顯示 header）。
   *
   * 🔴 目的：令明細頁就地對帳嘅 `period` key 同列表流程一致
   *    （列表流程用 `YYYY-MM-DD ~ YYYY-MM-DD`），避免 POS 用唔同 key 重複建帳期。
   *    搵唔到就返空（交返 `detailRowsPeriodRange` / accountId 兜底）。
   */
  function detailPagePeriodText() {
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!PERIOD_RANGE_RE.test(String(el.textContent || ""))) continue;
      // 只留最細層（避免命中整個容器）
      var deeper = false;
      for (var j = 0; j < el.children.length; j++) {
        if (PERIOD_RANGE_RE.test(String(el.children[j].textContent || ""))) {
          deeper = true;
          break;
        }
      }
      if (deeper) continue;
      var m = PERIOD_RANGE_RE.exec(String(el.textContent || ""));
      if (m) {
        var s = m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
        var e = m[4] + "-" + String(m[5]).padStart(2, "0") + "-" + String(m[6]).padStart(2, "0");
        return s + " ~ " + e;
      }
    }
    return "";
  }

  /** 由明細列日期兜一個帳期區間（`detailPagePeriodText` 搵唔到時用）。 */
  function detailRowsPeriodRange() {
    var rows = rawFinanceCapture.detailRows;
    if (!rows || !rows.length) return "";
    var DATE_KEYS = [
      "settleTime", "tradeDate", "completeTime", "payTime",
      "orderTime", "createTime", "settlementTime", "settleDate", "settleDay",
    ];
    var min = null, max = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== "object") continue;
      for (var k = 0; k < DATE_KEYS.length; k++) {
        var v = r[DATE_KEYS[k]];
        if (v == null) continue;
        var d = normDay(String(v).slice(0, 10));
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          if (min == null || d < min) min = d;
          if (max == null || d > max) max = d;
        }
      }
    }
    if (min == null) return "";
    if (max == null || max === min) return min + " ~ " + min;
    return min + " ~ " + max;
  }

  /** 明細頁撳「查詢」掣（觸發平台重發明細；唔使填單號 ＝ 撈返全期）。 */
  function clickDetailQuery() {
    var el = findByText(/^查詢$|^查询$/, { maxLen: 4 });
    if (!el) return { ok: false, reason: "明細頁搵唔到「查詢」掣" };
    try {
      el.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "撳「查詢」失敗：" + ((e && e.message) || e) };
    }
  }

  /**
   * 揀出「今次要行」嘅帳期列。
   *
   * 🔴 使用者 Q5 明確：
   *    「只要是在商家 set 的日期內, 你都要去拿到」
   *    ⇒ 有 `startDate` 時，行「帳期結束日 >= startDate」嘅**全部**帳期
   *      （一路到最新），唔只行命中今日嗰一個。
   *    冇 `startDate` ⇒ 只行「命中 `targetDate`」嗰一個（避免定時對帳
   *    每輪掃全頁而永遠追唔上）。
   */
  function pickPeriodTargets(opts) {
    opts = opts || {};
    var all = listPeriodRows();
    if (!all.length) {
      return { ok: false, targets: [], reason: "帳期列表係空（可能平台未對帳）" };
    }

    var sd = opts.startDate || null;
    if (sd) {
      var picked = [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].end && all[i].end < sd) continue;
        picked.push(all[i]);
      }
      if (!picked.length) {
        return {
          ok: false,
          targets: [],
          reason:
            "帳期列表冇任何區間喺 " + sd + " 之後（開始日期可能太新，或帳期未生成）",
        };
      }
      var capped = false;
      if (picked.length > MAX_PERIODS) {
        picked = picked.slice(0, MAX_PERIODS);
        capped = true;
      }
      return { ok: true, walk: true, targets: picked, capped: capped, total: all.length };
    }

    var td = opts.targetDate || null;
    var hit = null;
    for (var j = 0; j < all.length; j++) {
      if (!td || (all[j].start && all[j].end && td >= all[j].start && td <= all[j].end)) {
        hit = all[j];
        break;
      }
    }
    if (!hit) hit = all[0];
    return { ok: true, walk: false, targets: [hit] };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ① 每頁筆數（代撳到最大）
  // ══════════════════════════════════════════════════════════════════

  /** 「20項/頁」→ 20；唔係呢個格式 → null。 */
  function parsePageSizeText(t) {
    var m = PAGE_SIZE_TEXT_RE.exec(String(t == null ? "" : t));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
  }

  /**
   * 搵出所有「每頁筆數」下拉（`el-pagination__sizes` 入面嗰個 `el-select`）。
   *
   * 🔴 認法要**兩個訊號聯集**（DOM 實證）：
   *   · 訊號 A：input 值係「N項/頁」
   *   · 訊號 B：個 select 喺 `.el-pagination__sizes` 入面
   *
   * 🔴 一定要**排除多選型**（`.el-select__tags`）：嗰個係商家選擇器。
   */
  function findPageSizeControls() {
    var wraps = document.querySelectorAll(".el-select");
    var out = [];
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      if (!visible(w)) continue;
      if (w.querySelector(".el-select__tags")) continue;
      if (w.closest(".el-table__row, tbody")) continue;

      var input = w.querySelector("input.el-input__inner, input");
      var n = parsePageSizeText(trimmed(input ? input.value : ""));
      var inPagination = !!(w.closest && w.closest(".el-pagination"));
      var inSizes = !!(w.closest && w.closest(".el-pagination__sizes"));

      if (n == null && !inSizes && !inPagination) continue;
      if (inPagination && !inSizes && n == null) continue;

      var r = w.getBoundingClientRect();
      out.push({
        wrap: w,
        input: input || null,
        current: n,
        inPagination: inPagination || inSizes,
        inDialog: !!(w.closest && w.closest(".el-dialog, .el-drawer, .el-dialog__wrapper")),
        top: r.top,
      });
    }
    var inDialog = [];
    for (var d = 0; d < out.length; d++) {
      if (out[d].inDialog) inDialog.push(out[d]);
    }
    if (inDialog.length) out = inDialog;
    out.sort(function (a, b) {
      var pa = a.inPagination ? 0 : 1;
      var pb = b.inPagination ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.top - a.top;
    });
    return out;
  }

  /**
   * 把**一個**「每頁筆數」下拉撳到最大。
   */
  function setOnePageSize(ctl, target, cap) {
    if (!ctl || !ctl.wrap) {
      return Promise.resolve({ ok: false, reason: "冇「每頁筆數」下拉" });
    }
    if (ctl.current != null && ctl.current >= target) {
      return Promise.resolve({ ok: true, already: true, value: ctl.current });
    }

    try {
      ctl.wrap.click();
      if (ctl.input) ctl.input.click();
    } catch (e) {
      /* 繼續試搵選項 */
    }

    var tries = 0;
    function retry() {
      tries++;
      var opts = document.querySelectorAll(".el-select-dropdown__item");
      var best = null;
      var bestN = -1;
      for (var i = 0; i < opts.length; i++) {
        if (!visible(opts[i])) continue;
        var n = parsePageSizeText(trimmed(opts[i].textContent));
        if (n == null) continue;
        if (n > cap) continue;
        if (n > bestN) {
          bestN = n;
          best = opts[i];
        }
      }
      if (best) {
        try {
          best.click();
        } catch (e) {
          return Promise.resolve({
            ok: false,
            reason: "撳「" + bestN + "項/頁」失敗：" + ((e && e.message) || e),
          });
        }
        return sleep(250).then(function () {
          var now = parsePageSizeText(trimmed(ctl.input ? ctl.input.value : ""));
          if (now != null && now >= bestN) {
            return { ok: true, value: now, from: ctl.current };
          }
          return {
            ok: false,
            reason:
              "已撳「" + bestN + "項/頁」但欄位仍然係「" +
              ((ctl.input && ctl.input.value) || "(空)") + "」",
          };
        });
      }
      if (tries >= 10) {
        return Promise.resolve({
          ok: false,
          value: ctl.current,
          reason: "下拉打開咗但搵唔到「N項/頁」選項（可能唔係分頁器，或平台改咗版）",
        });
      }
      return sleep(150).then(retry);
    }
    return sleep(120).then(retry);
  }

  /**
   * 把所有「每頁筆數」下拉撳到最大 —— **即時對帳自己幫使用者撳**。
   *
   * 使用者 Q4：「要, 不然後拿不了全部」
   */
  function setPageSizeToMax(opts) {
    opts = opts || {};
    var target = Number(opts.target) || PAGE_SIZE_TARGET;
    var cap = Number(opts.cap) || PAGE_SIZE_CAP;

    var ctls = findPageSizeControls();
    if (!ctls.length) {
      return Promise.resolve({
        ok: false,
        controls: 0,
        reason: "搵唔到「每頁筆數」下拉（未見 N項/頁）｜可能明細未開，或平台改咗版。",
      });
    }

    var results = [];
    var i = 0;
    function next() {
      if (i >= ctls.length) {
        var anyOk = false;
        var changed = false;
        for (var k = 0; k < results.length; k++) {
          if (results[k].ok) anyOk = true;
          if (results[k].ok && !results[k].already) changed = true;
        }
        return Promise.resolve({
          ok: anyOk,
          changed: changed,
          controls: ctls.length,
          target: target,
          results: results,
          reason: anyOk ? null : "搵到 " + ctls.length + " 個「每頁筆數」下拉但全部改唔到",
        });
      }
      return setOnePageSize(ctls[i], target, cap).then(function (r) {
        results.push(r);
        i++;
        return sleep(200).then(next);
      });
    }
    return next();
  }

  /** 撳「下一頁」。 */
  function clickPaginationNext() {
    var btns = document.querySelectorAll(
      ".el-pagination .btn-next, .el-pagination button.btn-next, .el-pager li.btn-next",
    );
    var pick = null;
    for (var i = 0; i < btns.length; i++) {
      if (!visible(btns[i])) continue;
      var inDialog = !!(btns[i].closest && btns[i].closest(".el-dialog, .el-drawer"));
      if (!pick || (inDialog && !pick.inDialog)) pick = { btn: btns[i], inDialog: inDialog };
    }
    if (!pick) {
      return { ok: false, done: false, reason: "搵唔到「下一頁」掣（.el-pagination .btn-next）" };
    }
    var btn = pick.btn;
    if (btn.disabled || /is-disabled/.test(btn.className || "")) {
      return { ok: false, done: true, reason: "已經係最後一頁" };
    }
    try {
      btn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, done: false, reason: "撳「下一頁」失敗：" + ((e && e.message) || e) };
    }
  }

  /**
   * 逐頁撳「下一頁」，直到抄夠 `total` 或者冇下一頁。
   *
   * 🔴 前提：列已經**跨頁累積**（`mergeDetailRows`），唔係覆寫。
   */
  function pumpDetailPages(opts) {
    opts = opts || {};
    var maxPages = Number(opts.maxPages) || MAX_PAGES;
    var pages = 0;

    function loop() {
      var have = rawFinanceCapture.detailRows.length;
      var total = rawFinanceCapture.detailTotal;
      if (typeof total === "number" && isFinite(total) && have >= total) {
        return Promise.resolve({ ok: true, rows: have, total: total, pages: pages, complete: true });
      }
      if (pages >= maxPages) {
        return Promise.resolve({
          ok: true,
          rows: have,
          total: total,
          pages: pages,
          complete: false,
          reason: "已撳咗 " + pages + " 頁（上限 " + maxPages + "）但仲未到 total=" + total,
        });
      }
      var seqBeforeNext = detailCaptureSeq;
      var n = clickPaginationNext();
      if (!n.ok) {
        return Promise.resolve({
          ok: true,
          rows: have,
          total: total,
          pages: pages,
          complete: !!n.done,
          reason: n.reason || null,
        });
      }
      pages++;
      return waitDetailCaptureAfter(seqBeforeNext, opts.pageTimeout || 6000).then(function (got) {
        if (!got) {
          return {
            ok: true,
            rows: rawFinanceCapture.detailRows.length,
            total: total,
            pages: pages,
            complete: false,
            reason: "撳「下一頁」之後等唔到新嘅明細回應（網絡慢？）",
          };
        }
        return sleep(350).then(loop);
      });
    }
    return loop();
  }

  // ══════════════════════════════════════════════════════════════════
  //  ② 返回帳期列表
  // ══════════════════════════════════════════════════════════════════

  /**
   * 🔴 從明細頁**返回**帳期列表 —— 行完一個帳期一定要返，否則撳唔到下一列。
   *
   * 澳覓明細頁係**同一頁換 route**（`takeoutDetail?accountId=…`），
   * 所以返回方式有兩種：① 頁面上嘅「返回 / 上一步」掣 ② 瀏覽器 history。
   * 兩者都試，並等返回成功（帳期列重新可見）。
   */
  function backToList(prevHash) {
    // ① 頁面上嘅返回掣
    var btn = findByText(/^(返回|上一步|回上一頁|返回列表|返回上一頁|关閉|关闭)$/, { maxLen: 6 });
    if (btn) {
      try {
        btn.click();
      } catch (e) {
        /* 換下一招 */
      }
    } else {
      // ② history 後退（澳覓明細係 push 出嚟嘅 route）
      try {
        if (prevHash != null && String(location.hash) !== String(prevHash)) {
          window.history.back();
        }
      } catch (e) {
        /* 忽略 */
      }
    }
    return sleep(900).then(function () {
      if (listPeriodRows().length) return { ok: true };
      // 再等一輪（SPA 渲染慢）
      return sleep(900).then(function () {
        var n = listPeriodRows().length;
        return {
          ok: n > 0,
          reason: n > 0 ? null : "返回之後仍然見到唔到帳期列（可能返回失敗）",
        };
      });
    });
  }

  /**
   * 由 URL route 分辨「係唔係明細頁」。
   *
   * 🔴 一定要靠 URL，**唔可以**靠「見唔到帳期列」推斷 ——
   *    「見唔到列」有其他成因（選擇器唔中／頁面未載入），
   *    靠佢推斷就會亂撳「返回」，反而把使用者帶離正確頁面。
   */
  function onDetailRoute() {
    var h = String(location.hash || "");
    var s = String(location.href || "");
    return /takeoutDetail/i.test(h) || /takeoutDetail/i.test(s);
  }

  /**
   * 🔴 啟動時若**已經喺明細頁**，先退回帳期列表。
   *
   * 為什麼一定要：使用者好自然會「睇緊某期明細」就撳立即對帳
   * （2026-09-29 真機：使用者開住 `…/takeoutDetail?accountId=unExp_16857`）。
   *
   * 而 `runFinanceSync` 會記低 `prevHash`（＝啟動時嘅 hash）用嚟「行完返列表」。
   * 如果啟動時就喺明細頁，`prevHash` ＝明細頁 ⇒ 第一輪行完
   * `backToList` 見 `location.hash === prevHash` **唔會 back** ⇒
   * 卡死在明細頁，只能拿到第一期，其餘**靜默消失**。
   *
   * @returns {Promise<{ok:boolean, moved:boolean, reason?:string}>}
   */
  function ensureOnListPage() {
    // 🔴 URL 講明係明細頁 ⇒ 直接退回列表。
    //    唔可以靠「見唔到帳期列」推斷係明細頁 ——「見唔到列」有其他成因
    //    （選擇器唔中／頁面未載入），靠佢推斷就會**亂撳「返回」**，
    //    反而把使用者帶離正確頁面（2026-09-29 真機實錄：明明喺列表頁都撳咗返回）。
    if (onDetailRoute()) {
      var btn = findByText(/^(返回|上一步|回上一頁|返回列表|返回上一頁|关閉|关闭)$/, {
        maxLen: 6,
      });
      if (btn) {
        try {
          btn.click();
        } catch (e) {
          /* 落去 history 招 */
        }
      } else {
        try {
          window.history.back();
        } catch (e) {
          /* 忽略 */
        }
      }
      return sleep(900).then(function () {
        if (listPeriodRows().length) return { ok: true, moved: true };
        return sleep(900).then(function () {
          var n = listPeriodRows().length;
          return {
            ok: n > 0,
            moved: true,
            reason: n > 0 ? null : "撳咗返回但仲係見唔到帳期列表（請確認係「外賣對帳」列表頁）",
          };
        });
      });
    }

    // 列表頁：只要見到帳期列就 OK（等一陣，SPA 可能未 render 完）
    if (listPeriodRows().length) return Promise.resolve({ ok: true, moved: false });
    return sleep(700).then(function () {
      if (listPeriodRows().length) return { ok: true, moved: false };
      return {
        ok: false,
        moved: false,
        reason:
          "頁面上見唔到帳期列（URL 唔似明細頁，亦唔會亂撳）。" +
          "可能：頁面仍在載入、未登入、或帳期列表嘅 DOM 結構同預期唔同。",
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  編排：逐帳期走訪
  // ══════════════════════════════════════════════════════════════════

  /**
   * 跑完整流程。
   *
   * @param {{storeName?:string, targetDate?:string, startDate?:string}} opts
   */
  function runFinanceSync(opts) {
    opts = opts || {};
    if (!onFinancePage()) {
      return Promise.resolve({
        ok: false,
        reason: "呢個分頁唔係澳覓財務對帳頁，唔會亂撳",
      });
    }

    // 🔴 防並發：popup 立即對帳 / 定時自動 / 明細頁「查詢」都可能觸發，一次只跑一個。
    if (financeSyncing) {
      return Promise.resolve({
        ok: false,
        reason: "對帳進行中，請稍候…",
        step: "busy",
      });
    }
    financeSyncing = true;

    // 🔴 一輪新同步開始：明細帳本由零開始（見 `resetDetailCapture` 註釋）。
    resetDetailCapture();

    var trace = [];
    var periodResults = [];
    var walkTargets = [];
    /** 帳期列表頁嘅 hash（用嚟「行完一期返列表」）；喺 `ensureOnListPage()` 之後才填。 */
    var prevHash = String(location.hash || "");

    /** 收尾：無論成功失敗都解鎖（避免卡死成 permanent busy）。 */
    function release() {
      financeSyncing = false;
    }

    // 🔴 明細頁就地短路：唔跳列表、唔 walk 全部帳期，就抓「當前在睇嗰一期」並推 POS。
    //    （使用者 2026-09-29：喺對帳記錄頁唔應強制跳返主頁；點「查詢」就自動重抓最新一期。）
    if (onDetailRoute()) {
      trace.push({ step: "route", ok: true, detail: true, note: "明細頁就地對帳" });
      return syncDetailPage(opts).then(
        function (res) {
          release();
          return res;
        },
        function (err) {
          release();
          throw err;
        },
      );
    }

    // ① 先確保企喺帳期列表（若使用者開住明細頁，先退返出去）
    return ensureOnListPage().then(function (e) {
      if (!e.ok) {
        return { ok: false, reason: e.reason, step: "list", trace: trace };
      }
      if (e.moved) trace.push({ step: "ensure-list", ok: true, note: "啟動時喺明細頁，已退回列表" });
      // 🔴 `prevHash` 一定要喺**退返列表之後**才記：
      //    否則會記住啟動時嗰個明細頁 hash ⇒ 行完返唔到列表（見 ensureOnListPage 註釋）。
      prevHash = String(location.hash || "");
      return step1();
    }).then(
      function (res) {
        release();
        return res;
      },
      function (err) {
        release();
        throw err;
      },
    );

    /**
     * 明細頁就地對帳：唔跳列表，就抓「當前在睇嗰一期」並推 POS。
     *
     * 流程：reset 已抓 → 撳「查詢」觸發平台重發明細 → 等新回應
     *       → 撳最大每頁筆數 → 逐頁抄 → finishPeriod（單期）→ finishAll。
     *
     * 🔴 撳「查詢」係 programmatic click（isTrusted=false），唔會觸發上面嗰個
     *    查詢監聽（佢只認真人 click），所以唔會自 loop。
     */
    function syncDetailPage() {
      resetDetailCapture();
      clearFinanceEvents(); // 清走頁面載入時舊嘅 finance_detail_captured，逼等「查詢」後新回應
      trace.push({ step: "detail-shortcut", ok: true, note: "明細頁就地對帳，唔跳列表" });

      // ② 先撳「查詢」觸發重抓（唔使填單號 ＝ 撈返全期最新數據）
      var q = clickDetailQuery();
      trace.push({ step: "detail-query", ok: q.ok, reason: q.reason || null });
      if (!q.ok) {
        // 🔴 冇查詢掣：退而求其次，period key 用 accountId 兜底（最多係 POST 建唔到帳期）
        var noQueryTarget = {
          period: "acct:" + (rawFinanceCapture.detailAccountId || "unknown"),
          start: null,
          end: null,
          row: null,
        };
        return Promise.resolve(
          periodFail(noQueryTarget, "detail-query", q.reason || "明細頁搵唔到「查詢」掣（無法觸發重抓）"),
        );
      }

      var seqBefore = detailCaptureSeq;
      return waitFinance("finance_detail_captured", 6000).then(function (first) {
        if (!first) {
          // 🔴 撳咗查詢但等唔到明細 ⇒ 如實失敗（唔可以當「呢期冇單」）
          var failTarget = {
            period: "acct:" + (rawFinanceCapture.detailAccountId || "unknown"),
            start: null,
            end: null,
            row: null,
          };
          trace.push({
            step: "detail-captured",
            ok: false,
            period: failTarget.period,
            reason: "撳咗查詢但等唔到明細回應（查詢掣可能未生效／平台改版）",
          });
          return periodFail(
            failTarget,
            "detail-captured",
            "撳咗查詢但等唔到明細回應（查詢掣可能未生效／平台改版）",
          );
        }

        // 🔴 period key 喺**抓到之後**先組（detailRows 先有數）：
        //    盡量用明細頁 header 文字 ⇒ 同列表流程一致，避免 POS 重複建帳期；
        //    冇 header 文字就由明細列日期兜；再冇就用 accountId 兜底。
        var periodText =
          detailPagePeriodText() ||
          detailRowsPeriodRange() ||
          "acct:" + (rawFinanceCapture.detailAccountId || "unknown");
        var parts = String(periodText).split(" ~ ");
        var target = {
          period: periodText,
          start: parts[0] || null,
          end: parts[1] || parts[0] || null,
          row: null,
        };

        var rows0 = first && Array.isArray(first.rawResult) ? first.rawResult.length : 0;
        trace.push({
          step: "detail-captured",
          ok: true,
          period: target.period,
          rows: rows0,
          accountId: (first && first.accountId) || null,
        });

        var seqAfter = detailCaptureSeq;
        return setPageSizeToMax({ target: PAGE_SIZE_TARGET }).then(function (ps) {
          trace.push({
            step: "page-size",
            ok: ps.ok,
            changed: !!ps.changed,
            period: target.period,
            reason: ps.reason || null,
          });
          if (!ps.ok || !ps.changed) return pumpDetail();
          return waitDetailCaptureAfter(seqAfter, 6000).then(function () {
            return pumpDetail();
          });
        });

        function pumpDetail() {
          return pumpDetailPages({}).then(function (pg) {
            trace.push({
              step: "paging",
              ok: pg.ok,
              rows: pg.rows,
              total: pg.total,
              pages: pg.pages,
              complete: !!pg.complete,
              period: target.period,
              reason: pg.reason || null,
            });
            var res = finishPeriod(target, 0);
            periodResults.push(res);
            return finishAll();
          });
        }
      });
    }

    function step1() {
      var pick = pickPeriodTargets(opts);
      if (!pick.ok) {
        return { ok: false, reason: pick.reason, step: "period", trace: trace };
      }
      walkTargets = pick.targets;
      trace.push({
        step: "periods",
        ok: true,
        walk: !!pick.walk,
        count: pick.targets.length,
        capped: !!pick.capped,
        totalOnPage: pick.total == null ? null : pick.total,
        startDate: opts.startDate || null,
        periods: pick.targets.map(function (t) {
          return t.period;
        }),
        note: pick.capped
          ? "頁面有 " + pick.total + " 個帳期，今次只行最近 " + pick.targets.length + " 個"
          : null,
      });
      return walkPeriods(pick.targets, 0);
    }

    /** 逐個帳期行；行完**一定返列表**先好去下一個。 */
    function walkPeriods(targets, i) {
      if (i >= targets.length) return Promise.resolve(finishAll());
      return runOnePeriod(targets[i], i).then(function (pr) {
        periodResults.push(pr);
        return backToList(prevHash).then(function (b) {
          trace.push({
            step: "back",
            ok: !!b.ok,
            period: targets[i].period,
            periodIndex: i,
            reason: b.reason || null,
          });
          if (b.ok === false) {
            trace.push({
              step: "walk-aborted",
              ok: false,
              period: targets[i].period,
              periodIndex: i,
              reason: "返回列表失敗，停止行之後嘅帳期（" + (b.reason || "未知") + "）",
            });
            return finishAll();
          }
          return sleep(400).then(function () {
            return walkPeriods(targets, i + 1);
          });
        });
      });
    }

    /**
     * 行**一個**帳期：撳「查看」→ 撳每頁筆數 → 逐頁抄明細。
     *
     * @returns {Promise<object>} 帳期結果（**失敗都回一份**）
     */
    function runOnePeriod(target, idx) {
      // 🔴 每個帳期獨立累積（見「第二個死穴」）
      resetDetailCapture();
      trace.push({ step: "period", ok: true, period: target.period, periodIndex: idx });

      // 🔴 次序好重要：**先清走舊事件，再撳「查看」**。
      //    否則會攞到上一輪殘留嘅明細 ⇒ 配錯帳期（金額「有值但錯」）。
      clearFinanceEvents();

      var d = clickDetailInRow(target.row);
      trace.push({
        step: "detail",
        ok: d.ok,
        period: target.period,
        periodIndex: idx,
        reason: d.reason || null,
      });
      if (!d.ok) {
        return Promise.resolve(periodFail(target, "detail", d.reason));
      }

      // 撳完之後，平台先會發明細請求 ⇒ 一定要**等**攔截到第一批明細。
      return waitFinance("finance_detail_captured", 5000).then(function (first) {
        var rows0 = first && Array.isArray(first.rawResult) ? first.rawResult.length : 0;
        trace.push({
          step: "detail-captured",
          ok: !!first,
          period: target.period,
          periodIndex: idx,
          rows: rows0,
          accountId: (first && first.accountId) || null,
          reason: first
            ? null
            : "撳咗「查看」但等唔到明細回應（網絡慢？平台改版？）",
        });

        // 🔴🔴 撳咗「查看」但**完全冇**明細回應 ＝ 硬失敗，唔可以當「呢個帳期冇單」。
        //
        //    兩者係唔同嘅事，一定要分得清：
        //      · `first` 有值、`rawResult` 係空陣列 → 平台真係回「冇單」（正常）
        //      · `first` 係 null（等 5 秒都冇任何回應）→ 明細根本冇開到
        //
        //    ⚠️ 舊寫法兩者一律當「成功、0 筆」⇒ 收銀台會見到「對帳成功、推送 0 筆」，
        //       而平台其實有幾十筆單。呢種「有做但冇數」係最難察覺嘅失敗模式
        //       （同 mfood 早期「每頁 20 筆」係同一類病）。
        //    ⇒ 寧願如實失敗（popup 出紅字、日誌有記錄），都唔可以靜靜地報成功。
        if (!first) {
          return periodFail(target, "detail-captured", "撳咗「查看」但等唔到明細回應（網絡慢？平台改版？）");
        }

        // 🔴 先撳每頁筆數，再逐頁抄。
        var seqBefore = detailCaptureSeq;
        return setPageSizeToMax({ target: PAGE_SIZE_TARGET }).then(function (ps) {
          trace.push({
            step: "page-size",
            ok: ps.ok,
            target: ps.target == null ? PAGE_SIZE_TARGET : ps.target,
            controls: ps.controls == null ? null : ps.controls,
            changed: !!ps.changed,
            period: target.period,
            periodIndex: idx,
            sizes: (ps.results || []).map(function (r) {
              return { ok: r.ok, value: r.value == null ? null : r.value, already: !!r.already };
            }),
            reason: ps.reason || null,
          });
          if (!ps.ok || !ps.changed) {
            return pump({ changed: false, note: ps.reason || "每頁筆數已經夠大" });
          }
          // 🔴 撳完 ⇒ 平台會再發一次請求 ⇒ 等**新**嗰個回應。
          return waitDetailCaptureAfter(seqBefore, 6000).then(function (got) {
            return pump({
              changed: true,
              got: !!got,
              note: got ? null : "撳完每頁筆數但等唔到新回應（沿用原本嗰批）",
            });
          });
        });

        function pump(psr) {
          return pumpDetailPages({}).then(function (pg) {
            trace.push({
              step: "paging",
              ok: pg.ok,
              rows: pg.rows,
              total: pg.total == null ? null : pg.total,
              pages: pg.pages,
              complete: !!pg.complete,
              period: target.period,
              periodIndex: idx,
              note: psr.note || null,
              reason: pg.reason || null,
            });
            return finishPeriod(target, idx);
          });
        }
      });
    }

    /** 由「已到手嘅明細列」組出一個帳期嘅結果。 */
    function finishPeriod(target, idx) {
      var rows = rawFinanceCapture.detailRows.slice();
      var total =
        rawFinanceCapture.detailTotal == null ? null : rawFinanceCapture.detailTotal;
      var complete = total != null && isFinite(Number(total)) && rows.length >= Number(total);

      // 逐筆正規化（orderId → tradeNo，costAmount → netAmount）
      var txns = [];
      var sumNet = 0;
      var anyNet = false;
      var sumGross = 0;
      var anyGross = false;
      for (var i = 0; i < rows.length; i++) {
        var t = normalizeTxn(rows[i]);
        if (!t) continue;
        if (t.netAmount != null) {
          sumNet += t.netAmount;
          anyNet = true;
        }
        // 🔴 營業額（應收）：逐筆 grossAmount 加總 ⇒ `should`
        //    POS `periodUsable` 要求 `should` 非空且 > 0 才啟用「帳期兜底」
        //    （否則澳覓報表落返逐單口徑，帳期級差額率會缺）。
        if (t.grossAmount != null) {
          sumGross += t.grossAmount;
          anyGross = true;
        }
        txns.push(t);
      }

      trace.push({
        step: "transactions",
        ok: rows.length > 0,
        via: "page-capture",
        count: rows.length,
        total: total,
        complete: complete,
        period: target.period,
        periodIndex: idx,
        reason: complete
          ? null
          : total == null
            ? "平台冇回 total，唔敢肯定抄齊（而家抄到 " + rows.length + " 列）"
            : "只抄到 " + rows.length + " / " + total + " 列（未齊）",
      });

      return {
        ok: true,
        source: "page-capture",
        period: target.period,
        start: target.start || null,
        end: target.end || null,
        // 🔴 帳期級實收：由明細逐筆加總（澳覓列表層冇金額，要入去先有）。
        receive: anyNet ? Math.round(sumNet * 100) / 100 : null,
        // 🔴 澳覓冇「補貼」兩段口徑 ⇒ subsidy 一律 null
        //    （POS `periodPayout()` 會自動落到 `receive`）。
        subsidy: null,
        // 🔴 營業額（應收）＝ 逐筆 grossAmount 加總 ⇒ POS `periodUsable` 靠佢
        //    啟用「帳期兜底」（2026-09-29 次要修復：舊寫法漏咗呢欄
        //    ⇒ 澳覓報表 `should` 永遠 null ⇒ 帳期級差額率缺）。
        should: anyGross ? Math.round(sumGross * 100) / 100 : null,
        transactions: txns,
        total: total,
        complete: complete,
      };
    }

    /** 一個帳期失敗時嘅統一回報。 */
    function periodFail(target, step, reason) {
      return {
        ok: false,
        step: step,
        period: target.period,
        reason: reason,
        transactions: [],
        total: null,
        complete: false,
        receive: null,
        subsidy: null,
        should: null,
        // 🔴 失敗都要帶 trace —— 否則 caller 收唔到「撳查詢但平台無回應」
        //    呢類斷言（[29]）。trace 喺 runFinanceSync 閉包內，隨時可附。
        trace: trace,
      };
    }

    /**
     * 全部帳期行完 → 組最終結果。
     *
     * 🔴 只要**有**任何一個帳期成功，今次就算成功（其他帳期失敗要如實列出）。
     */
    function finishAll() {
      var okPeriods = [];
      var failed = [];
      for (var i = 0; i < periodResults.length; i++) {
        var p = periodResults[i];
        if (p && p.ok) okPeriods.push(p);
        else failed.push(p);
      }

      if (!okPeriods.length) {
        var f = failed[0] || null;
        if (f) {
          return {
            ok: false,
            reason: f.reason || "所有帳期都抓唔到",
            step: f.step || "period",
            period: f.period || null,
            trace: trace,
            periods: periodResults,
            periodCount: periodResults.length,
          };
        }
        return {
          ok: false,
          reason: "帳期列表係空（可能平台未對帳）",
          step: "period",
          trace: trace,
          periods: [],
          periodCount: 0,
        };
      }

      var allTxns = [];
      var totalSum = null;
      var totalKnown = true;
      var completeAll = true;
      var receiveSum = 0;
      var anyReceive = false;
      var shouldSum = 0;
      var anyShould = false;
      for (var k = 0; k < okPeriods.length; k++) {
        var q = okPeriods[k];
        allTxns = allTxns.concat(q.transactions || []);
        if (q.total == null) totalKnown = false;
        else totalSum = (totalSum == null ? 0 : totalSum) + Number(q.total);
        if (!q.complete) completeAll = false;
        if (q.receive != null) {
          receiveSum += Number(q.receive);
          anyReceive = true;
        }
        if (q.should != null) {
          shouldSum += Number(q.should);
          anyShould = true;
        }
      }

      var primary = okPeriods[0];
      return {
        ok: true,
        source: primary.source || null,
        period: primary.period || null,
        receive: primary.receive == null ? null : primary.receive,
        subsidy: null,
        // 🔴 營業額（應收）＝ primary 帳期嘅 `should`
        //    （background `amountsOf(p)` 會原樣轉發去 POS，POS `periodUsable` 靠佢）。
        should: primary.should == null ? null : primary.should,
        transactions: allTxns,
        transactionsTotal: totalKnown ? totalSum : null,
        transactionsComplete: completeAll && totalKnown,
        // 🔴 逐帳期結果（background 會**逐個**推送去 POS）
        periods: okPeriods,
        periodCount: okPeriods.length,
        receiveSum: anyReceive ? Math.round(receiveSum * 100) / 100 : null,
        shouldSum: anyShould ? Math.round(shouldSum * 100) / 100 : null,
        failedPeriods: failed.map(function (x) {
          return {
            period: x && x.period ? x.period : null,
            step: (x && x.step) || null,
            reason: (x && x.reason) || null,
          };
        }),
        periodWalk: {
          requested: walkTargets.length,
          ok: okPeriods.length,
          failed: failed.length,
          periods: walkTargets.map(function (t) {
            return t.period;
          }),
        },
        trace: trace,
      };
    }
  }

  /**
   * 把澳覓明細 raw 列正規化為 POS 認得嘅交易。
   *
   * 🔴 `orderId`（`TK0011526…`）→ `tradeNo`。
   *    POS 端 `tradeNoCore()` 會剝開頭英文字母 ⇒ `0011…` 同 POS 存嘅純數字對得上。
   *
   * 🔴 `costAmount`（分）→ `netAmount`（元）。只認 `costAmount`，冇就 null。
   */
  function normalizeTxn(row) {
    if (!row || typeof row !== "object") return null;
    var orderId =
      row.orderId != null
        ? String(row.orderId)
        : row.tradeNo != null
          ? String(row.tradeNo)
          : row.orderNo != null
            ? String(row.orderNo)
            : null;
    if (!orderId) return null;

    var settle = settleAmountOf(row);
    return {
      tradeNo: orderId,
      netAmount: settle.mop,
      grossAmount: grossAmountOf(row),
      // 🔴 澳覓冇補貼兩段口徑 ⇒ subsidy 一律 null
      subsidyNet: null,
      // 保留原始（診斷用，POS 端會忽略未知欄位）
      raw: row,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  訊息接口
  // ══════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    if (msg.type === "GRAB_PING") {
      sendResponse({
        ok: true,
        href: String(location.href || ""),
        ready: String(document.readyState || ""),
        finance: onFinancePage(),
      });
      return true;
    }

    if (msg.type === "AOMIFIN_SYNC") {
      // 🔴 一定要有 `.catch`：舊寫法冇 catch ⇒ 任何錯誤都變 unhandled rejection
      //    ⇒ popup 永遠收唔到回應（睇落就係「卡住」、「巳停止」）。
      // 🔴 一定要帶 `startDate`：跨層欄位會靜默蒸發（bridge handler 唔轉發
      //    ⇒ 只會行「命中今日」嗰一個帳期）。
      runFinanceSync({
        storeName: msg.storeName,
        targetDate: msg.targetDate,
        startDate: msg.startDate || null,
      }).then(sendResponse, function (e) {
        sendResponse({
          ok: false,
          reason: "內部錯誤：" + ((e && e.message) || e),
          stack: String((e && e.stack) || "").slice(0, 1500),
          step: "internal",
        });
      });
      return true;
    }

    /** 把全部已攔到嘅原始資料原樣交返出嚟（唔配對、唔篩選）。 */
    if (msg.type === "AOMIFIN_RAW") {
      try {
        var rawResp = {
          ok: true,
          href: String(location.href || ""),
          finance: onFinancePage(),
          capturedAt: rawFinanceCapture.updatedAt,
          periodRowCount: rawFinanceCapture.periodRows.length,
          periodRowKeys: rawFinanceCapture.periodRowKeys,
          periodRows: rawFinanceCapture.periodRows,
          detailRowCount: rawFinanceCapture.detailRows.length,
          detailTotal: rawFinanceCapture.detailTotal,
          detailAccountId: rawFinanceCapture.detailAccountId,
          firstRowKeys: rawFinanceCapture.firstRowKeys,
          detailRows: rawFinanceCapture.detailRows,
          detailPages: rawFinanceCapture.detailPages,
          lastRequest: financeEvents.finance_last_request
            ? {
                url: financeEvents.finance_last_request.url || null,
                accountId: financeEvents.finance_last_request.accountId || null,
              }
            : null,
        };
        var rawJson = "";
        try {
          rawJson = JSON.stringify(rawResp);
        } catch (se) {
          rawJson = "";
        }
        var RAW_MAX = 4 * 1024 * 1024;
        if (rawJson && rawJson.length > RAW_MAX) {
          rawResp.detailRows = rawResp.detailRows.slice(0, 200);
          rawResp.periodRows = rawResp.periodRows.slice(0, 200);
          rawResp.truncated = true;
        }
        try {
          structuredClone(rawResp);
        } catch (ce) {
          rawResp = JSON.parse(JSON.stringify(rawResp));
          rawResp.sanitized = true;
        }
        sendResponse(rawResp);
      } catch (e) {
        sendResponse({
          ok: false,
          reason: "AOMIFIN_RAW 建構回應時出錯：" + ((e && e.message) || e),
          step: "raw-build",
        });
      }
      return true;
    }

    /** 只讀診斷（唔會撳任何嘢）。 */
    if (msg.type === "AOMIFIN_PROBE") {
      askLastFinanceRequest(800).then(function (last) {
        sendResponse({
          ok: true,
          finance: onFinancePage(),
          periodRows: listPeriodRows().map(function (p) {
            return p.period;
          }),
          pageSizeControls: findPageSizeControls().length,
          hasNextButton: !!document.querySelector(".el-pagination .btn-next"),
          capturedDetailRows: rawFinanceCapture.detailRows.length,
          capturedDetailTotal: rawFinanceCapture.detailTotal,
          lastRequestUrl: (last && last.url) || null,
        });
      });
      return true;
    }
  });

  console.log(TAG, "installed on", window.location.href);
})();
