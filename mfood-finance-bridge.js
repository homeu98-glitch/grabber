/**
 * mfood-finance-bridge.js — isolated world content script（mFood 財務／對帳頁）
 *
 * 掛載頁面：`https://merchant.mfoodapp.com/#/finance/tackout-check`
 *
 * ── 為什麼要獨立一支（唔可以塞入 mfood-bridge.js）────────────────────
 * `mfood-bridge.js` 掛喺 `*.mfoodapp.com/*` 嘅**訂單管理**頁（SPA 同一個 origin，
 * 換 hash 唔會重新載入 ⇒ 一個 content script 會同時存在於兩頁）。
 * 但財務頁要跑**完全另一套四步流程**：
 *   ① 選商家 → ② 按查詢 → ③ 查看詳情 → ④ 呼叫 `_get-order-summary-list`
 * 塞入 `mfood-bridge.js` 會令 `GRAB_RESCAN`（訂單查詢）撞到財務頁嘅「查詢」掣
 * ⇒ 兩套流程互相干擾。獨立一支，用唔同嘅 message 前綴（`MFOODFIN_`）就完全隔離。
 *
 * ── 🔴 單位 ─────────────────────────────────────────────────────────
 * mfood 金額係**元**（`storeReceiveAmtn: 35.11` 就係 MOP 35.11），唔使除 100。
 * 同 `mfood-bridge.js` 一致（唔好似澳覓咁當「分」）。
 *
 * ── 🔴 唔可以 F5（使用者 2026-09-26 明確要求）───────────────────────
 * 全程只用 DOM 操作（設定下拉、按掣、展開詳情）＋ fetch。
 * 冇任何 `location.reload()`。使用者原話：「不需要 F5 整個頁面…只需要按查詢就夠了」。
 *
 * ── 四步流程 ───────────────────────────────────────────────────────
 *   ① 選商家（多店商戶要指定；由設定傳入商家名）
 *   ② 按「查詢」→ 取得帳期列表（`summary/_list`）
 *   ③ 揀對應帳期，按「查看詳情」
 *   ④ 呼叫 `_get-order-summary-list` 逐頁拎 transaction detail
 *      ⚠️ 帳期列表嘅 `details` 係**空陣列**，唔可以靠佢 —— 一定要另外呼叫。
 *      ⚠️ `total: 231` 但 `result: 22` ⇒ **必須翻頁**，否則實收靜默偏少一大截。
 */

(function () {
  "use strict";

  // 🔴🔴 2026-09-28 第十四次真機：**呢兩道 guard 缺一不可**。
  //
  //    真機紅字實證：「Uncaught ReferenceError: onFinancePage is not defined」。
  //
  //    成因：guard 用 `window.__XXX_INSTALLED__` 做記號，
  //    而 **`window` 喺 content script（isolated）同頁面（MAIN）之間係同一個物件**
  //    （兩者共享 DOM 同 `window`，只係 JS 全域變數唔共享）。
  //    ⇒ 一旦呢支 bridge 被意外注入 MAIN world：
  //        MAIN 先跑 → 記號設 true → `onFinancePage` 等**從未定義**
  //        真正 isolated 跑 → 見到記號即 `return` → 但舊嘅 onMessage listener 仍在
  //        ⇒ 收到訊息就叫 `onFinancePage()` ⇒ ReferenceError（而且係 Uncaught）
  //
  //    ⇒ 修法一：guard 改成「**只有真係喺 extension context** 才設記號」。
  //      `chrome.runtime.id` 只有 extension context 有 ⇒ MAIN world 唔會污染記號。
  var IN_EXTENSION_CONTEXT = !!(
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.id
  );

  // ⚠️ 唔喺 extension context（例如被錯誤注入 MAIN world）＝**直接唔做嘢**。
  //    比「做到一半拋錯」好得多：唔會註冊半殘 listener，亦唔會污染記號。
  if (!IN_EXTENSION_CONTEXT) return;

  if (window.__MFOOD_FINANCE_BRIDGE_INSTALLED__) return;
  window.__MFOOD_FINANCE_BRIDGE_INSTALLED__ = true;

  var TAG = "[mfood/finance]";

  /** 財務頁 route（SPA hash）。 */
  var FINANCE_HASH = "finance/tackout-check";

  /** `_get-order-summary-list` 嘅相對路徑（同 origin，靠 cookie 認身分）。 */
  var SUMMARY_LIST_PATH = "/merchants/summarys/summary/_get-order-summary-list";
  /** 每頁筆數（同後台一致；太大會被拒）。 */
  var PAGE_SIZE = 20;

  /** 翻頁上限：防平台回錯 `total` 導致無限迴圈。 */
  var MAX_PAGES = 40;

  // ══════════════════════════════════════════════════════════════════
  //  🔴🔴🔴 2026-09-28 第十六次真機（使用者點醒）：「每頁筆數」要自己撳
  //
  //  使用者原話：
  //    「拿不到 32 條是因為, paging 我沒選到 50一頁,
  //     但是當我用立即對帳, 應該是你也要幫忙按到才行.」
  //
  //  真機事實（DOMDUMP 實證）：
  //    · 明細彈窗（「查看詳情」）下面有 `el-pagination`，內含一個 `el-select`
  //      闊 110px，`inputValue = "20項/頁"`，
  //      選項 = 10項/頁 | 20項/頁 | 30項/頁 | 40項/頁 | 50項/頁
  //    · 平台上限就係 **50** ⇒ 一個月 32 筆，揀 50 就**一頁晒**，唔使翻頁。
  //    · 我哋之前係「照抄平台請求 + 自己重放」⇒ **CORS 一定死**（第十五次真機）。
  //
  //  ✅ 正解（搭便車，唔重放）：
  //      ① 我哋**代撳**嗰個 `el-select`，揀最大（50）
  //      ② 平台自己用 `pageSize=50` **再發一次** `_get-order-summary-list`
  //      ③ 我哋喺 MAIN world **被動**抄低回應 ⇒ 零 CORS、零簽章、零重放
  //      ④ 若 `total > 50`（跨月大單）⇒ 再逐頁撳 `.btn-next` 累積
  //
  //  ⚠️ 次序唔可以調轉：**先撳每頁筆數，再等新回應**。
  //     掉轉會抄到「撳之前」嗰 20 筆，白撳一場。
  // ══════════════════════════════════════════════════════════════════

  /** 「20項/頁」呢類文字 → 數字（20）。簡體「条」亦認。 */
  var PAGE_SIZE_TEXT_RE = /(\d+)\s*(?:項|條|条|筆)\s*\/\s*頁/;

  /** 每頁筆數上限：就算平台畀 200/500 都唔好搏（太大會被閘道拒）。 */
  var PAGE_SIZE_CAP = 200;

  /**
   * 立即對帳想撳到幾多項／頁。
   *
   * 實測平台上限 = 50，而一個月最多都係幾十筆 ⇒ 50 一頁就夠。
   * 「已經係 ≥50」就**唔再撳**（避免開合下拉拖慢、亦唔會觸發多餘請求）。
   */
  var PAGE_SIZE_TARGET = 50;

  /**
   * 🔴 2026-09-28 第四次真機（HTTP 404 真兇）：
   *    舊寫法用 **GET + `?summaryId=`** 打 `_get-order-summary-list` ⇒ **404**。
   *    真機請求係 **POST + JSON body**，id 喺 body 叫 **`weekId`**：
   *    `{"startDate":1789488000000,"endDate":1790784000000,"storeId":"...",
   *      "storeName":"...","weekId":"202609170106005576278","fromMerchant":true,
   *      "orderType":1,"pageNo":1,"pageSize":20}`
   *    ⇒ 呢度記低「今次查詢見過嘅請求 body 範本」，
   *      之後 `fetchSummaryList` 照抄佢（只換 `weekId` 同 `pageNo`），
   *      先可以 200。呢個係「照抄真實請求」原則嘅延伸。
   */
  var lastListBodyTemplate = null;

  /**
   * 🔴 2026-09-28 第五次真機：**重放要打邊個 host ＋ 邊條路徑**。
   *
   * 真機請求絕對 URL ＝
   *   `https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list`
   * 而頁面 origin ＝ `https://merchant.mfoodapp.com`
   * ⇒ 用 `location.origin + path` 重放會 404（打錯 host）。
   *
   * 所以由攔截到嘅真實請求抽 `origin` + `path` 記落嚟，
   * **只在完全冇攔截到嘅情況**才 fallback 去 `location.origin`。
   */
  var lastReplayOrigin = null;
  var lastReplayPath = null;

  // ══════════════════════════════════════════════════════════════════
  //  🔴 MAIN world（`mfood-inject.js`）通訊通道 —— 2026-09-28 新增
  //
  //  為咩要呢條通道：真機實測（2026-09-28）證明財務頁係 **Vue 3**
  //  （`vueProbe` 全 false、`__vue__` 完全唔存在），
  //  所以「由 DOM 撈帳期 id」係死路 —— 舊寫法 `row.__vue__.row.id` 100% 回 null。
  //
  //  新做法：`mfood-inject.js` 喺 MAIN world 搭便車抄低財務頁自己發嘅請求，
  //  經 `window.postMessage`（命名空間 `__mfoodFinance`）傳過嚟。
  //  帳期 id 就喺「查看詳情」嗰個請求嘅 query / body 上面。
  // ══════════════════════════════════════════════════════════════════

  /** 最近收到嘅財務事件（by kind）。 */
  var financeEvents = {
    finance_request: null,
    finance_periods: null,
    finance_detail_captured: null,
    finance_last_request: null,
  };

  /**
   * 🔴 2026-09-28 第十一次真機（使用者要求）：
   *    「唔好配對，先將所有訂單拿喺手。」
   *
   *    之前每一步都係「為咗配對」而篩資料（只留 tradeNo / 金額），
   *    結果一旦配對失敗，就完全冇嘢可以分析。
   *    ⇒ 另外存一份**未經篩選**嘅原始資料（帳期列 raw ＋ 明細列 raw），
   *      只加不減，供使用者離線分析。
   *
   *    刻意放喺 module 層（唔跟 `clearFinanceEvents` 清）——
   *    佢係「到手嘅數據」，唔係「本輪請求狀態」。
   */
  var rawFinanceCapture = {
    updatedAt: null,
    periodRows: [], // 帳期列表（_list）嘅原始列
    detailRows: [], // 明細（_get-order-summary-list）嘅原始列（🔴 跨頁累積）
    detailTotal: null,
    detailSummaryId: null,
    firstRowKeys: [],
    periodRowKeys: [],
    // 🔴 第十六次真機：每頁「抄到幾多列／total 係幾多」嘅流水 —— 用嚟
    //    一眼睇出「平台話 32 筆，我哋只抄到 20」類嘅漏。
    detailPages: [],
  };

  /**
   * 清走「到手嘅明細列」—— 只喺**一輪新同步開始**時 call。
   *
   * 🔴 為什麼要喺同步開始清（而唔係靠 `clearFinanceEvents`）：
   *    一輪同步自己會撳「每頁筆數 + 逐頁下一頁」，理論上可以抄齊；
   *    若上一輪（或使用者手動瀏覽）殘留咗**另一個帳期**嘅列，
   *    唔清就會撈埋一齊 ⇒ POS 寫入錯帳期（金額「有值但錯」，最難察覺）。
   */
  function resetDetailCapture() {
    rawFinanceCapture.detailRows = [];
    rawFinanceCapture.detailPages = [];
    rawFinanceCapture.detailTotal = null;
    rawFinanceCapture.detailSummaryId = null;
    rawFinanceCapture.firstRowKeys = [];
  }

  /**
   * 明細列嘅去重 key。
   *
   * 🔴 一定要有 key 先去重得：翻頁時平台可能回重疊邊界（page1 尾 = page2 頭），
   *    冇 key 就會重複計數 ⇒ 營業額翻倍（比少數更難查）。
   *
   * @returns {string|null} null ＝ 認唔出，照樣照單全收（唔敢丟）。
   */
  function detailRowKey(row) {
    if (!row || typeof row !== "object") return null;
    var candidates = ["tradeNo", "tradeNoStr", "orderNo", "order_no", "orderId", "id"];
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
   * 🔴 換咗帳期（`summaryId` 唔同）⇒ 清空重嚟，唔可以撈埋兩個帳期。
   */
  function mergeDetailRows(rows, payload) {
    detailCaptureSeq++;
    var sid = payload && payload.summaryId ? String(payload.summaryId) : null;
    if (
      sid &&
      rawFinanceCapture.detailSummaryId &&
      rawFinanceCapture.detailSummaryId !== sid
    ) {
      // 換帳期：上一批作廢
      rawFinanceCapture.detailRows = [];
      rawFinanceCapture.detailPages = [];
      rawFinanceCapture.detailTotal = null;
    }
    if (sid) rawFinanceCapture.detailSummaryId = sid;

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
      summaryId: sid,
    });
    // 只留最近 60 頁嘅流水，防止長年累積爆記憶體
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
      // 輪詢 120ms：網絡正常時通常一兩輪就中，唔會白等成個 timeout
      return sleep(120).then(step);
    }
    return step();
  }

  /**
   * 🔴 2026-09-28 第二次真機：撳一次「查看詳情」會連發**多個**財務請求
   *    （`_get-order-summary-data` / `_get-order-summary-list` / …），
   *    而**第一個唔一定帶 id**。舊寫法只保留最後一個 ⇒ 若最後一個唔帶 id
   *    就永遠撈唔到（即使前面嗰個有）。
   *    ⇒ 另外用一個**陣列**累積本輪所有 `finance_request`，供 `resolveSummaryId` 逐個掃。
   */
  var financeRequests = [];
  var FINANCE_REQ_MAX = 30;

  /**
   * 🔴 2026-09-28 第三次真機：帳期列表（`_list`）請求 body 嘅 `weekId`
   *    就係帳期 id（同 `_list` 回應 `result[].id` 完全一致）。
   *
   *    但 `_list` 請求係喺**按「查詢」**（step2）時發，而 `clearFinanceEvents()`
   *    係喺**撳「查看詳情」之前**（step3）才清 —— 即係會**清走帶 weekId 嘅請求**。
   *    ⇒ 必須**另外**保留一份「今次查詢見過嘅帳期 id」，唔受 clear 影響。
   *    佢係「今次查詢」嘅產物，同上一輪殘留唔同（呢個才係安全來源）。
   *
   *    ⚠️ 只收 `summary_list` / `other` 類（**唔收 detail**）——
   *       因為 detail 請求可能係「上一輪撳詳情」殘留，唔代表今次查詢嘅帳期。
   */
  var lastListWeekId = null;

  /** 等待者：kind → [resolve...] */
  var financeWaiters = {};

  /**
   * 🔴 第十六次真機：「明細回應」嘅**流水號**。
   *
   *    每抄到一批就 +1。用途：撳完「每頁筆數／下一頁」之後，
   *    要等「**新**嘅明細回應」，而**唔可以**用「清走事件再等」——
   *
   *    ✗ 舊寫法（`financeEvents[kind] = null` 再 wait）有兩個死穴：
   *      ① 回應可能喺我哋清之前就到咗 ⇒ 白等成個 timeout（實測 7 秒，
   *         令整個流程超過 popup／測試嘅 9 秒保險 ⇒ 睇落似「卡死」）
   *      ② 清走咗一個**真實有效**嘅回應事件，之後嘅 fallback 讀唔到
   *
   *    ✓ 序號制：撳之前記低 `n`，撳之後等 `> n` —— 喺撳之前定之後到都認得，
   *      而且一到就走（實測網絡通常 <1 秒）。
   */
  var detailCaptureSeq = 0;

  function emitFinance(kind, payload) {
    financeEvents[kind] = payload;

    // 🔴 2026-09-28 第十一次真機：順手把原始列存落「到手數據」帳本。
    //    呢度只做**累積**，唔做任何篩選／配對／改名 —— 過濾就係假設。
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
        // 🔴🔴 2026-09-28 第十六次真機：**新一批唔可以再覆蓋舊一批**。
        //
        //    舊寫法「新一批覆蓋舊一批（避免重複累加）」係為咗「同一帳期重複抓」，
        //    但立即對帳而家會**逐頁撳下一頁** ⇒ 覆蓋 = 只剩最後一頁（最經典嘅
        //    「有數但少一大截」）。
        //
        //    ⇒ 改為**跨頁累積**，用 `tradeNo`（或整列 JSON）去重；
        //      只有**換咗帳期**（summaryId 唔同）才清空重嚟。
        mergeDetailRows(rows, payload);
        rawFinanceCapture.updatedAt = Date.now();
      }
    } catch (e) {
      /* 帳本損壞唔可以拖冧主流程 */
    }

    if (kind === "finance_request" && payload) {
      financeRequests.push(payload);
      if (financeRequests.length > FINANCE_REQ_MAX) financeRequests.shift();
      // 記低「今次查詢」見過嘅帳期 id（唔收 detail ⇒ 防上一輪殘留）
      if (payload.summaryId && payload.kind !== "detail") {
        lastListWeekId = String(payload.summaryId);
      }
      // 🔴 記低 detail 請求嘅 body 範本（`weekId` 喺 body、POST）。
      //    `fetchSummaryList` 照抄佢先唔會 404。
      //
      //    🔴🔴 2026-09-28 第五次真機：只可以收 **`_get-order-summary-list`**！
      //    真機同一輪有**兩個** `kind:"detail"`：
      //      · `_get-order-summary-data`（body **冇** `pageNo`/`pageSize`）
      //      · `_get-order-summary-list`（body **有** `pageNo`/`pageSize`）← 重放要用呢個
      //    舊寫法「任何 detail 都覆寫」⇒ 順序一變就攞到 `-data` 嘅 body
      //    ⇒ 重放缺 `pageNo`/`pageSize`，可能回錯形狀或失敗。
      //    ⇒ 只認 `-list`（用 URL 判斷，唔靠抵達順序）。
      if (
        typeof payload.body === "string" &&
        payload.body &&
        payload.url &&
        /_get-order-summary-list/i.test(String(payload.url))
      ) {
        lastListBodyTemplate = payload.body;
      }
      // 🔴 同時記低「重放要打邊個 host ＋ 邊條路徑」——由真實請求抽，
      //    唔可以靠 `location.origin`（真機兩者唔同，見檔頭註釋）。
      if (
        payload.url &&
        /_get-order-summary-list/i.test(String(payload.url)) &&
        payload.origin &&
        payload.path
      ) {
        lastReplayOrigin = String(payload.origin);
        lastReplayPath = String(payload.path);
      }
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

  /**
   * 清走**會過期**嘅事件 —— 只清「最近一次 detail 請求」。
   *
   * 🔴 唔可以連 `finance_periods` 一齊清：佢係「帳期文字 → id」嘅對照表，
   *    由平台載入帳期列表時發出，同「撳查看詳情」無關。清走就冇咗
   *    配對失敗時嘅重要 fallback（實測 2026-09-28 測試 [20] 捉到）。
   */
  function clearFinanceEvents() {
    financeEvents.finance_request = null;
    financeEvents.finance_last_request = null;
    financeEvents.finance_detail_captured = null;
    // 🔴 一併清空「本輪累積嘅財務請求」—— 佢哋同「撳查看詳情」有時序綁定，
    //    唔清就會攞到上一輪殘留嘅 id（配錯帳期 = 實收全錯）。
    financeRequests = [];
    // finance_periods 刻意保留（係對照表，同撳掣無關）
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__mfoodFinance !== true) return;
    if (d.kind) emitFinance(d.kind, d.payload || null);
  });

  /** 叫 MAIN world 回報最近一次財務 detail 請求（攞 summaryId 用）。 */
  function askLastFinanceRequest(timeoutMs) {
    var p = waitFinance("finance_last_request", timeoutMs || 1500);
    try {
      window.postMessage({ __mfoodCmd: true, cmd: "finance_last_request" }, window.location.origin);
    } catch (e) {
      /* 忽略 */
    }
    return p;
  }

  function trimmed(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/^\s+|\s+$/g, "");
  }

  /** mfood 金額：**元**，最多兩位小數。 */
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** 呢個分頁係唔係財務頁。 */
  function onFinancePage() {
    return String(location.hash || "").indexOf(FINANCE_HASH) >= 0;
  }

  /** 係唔係可見（用嚟排除隱藏 tab／未展開嘅下拉）。 */
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ══════════════════════════════════════════════════════════════════
  //  通用：找可見文字嘅元素（Element-UI 大量用 span / div 扮掣）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 找「文字剛好等於 / 包含目標」嘅可撳元素。
   *
   * 🔴 文字長度上限（`maxLen`）好重要：冇咗它，`查詢` 會命中成頁最外層
   *    容器（`textContent` 含「查詢」兩個字嘅大 div）⇒ 撳落去等於撳空白。
   */
  function findByText(pattern, opts) {
    opts = opts || {};
    var maxLen = opts.maxLen || 8;
    var root = opts.root || document;
    var nodes = root.querySelectorAll(opts.sel || 'button, a, [role="button"], span, div');
    var best = null;
    var bestLen = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var txt = trimmed(el.textContent).replace(/\s+/g, "");
      if (!txt || txt.length > maxLen) continue;
      if (!pattern.test(txt)) continue;
      if (!visible(el)) continue;
      // 揀**最短**嘅候選（最貼近嗰粒掣本身，唔係包住佢嘅大容器）
      if (txt.length < bestLen) {
        best = el;
        bestLen = txt.length;
      }
    }
    return best;
  }

  // ══════════════════════════════════════════════════════════════════
  //  ① 選商家
  // ══════════════════════════════════════════════════════════════════

  /**
   * 🔴🔴 列出**全部**可以當「商家下拉」嘅 `.el-select` 候選（按分數排序）。
   *
   * 點解要由「揀一個」改為「列晒出嚟」（2026-09-30 真機 bug）：
   *
   *   舊寫法 `findStoreSelectControl()` 淨係取分數最高嗰一個，而分數入面
   *   `hasTags` 佔 **+100** —— 呢個係基於「商家選擇器係**多選標籤型**」嘅假設
   *   （2026-09-28 真機 dump）。但**之後**你貼嘅真機 DOM 顯示商家選擇器其實係
   *   **單選**（`readonly` input ＋ placeholder「全部」、**冇** `.el-select__tags`）。
   *
   * ⇒ 兩個假設互相矛盾，而財務頁上面其實有**好幾個** `.el-select`
   *   （月份／狀態／商家／分頁…）。只要當中有任何一個帶 `.el-select__tags`
   *   （或者更闊／更靠上），`hasTags` 嘅 +100 就一定壓過真正嘅商家欄
   *   ⇒ 撳開嘅係**另一個**下拉 ⇒ 商家選項永遠唔會出現
   *   ⇒ 對帳卡死喺 `store` 步，報「撳咗商家下拉但 1620ms 內一個可見選項都冇」。
   *
   * ✅ 修法：**唔再賭評分**。列晒全部候選出嚟，交畀 `setStore()` 逐個試，
   *    用「呢個下拉實際有冇彈出商家選項」呢個**反饋**去決定邊個先係商家欄。
   *    無論真機係單選定多選、邊個排第一，都唔會再揀錯。
   *
   * @returns {Array<{wrap:Element, input:Element|null, hasTags:boolean, score:number}>}
   */
  function storeSelectCandidates() {
    var wraps = document.querySelectorAll(".el-select");
    var list = [];
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      if (!visible(w)) continue;
      var r = w.getBoundingClientRect();
      var input = w.querySelector("input.el-input__inner, input");
      var hasTags = !!w.querySelector(".el-select__tags");
      // 跳過太細嘅（例如純 icon 下拉），亦跳過表格內嘅行內下拉
      if (r.width < 120) continue;
      if (w.closest(".el-table, .el-table__row, tbody")) continue;

      var score = 0;
      // tags 型（多選商家）＝ 一個訊號，但**唔再係獨裁**（見上面註釋）
      if (hasTags) score += 100;
      // 寬度大 ≈ 篩選器（商家名長）
      score += Math.min(60, r.width / 5);
      // 越靠上越似工具列
      score += Math.max(0, 40 - Math.abs(r.top) / 20);
      list.push({ wrap: w, input: input || null, hasTags: hasTags, score: score });
    }
    list.sort(function (a, b) {
      return b.score - a.score;
    });
    return list;
  }

  /**
   * 找出「商家」下拉嘅 `.el-select` 容器。
   *
   * ── 🔴 為咩唔可以再靠 placeholder（2026-09-28 真機教訓）──────────────
   * 舊寫法搵 `input[placeholder*="商家"]`。真機 dump 顯示**完全搵唔到**：
   * 真商家選擇器係**多選標籤型**（`el-select__tags`，寬 230px，
   * `data-v-8115293c`），佢個 input 嘅 placeholder 係「**全部**」，唔係「商家」。
   * ⇒ 靠 placeholder 一定回 null（就係「找不到商家下拉」嘅真正原因）。
   *
   * 新寫法：**結構定位**。工具列上通常有幾個 `el-select`（月份、狀態、商家…），
   * 取「最靠上、最靠左」而且**有 tags 容器或係最大寬度**嗰個。
   * 咁樣就算平台改字眼（「全部」→「請選擇」）都唔會斷。
   *
   * @returns {{wrap:Element, input:Element|null, hasTags:boolean}|null}
   */
  function findStoreSelectControl() {
    return storeSelectCandidates()[0] || null;
  }

  /** 由下拉容器讀出「而家已選嘅商家標籤文字」。 */
  function storeSelectedText(ctl) {
    if (!ctl || !ctl.wrap) return "";
    var tags = ctl.wrap.querySelectorAll(".el-select__tags .el-tag, .el-tag");
    var parts = [];
    for (var i = 0; i < tags.length; i++) {
      var t = trimmed(tags[i].textContent);
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join(",");
    return trimmed(ctl.input ? ctl.input.value : "");
  }

  /**
   * 🔴🔴 2026-09-30：店名「同字但唔同碼」會令比對失敗 ⇒ 欄位永遠選唔中。
   * 常見元兇：
   *   · 全角／半角括號（後台落庫用 `（）`，DOM 顯示用 `()`，反之亦然）
   *   · 多餘 whitespace（popup 存嘅 data-store 同 DOM textContent 差幾個空格）
   *   · 全角／半角逗號、分號（分店括號內嘅招牌菜列表）
   * ⇒ 比對前兩邊都過 normStoreName() 統一歸一，先可以避免「明明有呢間店但揀唔中」。
   */
  function normStoreName(s) {
    if (!s) return "";
    return String(s)
      .replace(/[ \s]+/g, " ")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/[【]/g, "[")
      .replace(/[】]/g, "]")
      .replace(/[［]/g, "[")
      .replace(/[］]/g, "]")
      .replace(/[「]/g, "")
      .replace(/[」]/g, "")
      .replace(/[，]/g, ",")
      .replace(/[；]/g, ";")
      .trim();
  }

  /**
   * 由一堆 `.el-select-dropdown__item` 入面，揀出最啱 `name` 嗰個。
   *
   * 🔴🔴 多相似分店場景（例：3 間都叫「表嫂美食(分店X)」）：
   *   舊寫法「包含」永遠揀第一個可見 ⇒ 容易揀錯。新寫法評分揀「最啱」：
   *     score 3 ＝ 歸一後完全相等（最優先）
   *     score 2 ＝ 選項係目標名嘅「分店擴展」（選項以目標名開頭）
   *     score 1 ＝ 選項係目標名嘅「子串」（少見）
   *     score 0 ＝ 目標名係選項嘅子串（例如只存咗「表嫂美食」前綴）
   *   高分優先；同分則保留 DOM 順序（第一間）。
   *
   * @returns {Element|null}
   */
  function pickStoreOption(opts, name) {
    var nName = normStoreName(name);
    if (!nName) return null;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < opts.length; i++) {
      if (!visible(opts[i])) continue;
      var nt = normStoreName(opts[i].textContent);
      if (!nt) continue;
      var score = -1;
      if (nt === nName) score = 3;
      else if (nt.indexOf(nName) === 0) score = 2;
      else if (nName.indexOf(nt) === 0) score = 1;
      else if (nt.indexOf(nName) >= 0) score = 0;
      if (score < 0) continue;
      if (score > bestScore) {
        bestScore = score;
        best = opts[i];
      }
    }
    return best;
  }

  /**
   * 把商家設為指定名稱。
   *
   * ⚠️ 名稱空 → 唔做嘢（保留後台預設），回 `skipped: true`。
   *    單店商戶唔需要選，強行開下拉反而增加失敗面。
   *
   * @returns {Promise<{ok:boolean, skipped?:boolean, already?:boolean, reason?:string, value?:string}>}
   */
  function setStore(storeName) {
    var name = trimmed(storeName);
    if (!name) return Promise.resolve({ ok: true, skipped: true });
    var nName = normStoreName(name);

    var cands = storeSelectCandidates();
    if (!cands.length) {
      return Promise.resolve({ ok: false, reason: "找不到商家下拉（請確認已進入外賣對帳頁）" });
    }

    var tried = []; // 診斷：每個候選「撳開之後見到幾多個可見選項」

    /** 呢個候選係咪**已經**揀啱（唔使再撳任何嘢）。 */
    function alreadyOn(ctl) {
      var cur = storeSelectedText(ctl);
      var nCur = normStoreName(cur);
      if (nCur === nName || (nCur && nCur.indexOf(nName) >= 0)) return cur;
      return null;
    }

    // ① 先睇吓有冇任何一個候選已經揀啱 —— 唔使撳、唔使開任何下拉。
    // 🔴🔴 2026-09-30：兩邊都過 normStoreName()，避免全角括號／空格導致「永遠唔等」。
    for (var k = 0; k < cands.length; k++) {
      var already = alreadyOn(cands[k]);
      if (already) return Promise.resolve({ ok: true, already: true, value: already });
    }

    function closePopper() {
      try {
        document.body.click();
      } catch (e) {
        /* ignore */
      }
    }

    /**
     * 派一個鍵盤事件落指定元素（用 `keydown` + `keyup` 一對）。
     *
     * 註：`isTrusted:false`，但 Element-UI 嘅 select 只係聽 `keydown` 做
     * `navigateOptions`／`handleOptionSelect`，唔會檢查 `isTrusted` ⇒ 照收。
     *
     * @param {Element|null} el
     * @param {string} key  例如 `"ArrowDown"`
     * @param {number} [keyCode]
     * @returns {boolean} 有冇成功派發
     */
    function dispatchKey(el, key, keyCode) {
      if (!el) return false;
      try {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: key,
            code: key,
            keyCode: keyCode || 0,
            which: keyCode || 0,
            bubbles: true,
            cancelable: true,
          }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: key,
            code: key,
            keyCode: keyCode || 0,
            which: keyCode || 0,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      } catch (e) {
        return false;
      }
    }

    /**
     * 把下拉選項容器嘅 scrollTop 推到某個選項身上。
     *
     * Element-UI 嘅 `scrollbar` 係自己覆寫嘅（真正可滾動嘅係 `.el-scrollbar__wrap`
     * 而唔係 `body`），所以要用「目標與容器嘅相對位置」去算 scrollTop，
     * 唔可以當普通 `scrollIntoView()`。
     *
     * @param {ArrayLike<Element>} opts 全部 `.el-select-dropdown__item`
     */
    function scrollOptionIntoView(opts) {
      try {
        for (var i = 0; i < opts.length; i++) {
          if (!visible(opts[i])) continue;
          var wrap = opts[i].closest ? opts[i].closest(".el-scrollbar__wrap") : null;
          if (!wrap) return;
          // 目標選項頂部相對容器頂部嘅距離（加返容器已滾動量）
          var delta = opts[i].getBoundingClientRect().top - wrap.getBoundingClientRect().top;
          wrap.scrollTop = wrap.scrollTop + delta;
          return;
        }
      } catch (e) {
        /* ignore */
      }
    }

    /**
     * 🔴🔴 2026-09-30（真機截圖＋DOM 教訓）：撳 `.el-select`／`input` **唔會開**呢個下拉。
     *
     * 用家實測（同一個 input，撳之前 vs 撳之後只有兩處分別）：
     *   1. 外層 `.el-input` 多咗 `is-focus`
     *   2. 箭頭 `.el-select__caret` 多咗 `is-reverse`（箭頭上→落，即係「已展開」）
     * ⇒ 下拉確實開咗。但**一個 `.el-select-dropdown__item` 都冇出現**
     * ⇒ 呢個 select 嘅選項係**未載入**（`el-option` 列表喺平台手上，
     *    要平台**自己**嘅 mousedown 處理器行完、或者遠端 API 返咗先有）。
     *
     * ⇒ 用 `.click()`（= mousedown + mouseup）造出嚟嘅係一個 Element-UI
     *    認唔到嘅合成事件（`mousedown` 淨係 `bubbles:true`，冇 `cancelable`／
     *    冇正確 `button`／`detail`、`isTrusted:false`）⇒ 平台 handler 冇跑
     *    ⇒ 「開咗但空」。所以**一定要行真實 pointer 序列**。
     *
     * @param {Element|null} el
     * @returns {boolean} 有冇成功派發
     */
    function realPointerPress(el) {
      if (!el) return false;
      var r;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        r = null;
      }
      var x = r && r.width ? r.left + r.width / 2 : 0;
      var y = r && r.height ? r.top + r.height / 2 : 0;
      var types = ["pointerdown", "mousedown", "mouseup", "click"];
      try {
        for (var i = 0; i < types.length; i++) {
          var T = types[i];
          var Ctor = window.PointerEvent && T.indexOf("pointer") === 0 ? window.PointerEvent : window.MouseEvent;
          var ev = new Ctor(T, {
            bubbles: true,
            cancelable: true, // 🔴 必加：Element-UI 好多 handler 會 preventDefault
            composed: true,
            view: window,
            detail: T === "click" || T === "mouseup" ? 1 : 0,
            button: 0,
            buttons: T === "mouseup" || T === "click" ? 0 : 1,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
          });
          el.dispatchEvent(ev);
        }
        return true;
      } catch (e2) {
        return false;
      }
    }

    /**
     * 一個候選下拉係咪「開咗」。
     *
     * 🔴 唔可以靠「有冇可見選項」判斷：真機係**開咗但列表未載入**（0 個選項），
     *    用「有冇選項」會被誤判成「冇開」⇒ 不停重試同一件事 ⇒ 永遠等唔到。
     * ⇒ 用 Element-UI 自己嘅展開標記（截圖＋DOM 雙重確認）：
     *    箭頭 `.el-select__caret` 帶 `is-reverse`，或外層 `.el-input` 帶 `is-focus`。
     *
     * @param {{wrap:Element, input:Element|null}} ctl
     * @returns {boolean}
     */
    function isPopperOpen(ctl) {
      if (!ctl || !ctl.wrap) return false;
      try {
        if (ctl.wrap.querySelector(".el-select__caret.is-reverse")) return true;
        var box = ctl.wrap.classList && ctl.wrap.classList.contains("el-input") ? ctl.wrap : ctl.wrap.querySelector(".el-input");
        if (box && box.classList && box.classList.contains("is-focus")) return true;
      } catch (e) {
        /* ignore */
      }
      return false;
    }

    /**
     * 試一個候選：用真實 pointer 序列開 → 輪流（開 Popper／按鍵盤）催選項 →
     * 中名就撳 → **回讀欄位值驗證**。
     *
     * 🔴 **靠反饋，唔靠估**：撳完如果呢個欄位嘅值冇變成目標商家名，
     *    就代表「呢個唔係商家欄位」⇒ 回 null，交畀下一個候選。
     *    咁樣就算評分排第一嗰個揀錯咗，都仲有得救。
     *
     * @param {object} ctl  候選（`storeSelectCandidates()` 嘅元素）
     * @param {number} budget 封頂重試次數（每次 ~150ms）
     * @param {boolean} isFirst 係咪評分最高嗰個（只用佢試鍵盤 fallback，
     *                          避免對每個候選亂派鍵盤事件）
     * @returns {Promise<object|null>} 成功就回結果；唔係商家欄位就回 null。
     */
    function tryOne(ctl, budget, isFirst) {
      // ── 開下拉：真實 pointer 序列（見 realPointerPress 註釋）────────────
      // 🔴 次序好緊要：`.el-select` 外層喺 Element-UI 係「click 即 toggle」，
      //    而 `input` 係「mousedown 開、click 唔 toggle」。
      //    如果撳完 input 再撳 wrap，就會即刻被 toggle 返收埋。
      //    ⇒ 只派一次：多選型（有 tags 或外面係 div）撳 wrap；單選盒撳 input。
      var hammered = 0; // 派咗幾多次 pointer 序列（最多 2 次：一次開、一次重開）
      var boxed = ctl.wrap && ctl.wrap.classList && ctl.wrap.classList.contains("el-input");
      var pressEl = ctl.hasTags || !boxed ? ctl.wrap : ctl.input || ctl.wrap;
      realPointerPress(pressEl);
      hammered++;

      var t = 0;
      function poll() {
        t++;
        var opts = document.querySelectorAll(".el-select-dropdown__item");
        var visCount = 0;
        for (var z = 0; z < opts.length; z++) if (visible(opts[z])) visCount++;
        // 🔴🔴 2026-09-30：改用 pickStoreOption —— 歸一化比對 ＋ 評分揀最啱，
        //    解決「全角括號／空格令完全相等失敗」同「3 間相似分店揀錯」兩個坑。
        var target = pickStoreOption(opts, name);
        if (target) {
          try {
            realPointerPress(target) || target.click();
          } catch (e) {
            return Promise.resolve({ ok: false, reason: "揀商家失敗：" + ((e && e.message) || e) });
          }
          return sleep(200).then(function () {
            var now = storeSelectedText(ctl);
            var nNow = normStoreName(now);
            if (nNow === nName || (nNow && nNow.indexOf(nName) >= 0)) return { ok: true, value: now };
            // 撳咗但呢個欄位冇變 ⇒ 呢個唔係商家欄位 ⇒ 試下一個候選
            tried.push({ hasTags: !!ctl.hasTags, visibleOptions: visCount, matched: false });
            return null;
          });
        }

        // ── 呢個候選嘅「催選項」策略 ────────────────────────────────
        // 真機係「開咗但 0 個選項」⇒ 唔可以死等，要主動催。
        var open = isPopperOpen(ctl);
        if (isFirst && visCount === 0 && open && t % 3 === 1) {
          // ① 鍵盤 fallback：派 ArrowDown（Element-UI 會 scrollIntoView 第一個選項，
          //    逼 Vue 真係 render 出列表）。⚠️ 只對評分最高嗰個用，
          //    免得每個候選都食到方向鍵而影響平台狀態。
          dispatchKey(ctl.input || ctl.wrap, "ArrowDown", 40);
        } else if (visCount === 0 && open && t % 3 === 2 && hammered < 2) {
          // ② 仲係 0 個選項：可能個 toggle 被自己嘅 click 抵銷咗（上面提過嘅次序坑）
          //    ⇒ 用 wrap 重開一次，並且**唔再**補 input click。
          hammered++;
          realPointerPress(ctl.wrap);
        } else if (visCount === 0 && open && t % 3 === 0) {
          // ③ 最後手段：真 keyboard event（isTrusted:false 但 Element-UI 照收）。
          scrollOptionIntoView(document.querySelectorAll(".el-select-dropdown__item"));
        }

        if (t >= budget) {
          tried.push({
            hasTags: !!ctl.hasTags,
            visibleOptions: visCount,
            matched: false,
            opened: !!open,
            presses: hammered,
          });
          return Promise.resolve(null);
        }
        return sleep(150).then(poll);
      }
      return sleep(120).then(poll);
    }

    function next(i) {
      if (i >= cands.length) {
        // 全部候選都試過 → 如實報告（帶診斷，唔好斷言未驗證嘅事）
        var total = 0;
        for (var z = 0; z < tried.length; z++) total += tried[z].visibleOptions || 0;
        var msg;
        if (!total) {
          msg =
            '撳咗商家下拉但一個可見選項都冇（試咗 ' +
            tried.length +
            ' 個候選下拉；下拉可能冇開，或商家列表係遠端搜尋未返）';
        } else {
          msg = '下拉有 ' + total + ' 個可見選項但都唔係「' + name + "」（請確認名稱同後台一致）";
        }
        return Promise.resolve({ ok: false, reason: msg, tried: tried });
      }
      // 🔴 每試一個候選之前，先睇吓佢係咪**已經**揀啱。
      //    （上一個候選可能誤打誤撞撳中咗啱嘅選項 ⇒ 唔使再撳多一次。）
      var al = alreadyOn(cands[i]);
      if (al) return Promise.resolve({ ok: true, already: true, value: al });

      // 🔴 排第一（分數最高）嗰個畀足舊有嘅 ~1620ms 預算（遠端搜尋要時間）；
      //    其餘候選只係「評分可能揀錯」嘅補救 ⇒ 短啲，唔好拖慢成個同步。
      return tryOne(cands[i], i === 0 ? 10 : 6).then(function (r) {
        if (r) return r;
        closePopper(); // 收返可能開咗嘅 popper，唔好留低影響下一個候選
        return next(i + 1);
      });
    }

    return next(0);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ①b 🔴🔴 「每頁筆數」自動拉到最大 ＋ 逐頁搭便車（2026-09-28 第十六次）
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
   * 🔴 認法要**兩個訊號聯集**，淨靠一個會斷（DOMDUMP 實證）：
   *   · 訊號 A：input 值係「N項/頁」（DOMDUMP：`inputValue:"20項/頁"`）
   *   · 訊號 B：個 select 喺 `.el-pagination__sizes` 入面
   * 平台改字眼（「項」→「條」）或者 input 讀唔到值，另一個訊號都頂到。
   *
   * 🔴 一定要**排除多選型**（`.el-select__tags`）：嗰個係商家選擇器，
   *    撳落去會彈一串商家名，再揀「看似數字」嘅嘢 ⇒ 靜默揀錯商家。
   *
   * 🔴 若明細係**彈窗**（`.el-dialog`）入面，只撳彈窗入面嗰個 ——
   *    唔好去郁帳期列表嗰個分頁器（會令列表重新渲染，行引用失效）。
   *
   * @returns {Array<{wrap:Element, input:Element|null, current:number|null, inPagination:boolean, top:number}>}
   */
  function findPageSizeControls() {
    var wraps = document.querySelectorAll(".el-select");
    var out = [];
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      if (!visible(w)) continue;
      // 多選型（商家）＝ 一定唔係每頁筆數
      if (w.querySelector(".el-select__tags")) continue;
      // 表格行內下拉唔係分頁器
      if (w.closest(".el-table__row, tbody")) continue;

      var input = w.querySelector("input.el-input__inner, input");
      var n = parsePageSizeText(trimmed(input ? input.value : ""));
      var inPagination = !!(w.closest && w.closest(".el-pagination"));
      var inSizes = !!(w.closest && w.closest(".el-pagination__sizes"));

      if (n == null && !inSizes && !inPagination) continue;
      if (inPagination && !inSizes && n == null) continue; // 分頁器入面其他下拉

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
    // 彈窗內優先（明細表一定喺彈窗／抽屜入面）
    var inDialog = [];
    for (var d = 0; d < out.length; d++) {
      if (out[d].inDialog) inDialog.push(out[d]);
    }
    if (inDialog.length) out = inDialog;
    // 同級：越落越優先（分頁器喺表格下面）
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
   *
   * @returns {Promise<{ok:boolean, already?:boolean, value?:number|null, from?:number|null, reason?:string}>}
   */
  function setOnePageSize(ctl, target, cap) {
    if (!ctl || !ctl.wrap) {
      return Promise.resolve({ ok: false, reason: "冇「每頁筆數」下拉" });
    }
    // 已經夠大（實測預設 20，目標 50）→ 唔好再開合，免得多餘請求同延遲
    if (ctl.current != null && ctl.current >= target) {
      return Promise.resolve({ ok: true, already: true, value: ctl.current });
    }

    // 開下拉：撳 `.el-select` 容器（同 `setStore` 一致，撳 input 唔穩）
    try {
      ctl.wrap.click();
      if (ctl.input) ctl.input.click();
    } catch (e) {
      /* 繼續試搵選項 */
    }

    // 等開合動畫（transform: scaleY(0)→scaleY(1)），再逐次重試。
    // 🔴 唔可以開完即刻 query：動畫期間量到 0×0（同 `setStore` 同一個坑）。
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
        if (n > cap) continue; // 唔搏超大 pageSize（閘道會拒）
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
   * 把所有（明細）「每頁筆數」下拉撳到最大 —— 立即對帳**自己**幫使用者撳。
   *
   * 🔴 為什麼要呢一步（使用者原話）：
   *     「拿不到 32 條是因為 paging 我沒選到 50一頁，
   *      但是當我用立即對帳，應該是你也要幫忙按到才行。」
   *
   *     ⇒ 唔可以再靠「使用者自己先揀好 50一頁」，亦唔可以靠重放
   *       （重放係 CORS 死路，見第十五次真機）。
   *     ⇒ 撳完，平台**自己**會用新 pageSize 再發一次請求，我哋抄就完。
   *
   * @returns {Promise<{ok:boolean, controls?:number, target?:number, results?:Array, reason?:string}>}
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
        reason:
          "搵唔到「每頁筆數」下拉（未見 N項/頁）｜可能明細彈窗未開，或平台改咗版。",
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
          reason: anyOk
            ? null
            : "搵到 " + ctls.length + " 個「每頁筆數」下拉但全部改唔到",
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

  /**
   * 撳「下一頁」。
   *
   * @returns {{ok:boolean, done?:boolean, reason?:string}} `done:true` ＝ 已到最後一頁
   */
  function clickPaginationNext() {
    var btns = document.querySelectorAll(
      ".el-pagination .btn-next, .el-pagination button.btn-next",
    );
    var pick = null;
    for (var i = 0; i < btns.length; i++) {
      if (!visible(btns[i])) continue;
      // 明細彈窗內優先
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
   *
   * @returns {Promise<{ok:boolean, rows:number, total:number|null, pages:number, complete:boolean, reason?:string}>}
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
      // 🔴 序號一定要喺**撳之前**記低（撳完再記會錯過即刻到嘅回應）
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
  //  ② 按「查詢」
  // ══════════════════════════════════════════════════════════════════

  /**
   * 按「查詢」（唔係「重置」）。
   *
   * 🔴 一定要優先揀 `el-button--primary`：「查詢」同「重置」通常並排，
   *    單靠文字容易撳錯（同 aomi-bridge 嘅 findQueryButton 同一個防護）。
   */
  function clickQuery() {
    // 第一優先：精確文字「查詢」＋ primary
    var nodes = document.querySelectorAll("button.el-button, .el-button");
    var fallback = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var txt = trimmed(el.textContent).replace(/\s+/g, "");
      if (txt !== "查詢" && txt !== "查询") continue;
      if (!visible(el)) continue;
      if (/el-button--primary/.test(el.className || "")) {
        try {
          el.click();
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: "撳查詢失敗：" + ((e && e.message) || e) };
        }
      }
      if (!fallback) fallback = el;
    }
    if (fallback) {
      try {
        fallback.click();
        return { ok: true, fallback: true };
      } catch (e) {
        return { ok: false, reason: "撳查詢失敗：" + ((e && e.message) || e) };
      }
    }
    return { ok: false, reason: "找不到「查詢」按鈕" };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ③ 揀帳期 → 查看詳情
  // ══════════════════════════════════════════════════════════════════

  /** 由帳期列表列，抽出佢嘅帳期文字（`2026-09-16 ~ 2026-09-30` 之類）。 */
  function rowPeriodText(row) {
    var m = String(row.textContent || "").match(
      /(\d{4}-\d{2}-\d{2})\s*[~～\-至]\s*(\d{4}-\d{2}-\d{2})/,
    );
    return m ? m[1] + " ~ " + m[2] : "";
  }

  /**
   * 把「目標日期」映射到帳期列。
   *
   * 命中規則：目標日期（`YYYY-MM-DD`）落喺 `start ~ end` 區間內。
   * `targetDate` 空 → 揀**最上面嗰列**（通常是最近帳期）作為 fallback。
   *
   * @returns {{row:Element, period:string}|null}
   */
  function findPeriodRow(targetDate) {
    var rows = document.querySelectorAll(
      ".el-table__row, tbody tr, .el-table__body tr, [class*='table'] tr",
    );
    var first = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!visible(row)) continue;
      var period = rowPeriodText(row);
      if (!period) continue;
      if (!first) first = { row: row, period: period };
      if (!targetDate) continue;

      var parts = period.split(" ~ ");
      if (parts.length !== 2) continue;
      // 純字串比較（`YYYY-MM-DD` 字典序等於時間序）—— 唔使 Date 物件，避時區。
      if (targetDate >= parts[0] && targetDate <= parts[1]) {
        return { row: row, period: period };
      }
    }
    return targetDate ? null : first;
  }

  /** 撳一列入面嘅「查看詳情」。 */
  function clickDetailInRow(row) {
    var el = findByText(/查看詳情|查看明细|詳情|明细/, { root: row, maxLen: 8 });
    if (!el) return { ok: false, reason: "呢一列冇「查看詳情」按鈕" };
    try {
      el.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "撳「查看詳情」失敗：" + ((e && e.message) || e) };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  ③b 🔴🔴🔴 直接由「帳期列表回應」抽實收金額（零重放）
  // ══════════════════════════════════════════════════════════════════
  //
  //  為什麼要有這一節（2026-09-28 第七次真機，使用者點醒）：
  //
  //    使用者原話：「我打開頁面後, 就看到所有的訂單, 然後每一條 record
  //    在介面上都已經有多少金額. 為什麼你就能不到?」
  //
  //    佢係**完全正確**嘅。真機 DOMDUMP 已證：
  //      POST .../summarys/summary/_list    ← 平台開頁時**自己就發咗**
  //      回應 result[0] 已經有齊：
  //        .id                       = 帳期 id
  //        .subsidyStoreReceiveAmtn  = 實收（補貼後，平台口徑）← 就係我要嘅嘢
  //        .storeReceiveAmtn         = 實收（補貼前）
  //        .platformServiceFee       = 平台服務費
  //        .details[].subsidyStoreReceiveAmtn = 每日明細（同樣有）
  //
  //    ⇒ 根本**唔需要**重放任何請求。之前兜嘅五大圈（regex → 多請求累積 →
  //      巢狀撈 id → `weekId` → `startDateStr` → 六條 resolve 路 → POST →
  //      host → 簽章）全部都係「為咗重放」，而重放本身就係多餘嘅。
  //
  //  ⚠️ 口徑紀律：實收**只認**平台自己嗰個欄位（`subsidyStoreReceiveAmtn`），
  //    唔可以喺我哋側自行用公式拼 —— 拼錯就會「有值但錯」（最難察覺）。
  //    公式只作 fallback，而且要明確標示 `via`。

  /** 實收金額候選欄位（**按平台口徑排序**：補貼後 > 補貼前 > 其他）。 */
  var RECEIVE_KEYS = [
    "subsidyStoreReceiveAmtn", // 🔴 首選：實收（含補貼，平台顯示口徑）
    "subsidyStoreReceiveAmt",
    "subsidyStoreReceiveAmount",
    "storeReceiveAmtn", // 次選：實收（補貼前）
    "storeReceiveAmt",
    "storeReceiveAmount",
    "receiveAmtn",
    "settleAmtn",
    "settleAmount",
  ];

  /** 應收／營業額候選欄位。 */
  var SHOULD_KEYS = [
    "storeBusinessAmtn",
    "storeBusinessAmt",
    "businessAmtn",
    "orderAmtn",
    "orderAmount",
    "totalAmtn",
    "shouldReceiveAmtn",
  ];

  /** 服務費候選欄位。 */
  var FEE_KEYS = [
    "platformServiceFee",
    "platformServiceFeeAmtn",
    "serviceFee",
    "serviceFeeAmtn",
    "platformFee",
  ];

  /** 由物件取第一個「係有限數字」嘅候選欄位。 */
  function pickNumber(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v == null || v === "") continue;
      var n = Number(v);
      if (isFinite(n)) return n;
    }
    return null;
  }

  /**
   * 由一個帳期 raw 物件抽「實收金額」。
   *
   * @returns {{receive:number|null, subsidy:number|null, should:number|null, fee:number|null, receiveKey:string|null, via:string}}
   *
   * ⚠️ 口徑：`receive` 同 `subsidy` **喺呢度係同一個數**
   *    —— 因為 `RECEIVE_KEYS` 首位已經係補貼後嘅 `subsidyStoreReceiveAmtn`。
   *    兩個 key 都出係為咗同 POS 側對齊：POS 嘅 `periodPayout()` 係
   *    「有 subsidy 用 subsidy，否則落返 receive」，如果只出 receive，
   *    POS 會當「冇補貼」而用補貼前數字（偏多）。
   *    ⇒ 一齊出，令 POS 取到嘅一定係平台顯示嗰個實收。
   */
  function amountsOfRaw(raw) {
    var out = { receive: null, subsidy: null, should: null, fee: null, receiveKey: null, via: "none" };
    if (!raw || typeof raw !== "object") return out;

    // ① 平台口徑欄位（最可靠）
    var rk = null;
    for (var i = 0; i < RECEIVE_KEYS.length; i++) {
      var v = raw[RECEIVE_KEYS[i]];
      if (v == null || v === "") continue;
      var n = Number(v);
      if (isFinite(n)) {
        out.receive = n;
        rk = RECEIVE_KEYS[i];
        break;
      }
    }
    out.receiveKey = rk;
    // 補貼後欄位**獨立**再抽一次（唔靠上面 loop 係唔係命中 subsidy*，
    // 因為 fallback 公式路徑都要有值）。
    out.subsidy = pickNumber(raw, ["subsidyStoreReceiveAmtn", "subsidyStoreReceiveAmt", "subsidyStoreReceiveAmount"]);
    out.should = pickNumber(raw, SHOULD_KEYS);
    out.fee = pickNumber(raw, FEE_KEYS);
    if (rk) {
      out.via = "list-field";
      // 平台只回補貼前（冇 subsidy* 欄位）→ 用補貼前補齊，
      // 令 POS 唔會因為「subsidy 缺失」而退回一個唔存在嘅口徑。
      if (out.subsidy == null) out.subsidy = out.receive;
      return out;
    }

    // ② fallback：平台欄位唔見咗（改咗名）⇒ 用已驗算嘅公式拼。
    //    公式（真機驗算命中）：
    //      storeReceiveAmtn        = storeBusinessAmtn − platformServiceFee − disMerchantDeliveryFee
    //      subsidyStoreReceiveAmtn = storeReceiveAmtn + deliverySubsidyAmtn − activitySubsidyAmtn
    var biz = pickNumber(raw, SHOULD_KEYS);
    var fee = pickNumber(raw, FEE_KEYS);
    var disMerch = pickNumber(raw, ["disMerchantDeliveryFee", "merchantDeliveryFee"]);
    if (biz != null) {
      var sr = biz - (fee || 0) - (disMerch || 0);
      var subDelivery = pickNumber(raw, ["deliverySubsidyAmtn", "deliverySubsidyAmt"]);
      var activity = pickNumber(raw, ["activitySubsidyAmtn", "activitySubsidyAmt"]);
      if (subDelivery != null || activity != null) {
        sr = sr + (subDelivery || 0) - (activity || 0);
      }
      out.receive = Math.round(sr * 100) / 100;
      out.subsidy = out.receive;
      out.via = "formula";
    }
    return out;
  }

  /**
   * 由帳期列表事件，搵出「目標帳期」嘅 raw 物件。
   *
   * 配對次序（由強到弱）：
   *   ① 帳期文字全等
   *   ② 目標日期落喺區間內
   *   ③ 只有一個帳期 **而且** 完全冇任何日期／文字線索 → 直接用
   *
   * 🔴🔴 2026-09-28 第七次真機（被測試 [37] 捉到嘅真 bug）：
   *    舊寫法嘅 ③ 係「`periods.length === 1` 就無條件用嗰個帳期」。
   *    但**目標日期明明唔喺佢區間**時，咁做就會回一個**屬於其他帳期嘅實收** ——
   *    金額有值、睇落正常，但係**錯嘅帳期**。呢種「有值但錯」最難察覺，
   *    亦正係使用者最介意嘅失敗模式。
   *    ⇒ 修正：③ 只可以喺「**冇任何線索可判斷**」（既冇目標日期、
   *      又冇帳期文字可比）時才啟用；只要有目標日期，就一定要落到區間內。
   *
   * @param {string} periodText `2026-09-16 ~ 2026-09-30`
   * @param {string} [targetDate] `YYYY-MM-DD`
   * @returns {object|null}
   */
  function matchPeriodRaw(periodText, targetDate) {
    var ev = financeEvents.finance_periods;
    var periods = ev && ev.periods;
    if (!Array.isArray(periods) || !periods.length) return null;

    var want = normalizePeriod(periodText);
    var i, cand;
    // ① 文字全等
    if (want) {
      for (i = 0; i < periods.length; i++) {
        var p = periods[i];
        if (!p || !p.raw) continue;
        cand = periodTextOfRaw(p.raw);
        if (cand && normalizePeriod(cand) === want) return p.raw;
      }
    }
    // ② 日期區間命中
    var d = targetDate || null;
    if (!d && periodText) {
      var pm = /(\d{4}-\d{2}-\d{2})/.exec(String(periodText));
      if (pm) d = pm[1];
    }
    if (d) {
      var hit = pickPeriodByDate(periods, d);
      if (hit) return hit.raw;
      // 🔴 有目標日期但冇任何帳期涵蓋佢 ⇒ **硬失敗**，唔可以退去 ③
      //    （否則就會攞到其他帳期嘅金額 = 有值但錯）
      return null;
    }
    // ③ 完全冇日期線索（呼叫者亦冇提供帳期文字）⇒ 只有一個帳期時才可直接用
    if (!want && periods.length === 1 && periods[0] && periods[0].raw) {
      return periods[0].raw;
    }
    return null;
  }

  /**
   * 🔴 直接由攔截到嘅「帳期列表回應」取實收金額（**唔發任何請求**）。
   *
   * @returns {{
   *   ok:boolean, receive:number|null, should:number|null, fee:number|null,
   *   summaryId:string|null, period:string|null, details:Array, via:string, reason?:string
   * }}
   */
  function readAmountsFromListEvent(periodText, targetDate) {
    var raw = matchPeriodRaw(periodText, targetDate);
    if (!raw) {
      return {
        ok: false,
        receive: null,
        should: null,
        fee: null,
        summaryId: null,
        period: null,
        details: [],
        via: "none",
        reason:
          "帳期列表回應未有對應嘅帳期（可能未按「查詢」，或該帳期未生成）",
      };
    }
    var amt = amountsOfRaw(raw);
    // 摘要列（帳期層）已經有每日明細，順手帶埋出去（供 POS 逐日核對）
    var details = Array.isArray(raw.details) ? raw.details : [];
    var did = raw.id != null ? String(raw.id) : null;
    if (!did) {
      var deep = deepIdOf(raw);
      if (deep) did = deep;
    }
    return {
      ok: amt.receive != null,
      receive: amt.receive,
      subsidy: amt.subsidy,
      should: amt.should,
      fee: amt.fee,
      summaryId: did,
      period: periodTextOfRaw(raw) || periodText || null,
      details: details,
      via: amt.via,
      receiveKey: amt.receiveKey,
      reason: amt.receive != null ? null : "列表回應內搵唔到實收金額欄位",
    };
  }

  /** 由 raw 物件深度撈帳期 id（兜底；同 MAIN world 嘅 deepFindSummaryId 同源）。 */
  function deepIdOf(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 3) return null;
    var direct = node.id != null ? node.id : node.summaryId != null ? node.summaryId : null;
    if (direct != null && String(direct) !== "") return String(direct);
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      if (/summary|period|bill|^week_?id$/i.test(keys[i]) && typeof node[keys[i]] !== "object") {
        var v = node[keys[i]];
        if (v != null && String(v) !== "") return String(v);
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  ④ 呼叫 `_get-order-summary-list`（含翻頁）—— 已降級為 fallback
  // ══════════════════════════════════════════════════════════════════

  /**
   * 由 DOM 嘗試撈「summaryId」。
   *
   * 🔴 **2026-09-28 真機實測：呢條路已經冇用。**
   *    財務頁係 Vue 3，`__vue__` 完全唔存在（vueProbe 全 false），
   *    列上只有 `class` 屬性。所以呢個函式**唔會**回傳任何嘢。
   *    刻意保留為「最後防線」但唔再當主力 ——
   *    真正嘅來源係網絡攔截（見 `resolveSummaryId`）。
   *
   * 保留原因：若平台日後改回 Vue 2（或 Element-UI 舊版會掛 `__vue__`），
   * 呢條路會自動生效，唔使再改一次。加上 `data-*` 屬性探測（成本極低）。
   */
  function extractSummaryIdFromDom(row) {
    // ① `data-*`（部分 Element-UI 版本會把 row id 掛上去）
    try {
      var el = row;
      for (var d = 0; el && d < 6; d++, el = el.parentElement) {
        var ds = el.dataset || {};
        var cand = ds.id || ds.summaryId || ds.summaryid || ds.rowId || ds.rowid || ds.rowKey;
        if (cand) return String(cand);
      }
    } catch (e) {
      /* 落下一條路 */
    }
    // ② Vue 2 殘留（`__vue__`）—— 現時通常唔存在
    try {
      var n = row;
      for (var depth = 0; n && depth < 6; depth++) {
        var vue = n.__vue__;
        if (vue) {
          var candidates = [vue.row, vue.data, vue.scope && vue.scope.row];
          for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c && (c.id || c.summaryId || c.pk)) {
              return String(c.id || c.summaryId || c.pk);
            }
          }
        }
        n = n.parentElement;
      }
    } catch (e) {
      /* 冇就冇 */
    }
    return null;
  }

  /**
   * 撈出「summaryId」—— 按可靠度排序，三條路：
   *
   *   ① **網絡攔截**（主力）：按「查看詳情」後，平台自己會打
   *      `_get-order-summary-list`，`summaryId` 就喺嗰個請求上面。
   *      `mfood-inject.js` 抄低並 post 過嚟 ⇒ 完全唔靠 Vue。
   *
   *   ② **問 MAIN world 上次嘅請求**：若「查看詳情」係我哋啱啱撳嘅，
   *      事件可能已經到咗，直接攞（唔使再等）。
   *
   *   ③ **帳期列表回應配對**：平台查詢帳期時會打 `summary/_list`，
   *      回應內每個帳期都有 id。用**帳期文字**同目標列配對。
   *      （覆蓋「詳情彈窗已開過、唔再發新請求」嘅情況。）
   *
   *   ④ **DOM 探測**（最後防線）。
   *
   * ⚠️ 四條都唔得 ＝ **硬失敗**（唔可以亂猜 id，配錯帳期 = 實收全錯）。
   *
   * @param {Element} row 目標帳期列
   * @param {string} periodText 該列嘅帳期文字（`2026-09-16 ~ 2026-09-30`）
   * @param {string} [targetDate] 目標日期（`YYYY-MM-DD`）—— 供「區間命中」配對兜底
   * @param {{allowStaleAsk?: boolean}} [opts] `allowStaleAsk:false` ＝ 唔好用
   *   MAIN world「上一次請求」嘅 id（多帳期走訪時會配錯，見 `runOnePeriod`）
   * @returns {Promise<{id:string|null, via:string}>}
   */
  function resolveSummaryId(row, periodText, targetDate, opts) {
    var allowStaleAsk = !(opts && opts.allowStaleAsk === false);
    // 🔴 2026-09-28 第三次真機：由 `periodText` 抽出目標日期區間（若呼叫者冇傳）。
    //    帳期文字格式係 `YYYY-MM-DD ~ YYYY-MM-DD` ⇒ 可直接當區間用。
    var targetDateInPeriods = targetDate || null;
    if (!targetDateInPeriods && periodText) {
      var pm = /(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(periodText);
      if (pm) targetDateInPeriods = pm[1]; // 用起始日去比對帳期區間
    }
    // ① 掃「本輪撳查看詳情後收到嘅所有財務請求」—— 逐個搵帶 id 嘅。
    //    🔴 一定要掃全部（唔止最後一個、唔止 kind==='detail'）：
    //       真機撳一次會發多個請求，帶 id 嘅可能係 `_get-order-summary-data`
    //       而唔係 `_get-order-summary-list`。順序：detail 優先，其次任何 kind。
    var ordered = [];
    for (var ri = 0; ri < financeRequests.length; ri++) {
      if (financeRequests[ri] && financeRequests[ri].summaryId) ordered.push(financeRequests[ri]);
    }
    ordered.sort(function (a, b) {
      var ad = a.kind === "detail" ? 0 : 1;
      var bd = b.kind === "detail" ? 0 : 1;
      return ad - bd;
    });
    if (ordered.length) {
      return Promise.resolve({ id: String(ordered[0].summaryId), via: "network-event" });
    }
    // 兼容：單一事件欄位（舊路徑）
    if (financeEvents.finance_request && financeEvents.finance_request.summaryId) {
      return Promise.resolve({
        id: String(financeEvents.finance_request.summaryId),
        via: "network-event",
      });
    }

    // ② 主動問 MAIN world「最近有冇 detail 請求」（同步、快）
    //
    //    🔴🔴🔴 第十七次真機：**冇新請求時唔可以問**。
    //    多帳期走訪時，每個帳期開始前都會 `clearFinanceEvents()`；
    //    若呢個帳期撳完「查看詳情」平台**冇發新請求**（常見：彈窗已快取、
    //    或者平台唔再俾舊帳期），MAIN world 嗰個「上一次請求」就一定係
    //    **上一個帳期**嘅 ⇒ 兩個帳期共用同一個 summaryId
    //    ⇒ 明細抄錯帳期（金額「有值但錯」，最難察覺嗰種）。
    //    ⇒ 呢種情況只可以用「帳期列表配對」（`periods-map`）呢啲**確定**來源。
    if (!allowStaleAsk) return Promise.resolve(afterAsk(null));
    return askLastFinanceRequest(1200).then(afterAsk);

    function afterAsk(r) {
      if (r && r.summaryId) {
        return { id: String(r.summaryId), via: "network-ask" };
      }

      // ③ 由帳期列表回應配對（用帳期文字）
      var periods = financeEvents.finance_periods && financeEvents.finance_periods.periods;
      if (Array.isArray(periods) && periods.length) {
        var want = normalizePeriod(periodText);
        for (var i = 0; i < periods.length; i++) {
          var p = periods[i];
          if (!p || !p.raw) continue;
          // 每個 raw item 都可能用唔同欄位名放帳期文字，逐個試
          var cand =
            periodTextOfRaw(p.raw) ||
            (p.raw.startDate && p.raw.endDate
              ? p.raw.startDate + " ~ " + p.raw.endDate
              : "");
          if (cand && normalizePeriod(cand) === want) {
            // 🔴🔴 第十七次真機：**冇 id 就唔可以交 `String(null)`**。
            //    `String(null)` === `"null"`（truthy！）⇒ 上層當成功，
            //    之後用 `"null"` 做 weekId 去重放 ⇒ 平台一定拒，
            //    而錯誤訊息只會話「重放失敗」，根本睇唔出係 id 係個假字串。
            if (p.id) return { id: String(p.id), via: "periods-map" };
          }
        }
        // 🔴 2026-09-28 第三次真機：就算文字配對失敗（平台改欄位名／格式），
        //    只要**目標日期區間**落喺某個帳期內，就用佢嘅 id —— 唔靠文字全等。
        if (targetDateInPeriods) {
          var hit = pickPeriodByDate(periods, targetDateInPeriods);
          if (hit && hit.id) return { id: String(hit.id), via: "periods-date" };
        }
        // 帳期只有一個 → 直接用（唔會配錯）
        if (periods.length === 1 && periods[0].id) {
          return { id: String(periods[0].id), via: "periods-only" };
        }
      }

      // ③b 🔴 2026-09-28 第三次真機：若帳期列表**解析唔出**（count=0）
      //     但今次查詢嘅列表請求 body 有 `weekId` ⇒ 佢就係帳期 id。
      //     ⚠️ 只在「完全冇其他線索」時用（排喺 periods 之後、DOM 之前），
      //        而且必須係**今次查詢**見過嘅（`lastListWeekId` 於按查詢時更新）。
      if (lastListWeekId) {
        return { id: String(lastListWeekId), via: "list-week-id" };
      }

      // ④ 最後防線：DOM
      var dom = extractSummaryIdFromDom(row);
      if (dom) return { id: dom, via: "dom" };
      return { id: null, via: "none" };
    }
  }

  /** 帳期文字正規化（去空白、統一 `~`），方便配對。 */
  function normalizePeriod(s) {
    return String(s || "")
      .replace(/\s+/g, "")
      .replace(/[～\-至]/g, "~");
  }

  /**
   * 由帳期 raw item 撈出帳期文字（嘗試多個常見欄位名）。
   *
   * 🔴 2026-09-28 第三次真機：`_list` 回應真實欄位係
   *    **`startDateStr` / `endDateStr`**（值 = `"2026-09-16"` / `"2026-09-30"`），
   *    而我哋一直只試 `period`/`summaryDate`/`startTime`（epoch）——
   *    所以 `periods-map` 配對永遠失敗（`periods.count=20` 但一個都對唔上）。
   *    ⇒ 加 `startDateStr`/`endDateStr`（同別名）。
   */
  function periodTextOfRaw(raw) {
    if (!raw || typeof raw !== "object") return "";
    // ① 單一欄位就係完整帳期文字（含完整日期）
    var keys = ["period", "summaryDate", "dateRange", "range", "settlePeriod", "periodText"];
    for (var i = 0; i < keys.length; i++) {
      var v = raw[keys[i]];
      if (typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v)) return v;
    }
    // ② 起迄分成兩個欄位 —— 真機用呢款
    //    `startDateStr`/`endDateStr`（字串）、`startDate`/`endDate`（字串）、
    //    `startTime`/`endTime`（epoch 毫秒）。
    var startStr = pickDateString(raw, [
      "startDateStr",
      "startDate",
      "beginDate",
      "periodStart",
      "startDay",
    ]);
    var endStr = pickDateString(raw, [
      "endDateStr",
      "endDate",
      "finishDate",
      "periodEnd",
      "endDay",
    ]);
    if (startStr && endStr) return startStr + " ~ " + endStr;
    if (startStr) return startStr;
    // ③ epoch 毫秒兜底
    if (raw.startTime && raw.endTime && isFinite(Number(raw.startTime))) {
      return epochToDay(raw.startTime) + " ~ " + epochToDay(raw.endTime);
    }
    return "";
  }

  /** 由多個候選欄位名，取第一個似 `YYYY-MM-DD` 嘅字串。 */
  function pickDateString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === "string") {
        var m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
        if (m) {
          return (
            m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0")
          );
        }
      }
    }
    return "";
  }

  /**
   * 由帳期列表，搵出「目標日期落喺佢區間內」嘅帳期。
   *
   * 用途：文字全等配對失敗時嘅兜底（平台改欄位名／格式）。
   * 用純字串比較（`YYYY-MM-DD` 字典序 = 時間序），唔使 Date 物件避時區。
   */
  function pickPeriodByDate(periods, targetDate) {
    for (var i = 0; i < periods.length; i++) {
      var p = periods[i];
      if (!p || !p.raw) continue;
      var s = pickDateString(p.raw, ["startDateStr", "startDate", "beginDate", "periodStart"]);
      var e = pickDateString(p.raw, ["endDateStr", "endDate", "finishDate", "periodEnd"]);
      if (!s && p.raw.startTime) s = epochToDay(p.raw.startTime);
      if (!e && p.raw.endTime) e = epochToDay(p.raw.endTime);
      if (s && e && targetDate >= s && targetDate <= e) return p;
    }
    return null;
  }

  /** epoch 毫秒 → `YYYY-MM-DD`（當地時間）。 */
  function epochToDay(ms) {
    var d = new Date(Number(ms));
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /**
   * 呼叫 `_get-order-summary-list` 拎一個帳期嘅全部 transaction（自動翻頁）。
   *
   * 🔴 2026-09-28 第四次真機：**一定要 POST + `weekId` 喺 body**（POST-only 路由）。
   *
   * 🔴🔴 2026-09-28 第五次真機：**host 都係「照抄真實請求」嘅一部分**。
   *    真機請求 host ＝ `management-api.mfoodapp.com`，
   *    但頁面 origin ＝ `merchant.mfoodapp.com` ⇒ 用後者會 **404**。
   *
   * 🔴🔴 2026-09-28 第六次真機：**重放要搬去 MAIN world，並且照抄簽章標頭**。
   *    詳見下方函式體註釋。
   *
   * @returns {Promise<{ok:boolean, transactions?:Array, pages?:number, reason?:string, status?:number, url?:string, requestBody?:string}>}
   */
  function fetchSummaryList(summaryId) {
    if (!summaryId) {
      return Promise.resolve({ ok: false, reason: "冇帳期 id，唔可以呼叫 transaction detail" });
    }

    // 🔴🔴 2026-09-28 第六次真機（`Failed to fetch` 真兇）：**重放改由 MAIN world 執行**。
    //
    //  症狀：v1.59 host 已改對（404 消失），但變成 `Failed to fetch`。
    //  真兇 ＝ mfood 同澳覓一樣用 **Alibaba 閘道簽章**（`x-ca-key` / `x-ca-nonce` /
    //  `x-ca-signature` / `x-ca-timestamp`）。冇簽章 ⇒ 閘道喺 HTTP 層之前就切斷連線
    //  ⇒ 瀏覽器只報 `Failed to fetch`（**唔會**回 401/403，因為根本冇 HTTP 回應）。
    //
    //  ⚠️ 呢個坑本專案**訂單流程當年已踩過一次**，症狀一字不差 ——
    //    見 `mfood-inject.js` 嘅 `replayDetail` 上方註釋：
    //    「那個請求沒有帶任何認證標頭，必定失敗（日誌顯示 Failed to fetch）」。
    //
    //  ⇒ 修法同訂單一樣：**喺 MAIN world 用攔截到嘅原始請求重放**（標頭照抄，
    //    簽章自然帶到）。bridge（isolated）唔可以自己組標頭，亦冇得算簽章。
    //
    //  ⚠️ 唔可以再喺呢度 fallback 去 isolated fetch —— 咁樣會靜默回一個
    //    「看似可行但必失敗」嘅結果，令下次更難查。要失敗就要**明確講清楚**。
    return replayListInMainWorld(summaryId).then(function (v) {
      if (!v) return { ok: false, reason: "MAIN world 回覆為空" };
      // 統一欄位名（下游 trace／POPUP 睇 `url`，MAIN world 回 `requestUrl`）
      return {
        ok: !!v.ok,
        transactions: v.transactions || [],
        pages: v.pages || null,
        total: v.total == null ? null : v.total,
        reason: v.reason || null,
        status: v.status == null ? null : v.status,
        url: v.requestUrl || null,
        requestBody: v.requestBody || null,
        headerKeys: v.headerKeys || null,
        hasSignature: typeof v.hasSignature === "boolean" ? v.hasSignature : null,
        // 🔴 2026-09-28 第八次真機：帶出實際用嘅 pageSize ＋ 降級次數
        //    —— 供 popup / log 驗證「有冇拿到最大 pageSize」。
        pageSize: v.pageSize == null ? null : v.pageSize,
        downgraded: v.downgraded || 0,
      };
    });
  }

  /**
   * 叫 MAIN world（`mfood-inject.js`）重放帳期明細請求，等佢回報結果。
   *
   * @param {string} summaryId 帳期 id（`weekId`）
   * @returns {Promise<{ok:boolean, transactions?:Array, pages?:number, total?:number, reason?:string, status?:number, requestUrl?:string, requestBody?:string, headerKeys?:string[], hasSignature?:boolean}>}
   */
  function replayListInMainWorld(summaryId) {
    var reqId = "frl-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

    // 只認**本次** reqId 嘅回覆（防上一輪殘留）。
    var p = new Promise(function (resolve) {
      var t = setTimeout(function () {
        var arr = financeWaiters["finance_replay_result"] || [];
        var idx = arr.indexOf(wrap);
        if (idx >= 0) arr.splice(idx, 1);
        resolve({
          ok: false,
          reason:
            "MAIN world 冇回應重放請求（可能未載入最新版 mfood-inject.js，請重新載入擴充功能）",
        });
      }, 15000);

      function wrap(v) {
        if (!v || v.reqId !== reqId) return; // 唔係呢一次，繼續等
        clearTimeout(t);
        var arr = financeWaiters["finance_replay_result"] || [];
        var idx = arr.indexOf(wrap);
        if (idx >= 0) arr.splice(idx, 1);
        resolve(v);
      }
      if (!financeWaiters["finance_replay_result"]) financeWaiters["finance_replay_result"] = [];
      financeWaiters["finance_replay_result"].push(wrap);
    });

    try {
      window.postMessage(
        { __mfoodCmd: true, cmd: "finance_replay_list", reqId: reqId, summaryId: String(summaryId) },
        window.location.origin,
      );
    } catch (e) {
      return Promise.resolve({ ok: false, reason: "postMessage 失敗：" + ((e && e.message) || e) });
    }

    return p;
  }

  // ══════════════════════════════════════════════════════════════════
  //  編排：四步一次過
  // ══════════════════════════════════════════════════════════════════

  /**
   * 跑完整四步。
   *
   * @param {{storeName?:string, targetDate?:string}} opts
   */
  // ══════════════════════════════════════════════════════════════════
  //  🔴🔴🔴 2026-09-29 第十七次真機（使用者要求）：一個頁面有**好多個帳期**
  //
  //  使用者原話：
  //    「其實你看到, 這個介面內, 是有超過一個的對帳日期時段,
  //      你要知道要找到不同的時段去拿到對應的帳, 就比如,
  //      我set 的時間是, 8月30日開始, 你就需要在頁面上找到 8月30日
  //      那個月的部份, 然後查看里面的數據, 然後一直拿, 拿到最新的一天.」
  //
  //  舊流程淨係揀「命中今日」嗰一個帳期（`findPeriodRow(targetDate)`），
  //  其餘帳期**完全冇抓** ⇒ POS 報表只會有一個帳期嘅數（靜默少一大截 ——
  //  同第十六次「每頁 20 筆」係同一類病：睇落有數，其實少咗）。
  //
  //  ✅ 新流程：
  //     ① 列出頁面上**全部**帳期列（`listPeriodRows`）
  //     ② 由使用者 set 嘅「開始日期」（8月30日）揀出要行嘅帳期：
  //        條件係「帳期結束日 >= 開始日」⇒ 開始日嗰個月嗰個會命中，
  //        之後每一個（一路到最新）都會行
  //     ③ 逐個帳期：撳「查看詳情」→ 撳每頁筆數 → 抄明細 → **閂彈窗** → 下一個
  //
  //  ⚠️ 次序死穴：**一定要閂彈窗先好撳下一列**。
  //     Element-UI 嘅 dialog 有 overlay，唔閂就撳唔到下面嘅列
  //     ⇒ 淨會攞到第一個帳期嘅數（又係「有值但少」）。
  //
  //  ⚠️ 第二個死穴：**每個帳期之間一定要清明細帳本**（`resetDetailCapture`）。
  //    `mergeDetailRows` 雖然會喺「summaryId 唔同」時自動清，
  //    但撈唔到 id 嘅情況無從判斷 ⇒ 唔主動清就會兩個帳期撈埋一齊
  //    ⇒ POS 寫入錯帳期（金額「有值但錯」，最難察覺）。
  // ══════════════════════════════════════════════════════════════════

  /** 一次同步最多行幾多個帳期（防頁面有幾十個帳期 ⇒ 跑幾個鐘）。 */
  var MAX_PERIODS = 12;

  /**
   * 列出頁面上**全部**帳期列。
   *
   * 順序 ＝ DOM 順序（平台一般係「新 → 舊」，即最新帳期喺最頂）。
   *
   * 🔴 一定要**去重**：Element-UI 嘅固定欄（`el-table__fixed`）會複製一份
   *    表格，同一個帳期會出現兩次 ⇒ 唔去重就抓兩次（重複推送、名冊被食）。
   *
   * @returns {Array<{row:Element, period:string, start:string|null, end:string|null}>}
   */
  function listPeriodRows() {
    var rows = document.querySelectorAll(
      ".el-table__row, tbody tr, .el-table__body tr, [class*='table'] tr",
    );
    var out = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!visible(row)) continue;
      var period = rowPeriodText(row);
      if (!period) continue;
      if (seen[period]) continue;
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
   * 揀出「今次要行」嘅帳期列。
   *
   * ① **有開始日期**（使用者 set 咗 8月30日）⇒ 由嗰個月**一路行到最新**：
   *    條件係 `帳期結束日 >= 開始日`（開始日嗰個月嗰個帳期會命中，
   *    之後每一個都要）。
   * ② **冇開始日期** ⇒ 只行「命中 `targetDate`」嗰一個（舊行為）。
   *
   *    為什麼冇開始日期就唔好自己掃全頁：使用者冇 set 日期代表冇要求
   *    「補歷史」，而每掃一個帳期都係 8~15 秒（撳彈窗＋逐頁抄），
   *    定時對帳（60 秒一輪）會**永遠追唔上** ⇒ 反而連最新嗰個都冇。
   */
  function pickPeriodTargets(opts) {
    opts = opts || {};
    var all = listPeriodRows();
    if (!all.length) {
      return { ok: false, targets: [], reason: "帳期列表係空（可能平台未結算）" };
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
      return {
        ok: true,
        walk: true,
        targets: picked,
        capped: capped,
        total: all.length,
      };
    }

    var hit = findPeriodRow(opts.targetDate);
    if (!hit) {
      return {
        ok: false,
        targets: [],
        reason: opts.targetDate
          ? "帳期列表冇涵蓋 " + opts.targetDate + " 嘅區間（可能帳期未生成）"
          : "帳期列表係空（可能平台未結算）",
      };
    }
    var hp = String(hit.period).split(" ~ ");
    return {
      ok: true,
      walk: false,
      targets: [{ row: hit.row, period: hit.period, start: hp[0] || null, end: hp[1] || null }],
    };
  }

  /** 搵而家開住嗰個彈窗（Element-UI dialog / drawer）。 */
  function findVisibleDialog() {
    var nodes = document.querySelectorAll(
      ".el-dialog__wrapper, .el-dialog, .el-drawer__wrapper, .el-drawer",
    );
    for (var i = 0; i < nodes.length; i++) {
      if (visible(nodes[i])) return nodes[i];
    }
    return null;
  }

  /** 等彈窗消失（poll）。 */
  function waitDialogGone(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 3000);
    function step() {
      if (!findVisibleDialog()) return Promise.resolve(true);
      if (Date.now() >= deadline) return Promise.resolve(false);
      return sleep(150).then(step);
    }
    return step();
  }

  /**
   * 閂咗明細彈窗 —— **每行完一個帳期一定要閂**。
   *
   * @returns {Promise<{ok:boolean, already?:boolean, closed?:boolean, reason?:string}>}
   */
  function closeDetailDialog() {
    var d = findVisibleDialog();
    if (!d) return Promise.resolve({ ok: true, already: true, closed: false });

    var btn = null;
    try {
      btn = d.querySelector(".el-dialog__headerbtn, .el-dialog__close, .el-drawer__close-btn");
    } catch (e) {
      btn = null;
    }
    if (!btn) btn = findByText(/^(關閉|关闭|取消|返回|×|✕)$/, { root: d, maxLen: 4 });
    if (!btn) return Promise.resolve({ ok: false, closed: false, reason: "搵唔到彈窗嘅關閉掣" });

    try {
      btn.click();
    } catch (e) {
      return Promise.resolve({
        ok: false,
        closed: false,
        reason: "撳關閉掣失敗：" + ((e && e.message) || e),
      });
    }
    return waitDialogGone(3000).then(function (gone) {
      return {
        ok: !!gone,
        closed: !!gone,
        reason: gone ? null : "撳咗關閉但彈窗仲喺度（平台動畫慢？）",
      };
    });
  }

  function runFinanceSync(opts) {
    opts = opts || {};
    if (!onFinancePage()) {
      return Promise.resolve({
        ok: false,
        reason: "呢個分頁唔係 mfood 財務對帳頁（finance/tackout-check），唔會亂撳",
      });
    }

    // 🔴 一輪新同步開始：清走上一輪殘留嘅「列表請求 id」——
    //    佢只可以由**今次**按「查詢」之後嘅請求更新，防止配錯帳期。
    lastListWeekId = null;
    // 🔴 同理：重放 host／路徑亦要係**今次**攔截到嘅（防跨輪殘留配錯端點）。
    //    若今次攔截到，`emitFinance` 會即刻覆寫返。
    lastReplayOrigin = null;
    lastReplayPath = null;

    // 🔴🔴 第十六次真機：明細列係**跨頁累積**嘅帳本（見 `mergeDetailRows`）。
    //    一輪新同步一定要由零開始，否則會撈埋上一輪／另一個帳期嘅列
    //    ⇒ POS 寫入錯帳期（金額「有值但錯」，最難察覺）。
    resetDetailCapture();

    var trace = [];
    // 🔴🔴🔴 第十七次真機：**每個帳期一份結果**。
    //    POS 要逐帳期寫（`pos_platform_settlements` 以帳期做 key），
    //    唔可以撈埋一個帳期 —— 撈埋就只剩一個帳期有數。
    var periodResults = [];
    var walkTargets = [];

    // ① 選商家
    return setStore(opts.storeName)
      .then(function (r) {
        trace.push({ step: "store", ok: r.ok, skipped: !!r.skipped, reason: r.reason || null });
        if (!r.ok) return { ok: false, reason: r.reason, step: "store", trace: trace };
        return sleep(300).then(step2);
      });

    function step2() {
      // ② 按查詢
      var q = clickQuery();
      trace.push({ step: "query", ok: q.ok, reason: q.reason || null });
      if (!q.ok) return { ok: false, reason: q.reason, step: "query", trace: trace };

      // 等列表請求回來（SPA；唔可以即刻查 DOM）
      return sleep(1800).then(step3);
    }

    /**
     * ③ 揀帳期 —— 🔴 第十七次真機：**可以揀多過一個**。
     *
     * 舊寫法 `findPeriodRow(targetDate)` 永遠只回一個 ⇒ 其餘帳期冇人抓。
     */
    function step3() {
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

    /** 逐個帳期行；行完**一定閂彈窗**先好去下一個。 */
    function walkPeriods(targets, i) {
      if (i >= targets.length) return Promise.resolve(finishAll());
      return runOnePeriod(targets[i], i).then(function (pr) {
        periodResults.push(pr);
        // 🔴 閂彈窗：唔閂就撳唔到下一列嘅「查看詳情」
        //    （Element-UI dialog 有 overlay）。
        return closeDetailDialog().then(function (c) {
          trace.push({
            step: "close-dialog",
            ok: !!c.ok,
            period: targets[i].period,
            periodIndex: i,
            already: !!c.already,
            reason: c.reason || null,
          });
          if (c.ok === false) {
            // 閂唔到 ⇒ 後面嘅帳期一定撳唔到 ⇒ 唔好再浪費時間逐個試
            trace.push({
              step: "walk-aborted",
              ok: false,
              period: targets[i].period,
              periodIndex: i,
              reason: "彈窗閂唔到，停止行之後嘅帳期（" + (c.reason || "未知") + "）",
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
     * 讀「某一個帳期」嘅帳期級金額（零重放）。
     *
     * 🔴 試兩次：先用主要日期線索（`targetDate`），再用帳期嘅開始日。
     *    原因：走訪多帳期時，`targetDate`（今日）通常**只落喺最新嗰個帳期**，
     *    用佢去讀「8月嗰個帳期」會配唔到 ⇒ 一定要用帳期自己嘅日期做保底。
     */
    function amountsForPeriod(target, dateHint) {
      var a = readAmountsFromListEvent(target.period, dateHint);
      if (!a.ok && target.start && target.start !== dateHint) {
        a = readAmountsFromListEvent(target.period, target.start);
      }
      return a;
    }

    /**
     * 行**一個**帳期：直讀金額 → 撳「查看詳情」→ 撳每頁筆數 → 逐頁抄明細。
     *
     * @returns {Promise<object>} 帳期結果（**失敗都回一份**，
     *   等上層可以繼續行下一個帳期，唔好一個失敗就冇晒）。
     */
    function runOnePeriod(target, idx) {
      // 🔴 每個帳期獨立累積（見上面「第二個死穴」）
      resetDetailCapture();

      // 主帳期（第一個）沿用 `targetDate`（舊行為），其餘用帳期自己嘅開始日
      var dateHint = idx === 0 && opts.targetDate ? opts.targetDate : target.start || null;
      var inline = null;

      trace.push({ step: "period", ok: true, period: target.period, periodIndex: idx });

      // 🔴🔴🔴 2026-09-28 第七次真機（使用者點醒）：
      //   按「查詢」之後，平台已經發咗 `summary/_list`，**回應本身就有實收金額**。
      //   ⇒ 先試「零重放」直讀，命中就記低，再繼續抓明細（第十次真機）。
      var direct = amountsForPeriod(target, dateHint);
      trace.push({
        step: "amounts-inline",
        ok: direct.ok,
        period: target.period,
        periodIndex: idx,
        receive: direct.receive,
        subsidy: direct.subsidy,
        should: direct.should,
        fee: direct.fee,
        receiveKey: direct.receiveKey || null,
        via: direct.via,
        periodFromList: direct.period || null,
        summaryId: direct.summaryId || null,
        reason: direct.reason || null,
        // 🔴 第十次真機：直讀命中唔再係終點，只係「已到手嘅帳期金額」
        note: direct.ok ? "直讀成功（仍會繼續抓明細）" : null,
      });
      if (direct.ok) {
        inline = {
          period: direct.period || target.period,
          summaryId: direct.summaryId || null,
          receive: direct.receive,
          subsidy: direct.subsidy,
          should: direct.should,
          fee: direct.fee,
          receiveKey: direct.receiveKey || null,
          via: direct.via,
          details: direct.details || [],
        };
      }

      // 🔴 次序好重要：**先清走舊事件，再撳「查看詳情」**。
      //    否則會攞到上一輪／上一次手動瀏覽時殘留嘅 summaryId，
      //    配錯帳期 ⇒ 實收全錯（而且金額「有值但錯」，最難察覺）。
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
        return Promise.resolve(periodFail(target, "detail", d.reason, inline));
      }

      // 撳完之後，平台先會發 detail 請求 ⇒ 一定要**等**攔截到 summaryId。
      // 等唔到就係硬失敗（唔可以猜）。最長等 4 秒（覆蓋慢網絡）。
      return waitFinance("finance_request", 4000).then(function () {
        // 🔴🔴 第十七次真機：**今個帳期有冇攔截到新請求**。
        //    有 ⇒ MAIN world「上一次請求」可以信（就係今個帳期嘅）。
        //    冇 ⇒ 唔可以信（會係上一個帳期嘅）⇒ 交返 `periods-map` 去配對。
        var fresh = false;
        for (var fi = 0; fi < financeRequests.length; fi++) {
          if (financeRequests[fi] && financeRequests[fi].summaryId) {
            fresh = true;
            break;
          }
        }
        return resolveSummaryId(target.row, target.period, dateHint, {
          allowStaleAsk: fresh,
        }).then(function (res) {
          trace.push({
            step: "summaryId",
            ok: !!res.id,
            value: res.id,
            via: res.via,
            periodIndex: idx,
          });
          if (!res.id) {
            return periodFail(
              target,
              "summaryId",
              "撈唔到帳期 id（已試網絡攔截同 DOM 兩條路）。請確認財務對帳頁已正常載入，並重新載入擴充功能後再試。",
              inline,
            );
          }
          // 撳完詳情（或平台自動補發）之後，列表事件可能新到 ⇒ 再讀一次帳期金額。
          var again = amountsForPeriod(target, dateHint);
          trace.push({
            step: "amounts-after-detail",
            ok: again.ok,
            period: target.period,
            periodIndex: idx,
            receive: again.receive,
            subsidy: again.subsidy,
            via: again.via,
            reason: again.reason || null,
          });
          // 🔴 第十次真機：呢度**唔可以**因為讀到金額就 return ——
          //    帳期金額係「順手攞埋」，**明細（逐筆 tradeNo）先係 POS 配對用嘅必要資料**。
          if (again.ok) {
            inline = {
              period: again.period || target.period,
              summaryId: res.id,
              receive: again.receive,
              subsidy: again.subsidy,
              should: again.should,
              fee: again.fee,
              receiveKey: again.receiveKey || null,
              via: again.via,
              details: again.details || [],
            };
          }
          // 🔴🔴🔴 2026-09-28 第十六次真機：**先撳每頁筆數，再抓明細**。
          return sleep(600).then(function () {
            return step3b(0, target, dateHint, inline, res, idx);
          });
        });
      });
    }

    /** 一個帳期失敗時嘅統一回報（仍然帶住已讀到嘅金額，唔好丟）。 */
    function periodFail(target, step, reason, inline) {
      return {
        ok: false,
        step: step,
        period: target.period,
        reason: reason,
        transactions: [],
        total: null,
        complete: false,
        receive: inline ? inline.receive : null,
        subsidy: inline ? inline.subsidy : null,
        should: inline ? inline.should : null,
        fee: inline ? inline.fee : null,
      };
    }

    /**
     * ③b 把「每頁筆數」撳到最大（50項/頁）＋ 逐頁搭便車抄低明細。
     *
     * 🔴🔴🔴 2026-09-28 第十六次真機（使用者點醒）：
     *   「拿不到 32 條是因為, paging 我沒選到 50一頁,
     *     但是當我用立即對帳, 應該是你也要幫忙按到才行.」
     *
     *   舊流程（撳完「查看詳情」就直接重放）有兩個死穴：
     *     ① 平台預設 `pageSize=20` ⇒ 一個月 32 筆只會回 20（**靜默少 12 筆**）
     *     ② 想補就要自己重放 ⇒ **CORS 一定死**（第十五次真機實證）
     *
     *   ✅ 新流程（**零重放**）：
     *     ① 我哋代撳 `el-pagination__sizes` 嗰個下拉 → 揀最大（50）
     *     ② 平台**自己**用 `pageSize=50` 再發 `_get-order-summary-list`
     *     ③ MAIN world **被動**抄低回應 ⇒ 冇 CORS、冇簽章、冇重放
     *     ④ 若 `total > 50`（跨月大單）⇒ 再逐頁撳「下一頁」累積（去重）
     *
     *   ⚠️ 次序死穴：**先撳、後等**。掉轉會抄到撳之前嗰 20 筆，白撳一場。
     */
    function step3b(attempt, target, dateHint, inline, res, idx) {
      attempt = attempt || 0;
      // 🔴 撳**之前**先記低序號：咁樣無論回應喺撳之前定之後到都認得到
      //    （「清走事件再等」嘅舊寫法會錯過撳之前已到嘅回應 ⇒ 白等 timeout）。
      var seqBefore = detailCaptureSeq;

      /**
       * 🔴 收尾（翻頁 → step4）**一定要包成一層**，唔可以寫成
       *    `.then(A).then(B)` —— 因為 A 嘅 `return`（重試嗰條路）
       *    **唔會**跳過 B，B 照樣會再跑一次 ⇒ `step4` 行兩次
       *    （實測：重放請求數 1 變 2、trace 出現兩段 paging）。
       */
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
            periodIndex: typeof idx === "number" ? idx : null,
            note: psr.note || null,
            reason: pg.reason || null,
          });
          return sleep(400).then(function () {
            return step4(target, dateHint, inline, res);
          });
        });
      }

      return setPageSizeToMax({ target: PAGE_SIZE_TARGET }).then(function (ps) {
        // 🔴 真機保險：Element-UI dialog 有過場動畫（~300ms）＋ 表格懶渲染，
        //    第一次可能仲未見到分頁器 ⇒ 等一陣再搵**一次**（只補一次，唔好拖慢）。
        //    ⚠️ 唔好淨係靠呢度：`pumpDetailPages`（撳下一頁）一樣補到數，
        //       所以就算兩次都搵唔到，都只係「慢啲」，**唔會少數**。
        if (!ps.ok && attempt < 1) {
          return sleep(700).then(function () {
            return step3b(attempt + 1, target, dateHint, inline, res, idx);
          });
        }
        trace.push({
          step: "page-size",
          ok: ps.ok,
          target: ps.target == null ? PAGE_SIZE_TARGET : ps.target,
          controls: ps.controls == null ? null : ps.controls,
          changed: !!ps.changed,
          period: target.period,
          // 每個下拉撳完之後嘅「實際每頁筆數」（用嚟一眼驗「係咪 50」）
          sizes: (ps.results || []).map(function (r) {
            return { ok: r.ok, value: r.value == null ? null : r.value, already: !!r.already };
          }),
          reason: ps.reason || null,
        });
        if (!ps.ok || !ps.changed) {
          return pump({
            changed: false,
            note: ps.reason || "每頁筆數已經係 ≥ " + PAGE_SIZE_TARGET + "，唔使再撳",
          });
        }
        // 🔴 撳完 ⇒ 平台會再發一次請求 ⇒ 等**新**嗰個回應（一到就走）。
        return waitDetailCaptureAfter(seqBefore, 6000).then(function (got) {
          return pump({
            changed: true,
            got: !!got,
            note: got ? null : "撳完每頁筆數但等唔到新回應（沿用原本嗰批）",
          });
        });
      });
    }

    /**
     * 🔴 由 trace 取「已配對嘅帳期文字」。
     *
     * 舊寫法係 `trace.filter(t => t.step === "period")[0].period` ——
     * 一旦**冇** `period` 呢個 trace 項（例如流程更早失敗、或者 planner 改過順序），
     * `[0]` 就係 `undefined` ⇒ 存取 `.period` **同步拋 TypeError**。
     * 而嗰兩處都在 `.then()` callback 內 ⇒ 變成 rejected promise，
     * 上層若冇 `.catch` 就會令 popup **永遠呆等**（最難查嘅一種掛死）。
     * ⇒ 集中一個安全取法，永不拋錯。
     */
    function periodTextFromTrace() {
      for (var ti = 0; ti < trace.length; ti++) {
        if (trace[ti] && trace[ti].step === "period") return trace[ti].period || null;
      }
      return null;
    }

    /**
     * 讀「被動搭便車抄到」嘅明細（跨頁累積、已去重）。
     *
     * 🔴 第十六次真機：呢個先係**主力來源** —— 平台自己發請求，零 CORS。
     *
     * @returns {{rows:Array, total:number|null, pages:number, complete:boolean}}
     */
    function readPassiveDetail() {
      var rows = rawFinanceCapture.detailRows.slice();
      var total =
        rawFinanceCapture.detailTotal == null ? null : rawFinanceCapture.detailTotal;
      return {
        rows: rows,
        total: total,
        pages: rawFinanceCapture.detailPages.length,
        // total 未知 ⇒ 唔敢話齊（寧願報「未齊」，唔可以扮齊）
        complete: total != null && isFinite(Number(total)) && rows.length >= Number(total),
      };
    }

    /**
     * 用「已到手嘅明細列」組出**一個帳期**嘅結果。
     *
     * 抽出嚟係因為**兩條路**都要用同一套組裝（被動抄到／重放成功），
     * 唔可以各寫一份 —— 各寫一份就遲早漂移（POS 嗰邊嘅 mapper 教訓）。
     *
     * @param {Array} rows 明細列（原樣，唔改名）
     * @param {{source:string, complete:boolean, total:number|null, pages:number|null}} meta
     * @param {object} target 帳期（`{period, start, end}`）
     * @param {object|null} inline 直讀到嘅帳期金額
     * @param {object} res `resolveSummaryId` 嘅結果（`{id, via}`）
     */
    function finishWithTransactions(rows, meta, target, dateHint, inline, res) {
      meta = meta || {};
      var sid = res && res.id ? res.id : null;
      var sidVia = res && res.via ? res.via : null;

      var lvl = amountsForPeriod(target, dateHint);
      if (!lvl.ok && inline) {
        lvl = {
          ok: true,
          receive: inline.receive,
          subsidy: inline.subsidy,
          should: inline.should,
          fee: inline.fee,
          receiveKey: inline.receiveKey,
          via: inline.via,
          details: inline.details || [],
        };
      }
      trace.push({
        step: "amounts-inline",
        ok: lvl.ok,
        period: target.period,
        receive: lvl.receive,
        subsidy: lvl.subsidy,
        should: lvl.should,
        fee: lvl.fee,
        receiveKey: lvl.receiveKey || null,
        via: lvl.via,
        reason: lvl.reason || null,
      });
      return {
        ok: true,
        source: meta.source || "replay",
        period: (inline && inline.period) || target.period,
        summaryId: sid,
        summaryIdVia: sidVia,
        receive: lvl.ok ? lvl.receive : null,
        should: lvl.ok ? lvl.should : null,
        fee: lvl.ok ? lvl.fee : null,
        subsidy: lvl.ok ? lvl.subsidy : null,
        receiveKey: lvl.receiveKey || null,
        amountsVia: lvl.via,
        details: lvl.details || [],
        transactions: rows,
        pages: meta.pages == null ? null : meta.pages,
        // 🔴🔴 第十六次真機：「抄咗幾多 / 平台話有幾多」一定要外露。
        //    淨係報 `transactions.length` 會令「32 筆只抄到 20」完全睇唔出
        //    （使用者正正係咁樣俾誤導咗一整日）。
        total: meta.total == null ? null : meta.total,
        complete: !!meta.complete,
      };
    }

    function step4(target, dateHint, inline, res) {
      // ④ 呼叫 API（唔靠 DOM 撈 transaction —— 帳期列表嘅 details 係空）

      // 🔴🔴🔴 2026-09-28 第十六次真機：**明細優先用「被動抄到」嘅，唔好再重放**。
      //
      //   重放（step4 下半部）已被證實係 **CORS 死路**（第十五次真機），
      //   等佢 15 秒只會換來一個「必定失敗」嘅結果。
      //   而 `step3b` 已經代撳咗「每頁筆數 50」＋ 逐頁「下一頁」，
      //   平台自己發嘅請求全部被動抄晒落 `rawFinanceCapture.detailRows`。
      //
      //   ⇒ 只要抄到任何一列，就**直接交貨**；重放只留作「完全抄唔到」嘅後備。
      var passive = readPassiveDetail();
      if (passive.rows.length) {
        trace.push({
          step: "transactions",
          ok: true,
          // 🔴 來源要寫明：popup／log 一眼就知今次係「搭便車」定「重放」
          via: "page-capture",
          count: passive.rows.length,
          total: passive.total,
          pages: passive.pages,
          complete: passive.complete,
          period: target.period,
          reason: passive.complete
            ? null
            : passive.total == null
              ? "平台冇回 total，唔敢肯定抄齊（而家抄到 " + passive.rows.length + " 列）"
              : "只抄到 " + passive.rows.length + " / " + passive.total + " 列（未齊）",
        });
        return Promise.resolve(
          finishWithTransactions(
            passive.rows,
            {
              source: "page-capture",
              complete: passive.complete,
              total: passive.total,
              pages: passive.pages,
            },
            target,
            dateHint,
            inline,
            res,
          ),
        );
      }

      return fetchSummaryList(res ? res.id : null).then(function (r) {
        trace.push({
          step: "transactions",
          ok: r.ok,
          pages: r.pages || null,
          count: r.transactions ? r.transactions.length : 0,
          period: target.period,
          reason: r.reason || null,
          // 🔴 2026-09-28 第五次真機：一定要帶埋「實際打咩 URL、帶咩 body」
          //    同「平台回咩 HTTP 碼」—— 否則背景 log 只有 "HTTP 404"，
          //    完全無從判斷係邊一步、邊條請求出錯。
          url: r.url || null,
          status: r.status || null,
          requestBody: r.requestBody || null,
          // 🔴 2026-09-28 第六次真機：重放係 MAIN world 發嘅，要知有冇帶到簽章標頭。
          //    `hasSignature:false` 就代表閘道會拒收（→ Failed to fetch）。
          headerKeys: r.headerKeys || null,
          hasSignature: typeof r.hasSignature === "boolean" ? r.hasSignature : null,
          // 🔴 2026-09-28 第八次真機：實際 pageSize ＋ 降級次數
          //    —— 驗「有冇拿到最大 pageSize」＋「平台上限係幾多」。
          pageSize: r.pageSize == null ? null : r.pageSize,
          downgraded: r.downgraded || 0,
          total: r.total == null ? null : r.total,
        });
        if (!r.ok) {
          // 🔴 2026-09-28 第七次真機：重放失敗**唔等於**冇數。
          //    再試最後一次「由已攔截嘅列表事件直讀」——呢條路唔需要網絡、
          //    唔需要簽章、唔需要 id。只要平台載過帳期列表就一定有得讀。
          var lastTry = amountsForPeriod(target, dateHint);
          trace.push({
            step: "amounts-last-resort",
            ok: lastTry.ok,
            period: target.period,
            receive: lastTry.receive,
            subsidy: lastTry.subsidy,
            via: lastTry.via,
            reason: lastTry.reason || null,
          });
          if (lastTry.ok) {
            return {
              ok: true,
              source: "list-inline",
              period: lastTry.period || target.period,
              summaryId: lastTry.summaryId,
              receive: lastTry.receive,
              subsidy: lastTry.subsidy,
              should: lastTry.should,
              fee: lastTry.fee,
              receiveKey: lastTry.receiveKey || null,
              amountsVia: lastTry.via,
              details: lastTry.details || [],
              transactions: [],
              total: null,
              complete: false,
              // 重放雖然失敗，但數已取到 —— 保留失敗原因供診斷
              replayFailedReason: r.reason || null,
            };
          }
          return {
            ok: false,
            reason: r.reason,
            step: "transactions",
            period: target.period,
            requestUrl: r.url || null,
            requestStatus: r.status || null,
            requestBody: r.requestBody || null,
            headerKeys: r.headerKeys || null,
            hasSignature: typeof r.hasSignature === "boolean" ? r.hasSignature : null,
            // 🔴 2026-09-28 第六次真機：重放已搬去 MAIN world。
            //    `hadBodyTemplate` 舊語意（bridge 自己有冇蒐到範本）已過時 ——
            //    真正決定成敗嘅係「MAIN world 有冇可重放嘅請求範本」
            //    （即 `requestUrl` 有冇值）。保留舊名以免 popup／log 讀唔到，
            //    但語意改為反映 MAIN world。
            hadBodyTemplate: !!r.url,
            mainWorldTemplate: !!r.url,
          };
        }
        // 🔴 重放成功 = 明細逐筆拎到。
        //    組裝**共用** `finishWithTransactions`（同「被動抄到」嗰條路同一套）——
        //    唔可以各寫一份：各寫一份就遲早漂移，而且「有冇抄齊」會得一面有。
        return finishWithTransactions(
          r.transactions,
          {
            source: inline ? "list-inline+replay" : "replay",
            pages: r.pages,
            total: r.total,
            complete:
              r.total == null
                ? false
                : (r.transactions ? r.transactions.length : 0) >= Number(r.total),
          },
          target,
          dateHint,
          inline,
          res,
        );
      });
    }

    /**
     * 全部帳期行完 → 組最終結果。
     *
     * 🔴 只要**有**任何一個帳期成功，今次就算成功（其他帳期失敗要如實列出，
     *    唔可以因為一個失敗就成次報失敗 —— 否則 8 月成功、9 月失敗會變「全冇」）。
     */
    function finishAll() {
      var okPeriods = [];
      var failed = [];
      for (var i = 0; i < periodResults.length; i++) {
        var p = periodResults[i];
        if (p && p.ok) okPeriods.push(p);
        else failed.push(p);
      }

      // 全部失敗 ⇒ 照舊回報第一個失敗（等 popup／log 睇到真實原因）
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
            requestUrl: f.requestUrl || null,
            requestStatus: f.requestStatus || null,
            requestBody: f.requestBody || null,
            headerKeys: f.headerKeys || null,
            hasSignature: typeof f.hasSignature === "boolean" ? f.hasSignature : null,
            hadBodyTemplate: typeof f.hadBodyTemplate === "boolean" ? f.hadBodyTemplate : null,
            mainWorldTemplate: typeof f.mainWorldTemplate === "boolean" ? f.mainWorldTemplate : null,
          };
        }
        return {
          ok: false,
          reason: "帳期列表係空（可能平台未結算）",
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
      var pagesSum = 0;
      for (var k = 0; k < okPeriods.length; k++) {
        var q = okPeriods[k];
        allTxns = allTxns.concat(q.transactions || []);
        if (q.total == null) totalKnown = false;
        else totalSum = (totalSum == null ? 0 : totalSum) + Number(q.total);
        if (!q.complete) completeAll = false;
        pagesSum += Number(q.pages) || 0;
      }

      var primary = okPeriods[0];
      return {
        ok: true,
        source: primary.source || null,
        period: primary.period || periodTextFromTrace(),
        summaryId: primary.summaryId || null,
        summaryIdVia: primary.summaryIdVia || null,
        receive: primary.receive == null ? null : primary.receive,
        should: primary.should == null ? null : primary.should,
        fee: primary.fee == null ? null : primary.fee,
        subsidy: primary.subsidy == null ? null : primary.subsidy,
        receiveKey: primary.receiveKey || null,
        amountsVia: primary.amountsVia || null,
        details: primary.details || [],
        // 🔴🔴 所有帳期嘅明細加埋（POS 係逐筆配對 `tradeNo`，跨帳期照配）
        transactions: allTxns,
        pages: pagesSum || null,
        // 🔴🔴 第十六次真機：「抄咗幾多 / 平台話有幾多」一定要外露。
        transactionsTotal: totalKnown ? totalSum : null,
        transactionsComplete: completeAll && totalKnown,
        // 🔴🔴🔴 第十七次真機：逐帳期結果（background 會**逐個**推送去 POS）
        periods: okPeriods,
        periodCount: okPeriods.length,
        // 失敗嘅帳期要如實帶出（唔可以靜默）
        failedPeriods: failed.map(function (x) {
          return { period: x && x.period ? x.period : null, step: (x && x.step) || null, reason: (x && x.reason) || null };
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

    if (msg.type === "MFOODFIN_SYNC") {
      // 🔴 2026-09-28 第七次真機：**一定要有 `.catch`**。
      //    舊寫法 `runFinanceSync(...).then(sendResponse)` 冇 catch ⇒ 流程內
      //    任何一個同步／非同步錯誤都會變成 unhandled rejection：
      //      · popup 永遠收唔到回應（睇落就係「卡住」「巳停止」）
      //      · service worker console 只有一條曖昧嘅 unhandled rejection
      //    呢種「靜默掛死」正是使用者最介意嘅失敗模式。
      // 🔴🔴 第十七次真機：**一定要帶 `startDate`**。
      //    舊寫法淨係轉發 `storeName` / `targetDate` ⇒ 使用者喺 popup set 嘅
      //    「只同步此日後」（8月30日）**永遠入唔到** `pickPeriodTargets()`
      //    ⇒ 只會行「命中今日」嗰一個帳期，其餘帳期全部冇抓（靜默少一大截）。
      runFinanceSync({
        storeName: msg.storeName,
        targetDate: msg.targetDate,
        startDate: msg.startDate || null,
      }).then(
        sendResponse,
        function (e) {
          // 明確回報錯誤，唔可以令 popup 呆等
          sendResponse({
            ok: false,
            reason: "內部錯誤：" + ((e && e.message) || e),
            stack: String((e && e.stack) || "").slice(0, 1500),
            step: "internal",
          });
        },
      );
      return true; // 非同步
    }

    /**
     * 🔴 2026-09-28 第十一次真機：**把全部訂單原樣交返出嚟**（唔配對、唔篩選）。
     *
     * 使用者原話：「不如你先不要做配對, 先把所有的訂單都先拿在手上,
     *              然後我再幫你分析好不好?」
     *
     * ⇒ 呢個 handler 只做一件事：回報目前**已攔截到**嘅所有原始資料。
     *   · `periodRows` ＝ 帳期列表（`_list`）嘅原始列（含平台口徑金額欄位）
     *   · `detailRows` ＝ 明細（`_get-order-summary-list`）嘅原始列（逐筆）
     *   · 兩者都係**原樣**（唔改名、唔計算、唔配對）
     *
     * ⚠️ 呢個 handler **唔會**觸發任何網絡請求 —— 只讀已攔到嘅嘢。
     *    要抓更多，就要先按 popup 上嘅「抓取」。
     */
    if (msg.type === "MFOODFIN_RAW") {
      // 🔴 2026-09-28 第十三次真機：**整個 handler 包 try/catch**。
      //
      //    真機症狀：popup 報「收到訊息但冇回」——即係 `sendResponse` 冇被叫到。
      //    呢個 handler 本來係同步直回、看似最安全，但**只要建構回應物件時
      //    拋任何錯（例如某個 raw 值係 BigInt／循環引用／Proxy，
      //    結構化複製會拋），`sendResponse` 就永遠唔會被叫** ⇒
      //    使用者見到嘅就係「收到訊息但冇回」呢句最無資訊量嘅錯誤。
      //
      //    ⇒ 一定要包住，而且**失敗時要回一個帶原因嘅回應**，
      //      唔可以靜默。另外加 size 上限：太大嘅 payload 會令
      //      訊息通道超時（同樣係「冇回」），寧可分頁都唔好死。
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
          detailSummaryId: rawFinanceCapture.detailSummaryId,
          firstRowKeys: rawFinanceCapture.firstRowKeys,
          detailRows: rawFinanceCapture.detailRows,
          // 🔴 第十六次真機：每頁「抄到幾多／total 幾多」嘅流水 ——
          //    「平台話 32 筆但只抄到 20」一定要喺呢度一眼睇到。
          detailPages: rawFinanceCapture.detailPages,
          // 同時帶埋「最後一次請求嘅端點／body」——方便對照欄位來源
          lastRequest: financeEvents.finance_last_request
            ? {
                url: financeEvents.finance_last_request.url || null,
                kind: financeEvents.finance_last_request.kind || null,
                summaryId: financeEvents.finance_last_request.summaryId || null,
              }
            : null,
        };

        // 先量度實際 JSON 大小（結構化複製前），太大就唔好硬傳。
        var rawJson = "";
        try {
          rawJson = JSON.stringify(rawResp);
        } catch (se) {
          rawJson = "";
        }
        var RAW_MAX = 4 * 1024 * 1024; // 4 MB 上限
        if (rawJson && rawJson.length > RAW_MAX) {
          rawResp.detailRows = rawResp.detailRows.slice(0, 200);
          rawResp.periodRows = rawResp.periodRows.slice(0, 200);
          rawResp.truncated = true;
          rawResp.truncatedReason =
            "原始資料超過 " +
            Math.round(RAW_MAX / 1024 / 1024) +
            " MB，已截斷至各 200 列（避免訊息通道超時＝『冇回』）";
        }

        // 再確認真係可以結構化複製（呢句就係之前靜默拋錯嘅位）。
        try {
          structuredClone(rawResp);
        } catch (ce) {
          // 有唔可以複製嘅值 ⇒ 先用 JSON round-trip 清洗一次
          rawResp = JSON.parse(JSON.stringify(rawResp));
          rawResp.sanitized = true;
          rawResp.sanitizedReason =
            "回應含不可結構化複製嘅值，已 JSON 正規化：" + ((ce && ce.message) || ce);
        }

        sendResponse(rawResp);
      } catch (e) {
        // 🔴 絕對唔可以靜默 —— 一定要回一個有原因嘅回應。
        sendResponse({
          ok: false,
          reason: "MFOODFIN_RAW 建構回應時出錯：" + ((e && e.message) || e),
          step: "raw-build",
          stack: String((e && e.stack) || "").slice(0, 1200),
        });
      }
      return true;
    }

    /**
     * 🔴 2026-09-28 第七次真機：只讀「由帳期列表回應抽到嘅實收金額」。
     *
     * 用途：真機上 `_list` 回應已經有齊金額，但偶爾仍然撈唔到目標帳期
     * （例如按「查詢」之後平台未返、或帳期文字格式唔同）。
     * 呢個 handler 令使用者**可以即刻見到**「平台究竟傳咗乜落嚟」——
     * 而唔需要靠截圖猜，亦唔需要跑完整四步。
     */
    if (msg.type === "MFOODFIN_AMOUNTS") {
      var got = readAmountsFromListEvent(msg.periodText || null, msg.targetDate || null);
      // 連「有幾多個帳期、每個帳期嘅實收」一齊回 —— 就算配對失敗都睇得到真實數據
      var ev = financeEvents.finance_periods;
      var periods = (ev && ev.periods) || [];
      got.periods = periods.map(function (p) {
        var a = amountsOfRaw(p.raw);
        return {
          id: p.id,
          period: periodTextOfRaw(p.raw) || null,
          receive: a.receive,
          subsidy: a.subsidy,
          should: a.should,
          fee: a.fee,
          receiveKey: a.receiveKey,
          via: a.via,
          detailCount: Array.isArray(p.raw && p.raw.details) ? p.raw.details.length : 0,
        };
      });
      sendResponse(got);
      return true;
    }

    /**
     * 🔴🔴 2026-09-30：「讀出商家下拉有咩店家可以揀」。
     *
     * 為咩要佢（使用者原話）：
     *   「你需要給商家在extension 上, 選擇用那家店, 去做mfood 對帳」
     *
     * 原本 popup 只有一個**自由文字框**叫商家自己打商家名。真機實測 80/80
     * 都失敗 —— 商家要記住後台嗰串又長又含招牌菜括號嘅名（例如
     * 「表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)」），打漏一個字／半形全形
     * 就對唔上。而**後台本身就有得揀**（`li.el-select-dropdown__item`）。
     *
     * ⇒ 呢個 handler 主動開一次商家下拉，把**真實可揀嘅選項**原樣交返 popup，
     *   由 popup 畫成清單畀商家揀 —— 由此以後商家唔需要打任何字，亦冇得打錯。
     *
     * 🔴 只讀＋選項本身：**只開下拉讀文字，唔會揀任何嘢、唔會改任何狀態**。
     *    （開下拉係唯讀操作；讀完即撳 Esc／body 收返，唔會影響之後嘅對帳。）
     *
     * 🔴 如實報告（同 `setStore` 失敗訊息同一個紀律）：一定要分清楚
     *    「搵唔到下拉容器」／「開到但冇選項（遠端搜尋未返）」／
     *    「有 N 個選項」三種情況，唔可以斷言未驗證嘅事。
     */
    if (msg.type === "MFOODFIN_STORE_OPTIONS") {
      var sctl = findStoreSelectControl();
      if (!sctl) {
        sendResponse({
          ok: false,
          reason:
            "搵唔到商家下拉（請確認已進入外賣對帳頁 " +
            "merchant.mfoodapp.com/#/finance/tackout-check）",
          step: "no-control",
        });
        return true;
      }

      // 開下拉（同 setStore 一樣：撳容器本身最穩）
      try {
        sctl.wrap.click();
        if (sctl.input) sctl.input.click();
      } catch (e) {
        /* 繼續試讀選項 */
      }

      var sotries = 0;
      function readOptions() {
        sotries++;
        // 🔴 只認「本身可見」嘅選項，而且**要同呢個下拉有關**。
        //    Element UI 會同時掛住好幾個 popper（月份／狀態／分頁），
        //    全頁掃 `.el-select-dropdown__item` 會混入其他下拉嘅選項
        //    （同 setStore 嘅已知結構隱患同源）。
        var seen = [];
        var seenSet = {};
        var allItems = document.querySelectorAll(".el-select-dropdown__item");
        for (var i = 0; i < allItems.length; i++) {
          if (!visible(allItems[i])) continue;
          var t = trimmed(allItems[i].textContent).replace(/\s+/g, " ");
          if (!t || t.length > 200) continue;
          if (seenSet[t]) continue;
          seenSet[t] = true;
          seen.push(t);
        }

        if (seen.length || sotries >= 10) {
          // 讀完 → 收返下拉（唔留低一個開住嘅 popper 影響後面）
          try {
            document.body.click();
          } catch (e2) {
            /* ignore */
          }
          sendResponse({
            ok: true,
            // ⚠️ 空陣列＝「開到下拉但一個可見選項都冇」，唔等於失敗 ——
            //    商家清單可能係遠端搜尋、未打關鍵字未返。popup 要照樣顯示
            //    「載入到 0 個」＋容許手動輸入，而唔係報「失敗」。
            options: seen,
            optionCount: seen.length,
            current: storeSelectedText(sctl),
            hasTags: !!sctl.hasTags,
            tries: sotries,
            // 方便 popup 講清楚「係咩情況」
            emptyReason: seen.length
              ? null
              : "開到商家下拉但 " +
                Math.round(sotries * 150) +
                "ms 內一個可見選項都冇（商家清單可能係遠端搜尋，要打關鍵字先返）",
          });
          return;
        }
        setTimeout(readOptions, 150);
      }
      setTimeout(readOptions, 120);
      return true;
    }

    // 只量度（診斷用）—— 唔會撳任何嘢
    if (msg.type === "MFOODFIN_PROBE") {
      var hit = findPeriodRow(msg.targetDate);
      var ctl = findStoreSelectControl();
      // 主動問 MAIN world 攞診斷帳本（只讀，唔會撳任何嘢）
      askLastFinanceRequest(800).then(function (last) {
        sendResponse({
          ok: true,
          finance: onFinancePage(),
          storeInput: !!ctl,
          storeValue: ctl ? storeSelectedText(ctl) : null,
          hasTags: ctl ? ctl.hasTags : null,
          queryButton: !!findByText(/^查詢$|^查询$/, { maxLen: 4 }),
          periodRow: hit ? hit.period : null,
          capturedSummaryId: (last && last.summaryId) || null,
          // 🔴 診斷：MAIN world 見過嘅所有財務 URL（幫確認真實端點名）
          seenFinanceUrls: (last && last.seenUrls) || null,
        });
      });
      return true;
    }

    /**
     * 🔴 深度 DOM 診斷（2026-09-28 新增）—— 只讀，唔撳任何嘢。
     *
     * 為咩要佢：真頁面同我哋假設嘅形狀有出入時（實測：真後台「詳情」係
     * **帳單明細彈窗**，唔係我哋假設嘅「帳期列」），靠截圖猜會反覆修錯。
     * 直接 dump 真實 DOM 結構，一次過對準。
     *
     * 回傳：所有輸入框／下拉、含日期嘅列、所有「查看詳情」掣、
     *       `__vue__` 有冇、以及可能嘅 summaryId 來源。
     */
    if (msg.type === "MFOODFIN_DOMDUMP") {
      function describe(el, maxLen) {
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: String(el.className || "").slice(0, 160),
          text: trimmed(el.textContent).replace(/\s+/g, " ").slice(0, maxLen || 120),
          visible: r.width > 0 && r.height > 0,
          size: Math.round(r.width) + "x" + Math.round(r.height),
        };
      }

      var out = {
        ok: true,
        href: String(location.href || ""),
        hash: String(location.hash || ""),
        finance: onFinancePage(),
        // ── 所有輸入框（搵商家下拉用）──
        inputs: [],
        // ── 所有 el-select（Element-UI 下拉）──
        selects: [],
        // ── 含「YYYY-MM-DD」嘅可見列（搵帳期用）──
        dateRows: [],
        // ── 所有「查看詳情」類掣 ──
        detailButtons: [],
        // ── Vue 實例探測（現時通常全 false；只作記錄）──
        vueProbe: null,
        // ── 🔴 新：已攔截到嘅財務網絡事件（2026-09-28 新增主力來源）──
        capturedEvents: {
          request: null,
          periods: null,
          detail: null,
        },
        // ── 有冇 el-table ──
        tables: [],
      };

      out.capturedEvents = {
        request: financeEvents.finance_request
          ? {
              url: financeEvents.finance_request.url,
              kind: financeEvents.finance_request.kind,
              summaryId: financeEvents.finance_request.summaryId,
              // 🔴 連 body 一齊 dump —— summaryId 唔喺 URL 就係喺呢度（或其巢狀位置）
              body: financeEvents.finance_request.body || null,
            }
          : null,
        // 🔴 本輪撳「查看詳情」後收到嘅**全部**財務請求（可能多過一個）
        requests: financeRequests.map(function (r) {
          return {
            url: r.url,
            kind: r.kind,
            summaryId: r.summaryId,
            body: r.body || null,
          };
        }),
        periods: financeEvents.finance_periods
          ? { count: (financeEvents.finance_periods.periods || []).length }
          : null,
        detail: financeEvents.finance_detail_captured
          ? { summaryId: financeEvents.finance_detail_captured.summaryId }
          : null,
      };

      // 🔴 見過嘅財務 URL（診斷用；幫確認真實端點名同參數）
      out.seenFinanceUrls = (function () {
        var last = financeEvents.finance_last_request;
        return (last && last.seenUrls) || [];
      })();

      // ① 輸入框
      var inputs = document.querySelectorAll("input, textarea");
      for (var i = 0; i < inputs.length && out.inputs.length < 40; i++) {
        var el = inputs[i];
        if (!visible(el)) continue;
        out.inputs.push({
          id: el.id || null,
          name: el.getAttribute("name") || null,
          type: el.getAttribute("type") || null,
          placeholder: trimmed(el.getAttribute("placeholder")) || null,
          value: trimmed(el.value).slice(0, 80) || null,
          readonly: !!el.readOnly,
          cls: String(el.className || "").slice(0, 120),
          isElInputInner: /el-input__inner/.test(String(el.className || "")),
        });
      }

      // ② el-select 容器
      var selNodes = document.querySelectorAll(".el-select");
      for (var s = 0; s < selNodes.length && out.selects.length < 20; s++) {
        var sn = selNodes[s];
        if (!visible(sn)) continue;
        var inner = sn.querySelector("input");
        out.selects.push({
          text: trimmed(sn.textContent).replace(/\s+/g, " ").slice(0, 80),
          inputValue: inner ? trimmed(inner.value).slice(0, 60) : null,
          inputPlaceholder: inner ? trimmed(inner.getAttribute("placeholder")) || null : null,
          // 🔴 新：是否多選標籤型（真商家選擇器就係呢種）
          hasTags: !!sn.querySelector(".el-select__tags"),
          width: Math.round(sn.getBoundingClientRect().width),
          outerHTMLStart: String(sn.outerHTML || "").slice(0, 300),
        });
      }

      // ③ 含日期嘅可見列（帳期）
      var all = document.querySelectorAll("tr, li, .el-table__row, [class*='row'], [class*='item']");
      var seen = 0;
      for (var r = 0; r < all.length && seen < 25; r++) {
        var row = all[r];
        if (!visible(row)) continue;
        var period = rowPeriodText(row);
        if (!period) continue;
        seen++;
        out.dateRows.push({
          period: period,
          tag: row.tagName,
          cls: String(row.className || "").slice(0, 120),
          text: trimmed(row.textContent).replace(/\s+/g, " ").slice(0, 140),
          // 🔴 三條路都試：__vue__ / data-* / 子元素 id
          hasVue: !!row.__vue__,
          vueKeys: row.__vue__ ? Object.keys(row.__vue__).slice(0, 25) : null,
          vueRowId: row.__vue__ && row.__vue__.row ? row.__vue__.row.id || null : null,
          attrs: (function () {
            var o = {};
            for (var a = 0; a < row.attributes.length && a < 12; a++) {
              o[row.attributes[a].name] = String(row.attributes[a].value).slice(0, 80);
            }
            return o;
          })(),
        });
      }

      // ④ 🔴🔴 2026-09-30 新增：**商家下拉專項探測**（為咗查「商家名搵唔到」80/80 全敗）
      //
      // 背景：使用者日誌顯示「下拉打開咗但搵唔到「表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)」」
      //       但**下拉選項文字逐個字都對得上**（實測同日後台 UI 一致）
      //       ⇒ 唔係全角/半角問題，而係**根本冇喺正確嘅下拉入面搵**。
      //
      // 🔴 現行 `setStore()` 係 `document.querySelectorAll('.el-select-dropdown__item')`
      //    —— **全頁**搵，完全冇同 `ctl.wrap` 掛鈎。Element UI 嘅 popper 係
      //    接去 `body` 尾、而且可以同時存在多個（月份 / 狀態 / 商家…），
      //    只要撳開嘅係**另一個**下拉，就會「打開咗但搵唔到」。
      //
      // ⇒ 呢段探測要答三條問題：
      //    ① `findStoreSelectControl()` 揀咗邊個 `.el-select`？（score / hasTags / width）
      //    ② 佢同 `aria-controls` / `aria-describedby` 指去邊個 popper id？
      //    ③ 全頁到底有幾個 `.el-select-dropdown`、各自屬主同內容係咩？
      out.storeProbe = (function () {
        var result = { picked: null, allSelects: [], poppers: [], aria: null };

        // ── 所有可見 .el-select，附上「我們嘅評分公式」結果 ──
        var wraps = document.querySelectorAll(".el-select");
        var scored = [];
        for (var i = 0; i < wraps.length; i++) {
          var w = wraps[i];
          if (!visible(w)) continue;
          var r = w.getBoundingClientRect();
          var inp = w.querySelector("input.el-input__inner, input");
          var hasTags = !!w.querySelector(".el-select__tags");
          var inTable = !!w.closest(".el-table, .el-table__row, tbody");
          var tooNarrow = r.width < 120;
          var score = 0;
          if (hasTags) score += 100;
          score += Math.min(60, r.width / 5);
          score += Math.max(0, 40 - Math.abs(r.top) / 20);
          scored.push({
            idx: i,
            width: Math.round(r.width),
            top: Math.round(r.top),
            left: Math.round(r.left),
            hasTags: hasTags,
            tooNarrow: tooNarrow,
            inTable: inTable,
            // ⚠️ 有冇被上面任何一個 `continue` 踢走（＝會唔會被揀到）
            excluded: tooNarrow || inTable,
            score: Math.round(score),
            text: trimmed(w.textContent).replace(/\s+/g, " ").slice(0, 60),
            inputValue: inp ? trimmed(inp.value).slice(0, 60) : null,
            inputPlaceholder: inp ? trimmed(inp.getAttribute("placeholder")) || null : null,
            // popper 掛鈎線索
            ariaControls: w.getAttribute("aria-controls") || null,
            innerAriaControls: inp ? inp.getAttribute("aria-controls") || null : null,
            // Vue 實例（若存在，可直接讀 state）
            hasVue: !!w.__vue__,
            // 🔴 最關鍵：呢個 select 自己嘅 popper 容器（Element UI 會 append 去 body）
            ownPopperId: null,
          });
        }
        result.allSelects = scored;

        // ── 重跑一次「我們嘅揀法」，睇實際會揀邊個 ──
        var ctl = findStoreSelectControl();
        if (ctl) {
          var cr = ctl.wrap.getBoundingClientRect();
          result.picked = {
            width: Math.round(cr.width),
            top: Math.round(cr.top),
            hasTags: !!ctl.hasTags,
            text: trimmed(ctl.wrap.textContent).replace(/\s+/g, " ").slice(0, 60),
            inputValue: ctl.input ? trimmed(ctl.input.value).slice(0, 60) : null,
          };
        }

        // ── 🔴 全頁所有 popper（`.el-select-dropdown`）：屬主同上掛點 ──
        var poppers = document.querySelectorAll(".el-select-dropdown");
        for (var p = 0; p < poppers.length && result.poppers.length < 15; p++) {
          var pop = poppers[p];
          var items = pop.querySelectorAll(".el-select-dropdown__item");
          var sys = [];
          for (var q = 0; q < items.length && sys.length < 12; q++) {
            sys.push({
              text: trimmed(items[q].textContent).replace(/\s+/g, " ").slice(0, 70),
              visible: visible(items[q]),
            });
          }
          // Element UI 嘅 popper 會有 aria-hidden / style.display / transform
          var popStyle = (pop.getAttribute("style") || "").slice(0, 200);
          var wrapper = pop.closest(".el-popper, .el-select-dropdown__wrap") || pop.parentElement;
          result.poppers.push({
            visible: visible(pop),
            ariaHidden: pop.getAttribute("aria-hidden"),
            parentTag: pop.parentElement ? pop.parentElement.tagName : null,
            parentCls: pop.parentElement
              ? String(pop.parentElement.className || "").slice(0, 100)
              : null,
            style: popStyle,
            itemCount: items.length,
            items: sys,
          });
        }

        result.aria = {
          popperCount: poppers.length,
          visiblePopperCount: result.poppers.filter(function (x) {
            return x.visible;
          }).length,
        };
        return result;
      })();

      // ⑤ 「查看詳情」類掣
      var btns = document.querySelectorAll("button, a, [role='button'], span");
      for (var b = 0; b < btns.length && out.detailButtons.length < 25; b++) {
        var bn = btns[b];
        if (!visible(bn)) continue;
        var bt = trimmed(bn.textContent).replace(/\s+/g, "");
        if (!/查看詳情|查看明细|詳情|明细|详情/.test(bt) || bt.length > 10) continue;
        out.detailButtons.push({
          tag: bn.tagName,
          text: bt,
          cls: String(bn.className || "").slice(0, 140),
          // 佢所屬嘅最近祖先列（睇下可唔可以行上去搵 summaryId）
          ancestorChain: (function () {
            var chain = [];
            var n = bn.parentElement;
            for (var d = 0; d < 6 && n; d++, n = n.parentElement) {
              chain.push({
                tag: n.tagName,
                cls: String(n.className || "").slice(0, 80),
                period: rowPeriodText(n) || null,
                hasVue: !!n.__vue__,
              });
            }
            return chain;
          })(),
        });
      }

      // ⑤ Vue 實例全局探測
      var rootEl = document.querySelector("#app") || document.body;
      out.vueProbe = {
        appHasVue2: !!rootEl.__vue__,
        appHasVue3: !!rootEl.__vue_app__,
        bodyHasVue: !!document.body.__vue__,
        // Vue 3 由 DOM 拎實例要用 __vueParentComponent
        anyVueParentComponent: !!document.querySelector("[data-v-app]"),
        hasDataVApp: !!document.querySelector("[data-v-app]"),
      };

      // ⑥ el-table
      var tbls = document.querySelectorAll(".el-table, table");
      for (var t = 0; t < tbls.length && out.tables.length < 10; t++) {
        var tb = tbls[t];
        out.tables.push({
          cls: String(tb.className || "").slice(0, 120),
          rows: tb.querySelectorAll("tr").length,
          visible: visible(tb),
          headers: Array.from(tb.querySelectorAll("th"))
            .map(function (th) {
              return trimmed(th.textContent).replace(/\s+/g, "");
            })
            .filter(Boolean)
            .slice(0, 12),
        });
      }

      // 🔴 最後問一次 MAIN world 攞最新財務帳本（只讀）——
      //    等佢返嚟才 sendResponse，否則診斷清單會係空。
      askLastFinanceRequest(700).then(function (last) {
        if (last && last.seenUrls) out.seenFinanceUrls = last.seenUrls;
        if (last && last.summaryId && !out.capturedEvents.request) {
          out.capturedEvents.request = { summaryId: last.summaryId, url: last.url, kind: last.kind };
        }
        sendResponse(out);
      });
      return true;
    }
  });

  console.log(TAG, "installed on", window.location.href);
})();
