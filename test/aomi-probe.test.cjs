/**
 * 澳覓「回讀查證」測試
 *
 * 為什麼需要這支測試：
 *   澳覓的簽章涵蓋完整 query string，所以我們無法自己改日期重放請求 ——
 *   只能操作頁面的日期欄位與狀態頁籤。「操作頁面」就有可能「按了但沒生效」，
 *   而過去的失敗全都是這樣靜默發生的。
 *
 *   解法是把「相信它成功」換成「證明它成功」：
 *   MAIN world 記錄頁面每次真正送出的列表請求，隔離世界的 bridge 事後回讀，
 *   核對 beginDate / endDate / type 到底是不是我們要的。
 *
 * 這支測試鎖住：記錄正確、回讀正確、非列表請求不可污染記錄。
 *
 * 執行：node test/aomi-probe.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INJECT = path.join(__dirname, "..", "aomi-inject.js");

const LIST_URL =
  "https://merchant.aomiapp.com/aomi-merchant-order/takeoutOrderRecord/list" +
  "?beginDate=2026-09-22&endDate=2026-09-23&type=GOING&channel=1&storeId=S1&sign=abc";

const DETAIL_URL =
  "https://merchant.aomiapp.com/aomi-merchant-order/takeoutOrderRecord/detail?id=1";

function loadInject() {
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

  const windowObj = {
    location: {
      href: "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord",
      origin: "https://merchant.aomiapp.com",
    },
    fetch: function () {
      return Promise.resolve({ clone: () => ({ json: () => Promise.resolve({}) }) });
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
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(INJECT, "utf8"), sandbox, { filename: "aomi-inject.js" });

  /** 模擬頁面自己用 fetch 發請求（url 決定是不是列表請求） */
  function pageFetch(url, init) {
    return windowObj.fetch(url, init || { method: "GET" });
  }

  /** 模擬頁面自己用 XHR 發請求 */
  function pageXhr(url, method) {
    const x = new FakeXHR();
    x.open(method || "POST", url);
    x.send();
    return x;
  }

  function command(cmd) {
    if (!msgListener) throw new Error("inject 沒有註冊 message listener");
    msgListener({ source: windowObj, data: Object.assign({ __aomiCmd: true }, cmd) });
  }

  /** 直接呼叫 inject 的 message listener（模擬非 __aomiCmd 的訊息） */
  function rawMessage(data) {
    if (!msgListener) throw new Error("inject 沒有註冊 message listener");
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

const probe = (inj, reqId) => {
  inj.posted.length = 0;
  inj.command({ cmd: "probe_list", reqId: reqId });
  return inj.tick().then(() => inj.posted.find((m) => m.kind === "list_probe"));
};

// ------------------------------------------------------------ 測試

(async () => {
  group("[1] 還沒抓到任何列表請求時，回讀要誠實說「沒有」");
  {
    const inj = loadInject();
    const r = await probe(inj, "p1");
    check("有回應", !!r, true);
    check("reqId 對得上", r && r.payload.reqId, "p1");
    check("req 為 null", r && r.payload.req, null);
  }

  group("[2] 🔴 頁面送出列表請求後，要能回讀到完整 URL（驗證的依據）");
  {
    const inj = loadInject();
    await inj.pageFetch(LIST_URL);
    await inj.tick();

    const r = await probe(inj, "p2");
    check("有 req", !!(r && r.payload.req), true);
    check("URL 完整保留", r && r.payload.req.url, LIST_URL);
    check("method 正確", r && r.payload.req.method, "GET");
    check("有時間戳", !!(r && r.payload.req.at), true);
  }

  group("[3] XHR 路線的列表請求也要記錄（澳覓可能走 axios）");
  {
    const inj = loadInject();
    await inj.pageXhr(LIST_URL);
    await inj.tick();

    const r = await probe(inj, "p3");
    check("XHR 的列表被記錄", !!(r && r.payload.req), true);
    check("URL 正確", r && r.payload.req.url, LIST_URL);
    check("method 正確", r && r.payload.req.method, "POST");
  }

  group("[4] 🔴 詳情請求不可污染列表記錄（否則驗證會拿錯資料）");
  {
    const inj = loadInject();
    await inj.pageXhr(LIST_URL);
    await inj.tick();

    // 之後頁面又發了詳情請求 —— 記錄必須還是列表那一個
    await inj.pageFetch(DETAIL_URL);
    await inj.tick();

    const r = await probe(inj, "p4");
    check("記錄仍是列表請求", r && r.payload.req.url, LIST_URL);
  }

  group("[5] 切換狀態（進行中 → 已完成）後，記錄要跟著更新");
  {
    const inj = loadInject();
    await inj.pageFetch(LIST_URL);
    await inj.tick();

    const finishURL = LIST_URL.replace("type=GOING", "type=FINISH");
    await inj.pageFetch(finishURL);
    await inj.tick();

    const r = await probe(inj, "p5");
    check("記錄換成最新的那一次", r && r.payload.req.url, finishURL);
  }

  group("[6] 未知命令不應有任何回應");
  {
    const inj = loadInject();
    inj.posted.length = 0;
    inj.command({ cmd: "something_else", reqId: "p6" });
    await inj.tick();
    check("沒有發出 list_probe", inj.posted.filter((m) => m.kind === "list_probe").length, 0);
  }

  group("[7] 不是 __aomiCmd 的訊息要被忽略（不可亂回應）");
  {
    const inj = loadInject();
    inj.posted.length = 0;
    inj.rawMessage({ cmd: "probe_list", reqId: "p7" });
    inj.rawMessage({ __aomiCmd: false, cmd: "probe_list", reqId: "p8" });
    await inj.tick();
    check("沒有發出 list_probe", inj.posted.filter((m) => m.kind === "list_probe").length, 0);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
