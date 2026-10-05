/**
 * mfood-inject.js — MAIN world content script (mFood)
 *
 * 執行在頁面自己的 JS 環境（world: "MAIN"），在 document_start 時包裝
 * window.fetch 與 XMLHttpRequest，搭便車複製 mfood 商戶後台自己發出的回應。
 *
 * ============================================================================
 * 兩種取得訂單的方式
 * ============================================================================
 * ① 搭便車（被動）：頁面自己發請求時，我們複製回應。
 *    → 列表、統計、以及「手動點開詳情」都走這條。
 *
 * ② 請求重放（主動）：mfood 的詳情請求沒有任何簽章標頭（只靠 cookie），
 *    所以我們可以自己重發。做法是「先擷取一次真實請求當範本，再替換 orderId」——
 *    不自己猜標頭，平台改版時只要重新擷取即可。
 *
 *    ⚠️ 澳覓做不到這件事（它有 Alibaba 閘道簽章，涵蓋 orderId 與 nonce），
 *       所以澳覓走 DOM 模擬點擊。
 *
 * 本檔只負責「抓」與「重放」，推送邏輯在 background.js。
 */

(function () {
  "use strict";

  // ⚠️ 2026-09-28 第十四次真機：**呢個 `window` 記號喺本檔係正確嘅**。
  //
  //    本檔係設計黎跑喺 **MAIN world**（要掛頁面本身嘅 `window.fetch` /
  //    `XMLHttpRequest` 才攔得到請求），所以用 `window` 做記號完全合理。
  //
  //    🔴 反面教材：`mfood-finance-bridge.js` 係 **isolated** world 腳本，
  //      佢**唔可以**照抄呢個寫法 —— 因為 `window` 喺 isolated / MAIN
  //       之間係**同一個物件**，MAIN 跑完會令 isolated 誤以為「已安裝」
  //       而整支 return，但函式其實全部未定義 ⇒
  //       「Uncaught ReferenceError: onFinancePage is not defined」。
  //       （bridge 已改用 `chrome.runtime.id` 做 world 判斷，見該檔 L34 附近。）
  //
  //    ⇒ 判斷準則：**腳本設計跑邊個 world，就用嗰個 world 獨有嘅嘢做記號。**
  //      MAIN world → `window.*`；isolated world → `chrome.runtime.id`。
  if (window.__MFOOD_GRABBER_INSTALLED__) return;
  window.__MFOOD_GRABBER_INSTALLED__ = true;

  var TAG = "[mfood/inject]";

  // 保留原生 fetch。replayDetail 一定要用它 ——
  // 因為底下會把 window.fetch 換成我們的包裝版，若用裸 fetch(...)
  // 會打到自己的包裝，同一筆詳情會被送出兩次。
  var nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  // 詳情請求的 URL 特徵
  var DETAIL_URL_RE = /(\/order\/_get|takeoutOrderRecord\/detail)/i;

  // 列表請求的 URL 特徵（「日期區間 + 狀態」篩選就在這個請求的 body 裡）
  var LIST_URL_RE = /(_list-amtn|takeouts\/order\/_list|orderRecord\/list)/i;

  // ==========================================================================
  // 財務／對帳頁（finance/tackout-check）—— 2026-09-28 新增
  // --------------------------------------------------------------------------
  // 為什麼要另外認呢幾條 URL：
  //   財務頁嘅「帳期 id」（summaryId）**唔可以由 DOM 撈**。真機 2026-09-28
  //   實測：`vueProbe` 全 false（Vue 3 冇 `__vue__`）、列上只有 class 屬性
  //   ⇒ 之前靠 `row.__vue__` 攞 id 嘅寫法 100% 回 null，
  //     結果永遠停在「冇帳期 id，唔可以呼叫 transaction detail」。
  //
  //   最可靠嘅來源係**平台自己發嘅請求**：按「查看詳情」時，
  //   頁面會打 `_get-order-summary-list`（帶 summaryId），
  //   帳期列表本身會打 `summary/_list`（回應內含每個帳期嘅 id）。
  //   我哋只要搭便車抄低，就完全唔需要靠 Vue。
  // ==========================================================================

  /**
   * 帳期列表（**只認真正嘅列表端點**）。
   *
   * 🔴 2026-09-28 第二次真機踩到嘅陷阱：
   *    舊寫法 `summarys\/summary(_list)?` 會**誤中** `.../summary/_get-order-summary-list`！
   *    因為 `summarys/summary` 後面嘅 `/_get-order-…` 被 `(_list)?` 當成「可選」而照 match
   *    ⇒ detail 請求被當成帳期列表 ⇒ 走 `extractPeriodIds` 然後 **return**，
   *      永遠到唔到 detail 分支，`periods.count` 亦永遠 0。
   *    ✅ 修正：要求 `summary` 後面**緊接** `_list`（用 `\/_list`，唔可以再有嘢）。
   */
  var FINANCE_SUMMARY_LIST_RE = /\/summary\/_list|\/summarys\/_list|\/summary\/list/i;
  /**
   * 帳期內嘅 transaction detail。
   *
   * 🔴 2026-09-28 第二次真機：真機見到**兩條** detail 類端點 ——
   *    `_get-order-summary-list`（我一直以為嘅）同
   *    **`_get-order-summary-data`**（hits 2，之前完全冇預期）。
   *    ⇒ 兩條都要認（`data` 好可能才係「撳查看詳情」真正發嘅）。
   */
  var FINANCE_DETAIL_RE = /(_get-order-summary(-list|-data)?|order-summary-(list|data))/i;
  /**
   * 任何財務相關請求（診斷用；涵蓋度較寬）。
   *
   * 🔴 一定要**排除訂單端點**：`takeouts/order/_list-amtn` 呢啲係訂單管道嘅命脈，
   *    一旦被當財務請求就會走入 `captureFinanceResponse` 而**唔會**再經
   *    `classify()` / `handle()` ⇒ 訂單靜默斷流（比唔抓更差）。
   *    `_get-order-summary-list` 雖然含 `order`，但佢有 `summary` 字根，
   *    所以用「先排除 order 端點、再要求財務字根」嘅判法。
   */
  var ORDER_ENDPOINT_RE = /(takeouts\/order|orderRecord|_list-amtn)/i;
  var FINANCE_ANY_RE = /(summarys?\/|summary\/|_get-order-summary|finance\/|tackout-check)/i;

  /** 係唔係財務頁請求（排除訂單端點後才問財務特徵）。 */
  function isFinanceUrl(url) {
    var u = String(url || "");
    if (ORDER_ENDPOINT_RE.test(u)) return false;
    return FINANCE_ANY_RE.test(u);
  }

  /**
   * 🔴 診斷帳本：記錄最近見過嘅財務請求 URL（去重，最多 40 條）。
   *
   * 為咩要佢：我哋對「帳期列表用邊條 API」仍然係**推測**。
   * 第一版真機跑完之後，睇呢個清單就可以一次過確認所有真實端點名，
   * 唔使再靠猜（亦係「唔好靜默失敗」嘅原則）。
   */
  var financeSeenUrls = [];
  var FINANCE_SEEN_MAX = 40;

  /**
   * 🔴 2026-09-28 第二次真機：URL 有記帳，但 summaryId 仍然全部 null。
   *    ⇒ 證明 id **唔喺 URL**，而係喺 body（或者喺 body 嘅某個巢狀位置）。
   *    舊帳本只記 URL，睇唔到 body ⇒ 無法對準。所以帳本要**連 body 一齊記**
   *    （每個 URL 只留最後一次，長度截斷），再加「所有 JSON key 路徑」摘要，
   *    咁下次診斷就一眼睇到 summaryId 到底叫咩名、擺喺邊。
   *
   * @param {string} url
   * @param {string} method
   * @param {boolean} hasSummaryId
   * @param {string|null} body 原始 body（可選）
   */
  function recordFinanceUrl(url, method, hasSummaryId, body) {
    var u = String(url || "");
    var b = body == null ? "" : String(body);
    for (var i = 0; i < financeSeenUrls.length; i++) {
      if (financeSeenUrls[i].url === u) {
        financeSeenUrls[i].hits++;
        // 每次覆寫成最新（最後一次最有代表性），並記低 key 路徑
        financeSeenUrls[i].lastBody = b.slice(0, 800);
        financeSeenUrls[i].bodyKeys = collectJsonKeys(b);
        if (hasSummaryId) financeSeenUrls[i].hasSummaryId = true;
        return;
      }
    }
    if (financeSeenUrls.length >= FINANCE_SEEN_MAX) financeSeenUrls.shift();
    financeSeenUrls.push({
      url: u.slice(0, 300),
      method: String(method || "GET").toUpperCase(),
      hasSummaryId: !!hasSummaryId,
      hits: 1,
      lastBody: b.slice(0, 800),
      bodyKeys: collectJsonKeys(b),
    });
  }

  /**
   * 由 body 收集所有 JSON key 路徑（最多 40 條，深度上限 4）。
   *
   * 目的：即使我哋唔知個欄位叫咩名，都可以一眼睇到 body 有咩 key，
   * 再對照值去搵帳期 id（例如 `{"data":{"summaryId":"..."}}`）。
   * 非 JSON 就回空陣列（唔會拋錯）。
   */
  function collectJsonKeys(body) {
    var b = body == null ? "" : String(body);
    if (!b || b.charAt(0) !== "{" && b.charAt(0) !== "[") return [];
    var out = [];
    function walk(node, prefix, depth) {
      if (out.length >= 40 || depth > 4 || !node || typeof node !== "object") return;
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length && out.length < 40; i++) {
        var k = keys[i];
        var v = node[k];
        var path = prefix ? prefix + "." + k : k;
        var t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        // 值係純量才記低值（避免長物件撐爆）
        var val =
          v === null || t === "array" || t === "object"
            ? null
            : String(v).slice(0, 60);
        out.push({ path: path, type: t, value: val });
        if (t === "object") walk(v, path, depth + 1);
        else if (t === "array" && v.length && typeof v[0] === "object" && v[0]) {
          walk(v[0], path + "[0]", depth + 1);
        }
      }
    }
    try {
      walk(JSON.parse(b), "", 0);
    } catch (e) {
      return [];
    }
    return out;
  }

  /**
   * 由 URL 或 body 撈出 summaryId。
   *
   * 平台有兩種可能寫法（query 或 body），兩者都試 —— 唔靠單一假設。
   * 🔴 2026-09-28 真機：三條財務 URL 都 `hasSummaryId:false` ⇒ 值**唔喺頂層**。
   *    ⇒ 加「遞歸掃描」：任何 key 名含 `summary`/`period`/`id` 嘅純量都當候選。
   *
   * @returns {string|null}
   */
  function extractSummaryIdFrom(url, body) {
    var u = String(url || "");

    // ① query string：?summaryId=xxx 或 ?summary_id=xxx
    var m = /[?&]summary_?id=([^&#]+)/i.exec(u);
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }

    // ② body（JSON）
    if (body && typeof body === "string") {
      try {
        var parsed = JSON.parse(body);
        // ②a 先試已知欄位名（快路）
        var cand = pickIdFromObject(parsed);
        if (cand) return cand;
        // ②b 遞歸掃描（未知形狀）
        var deep = deepFindSummaryId(parsed, 0);
        if (deep) return deep;
      } catch (e) {
        /* 不是 JSON，當冇 */
      }
    }
    return null;
  }

  /**
   * 由物件（或陣列第一項）取已知 id 欄位。
   *
   * 🔴 2026-09-28 第三次真機（最關鍵一筆）：
   *    `_list` 回應 `result[0].id = "202609170106005576278"`，
   *    而請求 body 嘅 **`weekId` 正是同一個值**。
   *    ⇒ 帳期 id 喺**請求側**嘅欄位名係 `weekId`（唔係 summaryId/periodId）。
   *      mfood 內部叫「帳期」做 **week**。
   *    之前三條路全滅就係因為個名一直對唔上。
   */
  function pickIdFromObject(o) {
    if (!o || typeof o !== "object") return null;
    var target = Array.isArray(o) ? o[0] : o;
    if (!target || typeof target !== "object") return null;
    var keys = [
      "summaryId",
      "summary_id",
      "summaryID",
      "settleSummaryId",
      "billId",
      "periodId",
      // 🔴 mfood 真機用嘅名：
      "weekId",
      "week_id",
      "settleWeekId",
      "id",
    ];
    for (var i = 0; i < keys.length; i++) {
      var v = target[keys[i]];
      if (v != null && String(v) !== "" && typeof v !== "object") return String(v);
    }
    return null;
  }

  /**
   * 遞歸掃描物件，搵出「睇落似帳期 id」嘅純量。
   *
   * 判斷：key 名含 `summary` / `period` / `bill` / `week`，且值係純量（非空）。
   * 容許巢狀（`{"data":{"summaryId":"..."}}`）—— 因為平台可能包一層。
   * 深度上限 4，避免大 payload 遞歸過深。
   *
   * ⚠️ **刻意唔用「任何 id」**：`id` 太通用（可能係 orderId / userId），
   *    只有連高信心字根先當（防止撈錯 id 去查 detail）。
   * 🔴 2026-09-28 第三次真機加 `week`：mfood 內部叫帳期做 **week**
   *    （請求 body 欄位 = `weekId`，同 `_list` 回應 `result[].id` 完全一致）。
   *    ⚠️ 只可以認 **`week` 開頭且 `id` 結尾**（`weekId`/`week_id`/`weekid`），
   *    **唔可以**寫 `/week/i` 或 `/^week/i` —— 咁會誤中 `weekday`（星期幾）、
   *    `weekTitle`（「第 38 週」）等無關欄位，攞住一個錯嘅值去查 detail
   *    ⇒ **實收有值但錯**（最難察覺嘅 bug）。測試 [21] 已鎖住。
   */
  function deepFindSummaryId(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) return null;
    var keys = Object.keys(node);
    // 先掃「高信心」key（含 summary / period / bill / weekId 字根）
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = node[k];
      if (v == null || typeof v === "object") continue;
      if (/summary|period|bill|^week_?id$/i.test(k) && String(v) !== "") return String(v);
    }
    // 再落一層
    for (var j = 0; j < keys.length; j++) {
      var child = node[keys[j]];
      if (child && typeof child === "object") {
        var r = deepFindSummaryId(Array.isArray(child) ? child[0] : child, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  /**
   * 撈出「帳期列表」回應裡面每一列嘅 id。
   *
   * 呢個係 Tier 1 嘅主力：唔撳「查看詳情」都可以知道每個帳期嘅 id，
   * 之後直接重放 detail。形狀唔確定 ⇒ 廣譜掃描（result / records / list），
   * 每個 item 試 id / summaryId / pk，並且記低佢嘅帳期文字方便配對。
   */
  function extractPeriodIds(body) {
    var p = unwrap(body);
    if (!p) return [];
    var rows = p.result || p.records || p.list || p.rows || p.data || [];
    // 🔴 2026-09-28：真機 `_list` 回應未必用上面任何一個欄位名
    //    （例如可能係 `detailMsg.list` 或 `data.records`）。
    //    ⇒ 落一層遞歸，搵**第一個有內容嘅物件陣列**做帳期列。
    if (!Array.isArray(rows) || !rows.length) {
      rows = findFirstArrayOfObjects(p, 0) || [];
    }
    if (!Array.isArray(rows)) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== "object") continue;
      var id =
        r.id != null
          ? r.id
          : r.summaryId != null
            ? r.summaryId
            : r.weekId != null
              ? r.weekId
              : r.pk;
      // 🔴 真機欄位名可能唔係 id/summaryId/pk —— 用「高信心」key 兜底
      if (id == null || String(id) === "") {
        id = deepFindSummaryId(r, 0);
      }
      if (id == null || String(id) === "") continue;
      out.push({
        id: String(id),
        // 帳期文字（可能叫 period / summaryDate / startTime+endTime），
        // 原樣丟返 bridge，由 bridge 統一解析（避免兩處各有各解析）。
        raw: r,
      });
      // 🔴 2026-09-28 第十一次真機（使用者要求）：「唔好配對，先將所有訂單拿喺手」。
      //    帳期列每一條都可能有 `details[]`（逐日／逐筆小計）。原本**冇**帶出
      //    MAIN world ⇒ bridge 收到嘅 `raw.details` 永遠係空（第七次真機
      //    `details: []` 就係咁嚟）。呢度原樣帶埋，令「訂單明細」真係落到手。
      if (Array.isArray(r.details) && r.details.length) {
        out[out.length - 1].details = r.details;
      }
    }
    return out;
  }

  /**
   * 遞歸搵「第一個有內容嘅物件陣列」（深度上限 4）。
   *
   * 用途：`_list` 回應嘅帳期列未必叫 `result`/`records`，
   * 但一定係一條物件陣列（每項一個帳期）。
   */
  function findFirstArrayOfObjects(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) return null;
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") return v;
    }
    for (var j = 0; j < keys.length; j++) {
      var child = node[keys[j]];
      if (child && typeof child === "object" && !Array.isArray(child)) {
        var r = findFirstArrayOfObjects(child, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // ==========================================================================
  // mfood 詳情 API —— 內建規格
  // --------------------------------------------------------------------------
  // 由真實請求逆向確認（Network 面板）：
  //   POST https://management-api.mfoodapp.com/merchants/takeouts/order/_get
  //   content-type: application/json;charset=UTF-8
  //   content-length: 30  ← 與 {"id":"202609230932086463403"} 完全吻合
  //
  // 關鍵：這個請求「沒有任何簽章標頭」，認證只靠 cookie，
  //       所以我們可以自己組出來直接呼叫，不必去點介面。
  //
  // 若之後 platform 改版，擷取到的真實範本（detailTemplate）會優先使用；
  // 這個內建規格只是「還沒有範本時」的保底。
  // ==========================================================================

  var BUILTIN_DETAIL_API = {
    url: 'https://management-api.mfoodapp.com/merchants/takeouts/order/_get',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    bodyPrefix: '{"id":"',
    bodySuffix: '"}',
  };

  // fetch 不允許自行設定的標頭（瀏覽器會自己加，設了會被忽略或拋錯）
  var FORBIDDEN_HEADER =
    /^(host|content-length|connection|origin|referer|cookie|user-agent|accept-encoding|sec-|priority|proxy-|:)/i;

  // ---- 請求範本 ------------------------------------------------------------

  var detailTemplate = null; // { url, method, headers, body, sampleId }
  var lastDetailReq = null; // 最近一次詳情請求（等待配對到回應）
  var listTemplate = null; // { url, method, headers, body, at } —— 列表請求範本

  function normalizeHeaders(h) {
    var out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach(function (v, k) {
          out[k] = v;
        });
      } else if (Array.isArray(h)) {
        h.forEach(function (pair) {
          if (pair && pair.length === 2) out[String(pair[0])] = String(pair[1]);
        });
      } else if (typeof h === "object") {
        Object.keys(h).forEach(function (k) {
          out[k] = h[k];
        });
      }
    } catch (e) {
      /* 忽略 */
    }
    return out;
  }

  function captureDetailRequest(url, method, headers, body) {
    var b = null;
    try {
      if (typeof body === "string") b = body;
      else if (body && typeof body.toString === "function" && !(body instanceof FormData)) {
        b = String(body);
      }
    } catch (e) {
      b = null;
    }
    lastDetailReq = {
      url: String(url),
      method: String(method || "GET").toUpperCase(),
      headers: normalizeHeaders(headers),
      body: b,
      at: Date.now(),
    };
  }

  /** 詳情回應到達時，把剛才那個請求定型成範本 */
  function freezeTemplate(orderId) {
    if (!lastDetailReq) return;
    if (Date.now() - lastDetailReq.at > 20000) return; // 太久以前的，不採信

    detailTemplate = {
      url: lastDetailReq.url,
      method: lastDetailReq.method,
      headers: lastDetailReq.headers,
      body: lastDetailReq.body,
      sampleId: orderId == null ? null : String(orderId),
    };

    post(
      "template",
      {
        url: detailTemplate.url,
        method: detailTemplate.method,
        headerNames: Object.keys(detailTemplate.headers),
        headers: detailTemplate.headers,
        body: detailTemplate.body,
        sampleId: detailTemplate.sampleId,
      },
      { transport: "capture" },
    );
    lastDetailReq = null;
  }

  // ---- 日期區間：直接用 API 重放，不去點頁面上的日期選擇器 ------------------
  //
  // 由真實請求確認（Network 面板）：
  //   POST https://management-api.mfoodapp.com/merchants/takeouts/order/_list-amtn
  //   body: { startTime: <epoch 毫秒>, endTime: <epoch 毫秒>, status: "", ... }
  //
  // 為什麼可以自己改 body 重放：
  //   與詳情同一套 Alibaba 閘道簽章 —— StringToSign 只涵蓋 method / URL / 標頭，
  //   **不含 request body**。日期與狀態都在 body 裡，所以改它們簽章仍然對得上。
  //   這也讓我們完全不必去操作頁面那個很難驅動的日期選擇器。
  //
  // ⚠️ 若閘道有 nonce 防重放，這個請求會失敗 → 呼叫端會自動退回 DOM 操作並回報原因。

  /** 擷取列表請求當範本（每次覆蓋：範本必須反映最新的篩選條件） */
  function captureListRequest(url, method, headers, body) {
    var b = null;
    try {
      if (typeof body === "string") b = body;
      else if (body && typeof body.toString === "function" && !(body instanceof FormData)) {
        b = String(body);
      }
    } catch (e) {
      b = null;
    }

    if (!b) return; // 沒有 body（例如 GET）就沒有可重放的篩選器

    try {
      JSON.parse(b);
    } catch (e) {
      return; // 不是 JSON 就不收
    }

    listTemplate = {
      url: String(url),
      method: String(method || "POST").toUpperCase(),
      headers: normalizeHeaders(headers),
      body: b,
      at: Date.now(),
    };
  }

  // ---- 財務頁擷取 ----------------------------------------------------------

  /**
   * 記低「最近一次財務請求」同回應 —— 供 bridge 撈 summaryId 用。
   *
   * 兩件事分開做：
   *   · 請求一出（`captureFinanceRequest`）就即刻報 —— 因為 summaryId 喺
   *     **請求**上面（query / body），唔使等回應。
   *     按「查看詳情」時同步發生，bridge 就算事後才問都攞得到（有 TTL）。
   *   · 回應到（`captureFinanceResponse`）再報一次，內含 transaction 資料，
   *     可以用嚟做「唔使重放都拿得到」嘅快路（但本專案仍以重放為準，
   *     因為彈窗有分頁，重放才可以保證拎齊）。
   */
  var lastFinanceReq = null;

  function captureFinanceRequest(url, method, headers, body) {
    var u = String(url || "");
    var isDetail = FINANCE_DETAIL_RE.test(u);
    var isList = FINANCE_SUMMARY_LIST_RE.test(u);

    var b = null;
    try {
      if (typeof body === "string") b = body;
      else if (body && typeof body.toString === "function" && !(body instanceof FormData)) {
        b = String(body);
      }
    } catch (e) {
      b = null;
    }

    var summaryId = extractSummaryIdFrom(u, b);

    // 🔴 診斷帳本：**所有**財務 URL 都記低（唔理認唔認得），連 body 一齊記，
    //    咁真機跑完就可以一眼睇到真實端點名＋參數，唔使再靠猜。
    recordFinanceUrl(u, method, !!summaryId, b);

    // 🔴🔴 2026-09-28 第五次真機（404 真兇）：**重放必須用呢個 host！**
    //
    //  真機請求絕對 URL ＝
    //    https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list
    //  但頁面自己嘅 origin ＝ https://merchant.mfoodapp.com
    //  ⇒ 之前用 `location.origin + path` 重放 ⇒ 打 merchant host 上唔存在嘅路徑 ⇒ **404**。
    //  （同訂單 API 一樣都係 management-api host，見 BUILTIN_DETAIL_API。）
    //
    //  亦記低 **API 路徑**（而唔只係 host），平台若改路徑都自動跟。
    //
    //  ⚠️ 唔可以用 `new URL()`：MAIN world 未必有全域 `URL` 建構子
    //     （測試 vm sandbox 就冇 ⇒ 回 null，令 [23] 紅）。
    //     用 regex 解析，兼容絕對 URL 同相對路徑兩種寫法。
    var uOrigin = "";
    var uPath = "";
    var abs = /^(https?:\/\/[^/]+)(\/[^?#]*)/i.exec(u);
    if (abs) {
      uOrigin = abs[1];
      uPath = abs[2] || "";
    } else {
      // 相對路徑：origin 用頁面自己（呼叫端再決定要唔要用）
      try {
        uOrigin = location.origin || "";
      } catch (e) {
        uOrigin = "";
      }
      var rel = /^([^?#]*)/.exec(u);
      uPath = rel ? rel[1] : "";
    }

    var kind = isDetail ? "detail" : isList ? "summary_list" : "other";

    // 🔴🔴 2026-09-28 第六次真機（`Failed to fetch` 真兇）：**重放要照抄簽章標頭！**
    //
    //  症狀：v1.59 host 已改對（404 消失），但變成 `Failed to fetch`。
    //  真兇 ＝ mfood 同澳覓一樣係 **Alibaba 閘道簽章**（`x-ca-key` / `x-ca-nonce` /
    //  `x-ca-signature` / `x-ca-timestamp`）。冇簽章 ⇒ 閘道喺 HTTP 層之前就切斷
    //  連線 ⇒ 瀏覽器只報 `Failed to fetch`（**唔會**回 401/403，因為根本冇 HTTP 回應）。
    //
    //  ⚠️ 呢個坑本專案**當年訂單流程已經踩過一次**，症狀一字不差 ——
    //    見 `replayDetail` 上方註釋：「那個請求沒有帶任何認證標頭，
    //    必定失敗（日誌顯示 Failed to fetch）」。財務重放一直冇抄標頭，所以重蹈覆轍。
    //
    //  ⇒ 所以 rec 一定要帶 `headers`（過 `FORBIDDEN_HEADER` 濾，瀏覽器唔准我們自己設
    //    嘅標頭照樣要濾走）。重放改喺 **MAIN world** 執行（同 `replayDetail` 同一條路），
    //    因為只有 MAIN world 嘅請求才同頁面本身嘅請求完全一致（origin / credentials / 簽章）。
    var hdrs = {};
    try {
      var norm = normalizeHeaders(headers);
      Object.keys(norm).forEach(function (k) {
        if (!FORBIDDEN_HEADER.test(k)) hdrs[k] = norm[k];
      });
    } catch (e) {
      hdrs = {};
    }

    var rec = {
      url: u,
      // 🔴 重放要用嘅 host ＋ 路徑（由真實請求抽，唔靠猜）
      origin: uOrigin || null,
      path: uPath || null,
      method: String(method || "GET").toUpperCase(),
      // 🔴 重放要用嘅簽章標頭（**唔可以漏**，否則閘道拒收 → Failed to fetch）
      headers: hdrs,
      headerKeys: Object.keys(hdrs),
      hasSignature: Object.keys(hdrs).some(function (k) {
        return /^x-ca-|signature|nonce|timestamp|token|authorization/i.test(k);
      }),
      body: b == null ? null : b.slice(0, 4000),
      summaryId: summaryId,
      kind: kind,
      at: Date.now(),
    };

    // 🔴🔴 2026-09-28 第六次真機：`lastFinanceReq`（重放範本）**只可以**用
    //    `_get-order-summary-list` 呢條端點嘅請求。
    //
    //  為什麼：真機同一輪「查看詳情」會發**兩條** detail 類請求 ——
    //    · `_get-order-summary-data`（帳期**匯總**；body **冇** pageNo/pageSize）
    //    · `_get-order-summary-list`（帳期**明細**；body **有** pageNo/pageSize）← 重放目標
    //  若「任何帶 id 嘅請求」都做範本，咁 `-data` 後到就會覆蓋成佢 ⇒
    //  重放會（a）打錯端點（`-data` 唔支援分頁）、（b）body 缺 pageNo/pageSize。
    //  ⇒ 用 URL 判斷，唔靠抵達順序（同 bridge 舊規則一致）。
    if (summaryId && /_get-order-summary-list/i.test(u)) lastFinanceReq = rec;

    // 🔴 2026-09-28 第二次真機：`_get-order-summary-data` 我哋完全冇預期過，
    //    佢可能才是真正帶 summaryId 嘅端點。所以**所有**財務請求都 post
    //    （唔再只限 detail/list）—— 寧多報少，唔可以靜默漏。
    postFinance("finance_request", rec, { transport: "capture" });
  }

  function captureFinanceResponse(url, body) {
    var u = String(url || "");
    // 🔴 診斷：連**回應形狀**都記落帳本（key 路徑 + 值）。因為
    //    `capturedEvents.periods.count = 0` 表示 `_list` 回應冇被解析出帳期
    //    ⇒ 需要睇真實回應結構才知道帳期 id 叫咩、擺喺邊。
    //
    // ⚠️ 2026-09-28 刻意**唔由回應推斷 summaryId** 並拿去查 detail：
    //    回應內可能含 orderId / userId 等「睇落似 id」嘅值，一旦撈錯，
    //    就會用一個錯嘅帳期 id 去查 transaction ⇒ **實收有值但錯**（最難察覺）。
    //    正確次序：先靠今次診斷睇清回應結構，確認咗欄位名才加推斷。
    //    （請求側嘅撈法有 `summary|period|bill` 字根把關，風險較低，已實作。）
    recordFinanceResponseShape(u, body);

    if (FINANCE_SUMMARY_LIST_RE.test(u)) {
      postFinance(
        "finance_periods",
        { url: u, periods: extractPeriodIds(body) },
        { transport: "capture" },
      );
      return;
    }
    if (FINANCE_DETAIL_RE.test(u)) {
      var p = unwrap(body);
      var detRows = p && Array.isArray(p.result) ? p.result : [];
      postFinance(
        "finance_detail_captured",
        {
          url: u,
          summaryId: extractSummaryIdFrom(u, null),
          result: detRows,
          total: p && isFinite(Number(p.total)) ? Number(p.total) : null,
          // 🔴 2026-09-28 第十一次真機：**原樣**連每一列嘅全部欄位一齊記低。
          //    目的：唔做任何配對／猜測，先把「平台實際回咗啲乜」完整拿到手，
          //    之後再離線分析（帳期列 vs 明細列嘅 key 對照）。
          //    刻意**唔篩欄位**——過濾就係假設，假設就會漏。
          rawResult: detRows,
          respTopKeys: p && typeof p === "object" ? Object.keys(p) : [],
          firstRowKeys:
            detRows.length && detRows[0] && typeof detRows[0] === "object"
              ? Object.keys(detRows[0])
              : [],
        },
        { transport: "capture" },
      );
    }
  }

  /**
   * 記低一個財務回應嘅「形狀」（key 路徑 + 值），供診斷睇真結構。
   *
   * 只保留最後一次（同 URL 覆寫），同 URL 帳本共用。
   */
  function recordFinanceResponseShape(url, body) {
    var u = String(url || "");
    for (var i = 0; i < financeSeenUrls.length; i++) {
      if (financeSeenUrls[i].url === u) {
        var p = null;
        try {
          p = typeof body === "string" ? JSON.parse(body) : body;
        } catch (e) {
          p = null;
        }
        financeSeenUrls[i].respKeys = p ? collectJsonKeys(JSON.stringify(p)) : [];
        // 記低最外層欄位名（一眼睇「result / records / list / data」邊個係陣列）
        try {
          financeSeenUrls[i].respTopKeys = p && typeof p === "object" ? Object.keys(p) : [];
        } catch (e) {
          financeSeenUrls[i].respTopKeys = [];
        }
        return;
      }
    }
  }

  /** bridge 主動問「最近有冇財務請求」時回覆（TTL 內才可信）。 */
  function replyFinanceRequestTTL() {
    var fresh = lastFinanceReq && Date.now() - lastFinanceReq.at < 120000;
    var payload = fresh ? lastFinanceReq : { summaryId: null };
    // 🔴 附帶診斷帳本（所有見過嘅財務 URL）—— 幫下次對準真實端點名。
    payload.seenUrls = financeSeenUrls.slice();
    postFinance("finance_last_request", payload, {});
  }

  /** 'YYYY-MM-DD' → 當地時間當日 00:00:00.000 的 epoch 毫秒 */
  function localDayStartMs(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  }

  /** 'YYYY-MM-DD' → 當地時間當日 23:59:59.999 的 epoch 毫秒 */
  function localDayEndMs(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
  }

  /**
   * 由真實列表請求範本，組出「指定日期區間」的請求。
   *
   * 只改三個欄位（startTime / endTime / status），其餘原樣保留 ——
   * 平台若偷偷加了新欄位，我們不會因為少帶而失敗。
   * 這是刻意的：不自己硬編 payload，平台改版時只要重新擷取一次範本。
   */
  function buildListReplay(startDate, endDate) {
    var tpl = listTemplate;
    if (!tpl) {
      return {
        ok: false,
        reason:
          "尚未看到 mfood 的列表請求 —— 請先在 mfood 後台按一次「查詢」，讓擴充功能擷取一次真實請求",
      };
    }

    var body;
    try {
      body = JSON.parse(tpl.body);
    } catch (e) {
      return { ok: false, reason: "列表請求範本不是合法 JSON" };
    }

    var startMs = localDayStartMs(startDate);
    if (startMs == null) return { ok: false, reason: "起始日期格式不對（應為 YYYY-MM-DD）" };

    var endMs = localDayEndMs(endDate);
    if (endMs == null) endMs = Date.now();

    body.startTime = startMs;
    body.endTime = endMs;
    body.status = ""; // 不限狀態：進行中／已完成／已取消全都要

    var headers = {};
    Object.keys(tpl.headers).forEach(function (k) {
      if (!FORBIDDEN_HEADER.test(k)) headers[k] = tpl.headers[k];
    });

    return {
      ok: true,
      url: tpl.url,
      method: tpl.method,
      headers: headers,
      body: JSON.stringify(body),
      applied: { startTime: startMs, endTime: endMs, status: "" },
    };
  }

  /** 重放列表請求：在指定日期區間抓全部訂單 */
  function replayList(startDate, endDate, reqId) {
    var spec = buildListReplay(startDate, endDate);

    if (!spec.ok) {
      post("list_range_result", { reqId: reqId, ok: false, reason: spec.reason }, {});
      return;
    }

    var doFetch = nativeFetch || (window.fetch && window.fetch.bind(window));
    if (!doFetch) {
      post("list_range_result", { reqId: reqId, ok: false, reason: "環境沒有可用的 fetch" }, {});
      return;
    }

    doFetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      credentials: "include",
    })
      .then(function (r) {
        return r.text().then(function (text) {
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            json = null;
          }

          if (!r.ok || !json) {
            post(
              "list_range_result",
              {
                reqId: reqId,
                ok: false,
                status: r.status,
                reason: "HTTP " + r.status + (json ? "" : "（回應不是 JSON）"),
              },
              {},
            );
            return;
          }

          var kind = classify(json);
          if (kind !== "order_list") {
            post(
              "list_range_result",
              {
                reqId: reqId,
                ok: false,
                status: r.status,
                reason: "回應不是訂單列表（分類結果：" + kind + "）",
              },
              {},
            );
            return;
          }

          var p = unwrap(json);
          var rows = p && Array.isArray(p.result) ? p.result.length : 0;

          // 平台自己回的 total = 這個篩選區間總共幾張單。
          // 拿它跟實際收到的筆數對比，就是一次自我驗證：
          // 若筆數少於 total，代表這個列表其實有分頁，我們只拿到第一頁。
          var total = p && isFinite(Number(p.total)) ? Number(p.total) : null;

          // 走正常管道 —— bridge / background 當成一般擷取處理。
          // 推送、去重、cut-off 全部共用，不必另寫一套。
          handle("order_list", spec.url, json, { transport: "replay", range: spec.applied });

          post(
            "list_range_result",
            { reqId: reqId, ok: true, rows: rows, total: total, applied: spec.applied },
            {},
          );
        });
      })
      .catch(function (err) {
        post(
          "list_range_result",
          { reqId: reqId, ok: false, reason: String((err && err.message) || err) },
          {},
        );
      });
  }
  // ---- 基本判斷 ------------------------------------------------------------

  function unwrap(body) {
    if (!body || typeof body !== "object") return null;
    var inner = body.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      if (
        Array.isArray(inner.result) ||
        Array.isArray(inner.prdtList) ||
        isFinite(Number(inner.orderCount))
      ) {
        return inner;
      }
    }
    return body;
  }

  function isOrderList(p) {
    if (!p || !Array.isArray(p.result) || p.result.length === 0) return false;
    var first = p.result[0];
    return !!(first && typeof first === "object" && first.tradeNo != null && first.amtn != null);
  }

  function isOrderDetail(p) {
    return !!(
      p &&
      typeof p === "object" &&
      p.id != null &&
      p.tradeNo != null &&
      Array.isArray(p.prdtList)
    );
  }

  function isStats(p) {
    return !!(
      p &&
      typeof p === "object" &&
      isFinite(Number(p.orderCount)) &&
      p.totalOrderAmt != null
    );
  }

  function post(kind, payload, meta) {
    try {
      window.postMessage(
        { __mfoodGrabber: true, kind: kind, payload: payload, meta: meta },
        window.location.origin,
      );
    } catch (err) {
      console.warn(TAG, "postMessage failed", err);
    }
  }

  /**
   * 財務頁專用 post —— 用**獨立命名空間** `__mfoodFinance`。
   *
   * 🔴 為什麼唔可以搭 `post()`（`__mfoodGrabber`）：
   *     `mfood-bridge.js` 全程監聽 `__mfoodGrabber`，佢收到唔認識嘅 kind 會
   *     當「未知擷取」處理。財務頁同日可以同時掛住訂單管理頁（同 origin、換 hash），
   *     兩支 bridge 並存 ⇒ 財務事件一定要有自己嘅通道，唔可以污染訂單管道。
   */
  function postFinance(kind, payload, meta) {
    try {
      window.postMessage(
        { __mfoodFinance: true, kind: kind, payload: payload, meta: meta },
        window.location.origin,
      );
    } catch (err) {
      console.warn(TAG, "postMessage(finance) failed", err);
    }
  }

  function classify(body) {
    var p = unwrap(body);
    if (!p) return null;
    if (isOrderDetail(p)) return "order_detail";
    if (isOrderList(p)) return "order_list";
    if (isStats(p)) return "stats";
    return null;
  }

  function handle(kind, url, body, extraMeta) {
    var p = unwrap(body);
    if (!p) return;

    var meta = Object.assign(
      { url: url, capturedAt: new Date().toISOString(), pageUrl: window.location.href },
      extraMeta || {},
    );

    if (kind === "order_list") {
      console.log(TAG, "captured order list,", p.result.length, "rows |", url);
      post("order_list", p, meta);
      return;
    }

    if (kind === "order_detail") {
      console.log(TAG, "captured order detail", p.id, "|", url);
      // 只有「頁面自己發出的」詳情才拿來當範本（重放來的不算）。
      // ⚠️ 原本寫 !extraMeta 是錯的 —— 每個呼叫端都會傳 extraMeta，
      //    所以這個條件永遠不成立，範本永遠抓不到，重放必定失敗而退回點擊。
      if (!detailTemplate && !(extraMeta && extraMeta.transport === 'replay')) {
        freezeTemplate(p.id);
      }
      post("order_detail", p, meta);
      return;
    }

    if (kind === "stats") {
      console.log(TAG, "captured stats, orderCount =", p.orderCount, "|", url);
      post("stats", p, meta);
      return;
    }
  }

  // ---- 請求重放 ------------------------------------------------------------

  /**
   * 組出可重放的請求。
   *
   * 優先序：
   *   ① 擷取到的真實範本（最忠實，平台若加自訂標頭也帶得到）
   *   ② 內建規格（還沒有範本時直接用，不必先手動點開一筆）
   */
  function buildReplay(orderId) {
    var id = String(orderId);
    var tpl = detailTemplate;

    // 只有「擷取到真實範本」這一條路 —— 不能自己猜。
    if (!tpl || !tpl.sampleId) return null;

    var sample = tpl.sampleId;

    // 🔴 標頭「原樣照抄」，包含 x-ca-signature / x-ca-nonce / x-ca-timestamp。
    //
    //    過去我以為 mfood 沒有簽章，所以做了一個「內建規格」自己組請求 ——
    //    結果那個請求沒有帶任何認證標頭，必定失敗（日誌顯示 Failed to fetch）。
    //    實際擷取到的標頭含 x-ca-key / x-ca-nonce / x-ca-signature，
    //    mfood 用的是跟澳覓同一套 Alibaba 閘道簽章。
    //
    //    為什麼照抄舊簽章還有機會成功：
    //      Alibaba 的 StringToSign = method + Accept + Content-MD5 + Content-Type
    //                              + Date + 被簽標頭 + URL
    //      **不含 request body**；而 orderId 是放在 JSON body 裡（不是 query），
    //      method / URL / 標頭都不變 → 換 body 裡的 id，簽章仍然對得上。
    //    若伺服器有 nonce 防重放，這次會失敗 → 自動退回模擬點擊。
    var headers = {};
    Object.keys(tpl.headers).forEach(function (k) {
      if (!FORBIDDEN_HEADER.test(k)) headers[k] = tpl.headers[k];
    });

    return {
      url: tpl.url,
      method: tpl.method,
      headers: headers,
      body: tpl.body == null ? undefined : tpl.body.split(sample).join(id),
      source: 'template',
    };
  }

  function replayDetail(orderId, reqId) {
    var spec = buildReplay(orderId);

    if (!spec) {
      post(
        "replay_result",
        {
          reqId: reqId,
          orderId: String(orderId),
          ok: false,
          reason: "尚未取得請求範本 —— 請先手動點開一筆訂單詳情，讓擴充功能擷取一次真實請求",
        },
        {},
      );
      return;
    }

    var doFetch = nativeFetch || (window.fetch && window.fetch.bind(window));
    if (!doFetch) {
      post(
        "replay_result",
        { reqId: reqId, orderId: String(orderId), ok: false, reason: "環境沒有可用的 fetch" },
        {},
      );
      return;
    }

    doFetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      credentials: "include",
    })
      .then(function (r) {
        return r.text().then(function (text) {
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            json = null;
          }

          if (!r.ok || !json || !Array.isArray(json.prdtList)) {
            post(
              "replay_result",
              {
                reqId: reqId,
                orderId: String(orderId),
                ok: false,
                status: r.status,
                reason: "HTTP " + r.status + (json ? "（回應不是訂單詳情）" : "（回應不是 JSON）"),
              },
              {},
            );
            return;
          }

          // 成功 —— 走正常管道，讓 bridge / background 當一般擷取處理
          handle("order_detail", spec.url, json, { transport: "replay" });
          post(
            "replay_result",
            { reqId: reqId, orderId: String(orderId), ok: true, via: spec.source },
            {},
          );
        });
      })
      .catch(function (err) {
        post(
          "replay_result",
          {
            reqId: reqId,
            orderId: String(orderId),
            ok: false,
            reason: String((err && err.message) || err),
          },
          {},
        );
      });
  }

  // ---- 來自 bridge 的命令 ---------------------------------------------------

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__mfoodCmd !== true) return;

    if (d.cmd === "fetch_detail") {
      replayDetail(d.orderId, d.reqId);
      return;
    }

    // 在指定日期區間抓全部（API 重放）—— 「只同步此日後」的真正實作
    if (d.cmd === "sync_range") {
      replayList(d.startDate, d.endDate, d.reqId);
      return;
    }

    if (d.cmd === "list_template_info") {
      post(
        "list_template_info",
        listTemplate
          ? { ready: true, url: listTemplate.url, at: listTemplate.at, body: listTemplate.body }
          : { ready: false },
        {},
      );
      return;
    }

    if (d.cmd === "template_info") {
      post(
        "template_info",
        detailTemplate
          ? {
              ready: true,
              sampleId: detailTemplate.sampleId,
              method: detailTemplate.method,
              url: detailTemplate.url,
            }
          : { ready: false },
        {},
      );
    }

    // 🔴 財務頁：bridge 問「最近有冇帳期 detail 請求」（攞 summaryId 用）
    if (d.cmd === "finance_last_request") {
      replyFinanceRequestTTL();
    }

    // 🔴 2026-09-28 第五次真機：bridge 問「見過嘅財務請求**絕對 URL**」。
    //    目的＝驗證重放 host。真機 body 完全正確但一直 404 ⇒ 高度懷疑
    //    請求唔喺頁面 origin（`merchant.mfoodapp.com`）而係另一個 API host
    //    （同訂單一樣係 `management-api.mfoodapp.com`）。
    //    ⇒ 呢度把帳本原樣（含完整 URL）回報，一睇就知。
    if (d.cmd === "finance_seen_urls") {
      postFinance("finance_seen_urls", financeSeenUrls.slice(), {});
      return;
    }

    // 🔴🔴 2026-09-28 第六次真機（`Failed to fetch` 真兇）：
    //    bridge（isolated world）直接 fetch 會被 Alibaba 閘道拒收 —— 因為佢
    //    **冇帶 `x-ca-*` 簽章標頭**（詳見 `captureFinanceRequest` 註釋）。
    //    ⇒ 重放搬嚟 **MAIN world** 執行，同 `replayDetail` 同一條路，
    //      標頭照抄攔截到嘅真實請求（`rec.headers`）。
    if (d.cmd === "finance_replay_list") {
      financeReplayList(d.reqId || null);
      return;
    }
  });

  /**
   * 🔴 2026-09-28 第八次真機（使用者明確要求）：帳期明細嘅**每頁筆數**。
   *
   * 使用者原話：「request payload 里面, 有一個叫 page size 的, 這個必須要拿到最大的,
   * 因為一個月里面, 會有很多數據。」
   *
   * 平台 UI 一頁顯示 20 筆 ≠ API 上限係 20。一個帳期可以過百筆，
   * 照抄 UI 嘅 20 就會白白多打幾倍請求（更多 429 風險、更長嘅失敗窗口）。
   */
  var MAX_PAGE_SIZE = 200;

  /**
   * 降級階梯：若 `MAX_PAGE_SIZE` 被平台拒收（4xx／形狀異常），
   * 逐級下調重試 —— 寧願多打幾次，都唔可以因為設太大而**完全拿唔到數**。
   */
  var PAGE_SIZE_LADDER = [200, 100, 50, 20];

  /**
   * 喺 MAIN world 重放「帳期 transaction 明細」請求。
   *
   * 為什麼一定要喺 MAIN world 而唔係 bridge（isolated）：
   *   mfood 用 Alibaba 閘道簽章（`x-ca-key`/`x-ca-nonce`/`x-ca-signature`/
   *   `x-ca-timestamp`）。呢啲標頭只可以「照抄」而唔可以自己算。isolated world
   *   嘅 fetch 冇帶呢啲標頭 ⇒ 閘道喺 HTTP 層之前就切斷連線 ⇒ 瀏覽器報
   *   `Failed to fetch`（唔會回 401/403，因為根本冇 HTTP 回應）。
   *
   * 同 `replayDetail` 一樣：Alibaba 嘅 StringToSign 唔含 request body，
   * 而 `weekId`／`pageNo`／`pageSize` 都係擺喺 JSON body ⇒ 換 body 內嘅值，
   * 只要 method / URL / 簽章標頭不變，簽章仍然對得上。
   *
   * ⚠️ 若伺服器有 nonce 防重放（同一 nonce 用第二次會被拒），呢個方法會失敗。
   *    但訂單流程證明 mfood 閘道**冇**嚴格 nonce 檢查（同一範本重放一直有效）。
   *
   * @param {string|null} reqId 對應 bridge 嘅請求 id（回報時原樣帶回）
   */
  function financeReplayList(reqId) {
    var rec = lastFinanceReq;
    var fail = function (reason, extra) {
      var p = { reqId: reqId, ok: false, reason: reason };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k];
        }
      }
      postFinance("finance_replay_result", p, { transport: "replay" });
    };

    if (!rec) {
      fail("MAIN world 未有財務請求範本（未撳過「查看詳情」？）");
      return;
    }

    // 一定要用**絕對 URL**（host ＋ 路徑由真實請求抽；用 location.origin 會 404）。
    var url = rec.url && /^https?:\/\//i.test(rec.url)
      ? rec.url
      : (rec.origin || "") + (rec.path || "");
    if (!url) {
      fail("範本冇有效 URL", { requestUrl: rec.url || null });
      return;
    }

    // ⚠️ 一定要用 `nativeFetch`：`window.fetch` 已被我哋包裝，用裸 fetch
    //    會再觸發攔截（雖然財務請求唔會走入訂單管道，但會重複記帳本）。
    var doFetch = nativeFetch || (window.fetch && window.fetch.bind(window));
    if (!doFetch) {
      fail("環境沒有可用的 fetch");
      return;
    }

    var bodyObj = null;
    try {
      bodyObj = rec.body ? JSON.parse(rec.body) : null;
    } catch (e) {
      bodyObj = null;
    }
    // 🔴🔴 2026-09-28 第八次真機（使用者明確要求）：**`pageSize` 一定要拉到最大**。
    //
    //  使用者原話：「request payload 里面, 有一個叫 page size 的, 這個必須要拿到最大的,
    //  因為一個月里面, 會有很多數據。」
    //
    //  舊寫法係「照抄平台範本嘅 pageSize」—— 平台 UI 一頁顯示 20 筆 ⇒ 範本多半係 20。
    //  但 API 嘅上限**唔等於** UI 嘅顯示筆數。一個帳期（半個月～一個月）動輒過百筆，
    //  照抄 20 就等於白白多打 5～10 倍請求：
    //    · 每多一次請求 = 多一次撞 429／被當異常流量嘅機會
    //    · 翻頁鏈路越長 = 中途失敗嘅機會越大（而失敗係「靜默偏少」最難察覺）
    //
    //  ⇒ 一律拉到 `MAX_PAGE_SIZE`；只有平台原本就帶咗**更大**嘅值才保留。
    //
    //  ⚠️ 平台可能有真正嘅上限。若回 4xx 或形狀異常，呼叫端（`runPage`）會
    //     **自動降級重試**（見下方 PAGE_SIZE_LADDER），而唔係直接失敗 ——
    //     呢點係必要嘅：寧願多打幾次，都唔可以因為設太大而完全拿唔到數。
    if (!bodyObj || typeof bodyObj !== "object") {
      bodyObj = {
        weekId: rec.summaryId ? String(rec.summaryId) : "",
        pageNo: 1,
        pageSize: MAX_PAGE_SIZE,
      };
    } else {
      if (rec.summaryId) bodyObj.weekId = String(rec.summaryId);
      bodyObj.pageNo = 1;
      var curSize = Number(bodyObj.pageSize);
      // 平台原本帶更大就尊重佢；否則一律拉高。
      bodyObj.pageSize =
        isFinite(curSize) && curSize > MAX_PAGE_SIZE ? curSize : MAX_PAGE_SIZE;
    }

    // 照抄攔截到嘅標頭（已過 FORBIDDEN_HEADER 濾）；唔可以自己組 —— 簽章喺裡面。
    var headers = {};
    var src = rec.headers || {};
    Object.keys(src).forEach(function (k) {
      if (!FORBIDDEN_HEADER.test(k)) headers[k] = src[k];
    });
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
    }

    var dbg = {
      requestUrl: url,
      requestBody: JSON.stringify(bodyObj).slice(0, 600),
      headerKeys: Object.keys(headers),
      hasSignature: Object.keys(headers).some(function (k) {
        return /^x-ca-|signature|nonce|timestamp|token|authorization/i.test(k);
      }),
    };

    // 🔴 分頁：平台 `_get-order-summary-list` 回 `{ result:[...], total:N }`。
    //    要拎齊，所以要續頁直到夠數或空頁（同 bridge 舊寫法一致）。
    var all = [];
    var page = 1;
    var MAX_PAGES = 40;
    // 🔴 2026-09-28 第八次真機：降級狀態。
    //    `MAX_PAGE_SIZE` 若被平台拒收，要逐級下調**重試同一頁**，
    //    而唔係當整次重放失敗（咁樣就會靜默少一大截數）。
    var sizeIdx = 0;
    var downgrades = 0;
    var MAX_DOWNGRADES = PAGE_SIZE_LADDER.length - 1;

    var runPage = function () {
      return doFetch(url, {
        method: rec.method || "POST",
        headers: headers,
        body: JSON.stringify(bodyObj),
        credentials: "include",
      }).then(
        function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) {
              // 🔴 2026-09-28 第八次真機：`pageSize` 設太大被拒 → **降級重試同一頁**。
              //    判斷條件：當前 pageSize 仲有得降（階梯未到底）。
              //    ⚠️ 只對「標準 HTTP 錯誤碼」降級；`Failed to fetch`（簽章問題）
              //       係另一回事，降級都冇用，唔應該浪費請求。
              if (
                r.status >= 400 &&
                r.status < 500 &&
                downgrades < MAX_DOWNGRADES &&
                Number(bodyObj.pageSize) > PAGE_SIZE_LADDER[sizeIdx + 1]
              ) {
                sizeIdx += 1;
                downgrades += 1;
                bodyObj.pageSize = PAGE_SIZE_LADDER[sizeIdx];
                // 保留原頁（唔可以跳頁，否則會漏）
                return runPage();
              }
              var msg = "HTTP " + r.status + "｜" + url;
              try {
                var j = JSON.parse(txt);
                var detail = (j && (j.message || j.msg || j.error || j.desc)) || "";
                if (detail) msg += "｜平台回：" + String(detail).slice(0, 200);
              } catch (e) {
                if (txt) msg += "｜平台回：" + String(txt).slice(0, 200);
              }
              if (downgrades > 0) {
                msg += "｜已由 " + MAX_PAGE_SIZE + " 降級至 " + PAGE_SIZE_LADDER[sizeIdx] + " 仍失敗";
              }
              return { ok: false, reason: msg, status: r.status };
            }
            var body = null;
            try {
              body = JSON.parse(txt);
            } catch (e) {
              body = null;
            }
            if (!body) {
              // 🔴 回應唔係 JSON 都當「pageSize 太大」嘅一種（平台可能回 HTML 錯誤頁）
              if (downgrades < MAX_DOWNGRADES) {
                sizeIdx += 1;
                downgrades += 1;
                bodyObj.pageSize = PAGE_SIZE_LADDER[sizeIdx];
                return runPage();
              }
              return { ok: false, reason: "平台回應不是 JSON｜" + String(txt).slice(0, 200), status: r.status };
            }
            var container = body.data && typeof body.data === "object" ? body.data : body;
            var rows = container.result || container.records || container.list || [];
            if (!Array.isArray(rows)) rows = [];
            for (var i = 0; i < rows.length; i++) all.push(rows[i]);
            var total = Number(container.total);
            // ⚠️ 用**實際生效**嘅 pageSize 判斷「是否最後一頁」——
            //    降級之後 bodyObj.pageSize 已經係新值，唔可以再用舊常數。
            var pageSize = Number(bodyObj.pageSize) || PAGE_SIZE_LADDER[sizeIdx];
            var enough =
              rows.length === 0 ||
              (isFinite(total) && total > 0 && all.length >= total) ||
              rows.length < pageSize;
            if (enough || page >= MAX_PAGES) {
              return {
                ok: true,
                transactions: all,
                pages: page,
                total: isFinite(total) ? total : null,
                // 🔴 帶出實際用嘅 pageSize —— 令「有冇拿到最大」可以喺 log 一眼驗證
                pageSize: pageSize,
                downgraded: downgrades,
              };
            }
            page += 1;
            bodyObj.pageNo = page;
            return runPage();
          });
        },
        function (err) {
          // 🔴🔴 2026-09-28 第十五次真機：**呢條路（主動重放）根本行唔通**。
          //
          //    真機 Console 實證：
          //      Access to fetch at 'https://management-api.mfoodapp.com/merchants/
          //      summarys/summary/_get-order-summary-list' from origin
          //      'https://merchant.mfoodapp.com' has been blocked by CORS policy:
          //      Response to preflight request doesn't pass access control check:
          //      The value of the 'Access-Control-Allow-Origin' header in the response
          //      must not be the wildcard '*' when the request's credentials mode
          //      is 'include'.
          //      mfood-inject.js:1335 POST … net::ERR_FAILED
          //
          //    根因：**跨域 ＋ `credentials:'include'` ＋ 平台回 `ACAO:*`**
          //        ＝ 瀏覽器規範上一定拒絕（wildcard 唔可以配 credentials）。
          //        `net::ERR_FAILED` 就係呢個 CORS 拒絕嘅外表，
          //        同簽章問題嘅 `Failed to fetch` **症狀相似但成因唔同**。
          //
          //    ⇒ 唔可以再叫使用者查簽章／標頭 —— 佢永遠都解決唔到。
          //      唯一可行：**叫頁面自己發**（同源，唔受 CORS 限制），
          //      我哋只搭便車。呢度一定要明確講出呢件事，
          //      令任何睇 log 嘅人（包括將來嘅我）唔會再白查一輪。
          //
          //    ⚠️ 實作位置好緊要：呢個 handler 係 `.then(onOk, onErr)` 嘅**第二個參數**，
          //       所以後面再加 `.catch()` **永遠唔會執行**（rejection 已被呢度消化）。
          //       一定要改喺呢度。
          var em = err && err.message ? String(err.message) : String(err);
          var isCors =
            /CORS|Access-Control-Allow-Origin|cross-origin/i.test(em) ||
            /net::ERR_FAILED/i.test(em);

          if (isCors) {
            // ⚠️ 用 `window.location` 而唔係裸 `location`：
            //    測試 vm sandbox 只有 `window`，冇全域 `location`
            //    （同檔其他地方亦有同樣注意，見 L574 附近嘅註釋）。
            var pgOrigin = "";
            try {
              pgOrigin = (window && window.location && window.location.origin) || "";
            } catch (e) {
              pgOrigin = "";
            }
            return {
              ok: false,
              reason:
                "⚠️ 主動重放**永遠冇得救**（CORS 拒絕）：本請求由頁面 origin '" +
                pgOrigin +
                "' 發出並帶 `credentials:include`，但平台回 `Access-Control-Allow-Origin: *`" +
                " ⇒ 瀏覽器規範上一定拒絕（wildcard 唔可以配 credentials）。" +
                "｜正解：**改用「代撳頁面 UI」讓頁面自己發請求**，我哋搭便車複製回應。" +
                "｜URL " +
                url,
              networkError: true,
              corsBlocked: true,
              errorName: err && err.name ? String(err.name) : null,
            };
          }

          // 其他網絡層錯誤：區分 `Failed to fetch`（簽章／閘道／網絡）同其他。
          return {
            ok: false,
            reason:
              "請求失敗: " +
              em +
              "｜URL " +
              url +
              "｜標頭 " +
              dbg.headerKeys.join(",") +
              (dbg.hasSignature ? "（含簽章）" : "（⚠️ 冇簽章標頭 —— 閘道會拒收）"),
            networkError: true,
            corsBlocked: false,
            errorName: err && err.name ? String(err.name) : null,
          };
        },
      );
    };

    runPage().then(function (res) {
      var out = {
        reqId: reqId,
        ok: !!res.ok,
        transactions: res.transactions || [],
        pages: res.pages || 0,
        total: res.total == null ? null : res.total,
        reason: res.reason || null,
        status: res.status == null ? null : res.status,
        requestUrl: dbg.requestUrl,
        requestBody: dbg.requestBody,
        headerKeys: dbg.headerKeys,
        hasSignature: dbg.hasSignature,
        // 🔴 2026-09-28 第八次真機：實際用嘅 pageSize ＋ 有冇降級
        //    —— 令「有冇拿到最大 pageSize」可以喺 popup / log 一眼驗證。
        pageSize: res.pageSize == null ? null : res.pageSize,
        downgraded: res.downgraded || 0,
        // 🔴 2026-09-28 第十五次真機：標明係 CORS 擋死（唔係簽章／標頭問題）。
        //    任何呼叫端見到呢個旗標就應該**放棄重放**，改用「代撳 UI」。
        corsBlocked: !!res.corsBlocked,
      };
      postFinance("finance_replay_result", out, { transport: "replay" });
    });
  }

  // ---- 攔截 fetch ----------------------------------------------------------

  var originalFetch = window.fetch;

  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      var url = "";
      var method = "GET";
      try {
        url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
        method = (init && init.method) || (input && input.method) || "GET";
      } catch (_) {
        url = "";
      }

      if (DETAIL_URL_RE.test(url)) {
        captureDetailRequest(url, method, init && init.headers, init && init.body);
      }

      if (LIST_URL_RE.test(url)) {
        captureListRequest(url, method, init && init.headers, init && init.body);
      }

      if (isFinanceUrl(url)) {
        captureFinanceRequest(url, method, init && init.headers, init && init.body);
      }

      var promise = originalFetch.apply(this, arguments);

      return promise.then(
        function (response) {
          try {
            var ct = "";
            try {
              ct = response.headers.get("content-type") || "";
            } catch (_) {
              ct = "";
            }
            if (ct && ct.indexOf("json") === -1 && ct.indexOf("text") === -1) return response;

            response
              .clone()
              .json()
              .then(function (body) {
                // 🔴 財務頁請求要**完全隔離**：唔可以跌落訂單管道。
                //    財務頁嘅 transaction detail 形狀同訂單詳情有機會撞
                //    （都有 id / tradeNo），一旦被當 order_detail 就會
                //    污染訂單擷取（送去 POS 一批唔係訂單嘅財務列）。
                if (isFinanceUrl(url)) {
                  captureFinanceResponse(url, body);
                  return;
                }
                var kind = classify(body);
                if (kind) {
                  handle(kind, url, body, { transport: "fetch", method: method });
                }
              })
              .catch(function () {
                /* 不是 JSON，忽略 */
              });
          } catch (err) {
            console.warn(TAG, "response clone failed", err);
          }
          return response;
        },
        function (error) {
          throw error;
        },
      );
    };
  }

  // ---- 攔截 XHR ------------------------------------------------------------

  var OriginalXHR = window.XMLHttpRequest;

  if (OriginalXHR && OriginalXHR.prototype) {
    var originalOpen = OriginalXHR.prototype.open;
    var originalSend = OriginalXHR.prototype.send;
    var originalSetHeader = OriginalXHR.prototype.setRequestHeader;

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__mfoodGrabber = {
          method: method,
          url: String(url),
          headers: {},
          isDetail: DETAIL_URL_RE.test(String(url)),
          isList: LIST_URL_RE.test(String(url)),
        };
      } catch (_) {
        this.__mfoodGrabber = null;
      }
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__mfoodGrabber) this.__mfoodGrabber.headers[name] = value;
      } catch (_) {
        /* 忽略 */
      }
      return originalSetHeader.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function (body) {
      var info = this.__mfoodGrabber;

      if (info && info.isDetail) {
        captureDetailRequest(info.url, info.method, info.headers, body);
      }

      if (info && info.isList) {
        captureListRequest(info.url, info.method, info.headers, body);
      }

      if (info && isFinanceUrl(info.url)) {
        captureFinanceRequest(info.url, info.method, info.headers, body);
      }

      if (info) {
        var self = this;
        this.addEventListener("load", function () {
          try {
            var parsed = null;
            if (self.responseType === "json") {
              parsed = self.response;
            } else if (self.responseType === "" || self.responseType === "text") {
              var text = self.responseText;
              if (text && text.length < 5 * 1024 * 1024) parsed = JSON.parse(text);
            }
            if (parsed) {
              // 🔴 同 fetch 側一樣：財務請求完全隔離，唔可以當訂單處理。
              if (isFinanceUrl(info.url)) {
                captureFinanceResponse(info.url, parsed);
              } else {
                var kind = classify(parsed);
                if (kind) {
                  handle(kind, info.url, parsed, {
                    transport: "xhr",
                    method: info.method,
                    status: self.status,
                  });
                }
              }
            }
          } catch (_) {
            /* 非 JSON，忽略 */
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }

  console.log(TAG, "installed on", window.location.href);
  post("ready", { href: window.location.href }, {});
})();
