/**
 * aomi-inject.js 財務攔截測試（澳覓 MAIN world）
 *
 * 為什麼需要這支測試：
 *   🔴🔴 澳覓三支財務 API 嘅**回應形狀完全一樣**
 *        （`{ resultCode, detailMsg: { list: [...] } }`）：
 *          ① `settleService/hadSettlement`  已打款帳期列表
 *          ② `settleService/unSettlement`   未出帳帳期列表
 *          ③ `settleService/order/list`     某帳期逐筆明細（帶 `accountId`）
 *   ⇒ **唯一**可靠嘅分類方法就係 URL。
 *     一旦分類錯，會出現兩種靜默災難：
 *       · 明細當成帳期列表 ⇒ 帳期數暴增（同一批明細被當成 N 個帳期）
 *       · 帳期列表當成明細 ⇒ `resetDetailCapture` 清走真明細、金額歸零
 *     兩者都**唔會拋錯**、畫面照樣「成功」—— 呢類 bug 最貴。
 *
 *   本檔鎖住：
 *     · `classify()` 對三支財務 URL 嘅分類（同訂單 URL 唔可以互撞）
 *     · `hadSettlement` / `unSettlement` 各自標對 `source`
 *     · 明細一定帶 `accountId`（唔可以漏，否則跨帳期會撈埋）
 *     · `finance_last_request` 反向命令
 *     · 非財務回應（形狀唔似）唔可以亂 post
 *     · 財務事件用**獨立命名空間**（`__aomiFinance`），唔可以污染訂單流程
 *
 * 執行：node test/aomi-inject.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INJECT = path.join(__dirname, "..", "aomi-inject.js");

const HAD_URL =
  "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/hadSettlement" +
  "?pageNum=1&pageSize=20";

const UNSETTLED_URL =
  "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/unSettlement" +
  "?pageNum=1&pageSize=20";

const DETAIL_URL =
  "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/order/list" +
  "?accountId=ACC-9527&pageNum=1&pageSize=50";

const ORDER_LIST_URL =
  "https://manager-gateway.aomiapp.com/aomi-merchant-order/takeoutOrderRecord/list" +
  "?beginDate=2026-09-22&endDate=2026-09-23&type=GOING";

const ORDER_DETAIL_URL =
  "https://manager-gateway.aomiapp.com/aomi-merchant-order/takeoutOrderRecord/detail?id=1";

/** 三支財務 API 嘅共用回應形狀（完全相同 —— 呢個就係問題所在）。 */
function financeBody(rows, total) {
  return {
    resultCode: "200",
    resultMsg: "success",
    detailMsg: {
      list: rows || [],
      total: total == null ? (rows || []).length : total,
      pageNum: 1,
      pageSize: 20,
    },
  };
}

function loadInject(opts) {
  opts = opts || {};
  const posted = [];
  let msgListener = null;

  function FakeXHR() {
    this.listeners = {};
  }
  FakeXHR.prototype.open = function (m, u) {
    this._m = m;
    this._u = u;
  };
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.setRequestHeader = function () {};
  FakeXHR.prototype.addEventListener = function (t, fn) {
    this.listeners[t] = fn;
  };

  /** 每次 pageFetch 回嘅 body（可以係函式或固定值）。 */
  const windowObj = {
    location: {
      href: "https://merchant.aomiapp.com/#/settle/merchant",
      origin: "https://merchant.aomiapp.com",
    },
    fetch: function (url) {
      const body = typeof opts.body === "function" ? opts.body(String(url)) : opts.body;
      return Promise.resolve({
        clone: () => ({ json: () => Promise.resolve(body === undefined ? {} : body) }),
      });
    },
    XMLHttpRequest: FakeXHR,
    addEventListener(type, fn) {
      if (type === "message") msgListener = fn;
    },
    postMessage(msg) {
      posted.push(msg);
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: windowObj,
    document: { querySelectorAll: () => [] },
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
    decodeURIComponent,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(INJECT, "utf8"), sandbox, { filename: "aomi-inject.js" });

  /** 模擬頁面自己用 fetch 發請求（url 決定分類）。 */
  function pageFetch(url, init) {
    return windowObj.fetch(url, init || { method: "GET" });
  }
  /** 模擬頁面自己用 XHR 發請求。 */
  function pageXhr(url, method) {
    const x = new FakeXHR();
    x.open(method || "POST", url);
    x.send();
    return x;
  }
  function command(cmd) {
    if (!msgListener) throw new Error("inject 冇註冊 message listener");
    msgListener({ source: windowObj, data: Object.assign({ __aomiCmd: true }, cmd) });
  }
  /** 直接戳 listener（模擬**冇** `__aomiCmd` 標記嘅訊息）。 */
  function rawMessage(data) {
    if (!msgListener) throw new Error("inject 冇註冊 message listener");
    msgListener({ source: windowObj, data: data });
  }

  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 50));

  return { posted, command, rawMessage, tick, pageFetch, pageXhr };
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

/** 最近一條指定 kind 嘅 post。 */
const lastOf = (inj, kind) => [...inj.posted].reverse().find((m) => m.kind === kind);

// ------------------------------------------------------------ 測試

(async () => {
  group("[1] 🔴🔴 hadSettlement（已打款帳期列表）⇒ finance_periods ＋ source 正確");
  {
    const inj = loadInject({
      body: financeBody([{ accountId: "A1" }, { accountId: "A2" }]),
    });
    await inj.pageFetch(HAD_URL);
    await inj.tick();

    const ev = lastOf(inj, "finance_periods");
    check("有發 finance_periods", !!ev, true);
    check("🔴 用 finance 命名空間（唔可以撞訂單）", ev && ev.__aomiFinance, true);
    check("🔴 source ＝ hadSettlement", ev && ev.payload.source, "hadSettlement");
    check("兩列", ev && ev.payload.periods.length, 2);
    check(
      "🔴 列原樣保留（raw）",
      ev && ev.payload.periods[0].raw.accountId,
      "A1",
    );
  }

  group("[2] 🔴🔴 unSettlement ⇒ 一樣係 finance_periods，但 source 要分得清");
  {
    const inj = loadInject({ body: financeBody([{ accountId: "U1" }]) });
    await inj.pageFetch(UNSETTLED_URL);
    await inj.tick();

    const ev = lastOf(inj, "finance_periods");
    check("有發 finance_periods", !!ev, true);
    check("🔴 source ＝ unSettlement", ev && ev.payload.source, "unSettlement");
  }

  group("[3] 🔴🔴🔴 order/list ⇒ 一定要分去 finance_detail_captured（唔可以當帳期）");
  {
    // 回應形狀同上面**一模一樣** —— 唯一分別就係 URL。
    const inj = loadInject({ body: financeBody([{ orderId: "TK001", costAmount: 11542 }], 231) });
    await inj.pageFetch(DETAIL_URL);
    await inj.tick();

    const detail = lastOf(inj, "finance_detail_captured");
    const periods = lastOf(inj, "finance_periods");
    check("🔴🔴 發嘅係 finance_detail_captured", !!detail, true);
    check(
      "🔴🔴 絕對唔可以同時發 finance_periods（否則帳期數暴增）",
      !!periods,
      false,
    );
    check("🔴 有帶 accountId", detail && detail.payload.accountId, "ACC-9527");
    check("🔴 有帶 total（翻頁靠佢）", detail && detail.payload.total, 231);
    check("列原樣保留", detail && detail.payload.rawResult[0].costAmount, 11542);
  }

  group("[4] 🔴 accountId 要 decode（否則對唔上帳期）");
  {
    const url =
      "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/order/list" +
      "?accountId=ACC%2F9527%20X";
    const inj = loadInject({ body: financeBody([{ orderId: "TK1" }]) });
    await inj.pageFetch(url);
    await inj.tick();
    const detail = lastOf(inj, "finance_detail_captured");
    check("🔴 已 decode", detail && detail.payload.accountId, "ACC/9527 X");
  }

  group("[5] 🔴 明細 URL 冇 accountId ⇒ 要老實帶 null（唔可以亂代入）");
  {
    const url =
      "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/order/list?pageNum=1";
    const inj = loadInject({ body: financeBody([{ orderId: "TK1" }]) });
    await inj.pageFetch(url);
    await inj.tick();
    const detail = lastOf(inj, "finance_detail_captured");
    check("accountId 為 null", detail && detail.payload.accountId, null);
  }

  group("[6] 🔴 訂單 URL 唔可以行財務通道（兩套流程要完全隔離）");
  {
    const inj = loadInject({
      body: { resultCode: "200", detailMsg: { list: [{ orderId: "O1" }], size: 1 } },
    });
    await inj.pageFetch(ORDER_LIST_URL);
    await inj.tick();
    check(
      "🔴 冇發任何財務事件",
      inj.posted.filter((m) => m.kind === "finance_detail_captured" || m.kind === "finance_periods")
        .length,
      0,
    );
    const ol = lastOf(inj, "order_list");
    check("🔴 走返訂單通道（__aomiGrabber）", ol && ol.__aomiGrabber, true);
  }

  group("[7] 🔴 訂單詳情 URL 唔可以行財務通道");
  {
    const inj = loadInject({
      body: { resultCode: "200", detailMsg: { orderId: "O1", list: [] } },
    });
    await inj.pageFetch(ORDER_DETAIL_URL);
    await inj.tick();
    check(
      "冇財務事件",
      inj.posted.filter((m) => m.__aomiFinance).length,
      0,
    );
    check("有訂單詳情事件", !!lastOf(inj, "order_detail"), true);
  }

  group("[8] 🔴 財務回應「唔似 list」⇒ 唔可以亂 post（防平台改版亂餵）");
  {
    // resultCode 唔係 "200"
    const inj1 = loadInject({ body: { resultCode: "500", detailMsg: { list: [{}] } } });
    await inj1.pageFetch(HAD_URL);
    await inj1.tick();
    check("失敗回應唔發事件", inj1.posted.filter((m) => m.__aomiFinance).length, 0);

    // 形狀唔似
    const inj2 = loadInject({ body: { resultCode: "200", detailMsg: {} } });
    await inj2.pageFetch(HAD_URL);
    await inj2.tick();
    check("形狀唔似唔發事件", inj2.posted.filter((m) => m.__aomiFinance).length, 0);
  }

  group("[9] 🔴 XHR 路線（澳覓可能用 axios）都要攔到");
  {
    const inj = loadInject({ body: financeBody([{ accountId: "X1" }]) });
    // FakeXHR 唔會自己觸發 load ⇒ 手動模擬「頁面用 XHR 收到明細」
    const x = inj.pageXhr(DETAIL_URL, "POST");
    x.status = 200;
    x.responseType = "json";
    x.response = financeBody([{ orderId: "TK9", costAmount: 500 }], 5);
    const fn = x.listeners["load"];
    if (fn) fn();
    await inj.tick();
    const detail = lastOf(inj, "finance_detail_captured");
    check("🔴 XHR 明細被攔到", !!detail, true);
    check("accountId 有帶", detail && detail.payload.accountId, "ACC-9527");
  }

  group("[10] 🔴 財務請求要記入 last_request（診斷用，唔重放）");
  {
    const inj = loadInject({ body: financeBody([{ orderId: "TK1" }]) });
    await inj.pageFetch(DETAIL_URL);
    await inj.tick();
    inj.posted.length = 0;
    inj.command({ cmd: "finance_last_request" });
    await inj.tick();
    const ev = lastOf(inj, "finance_last_request");
    check("有回應", !!ev, true);
    check("🔴 記住明細 URL", !!(ev && ev.payload && ev.payload.url.indexOf("order/list") >= 0), true);
    check("🔴 記住 accountId", ev && ev.payload.accountId, "ACC-9527");
  }

  group("[11] 🔴 冇任何財務請求時，last_request 要老實回 null");
  {
    const inj = loadInject({ body: financeBody([]) });
    inj.posted.length = 0;
    inj.command({ cmd: "finance_last_request" });
    await inj.tick();
    const ev = lastOf(inj, "finance_last_request");
    check("有回應", !!ev, true);
    check("🔴 payload 為 null", ev && ev.payload, null);
  }

  group("[12] 🔴 財務事件唔可以污染訂單事件（命名空間要分開）");
  {
    const inj = loadInject({ body: financeBody([{ accountId: "A1" }]) });
    await inj.pageFetch(HAD_URL);
    await inj.tick();
    const ev = lastOf(inj, "finance_periods");
    check("🔴 有 __aomiFinance 記號", ev && ev.__aomiFinance, true);
    check("🔴 冇 __aomiGrabber 記號（唔可以撈埋）", ev && ev.__aomiGrabber, undefined);
  }

  group("[13] 🔴 唔係 __aomiCmd 嘅訊息要被忽略");
  {
    const inj = loadInject({ body: financeBody([]) });
    inj.posted.length = 0;
    inj.rawMessage({ cmd: "finance_last_request" });
    inj.rawMessage({ __aomiCmd: false, cmd: "finance_last_request" });
    await inj.tick();
    check(
      "冇發出 finance_last_request",
      inj.posted.filter((m) => m.kind === "finance_last_request").length,
      0,
    );
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
