/**
 * mfood-inject.js 的詳情重放測試
 *
 * 為什麼需要這支測試：
 *   mfood 的詳情 API 帶 Alibaba 閘道簽章（x-ca-key / x-ca-nonce /
 *   x-ca-timestamp / x-ca-signature）。我先前誤判「沒有簽章」而做了
 *   一個自己組的內建規格 —— 那個請求沒有任何認證標頭，必定失敗。
 *
 *   現在的做法是「照抄擷取到的真實請求，只換 body 裡的 orderId」，
 *   因為 Alibaba 的 StringToSign 不含 request body，而 orderId 放在 body。
 *   這支測試就是鎖住這個契約。
 *
 * 執行：node test/mfood-inject.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INJECT = path.join(__dirname, "..", "mfood-inject.js");

const DETAIL_URL = "https://management-api.mfoodapp.com/merchants/takeouts/order/_get";

function detailBody(id) {
  return JSON.stringify({
    id,
    tradeNo: "CRD" + id,
    amtn: 53.9,
    prdtList: [{ productName: "表嫂手打肉餅", buyCount: 1, skuPrice: 58 }],
  });
}

/** 擷取到的真實請求長相（取自使用者診斷，值已換成假字串） */
const REAL_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json;charset=utf-8",
  "x-token": "TOKEN_ABC123",
  "x-merchant": "202208171125016609774",
  "x-client": "web",
  "x-scope": "manager-merchant",
  "x-device-id": "2a9f358a-3408-44a3-9d75-0c9c946e9495",
  "x-client-version": "9.0.0",
  "x-ca-key": "83579288",
  "x-ca-timestamp": "1790169092563",
  "x-ca-nonce": "abcdef0123456789abcdef0123456789",
  "x-ca-signature": "U0lHTkFUVVJFX0FCQzEyMzQ1Njc4OTA=",
};

function loadInject(opts) {
  opts = opts || {};
  const posted = [];
  const fetchCalls = [];
  let msgListener = null;
  let nextBody = opts.responseText || detailBody("AAA");

  const windowObj = {
    location: {
      href: "https://merchant.mfoodapp.com/#/trade/tackout",
      origin: "https://merchant.mfoodapp.com",
    },
    addEventListener(type, fn) {
      if (type === "message") msgListener = fn;
    },
    postMessage(msg) {
      posted.push(msg);
    },
  };

  windowObj.fetch = function (url, init) {
    fetchCalls.push({ url: String(url), init: init || {} });
    // 🔴 2026-09-28 第十五次真機：容許測試令 fetch **拋錯**。
    //    真機嘅 CORS 拒絕外表就係 `TypeError: Failed to fetch`
    //    （或者 console 見 `net::ERR_FAILED`）—— 呢個係「網絡層失敗」，
    //    **唔會**回 HTTP 狀態碼，所以 `opts.httpOk !== false` 呢條路測唔到。
    //    ⇒ 要一個獨立鈎子先驗得到 CORS 分支。
    if (opts.fetchError) return Promise.reject(opts.fetchError);
    const text = nextBody;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    const res = {
      ok: opts.httpOk !== false,
      status: opts.status || 200,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(parsed),
      headers: { get: () => "application/json" },
      clone() {
        return res;
      },
    };
    return Promise.resolve(res);
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: windowObj,
    fetch: windowObj.fetch,
    Headers: function Headers() {},
    FormData: function FormData() {},
    Promise,
    setTimeout,
    clearTimeout,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    Date,
    isFinite,
    parseInt,
    parseFloat,
    RegExp,
    Set,
    Map,
    URLSearchParams,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(INJECT, "utf8"), sandbox, { filename: "mfood-inject.js" });

  function command(cmd) {
    if (!msgListener) throw new Error("inject 沒有註冊 message listener");
    msgListener({ source: windowObj, data: Object.assign({ __mfoodCmd: true }, cmd) });
  }

  /** 模擬「頁面自己點開一筆詳情」→ 讓 inject 擷取範本 */
  function captureTemplate(id) {
    nextBody = detailBody(id);
    return windowObj.fetch(DETAIL_URL, {
      method: "POST",
      headers: Object.assign({}, REAL_HEADERS),
      body: JSON.stringify({ id }),
      credentials: "include",
    });
  }

  /** 擷取範本之後，改掉之後的回應內容（模擬伺服器回錯） */
  function setResponse(text, ok, status) {
    nextBody = text;
    opts.responseText = text;
    opts.httpOk = ok;
    opts.status = status;
  }

  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 80));

  /** 直接改「下一次」回應內容（模擬平台回傳指定 JSON）。 */
  function setNextBody(_inj, obj) {
    nextBody = typeof obj === "string" ? obj : JSON.stringify(obj);
  }

  /**
   * 令之後嘅 fetch 拋出指定錯誤（模擬網絡層失敗／CORS 拒絕）。
   *
   * 🔴 為什麼要：CORS 失敗**唔會**有 HTTP 狀態碼，係 `Promise.reject`。
   *    用 `opts.httpOk` 模擬唔到（嗰個係「有回應但狀態碼唔係 2xx」）。
   */
  function setFetchError(err) {
    opts.fetchError = err || new TypeError("Failed to fetch");
  }

  /** 清除 fetch 錯誤（恢復正常回應）。 */
  function clearFetchError() {
    opts.fetchError = null;
  }

  return {
    posted,
    fetchCalls,
    command,
    tick,
    captureTemplate,
    setResponse,
    setNextBody,
    setFetchError,
    clearFetchError,
    window: windowObj,
  };
}

/**
 * 模擬「頁面自己發一個請求」。
 *
 * 🔴 一定要經 `windowObj.fetch`（被 inject 包裝過嗰個），
 *    唔可以直接呼叫沙箱內嘅 fetch —— 咁樣就繞過攔截，測唔到任何嘢。
 */
function window0(inj, url, init) {
  return inj.window.fetch(url, Object.assign({ credentials: "include" }, init || {}));
}

// ------------------------------------------------------------ 斷言

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  \u2713 ${label}`); }
  else {
    failed++;
    console.log(`  \u2717 ${label}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      實際: ${JSON.stringify(actual)}`);
  }
}

function group(n) { console.log(`\n${n}`); }

// ------------------------------------------------------------ 測試

(async () => {

  group("[1] 🔴 沒有範本時，不可以自己亂組請求");
  {
    const inj = loadInject();
    inj.command({ cmd: "fetch_detail", orderId: "BBB", reqId: "r1" });
    await inj.tick();

    check("沒有發出任何請求（不猜）", inj.fetchCalls.length, 0);

    const rr = inj.posted.find((m) => m.kind === "replay_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check(
      "原因說明要先去擷取範本",
      !!(rr && rr.payload && String(rr.payload.reason).indexOf("範本") >= 0),
      true,
    );
  }

  group("[2] 🔴 有範本時，標頭要「原樣照抄」");
  {
    const inj = loadInject();
    await inj.captureTemplate("AAA");
    await inj.tick(120);

    const tplMsg = inj.posted.find((m) => m.kind === "template");
    check("有回報擷取到範本", !!tplMsg, true);
    check("範本的 sampleId 正確", tplMsg && tplMsg.payload.sampleId, "AAA");

    inj.fetchCalls.length = 0; // 清掉擷取時那次
    inj.posted.length = 0; // 也清掉擷取時發出的 order_detail

    inj.command({ cmd: "fetch_detail", orderId: "BBB", reqId: "r2" });
    await inj.tick(120);

    check("有發出重放請求", inj.fetchCalls.length, 1);
    const c = inj.fetchCalls[0] || { url: "", init: {} };
    const h = c.init.headers || {};

    check("URL 不變", c.url, DETAIL_URL);
    check("method 不變", c.init.method, "POST");
    check("🔴 body 換成新的 id", c.init.body, '{"id":"BBB"}');

    check("🔴 簽章原樣照抄（不可自行重算）", h["x-ca-signature"], REAL_HEADERS["x-ca-signature"]);
    check("nonce 原樣照抄", h["x-ca-nonce"], REAL_HEADERS["x-ca-nonce"]);
    check("timestamp 原樣照抄", h["x-ca-timestamp"], REAL_HEADERS["x-ca-timestamp"]);
    check("x-token 原樣照抄", h["x-token"], REAL_HEADERS["x-token"]);
    check("x-merchant 原樣照抄", h["x-merchant"], REAL_HEADERS["x-merchant"]);
    check("Content-Type 保留", h["Content-Type"], REAL_HEADERS["Content-Type"]);

    check("帶 cookie（credentials include）", c.init.credentials, "include");

    const rr = inj.posted.find((m) => m.kind === "replay_result" && m.payload.reqId === "r2");
    check("回報成功", !!(rr && rr.payload.ok), true);
    check("標明來源為範本", rr && rr.payload.via, "template");

    const details = inj.posted.filter((m) => m.kind === "order_detail");
    check("詳情只送一次（不可重複）", details.length, 1);
  }

  group("[3] 回應不是訂單詳情 → 回報失敗，不得誤送");
  {
    const inj = loadInject();
    await inj.captureTemplate("AAA");
    await inj.tick(140);

    // 範本已就緒；之後伺服器改回錯誤內容
    inj.setResponse('{"errorCode":"unauthorized","msg":"not logged in"}', true, 200);
    inj.posted.length = 0;
    inj.fetchCalls.length = 0;

    inj.command({ cmd: "fetch_detail", orderId: "ZZZ", reqId: "r3" });
    await inj.tick(140);

    check("有發出重放請求", inj.fetchCalls.length, 1);
    const rr = inj.posted.find((m) => m.kind === "replay_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check("有失敗原因", !!(rr && rr.payload && rr.payload.reason), true);
    check("沒有誤送詳情", inj.posted.filter((m) => m.kind === "order_detail").length, 0);
  }

  group("[4] HTTP 401 要回報失敗");
  {
    const inj = loadInject();
    await inj.captureTemplate("AAA");
    await inj.tick(140);

    inj.setResponse("Unauthorized", false, 401);
    inj.posted.length = 0;

    inj.command({ cmd: "fetch_detail", orderId: "BBB", reqId: "r4" });
    await inj.tick(140);

    const rr = inj.posted.find((m) => m.kind === "replay_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check(
      "原因含狀態碼",
      !!(rr && rr.payload && String(rr.payload.reason).indexOf("401") >= 0),
      true,
    );
    check("沒有誤送詳情", inj.posted.filter((m) => m.kind === "order_detail").length, 0);
  }

  group("[5] 未知命令不應觸發任何事");
  {
    const inj = loadInject();
    inj.command({ cmd: "unknown_cmd" });
    await inj.tick();
    check("沒有發出請求", inj.fetchCalls.length, 0);
  }

  // ════════════════════════════════════════════════════════════════════
  //  財務頁（2026-09-28 新增）
  //  ───────────────────────────────────────────────────────────────────
  //  真機實測：財務頁係 Vue 3，`__vue__` 唔存在 ⇒ 帳期 id（summaryId）
  //  唔可能由 DOM 撈。唯一可靠來源 ＝ 攔截平台自己發嘅請求。
  // ════════════════════════════════════════════════════════════════════

  const FIN_DETAIL_URL =
    "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list?pageNo=1&pageSize=50&summaryId=SUM-7788";

  group("[6] 🔴 攔截財務 detail 請求 → post 出 summaryId（唔靠 Vue）");
  {
    const inj = loadInject();
    // 模擬平台自己按「查看詳情」時發嘅請求
    await window0(inj, FIN_DETAIL_URL);
    await inj.tick(120);

    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("有 post finance_request", !!ev, true);
    check("🔴 撈到 summaryId（由 URL query）", ev && ev.payload.summaryId, "SUM-7788");
    check("分類為 detail", ev && ev.payload.kind, "detail");
    check(
      "🔴 走獨立命名空間（唔可以污染 __mfoodGrabber）",
      !!(ev && ev.__mfoodFinance === true && ev.__mfoodGrabber === undefined),
      true,
    );
  }

  group("[7] 🔴 財務請求唔可以當成訂單列表／詳情處理");
  {
    const inj = loadInject();
    await window0(inj, FIN_DETAIL_URL);
    await inj.tick(120);
    check(
      "冇任何 order_list / order_detail 事件（唔可以污染訂單管道）",
      inj.posted.filter((m) => m.kind === "order_list" || m.kind === "order_detail").length,
      0,
    );
  }

  group("[8] 🔴 bridge 問「上次 summaryId」要答得出（TTL 內）");
  {
    const inj = loadInject();
    await window0(inj, FIN_DETAIL_URL);
    await inj.tick(120);

    inj.posted.length = 0;
    inj.command({ cmd: "finance_last_request" });
    await inj.tick(80);

    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_last_request",
    );
    check("有回覆 finance_last_request", !!ev, true);
    check("帶返 summaryId", ev && ev.payload.summaryId, "SUM-7788");
  }

  group("[9] 🔴 冇攔截過就唔可以亂答一個 id");
  {
    const inj = loadInject();
    inj.command({ cmd: "finance_last_request" });
    await inj.tick(80);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_last_request",
    );
    check("有回覆", !!ev, true);
    check("🔴 summaryId 為 null（唔可以猜）", ev && ev.payload.summaryId, null);
  }

  group("[10] 🔴 帳期列表回應要抽出每個帳期 id");
  {
    const inj = loadInject();
    const listUrl =
      "https://management-api.mfoodapp.com/merchants/summarys/summary/_list?pageNo=1&pageSize=20";
    // 模擬平台查詢帳期列表
    inj.setNextBody(inj, {
      result: [
        { id: "SUM-A", period: "2026-09-01 ~ 2026-09-15" },
        { id: "SUM-B", period: "2026-09-16 ~ 2026-09-30" },
      ],
      total: 2,
    });
    await window0(inj, listUrl);
    await inj.tick(150);

    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_periods");
    check("有 post finance_periods", !!ev, true);
    check("抽出兩個帳期 id", ev && ev.payload.periods.length, 2);
    check("第一個 id 正確", ev && ev.payload.periods[0].id, "SUM-A");
    check("第二個 id 正確", ev && ev.payload.periods[1].id, "SUM-B");
  }

  group("[10b] 🔴 帳期列表回應用非標準欄位名（detailMsg.list）都要抽到");
  {
    // 真機 2026-09-28：`_list` 回應可能包喺 `detailMsg.list`，或者每項嘅 id
    // 唔叫 `id`/`summaryId`/`pk` 而叫其他名（例如 `summaryNo`）。
    // 舊寫法只認 result/records/list/rows/data + id/summaryId/pk ⇒ 抽唔到，
    // `periods.count` 永遠 0 ⇒ 失去重要 fallback。
    const inj = loadInject();
    const listUrl = "https://management-api.mfoodapp.com/merchants/summarys/summary/_list";
    inj.setNextBody(inj, {
      resultCode: "200",
      detailMsg: {
        list: [
          { summaryNo: "REAL-1", period: "2026-09-01 ~ 2026-09-15" },
          { summaryNo: "REAL-2", period: "2026-09-16 ~ 2026-09-30" },
        ],
      },
    });
    await window0(inj, listUrl, { method: "POST", body: "{}" });
    await inj.tick(150);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_periods");
    check("有 post finance_periods", !!ev, true);
    check("🔴 包喺 detailMsg.list 都抽到", ev && ev.payload.periods.length, 2);
    check("🔴 非標準 id 欄位（summaryNo）都抽到", ev && ev.payload.periods[0].id, "REAL-1");
  }

  group("[10c] 🔴🔴 帳期列嘅 details[] 一定要原樣帶出（2026-09-28 第十一次真機）");
  {
    // 使用者要求：「唔好配對，先將所有訂單拿喺手」。
    // 帳期列每條都可能有 `details[]`（逐日／逐筆小計）。舊寫法只帶 id + raw 而
    // **raw 有帶**，但 bridge 側收到嘅 `details` 曾實測係空 —— 呢個測試鎖死
    // 「details 一定要原樣落到 payload」，防止日後 refactor 又靜默掉。
    const inj = loadInject();
    const listUrl = "https://management-api.mfoodapp.com/merchants/summarys/summary/_list";
    inj.setNextBody(inj, {
      result: [
        {
          id: "SUM-X",
          period: "2026-09-16 ~ 2026-09-30",
          subsidyStoreReceiveAmtn: 1212.37,
          details: [
            { day: "2026-09-16", subsidyStoreReceiveAmtn: 100.5 },
            { day: "2026-09-17", subsidyStoreReceiveAmtn: 200.25 },
          ],
        },
      ],
      total: 1,
    });
    await window0(inj, listUrl, { method: "POST", body: "{}" });
    await inj.tick(150);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_periods");
    check("有 post finance_periods", !!ev, true);
    const p0 = ev && ev.payload.periods[0];
    check("🔴 details 原樣帶出（2 條）", p0 && Array.isArray(p0.details) && p0.details.length, 2);
    check(
      "🔴 details 金額冇被改寫",
      p0 && p0.details && p0.details[0] && p0.details[0].subsidyStoreReceiveAmtn,
      100.5,
    );
    check("🔴 raw 亦保留（俾 bridge 解析帳期文字）", !!(p0 && p0.raw), true);
  }

  group("[10d] 🔴🔴 明細回應要原樣記錄（rawResult ＋ firstRowKeys）");
  {
    // 同一原則：明細列唔可以篩欄位。`rawResult` 要係**完整**陣列。
    const inj = loadInject();
    const detailUrl =
      "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list";
    inj.setNextBody(inj, {
      result: [
        {
          tradeNo: "CRD202609161003178839221",
          subsidyStoreReceiveAmtn: 45.6,
          storeReceiveAmtn: 50,
          weekId: "202609170106005576278",
        },
      ],
      total: 1,
    });
    await window0(inj, detailUrl, { method: "POST", body: JSON.stringify({ weekId: "W1" }) });
    await inj.tick(150);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_detail_captured",
    );
    check("有 post finance_detail_captured", !!ev, true);
    check("🔴 rawResult 係完整陣列（1 條）", ev && Array.isArray(ev.payload.rawResult) && ev.payload.rawResult.length, 1);
    check(
      "🔴 rawResult 保留平台全部欄位（tradeNo）",
      ev && ev.payload.rawResult && ev.payload.rawResult[0] && ev.payload.rawResult[0].tradeNo,
      "CRD202609161003178839221",
    );
    check(
      "🔴 firstRowKeys 有列全部欄位名",
      ev && Array.isArray(ev.payload.firstRowKeys) && ev.payload.firstRowKeys.includes("tradeNo"),
      true,
    );
  }

  group("[11] 🔴 summaryId 喺 body 都要撈到（唔止 query）");
  {
    const inj = loadInject();
    const url = "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list";
    // 模擬寫成 POST + body 嘅版本
    await window0(inj, url, {
      method: "POST",
      body: JSON.stringify({ summaryId: "BODY-9999", pageNo: 1 }),
    });
    await inj.tick(120);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("🔴 由 body 撈到 summaryId", ev && ev.payload.summaryId, "BODY-9999");
  }

  group("[12] 🔴 訂單端點唔可以被當成財務請求（會斷訂單流）");
  {
    const inj = loadInject();
    // 呢條係訂單列表 API（`mfood-inject` 嘅命脈）
    const orderListUrl =
      "https://management-api.mfoodapp.com/merchants/takeouts/order/_list-amtn";
    inj.setNextBody(inj, {
      result: [{ tradeNo: "T1", amtn: 10 }],
      total: 1,
    });
    await window0(inj, orderListUrl, {
      method: "POST",
      body: JSON.stringify({ startTime: 1, endTime: 2 }),
    });
    await inj.tick(150);

    check(
      "🔴 訂單列表照樣被處理（冇被財務邏輯攔截）",
      inj.posted.some((m) => m.kind === "order_list"),
      true,
    );
    check(
      "🔴 冇誤報成財務請求",
      inj.posted.filter((m) => m.__mfoodFinance === true && m.kind === "finance_request").length,
      0,
    );
  }

  group("[13] 🔴 訂單詳情端點亦唔可以跌入財務管道");
  {
    const inj = loadInject();
    await inj.captureTemplate("AAA");
    await inj.tick(140);
    await window0(inj, DETAIL_URL, {
      method: "POST",
      headers: Object.assign({}, REAL_HEADERS),
      body: JSON.stringify({ id: "AAA" }),
    });
    await inj.tick(140);
    check(
      "🔴 訂單詳情照樣被處理",
      inj.posted.some((m) => m.kind === "order_detail"),
      true,
    );
    check(
      "冇財務事件",
      inj.posted.filter((m) => m.__mfoodFinance === true && m.kind === "finance_request").length,
      0,
    );
  }

  group("[14] 🔴 診斷帳本要記低所有見過嘅財務 URL");
  {
    const inj = loadInject();
    await window0(inj, FIN_DETAIL_URL);
    await inj.tick(120);
    inj.posted.length = 0;
    inj.command({ cmd: "finance_last_request" });
    await inj.tick(80);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_last_request",
    );
    check("回覆帶 seenUrls", !!(ev && Array.isArray(ev.payload.seenUrls)), true);
    check(
      "帳本有記低 detail URL",
      !!(ev && ev.payload.seenUrls.some((s) => /_get-order-summary-list/.test(s.url))),
      true,
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  財務頁（2026-09-28 第二次真機修正）
  //  ───────────────────────────────────────────────────────────────────
  //  真機第二次診斷暴露兩個致命問題：
  //   ① `_get-order-summary-data`（平台真正發嘅 detail）被誤判成帳期列表，
  //      因為舊 regex `summarys\/summary(_list)?` 會 match `summary/_get-order-…`
  //      ⇒ detail 請求走入 `extractPeriodIds` 然後 return，永遠到唔到 detail 分支。
  //   ② 撳一次「查看詳情」會發**多個**財務請求，帶 id 嗰個未必係最後一個。
  // ════════════════════════════════════════════════════════════════════

  const FIN_DATA_URL =
    "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-data";

  group("[15] 🔴 `_get-order-summary-data` 唔可以被當成帳期列表");
  {
    const inj = loadInject();
    // 模擬平台真正發嘅 detail 請求（POST + body，唔帶 query summaryId）
    inj.setNextBody(inj, { result: [], total: 0 });
    await window0(inj, FIN_DATA_URL, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await inj.tick(150);

    const fin = inj.posted.filter((m) => m.__mfoodFinance === true);
    const periods = fin.filter((m) => m.kind === "finance_periods");
    const detail = fin.filter((m) => m.kind === "finance_detail_captured");
    check("🔴 唔可以被當成帳期列表（唔可以 post finance_periods）", periods.length, 0);
    check("🔴 要當成 detail 處理（有 post finance_detail_captured）", detail.length, 1);
  }

  group("[16] 🔴 summaryId 喺巢狀 body 都要撈到");
  {
    const inj = loadInject();
    await window0(inj, FIN_DATA_URL, {
      method: "POST",
      // 真機可能包一層：{"data":{"summaryId":"..."}}
      body: JSON.stringify({ pageNo: 1, data: { summaryId: "NEST-4321" } }),
    });
    await inj.tick(120);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("🔴 由巢狀 body 撈到 summaryId", ev && ev.payload.summaryId, "NEST-4321");
  }

  group("[17] 🔴 撳一次會發多個請求 → 帶 id 嗰個唔係最後一個都要捉到");
  {
    const inj = loadInject();
    // 先發一個唔帶 id 嘅（例如 _list）
    await window0(inj, "https://management-api.mfoodapp.com/merchants/summarys/summary/_list", {
      method: "POST",
      body: JSON.stringify({ pageNo: 1 }),
    });
    await inj.tick(60);
    // 再發一個帶 id 嘅（_get-order-summary-data）
    await window0(inj, FIN_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ periodId: "PERIOD-888" }),
    });
    await inj.tick(60);
    // 最後再發一個唔帶 id 嘅（_get-order-summary-list，冇 summaryId）
    await window0(inj, FIN_DETAIL_URL.split("?")[0], {
      method: "POST",
      body: JSON.stringify({ pageNo: 1 }),
    });
    await inj.tick(120);

    const reqs = inj.posted.filter(
      (m) => m.__mfoodFinance === true && m.kind === "finance_request",
    );
    check("🔴 三個請求都要 post（唔可以只留最後一個）", reqs.length, 3);
    check(
      "🔴 帶 id 嗰個（periodId → PERIOD-888）要被撈到",
      reqs.some((m) => m.payload.summaryId === "PERIOD-888"),
      true,
    );
  }

  group("[18] 🔴 診斷帳本要連 body 同 body key 路徑一齊記");
  {
    const inj = loadInject();
    await window0(inj, FIN_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ pageNo: 1, data: { summaryId: "NEST-4321" } }),
    });
    await inj.tick(120);
    inj.posted.length = 0;
    inj.command({ cmd: "finance_last_request" });
    await inj.tick(80);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_last_request",
    );
    const rec =
      ev && ev.payload.seenUrls && ev.payload.seenUrls.find((s) => /summary-data/.test(s.url));
    check("帳本有記低 `_get-order-summary-data`", !!rec, true);
    check("🔴 有記低 request body", !!(rec && typeof rec.lastBody === "string" && rec.lastBody), true);
    check(
      "🔴 有記低 body 嘅 key 路徑（一眼睇到 summaryId 擺喺邊）",
      !!(rec && Array.isArray(rec.bodyKeys) && rec.bodyKeys.some((k) => /summary/i.test(k.path))),
      true,
    );
  }

  group("[19] 🔴 真機 2026-09-28：帳期 id 嘅欄位名係 `weekId`");
  {
    // 真機實錄：`_list` 請求 body = {"weekId":"202609170106005576278","storeId":...}
    // 而 `_list` 回應 result[0].id 正是同一個值。
    // 舊寫法只認 summaryId/periodId/billId ⇒ 永遠撈唔到（三條路全滅）。
    const inj = loadInject();
    const listUrl = "https://management-api.mfoodapp.com/merchants/summarys/summary/_list";
    await window0(inj, listUrl, {
      method: "POST",
      body: JSON.stringify({
        weekId: "202609170106005576278",
        storeId: "STORE-1",
        startDate: 1789574400000,
        endDate: 1790870399999,
        fromMerchant: true,
      }),
    });
    await inj.tick(120);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("🔴 由 body 嘅 weekId 撈到帳期 id", ev && ev.payload.summaryId, "202609170106005576278");
  }

  group("[20] 🔴 `weekId` 喺巢狀 body 都要撈到（deepFind 要認 week 字根）");
  {
    const inj = loadInject();
    await window0(inj, FIN_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ pageNo: 1, query: { weekId: "NEST-WEEK-77" } }),
    });
    await inj.tick(120);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("🔴 巢狀 weekId 都撈到", ev && ev.payload.summaryId, "NEST-WEEK-77");
  }

  group("[21] 🔴 `weekId` 唔可以誤中無關欄位（weekday / weekLabel）");
  {
    const inj = loadInject();
    const listUrl = "https://management-api.mfoodapp.com/merchants/summarys/summary/_list";
    await window0(inj, listUrl, {
      method: "POST",
      // 冇任何 id；`weekday` / `weekTitle` 唔應該被當成 id
      body: JSON.stringify({ pageNo: 1, weekday: "3", weekTitle: "第 38 週" }),
    });
    await inj.tick(120);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_request");
    check("🔴 唔可以亂當 weekday 做帳期 id", ev && ev.payload.summaryId, null);
  }

  group("[22] 🔴 真機帳期列表回應（startDateStr/endDateStr）要抽出 id");
  {
    const inj = loadInject();
    const listUrl = "https://management-api.mfoodapp.com/merchants/summarys/summary/_list";
    inj.setNextBody(inj, {
      result: [
        {
          id: "202609170106005576278",
          startDateStr: "2026-09-16",
          endDateStr: "2026-09-30",
          status: "1",
          storeReceiveAmtn: 1212.37,
        },
      ],
      total: 1,
    });
    await window0(inj, listUrl, { method: "POST", body: JSON.stringify({ pageNo: 1 }) });
    await inj.tick(150);
    const ev = inj.posted.find((m) => m.__mfoodFinance === true && m.kind === "finance_periods");
    check("有 post finance_periods", !!ev, true);
    check("抽出帳期 id", ev && ev.payload.periods[0].id, "202609170106005576278");
    check(
      "raw 保留 startDateStr/endDateStr（供 bridge 配對）",
      !!(ev && ev.payload.periods[0].raw && ev.payload.periods[0].raw.startDateStr === "2026-09-16"),
      true,
    );
  }

  group("[23] 🔴🔴 財務請求要記低真實 host ＋ 路徑（重放唔可以靠 location.origin）");
  {
    // 2026-09-28 第五次真機 404 真兇：
    //   真機 host ＝ management-api.mfoodapp.com，頁面 origin ＝ merchant.mfoodapp.com
    //   ⇒ bridge 重放必須用**攔截到嘅 host**。
    //   呢個測試鎖住 `finance_request` 一定要帶 `origin` / `path`。
    const inj = loadInject();
    await window0(
      inj,
      "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
      {
        method: "POST",
        body: JSON.stringify({ weekId: "202609170106005576278", pageNo: 1, pageSize: 20 }),
      },
    );
    await inj.tick(150);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_request",
    );
    check("有 post finance_request", !!ev, true);
    check(
      "🔴🔴 記低真實 origin（management-api）",
      ev && ev.payload.origin,
      "https://management-api.mfoodapp.com",
    );
    check(
      "🔴 記低真實 path",
      ev && ev.payload.path,
      "/merchants/summarys/summary/_get-order-summary-list",
    );
    check("仍然抽到 summaryId", ev && ev.payload.summaryId, "202609170106005576278");
  }

  group("[24] 🔴🔴 財務請求要記低**簽章標頭**（否則重放 → Failed to fetch）");
  {
    // 2026-09-28 第六次真機：404 修好後變成 `Failed to fetch`。
    //   真兇 ＝ mfood 用 Alibaba 閘道簽章（x-ca-key/nonce/signature/timestamp）。
    //   重放一定要照抄呢啲標頭 ⇒ `finance_request` 必須帶 `headers`。
    //   ⚠️ 呢個坑訂單流程當年已踩過（`replayDetail` 註釋有記）。
    const inj = loadInject();
    await window0(
      inj,
      "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json;charset=UTF-8",
          "x-ca-key": "203800000",
          "x-ca-nonce": "abc123",
          "x-ca-timestamp": "1789488000000",
          "x-ca-signature": "SIG==",
          // 瀏覽器禁止自行設定嘅標頭 → 必須被濾走
          Cookie: "SESSION=xxx",
          Host: "management-api.mfoodapp.com",
        },
        body: JSON.stringify({ weekId: "W1", pageNo: 1, pageSize: 20 }),
      },
    );
    await inj.tick(150);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_request",
    );
    check("有 post finance_request", !!ev, true);
    const h = (ev && ev.payload.headers) || {};
    check("🔴🔴 記低 x-ca-signature", h["x-ca-signature"], "SIG==");
    check("🔴 記低 x-ca-key", h["x-ca-key"], "203800000");
    check("🔴 記低 x-ca-nonce", h["x-ca-nonce"], "abc123");
    check("🔴 偵測到有簽章（hasSignature）", ev && ev.payload.hasSignature, true);
    check("🔴 禁止標頭 Cookie 要被濾走", h["Cookie"], undefined);
    check("🔴 禁止標頭 Host 要被濾走", h["Host"], undefined);
  }

  group("[25] 🔴 冇簽章標頭時 hasSignature = false（唔可以扮有）");
  {
    const inj = loadInject();
    await window0(
      inj,
      "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: JSON.stringify({ weekId: "W1", pageNo: 1, pageSize: 20 }),
      },
    );
    await inj.tick(150);
    const ev = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_request",
    );
    check("🔴 hasSignature = false", ev && ev.payload.hasSignature, false);
  }

  group("[26] 🔴🔴 重放範本只認 `-list`（`-data` 後到唔可以覆蓋）");
  {
    // 真機同一輪有兩條 detail 類請求：
    //   `_get-order-summary-list`（明細，body 有 pageNo/pageSize）← 範本要用呢個
    //   `_get-order-summary-data`（匯總，body 冇 pageNo/pageSize）
    // 若 `-data` 後到就覆蓋範本 ⇒ 重放會打錯端點／缺分頁欄位。
    const inj = loadInject();
    const base = "https://management-api.mfoodapp.com/merchants/summarys/summary/";
    // 先 `-list`（帶 id）
    await window0(inj, base + "_get-order-summary-list", {
      method: "POST",
      headers: { "x-ca-signature": "S" },
      body: JSON.stringify({ weekId: "W-LIST", pageNo: 1, pageSize: 20, storeId: "S9" }),
    });
    await inj.tick(120);
    // 再 `-data`（**亦帶 id**）—— 舊寫法會覆蓋
    await window0(inj, base + "_get-order-summary-data", {
      method: "POST",
      headers: { "x-ca-signature": "S" },
      body: JSON.stringify({ weekId: "W-DATA" }),
    });
    await inj.tick(120);

    // 叫 MAIN world 重放，睇佢用邊條 URL
    const callsBefore = inj.fetchCalls.length;
    inj.command({ cmd: "finance_replay_list", reqId: "r1" });
    await inj.tick(300);
    const replay = inj.fetchCalls.slice(callsBefore).find((c) => /_get-order-summary/.test(c.url));
    check("🔴 有重放請求", !!replay, true);
    check(
      "🔴🔴 重放打 `-list`（唔可以係 `-data`）",
      !!(replay && replay.url.indexOf("_get-order-summary-list") >= 0),
      true,
    );
    const rp = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_replay_result",
    );
    check("有回報 finance_replay_result", !!rp, true);
    check("🔴 回報帶 reqId", rp && rp.payload.reqId, "r1");
    let b = null;
    try {
      b = replay && replay.init.body ? JSON.parse(replay.init.body) : null;
    } catch (e) {
      b = null;
    }
    // 🔴 2026-09-28 第八次真機：`pageSize` 一定要拉到最大（`MAX_PAGE_SIZE=200`），
    //    唔可以照抄範本（範本係平台 UI 嘅 20）。舊斷言寫死 20 已過時。
    //    重點係「分頁欄位唔可以缺」＋「一定要拉到最大」。
    check("🔴 pageSize 唔可以缺（一定要存在）", !!(b && isFinite(Number(b.pageSize))), true);
    check("🔴🔴 pageSize 一定要拉到最大 200（唔可以照抄範本 20）", b && b.pageSize, 200);
    check("🔴 保留 storeId（照抄範本其他欄位）", b && b.storeId, "S9");
  }

  group("[27] 🔴🔴 CORS 擋死重放：一定要標明（唔可以再叫人查簽章）");
  {
    // 🔴 2026-09-28 第十五次真機，真機 Console 實證：
    //   Access to fetch at '…/_get-order-summary-list' from origin
    //   'https://merchant.mfoodapp.com' has been blocked by CORS policy:
    //   … 'Access-Control-Allow-Origin' must not be '*' when the request's
    //   credentials mode is 'include'.
    //   mfood-inject.js:1335 POST … net::ERR_FAILED
    //
    // 根因：跨域 ＋ `credentials:'include'` ＋ 平台回 `ACAO:*`
    //      ＝ 瀏覽器**規範上一定拒絕**。呢條路（主動重放）**永遠冇得救**。
    //
    // ⇒ 呢組測試鎖死：
    //   ① CORS 失敗要畀一個**講明「永遠冇得救 + 正解係代撳 UI」**嘅原因
    //      （而唔係舊版叫使用者查簽章 —— 佢永遠解決唔到）
    //   ② 要帶 `corsBlocked: true` 旗標，令呼叫端可以放棄重放
    const inj = loadInject({});
    const base = "https://management-api.mfoodapp.com/merchants/summarys/summary/";
    // 先建立範本
    await window0(inj, base + "_get-order-summary-list", {
      method: "POST",
      headers: { "x-ca-signature": "S" },
      body: JSON.stringify({ weekId: "W1", pageNo: 1, pageSize: 20 }),
    });
    await inj.tick(120);

    // 🔴 令重放嘅 fetch **拋 CORS 錯**（模擬真機）
    inj.setFetchError(
      new TypeError(
        "Failed to fetch: Access to fetch blocked by CORS policy: " +
          "The value of the 'Access-Control-Allow-Origin' header in the response " +
          "must not be the wildcard '*' when the request's credentials mode is 'include'.",
      ),
    );

    inj.command({ cmd: "finance_replay_list", reqId: "cors1" });
    await inj.tick(300);

    const rp = inj.posted.find(
      (m) => m.__mfoodFinance === true && m.kind === "finance_replay_result",
    );
    check("有回報 finance_replay_result", !!rp, true);
    check("ok=false", rp && rp.payload.ok, false);
    check("🔴 帶 corsBlocked 旗標", rp && rp.payload.corsBlocked, true);
    check(
      "🔴 原因要講明 CORS／憑證模式",
      !!(rp && /CORS|Access-Control-Allow-Origin/.test(String(rp.payload.reason || ""))),
      true,
    );
    check(
      "🔴🔴 原因要指出正解係「代撳頁面 UI」而唔係叫使用者查簽章",
      !!(rp && /代撳|搭便車/.test(String(rp.payload.reason || ""))),
      true,
    );
    check(
      "🔴 唔可以再叫使用者查簽章（嗰個係另一回事）",
      !!(rp && !/冇簽章標頭.*閘道會拒收/.test(String(rp.payload.reason || ""))),
      true,
    );
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
