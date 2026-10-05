/**
 * mfood 列表請求重放測試 —— 「只同步此日後」的真正實作
 *
 * 為什麼需要這支測試：
 *   使用者要求「設定了起始日期，就要把那個日期之後的訂單全部抓進來」。
 *   過去的做法是去操作頁面的日期選擇器 —— 失敗率很高，而且失敗時我們無從得知。
 *
 *   現在改成：直接重放頁面自己的列表請求（_list-amtn），只換掉
 *   startTime / endTime / status 三個欄位。
 *   可行的原因是 Alibaba 閘道的 StringToSign 不含 request body，
 *   而日期與狀態都在 body 裡 → 簽章仍然對得上。
 *
 *   這支測試鎖住三件事：
 *     ① 沒有範本時「絕對不自己亂組請求」
 *     ② 有範本時只改三個欄位，其餘原樣保留、標頭原樣照抄
 *     ③ 時間換算必須是「當地時區的當日 00:00 ~ 23:59:59.999」
 *
 * 執行：node test/mfood-list.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INJECT = path.join(__dirname, "..", "mfood-inject.js");

const LIST_URL = "https://management-api.mfoodapp.com/merchants/takeouts/order/_list-amtn";

/** 使用者提供的真實 payload 形狀（時間欄位會在重放時被換掉） */
const REAL_LIST_BODY = {
  endTime: 1790179199000,
  status: "",
  startTime: 1787500800000,
  refundType: null,
  isReserve: null,
  dateType: 1,
  deliveryType: null,
  orderNumber: null,
  tradeNo: null,
  fromMerchant: true,
  storeIds: [],
  id: null,
};

/** 列表回應：必須符合 isOrderList 的判定（result[0].tradeNo + amtn） */
const LIST_RESPONSE = {
  result: [
    { tradeNo: "CRD001", amtn: 75.9, orderStatus: 4, transactionStatus: 2, deliveryType: 1 },
    { tradeNo: "CRD002", amtn: 59, orderStatus: 4, transactionStatus: 2, deliveryType: 3 },
  ],
  total: 2,
};

const REAL_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json;charset=utf-8",
  "x-token": "TOKEN_ABC123",
  "x-merchant": "202208171125016609774",
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
  let nextBody = opts.responseText || JSON.stringify(LIST_RESPONSE);
  let httpOk = opts.httpOk !== false;
  let status = opts.status || 200;

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
    const text = nextBody;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    const res = {
      ok: httpOk,
      status: status,
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

  /** 模擬「頁面自己在後台按了一次查詢」→ inject 擷取列表請求範本 */
  function captureList(body) {
    return windowObj.fetch(LIST_URL, {
      method: "POST",
      headers: Object.assign({}, REAL_HEADERS),
      body: JSON.stringify(body || REAL_LIST_BODY),
      credentials: "include",
    });
  }

  function setResponse(text, ok, st) {
    nextBody = text;
    httpOk = ok !== false;
    status = st || 200;
  }

  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

  return { posted, fetchCalls, command, tick, captureList, setResponse };
}

// ------------------------------------------------------------ 斷言

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 ${label}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      實際: ${JSON.stringify(actual)}`);
  }
}

function group(n) {
  console.log(`\n${n}`);
}

// ------------------------------------------------------------ 測試

(async () => {
  group("[1] 🔴 沒有範本時，不可以自己亂組列表請求");
  {
    const inj = loadInject();
    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L1" });
    await inj.tick();

    check("沒有發出任何請求（不猜）", inj.fetchCalls.length, 0);

    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check(
      "原因說明要先去後台按一次查詢",
      !!(rr && rr.payload && String(rr.payload.reason).indexOf("列表請求") >= 0),
      true,
    );
  }

  group("[2] 🔴 有範本時，只改三個欄位，其餘原樣保留");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.fetchCalls.length = 0;
    inj.posted.length = 0;

    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L2" });
    await inj.tick(140);

    check("有發出重放請求", inj.fetchCalls.length, 1);

    const c = inj.fetchCalls[0] || { url: "", init: {} };
    const sent = JSON.parse(c.init.body);

    check("URL 不變", c.url, LIST_URL);
    check("method 不變", c.init.method, "POST");

    // 時間換算：當地時區的當日 00:00 與 23:59:59.999
    check("🔴 startTime = 當地 2026-09-22 00:00", sent.startTime, new Date(2026, 8, 22, 0, 0, 0, 0).getTime());
    check(
      "🔴 endTime = 當地 2026-09-23 23:59:59.999",
      sent.endTime,
      new Date(2026, 8, 23, 23, 59, 59, 999).getTime(),
    );
    check("status 強制為空（不限狀態）", sent.status, "");

    // 其餘欄位必須原樣保留 —— 少帶欄位就是失敗的來源
    check("dateType 保留", sent.dateType, 1);
    check("fromMerchant 保留", sent.fromMerchant, true);
    check("storeIds 保留", sent.storeIds, []);
    check("refundType 保留", sent.refundType, null);
    check("isReserve 保留", sent.isReserve, null);
    check("deliveryType 保留", sent.deliveryType, null);
    check("orderNumber 保留", sent.orderNumber, null);
    check("tradeNo 保留", sent.tradeNo, null);
    check("id 保留", sent.id, null);

    // 標頭原樣照抄（含簽章）
    const h = c.init.headers || {};
    check("🔴 簽章原樣照抄", h["x-ca-signature"], REAL_HEADERS["x-ca-signature"]);
    check("nonce 原樣照抄", h["x-ca-nonce"], REAL_HEADERS["x-ca-nonce"]);
    check("x-token 原樣照抄", h["x-token"], REAL_HEADERS["x-token"]);
    check("帶 cookie", c.init.credentials, "include");

    // 回應要走正常管道 → 變成一般的 order_list，後續推送邏輯完全共用
    const lists = inj.posted.filter((m) => m.kind === "order_list");
    check("列表只送一次", lists.length, 1);
    check("列表帶了 2 筆", lists[0] && lists[0].payload.result.length, 2);
    check("標明來源為重放", lists[0] && lists[0].meta.transport, "replay");
    check("附上實際套用的區間", lists[0] && !!lists[0].meta.range, true);

    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報成功", !!(rr && rr.payload.ok), true);
    check("回報筆數", rr && rr.payload.rows, 2);
    check("🔴 回報平台總數（用來當場發現漏抓）", rr && rr.payload.total, 2);
    check("回報實際套用的 startTime", rr && rr.payload.applied.startTime, new Date(2026, 8, 22).getTime());
  }

  group("[3] 🔴 每次都要用最新的範本（使用者的篩選條件是活的）");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    // 使用者在頁面上改了篩選條件 → 頁面再送一次查詢 → 範本要跟著更新
    await inj.captureList(Object.assign({}, REAL_LIST_BODY, { dateType: 2, storeIds: ["S1"] }));
    await inj.tick(120);

    inj.fetchCalls.length = 0;
    inj.command({ cmd: "sync_range", startDate: "2026-10-01", endDate: "2026-10-02", reqId: "L3" });
    await inj.tick(140);

    const sent = JSON.parse(inj.fetchCalls[0].init.body);
    check("用最新範本的 dateType", sent.dateType, 2);
    check("用最新範本的 storeIds", sent.storeIds, ["S1"]);
    check("日期仍被覆蓋", sent.startTime, new Date(2026, 9, 1).getTime());
  }

  group("[4] 回應不是訂單列表 → 回報失敗，不得誤送");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.setResponse('{"errorCode":"unauthorized","msg":"not logged in"}', true, 200);
    inj.posted.length = 0;
    inj.fetchCalls.length = 0;

    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L4" });
    await inj.tick(140);

    check("有發出重放請求", inj.fetchCalls.length, 1);
    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check("有失敗原因", !!(rr && rr.payload && rr.payload.reason), true);
    check("沒有誤送列表", inj.posted.filter((m) => m.kind === "order_list").length, 0);
  }

  group("[5] HTTP 401 要回報失敗");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.setResponse("Unauthorized", false, 401);
    inj.posted.length = 0;
    inj.fetchCalls.length = 0;

    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L5" });
    await inj.tick(140);

    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check(
      "原因含狀態碼",
      !!(rr && rr.payload && String(rr.payload.reason).indexOf("401") >= 0),
      true,
    );
    check("沒有誤送列表", inj.posted.filter((m) => m.kind === "order_list").length, 0);
  }

  group("[6] 日期格式不對要擋下來，不可送出亂七八糟的請求");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.fetchCalls.length = 0;
    inj.posted.length = 0;

    inj.command({ cmd: "sync_range", startDate: "22/09/2026", endDate: "2026-09-23", reqId: "L6" });
    await inj.tick(140);

    check("沒有發出請求", inj.fetchCalls.length, 0);
    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報失敗", !!(rr && rr.payload && rr.payload.ok === false), true);
    check(
      "原因提到日期格式",
      !!(rr && rr.payload && String(rr.payload.reason).indexOf("日期格式") >= 0),
      true,
    );
  }

  group("[7] list_template_info 要正確回報範本狀態");
  {
    const inj = loadInject();
    inj.command({ cmd: "list_template_info" });
    await inj.tick();
    const before = inj.posted.find((m) => m.kind === "list_template_info");
    check("沒有範本時 ready=false", before && before.payload.ready, false);

    await inj.captureList();
    await inj.tick(120);

    inj.posted.length = 0;
    inj.command({ cmd: "list_template_info" });
    await inj.tick();
    const after = inj.posted.find((m) => m.kind === "list_template_info");
    check("有範本時 ready=true", after && after.payload.ready, true);
    check("回報範本 URL", after && after.payload.url, LIST_URL);
  }

  group("[8] 🔴 平台總數與實際筆數不符時，要老實把兩個數字都報出來");
  {
    // 後台截圖顯示「共 115 項」，但 UI 是 20 項/頁。
    // `_list-amtn` 的 body 沒有分頁欄位，所以推測 API 一次回全部。
    // 若推測錯了（筆數 < total），我們必須當場看得出來，而不是少抓了還以為成功。
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.setResponse(JSON.stringify({ result: LIST_RESPONSE.result, total: 115 }), true, 200);
    inj.fetchCalls.length = 0;
    inj.posted.length = 0;

    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L8" });
    await inj.tick(140);

    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("回報收到 2 筆", rr && rr.payload.rows, 2);
    check("🔴 同時回報平台說有 115 筆", rr && rr.payload.total, 115);
  }

  group("[9] 平台沒有回 total 時，要回報 null（不可瞎編）");
  {
    const inj = loadInject();
    await inj.captureList();
    await inj.tick(120);

    inj.setResponse(JSON.stringify({ result: LIST_RESPONSE.result }), true, 200);
    inj.posted.length = 0;

    inj.command({ cmd: "sync_range", startDate: "2026-09-22", endDate: "2026-09-23", reqId: "L9" });
    await inj.tick(140);

    const rr = inj.posted.find((m) => m.kind === "list_range_result");
    check("total 為 null", rr && rr.payload.total, null);
    check("仍然成功", rr && rr.payload.ok, true);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
