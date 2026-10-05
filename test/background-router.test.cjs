/**
 * background.js 訊息路由回歸測試
 *
 * 為什麼需要這支測試：
 *   這個擴充功能同時服務兩種「訊息形狀」：
 *     MacauPay  → { action: 'manualGrab' }          （沒有 type）
 *     擷取來源  → { type: 'MFOOD_GET_DASHBOARD' }   （沒有 action）
 *
 *   曾經因為在 onMessage 開頭寫了 `if (typeof request.type !== 'string') return false;`
 *   導致 MacauPay 的訊息被提早 return，手動刷新 / Start / Stop 全部失效
 *   —— 而且不會拋錯、不會有 log，完全是靜默失效。
 *   這支測試就是為了讓那個 bug 不可能再回來。
 *
 * 執行：node test/background-router.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "background.js");

// ------------------------------------------------------------ chrome stub

function makeChrome() {
  const store = {};
  const state = {
    onMessage: null,
    onInstalled: null,
    onAlarm: null,
    notifications: [],
    alarms: [],
    alarmsCleared: [],
    sentTabs: [],
    reloadedTabs: [],
    queriedTabs: [],
    /** 模擬「有開住 mfood 財務頁」；null = 冇開 */
    financeTabs: null,
    // 🔴🔴 2026-09-30 補（第 [87] 組）：`grabEnsureTabForUrl()` 用
    //    `tabs.query({url:sitePattern})` 攞齊該站分頁，再自己比對 hash 路徑。
    //    `state.tabs` 有值 ＝ 模擬「呢啲分頁已經開住」（orders / finance 都要列）；
    //    未設（null）＝ fallback 去 `state.financeTabs`（舊測試沿用）。
    tabs: null,
    /** 模擬 `chrome.tabs.create()` 開過嘅 URL（順序） */
    tabsCreated: [],
    // 🔴🔴 2026-09-30 補（第 [87] 組）：宣告式設定「某平台已有帳密」。
    //    `storage.local.get` 會兜底讀呢度（見上面 `get()`），
    //    令 `grabHasCreds()` 判斷得到 true ⇒ 行到開分頁嘅分支。
    //    形狀：`{ mfood: {username,password}, aomi: {username,password} }`
    creds: undefined,
    /** 🔴 2026-09-28 第十二次真機：背景重新注入內容腳本時，記低每次 executeScript 呼叫 */
    injectedScripts: [],
    /** `true` = 重新注入都失敗（模擬無權限／頁面唔准注入） */
    injectFails: false,
    injectFailMessage: null,
  };

  const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

  function get(keys, cb) {
    const out = {};
    const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
    for (const k of list) if (k in store) out[k] = clone(store[k]);
    if (keys && typeof keys === "object" && !Array.isArray(keys)) {
      for (const k of Object.keys(keys)) if (!(k in out)) out[k] = keys[k];
    }
    // 🔴 2026-09-30 補（第 [87] 組）：`GrabGetCreds` 走 `storage.local.get`
    //    ⇒ 想宣告式咁「設好兩平台帳密」就要撳呢度兜底。
    //    `state.creds` 未設（undefined）＝ 完全唔影響既有測試。
    if (state.creds && typeof state.creds === "object") {
      for (const k of Object.keys(state.creds)) {
        const credKey = k === "aomi" ? "aomiCreds" : "mfoodCreds";
        if (list.indexOf(credKey) >= 0 && !(credKey in out)) {
          out[credKey] = clone(state.creds[k]);
        }
      }
    }
    if (typeof cb === "function") cb(out);
    return Promise.resolve(out);
  }

  function set(obj, cb) {
    Object.assign(store, clone(obj));
    if (typeof cb === "function") cb();
    return Promise.resolve();
  }

  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.6" }),
      onInstalled: { addListener(fn) { state.onInstalled = fn; } },
      onMessage: { addListener(fn) { state.onMessage = fn; } },
    },
    alarms: {
      create(name, opts) { state.alarms.push({ name, opts }); },
      clear(name, cb) { state.alarmsCleared.push(name); if (cb) cb(); },
      onAlarm: { addListener(fn) { state.onAlarm = fn; } },
    },
    storage: { local: { get, set } },
    notifications: {
      create(id, opts) { state.notifications.push({ id, opts }); },
    },
    // 🔴 2026-09-28 第十二次真機：財務頁 sendMessage 失敗時，
    //    背景會用 `chrome.scripting.executeScript` **重新注入**內容腳本再試。
    //    harness 一定要 stub —— 否則一句 TypeError 就會炸穿成條 route。
    //    `state.injectFails = true` 可模擬「重新注入都失敗」（例如無權限）。
    scripting: {
      executeScript(opts) {
        state.injectedScripts.push(opts);
        // 🔴 測試可用 `state.onInject` 模擬「注入成功 = 內容腳本活了」
        //    （把 `state.tabDead` 關掉，令下一次 sendMessage 成功）。
        if (typeof state.onInject === "function") state.onInject(opts);
        if (state.injectFails) {
          return Promise.reject(new Error(state.injectFailMessage || "Cannot access contents of the page"));
        }
        return Promise.resolve([{ result: null }]);
      },
    },
    tabs: {
      // 🔴 2026-09-26 補：`grabFindFinanceTab()` 用 `chrome.tabs.query` 去搵
      //    mfood 財務頁（唔靠內容腳本回報，因為財務頁根本冇 bridge 掛住）。
      //    harness 之前只 stub 咗 sendMessage → 一跑 autoTick 就 TypeError，
      //    令**整支測試檔**死喺第 19 組（連帶後面所有斷言都冇跑）。
      //    呢個 stub 模擬「真實有冇開住財務頁」：state.financeTabs 有值就當搵到。
      query(q, cb) {
        state.queriedTabs.push(q);
        // 🔴 2026-09-30：兩套模擬並存 ——
        //   `state.tabs`（新，第 [87] 組用）＝ 整站分頁清單，逐個比對 hash；
        //   `state.financeTabs`（舊）＝ 只有財務頁，向後兼容既有斷言。
        let tabs =
          state.tabs != null
            ? state.tabs.slice()
            : state.financeTabs
              ? state.financeTabs.slice()
              : [];
        // 🔴🔴 2026-09-30（第 [89] 組）：真 Chrome 會**按 `url` 條件先過濾**，
        //    呢個 stub 之前係「原樣回全部」⇒ 一旦測試同時擺 mfood 同澳覓分頁，
        //    就同真實行為唔一致（第 [89] 組第一次跑就係咁數到 4 而唔係 3）。
        //    窄範圍修：只喺 `q.url` 係字串時做 glob 比對，其餘查詢行為完全不變。
        if (q && typeof q.url === "string" && q.url.indexOf("*") >= 0) {
          const re = new RegExp(
            "^" +
              q.url
                .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*") +
              "$",
          );
          tabs = tabs.filter((t) => re.test(String((t && t.url) || "")));
        }
        if (typeof cb === "function") cb(tabs);
        return Promise.resolve(tabs);
      },
      // 🔴 2026-09-30 補：`grabEnsureTabForUrl()` 缺頁時會 `tabs.create`。
      //    harness 之前完全冇呢個 stub ⇒ 一叫就 TypeError 炸穿成條 route。
      create(opts, cb) {
        const url = String((opts && opts.url) || "");
        const tab = { id: 900 + state.tabsCreated.length, url: url, active: !!(opts && opts.active) };
        state.tabsCreated.push(url);
        // 開完之後該分頁就存在 —— 令同一次呼叫嘅第二次 query 睇得到
        if (state.tabs == null) state.tabs = [];
        state.tabs.push(tab);
        if (typeof cb === "function") cb(tab);
        return Promise.resolve(tab);
      },
      sendMessage(tabId, msg, cb) {
        state.sentTabs.push({ tabId, msg });
        // state.tabDead = true → 模擬「內容腳本已死」（sendMessage 報 lastError）。
        // 2026-09-25 新增：自動重載現在**只**喺內容腳本真係死咗時才觸發。
        if (state.tabDead) {
          chrome.runtime.lastError = { message: "Could not establish connection." };
          if (cb) cb(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        // state.tabReply 可讓個別測試自訂內容腳本的回應（預設維持原本行為）
        const r = state.tabReply ? state.tabReply(msg) : { ok: true, label: "查詢" };
        if (cb) cb(r);
      },
      reload(tabId, opts, cb) {
        state.reloadedTabs.push({ tabId, opts });
        if (cb) cb();
      },
    },
  };

  return { chrome, store, state };
}

// ------------------------------------------------------------ 載入

function loadBackground() {
  const { chrome, store, state } = makeChrome();
  const fetchCalls = [];

  const fakeResponse = () => ({
    ok: true,
    status: 200,
    text: async () =>
      typeof state.fetchReply === "function"
        ? String(state.fetchReply())
        : // 🔴 2026-09-26：預設回一個**真實形狀**嘅回應。
          //    之前係 `"[]"` —— 對訂單 route 無害（佢唔睇 ok 欄位），
          //    但 settlement route 嘅守衛會判 `ok !== true` ⇒ 判成「格式異常」。
          //    測試替身同真實 API 形狀唔一致 ＝ 測試講大話。
          state.fetchUrl && String(state.fetchUrl).indexOf("/settlement") >= 0
          ? JSON.stringify({ ok: true, received: 0, orders: 0, updated: 0, notFound: [] })
          : "[]",
    json: async () => ({ result: "true", list: [] }),
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome,
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init: init || {} });
      state.fetchUrl = String(url);
      return Promise.resolve(fakeResponse());
    },
    URLSearchParams,
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
  vm.runInContext(fs.readFileSync(BG, "utf8"), sandbox, { filename: "background.js" });

  if (!state.onMessage) throw new Error("background.js 沒有註冊 onMessage listener");

  /** 送出訊息並取得回應（支援 async sendResponse）；sender 可指定分頁 */
  function send(request, sender) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const ret = state.onMessage(request, sender || {}, finish);
      if (ret !== true) {
        // 同步路徑：listener 唔會再叫 sendResponse
        setTimeout(() => finish(undefined), 20);
      } else {
        setTimeout(() => finish(undefined), 120);
      }
    });
  }

  const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

  /** 手動觸發某個 alarm（stub 會記下 listener） */
  function fireAlarm(name) {
    if (!state.onAlarm) throw new Error("background.js 沒有註冊 alarm listener");
    state.onAlarm({ name });
    return tick(180);
  }

  // 🔴 2026-09-29：把 context 一齊交出去，等測試可以直接掂 sandbox 上嘅純函式
  //    （`grabEnrichOrdersWithItems` / `grabFillMissingOrderNo` 嗰類）。
  //    唔 expose 嘅話就只能靠「行完整條推送流程」去間接驗 —— 慢、脆、難定位。
  return { send, tick, fireAlarm, store, state, fetchCalls, sandbox, chrome };
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

/** 取出送去某分頁嘅最後一個訊息內容（方便斷言 payload）。 */
function bw(bg, tabId) {
  const hits = bg.state.sentTabs.filter((t) => t.tabId === tabId);
  return hits.length ? hits[hits.length - 1].msg : null;
}

/** 取出送去某分頁嘅「最後一封對帳訊息」（MFOODFIN_SYNC / AOMIFIN_SYNC）。
 *  🔴 2026-09-30：單一分頁對帳會額外送 GRAB_PAUSE_ORDERS / GRAB_RESUME_ORDERS，
 *    所以唔可以再用 `bw()`（拎最後一封＝可能係 resume 訊息），要按 type 過濾。 */
function lastSyncMsg(bg, tabId) {
  const hits = bg.state.sentTabs.filter(
    (t) =>
      t.tabId === tabId &&
      t.msg &&
      (t.msg.type === "MFOODFIN_SYNC" || t.msg.type === "AOMIFIN_SYNC"),
  );
  return hits.length ? hits[hits.length - 1].msg : null;
}

// ------------------------------------------------------------ 測試

(async () => {

  group("[1] 🔴 MacauPay 訊息：只有 action、沒有 type（回歸重點）");
  {
    const bg = loadBackground();

    await bg.send({ action: "manualGrab" });
    await bg.tick(120);

    const urls = bg.fetchCalls.map((c) => c.url);
    const hitDashboard = urls.some((u) => u.includes("mpopBasicStpprdinf/list"));
    const hitTarget = urls.some((u) => u.includes("mpopBasicStpprdinf/listData"));

    check("manualGrab 有觸發（keepSessionAlive 打 dashboard）", hitDashboard, true);
    check("manualGrab 有觸發（打 listData 抓資料）", hitTarget, true);
    check("完全沒打任何網路請求 = 路由被吃掉", bg.fetchCalls.length > 0, true);

    // stopTimer 應該清掉 grabDataAlarm
    await bg.send({ action: "stopTimer" });
    await bg.tick(40);
    check("stopTimer 有執行", bg.state.alarmsCleared.includes("grabDataAlarm"), true);
  }

  group("[2] 擷取來源訊息：只有 type、沒有 action");
  {
    const bg = loadBackground();

    const res = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    check("MFOOD_GET_DASHBOARD 有回應", !!res, true);
    check("回傳的來源正確", res && res.source, "mfood");
    check("回傳含標籤", res && res.label, "mfood");
    check("回傳含 state", !!(res && res.state), true);
    check("回傳含 settings", !!(res && res.settings), true);
    check("預設不推送", res && res.settings && res.settings.pushEnabled, false);

    const res2 = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    check("AOMI_GET_DASHBOARD 回傳來源正確", res2 && res2.source, "aomi");
    check("澳覓不支援頁面統計", res2 && res2.supportsStats, false);
  }

  group("[3] 兩種形狀在同一支 listener 內互不干擾");
  {
    const bg = loadBackground();

    const dash = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    check("先送 type 訊息 OK", dash && dash.source, "mfood");

    await bg.send({ action: "manualGrab" });
    await bg.tick(120);
    check("接著送 action 訊息仍能觸發", bg.fetchCalls.length > 0, true);

    const dash2 = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    check("再送 type 訊息仍 OK", dash2 && dash2.source, "aomi");
  }

  group("[4] 擷取流程寫入日誌與去重");
  {
    const bg = loadBackground();

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "TK001", orderStatus: "completed", orderStatusRaw: 4, amount: { businessAmount: 62 } },
      ],
      meta: { total: 110 },
    });
    await bg.tick(120);

    let log = bg.store.mfoodLog || [];
    check("有寫入日誌", log.length >= 1, true);

    // 日誌是「最新在前」，而 grabHandleList 之後還會追加一筆 push_skipped，
    // 所以不能直接看 log[0] —— 要找出列表那一筆。
    const listEntry = log.find((e) => e.kind === "mfood_order_list");
    check("有寫入列表日誌", !!listEntry, true);
    check("列表日誌等級為新單", listEntry && listEntry.level, "new");

    // 同一筆再送一次 → 不應再算新單
    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "TK001", orderStatus: "completed", orderStatusRaw: 4, amount: { businessAmount: 62 } },
      ],
      meta: { total: 110 },
    });
    await bg.tick(120);

    const mfoodState = bg.store.mfoodState;
    check("第二次被判定為重複", mfoodState.counters.duplicatesSkipped, 1);
    check("新單計數仍為 1", mfoodState.counters.freshRows, 1);
  }

  group("[5] 防禦性：壞訊息不應崩潰");
  {
    const bg = loadBackground();

    await bg.send(null);
    await bg.send({});
    await bg.send({ type: "UNKNOWN_PREFIX_FOO" });
    await bg.send({ action: "unknownAction" });
    await bg.send({ type: "MFOOD_NOT_A_REAL_CASE" });

    check("送出 5 種壞訊息後仍存活", true, true);

    // 仍能正常處理
    const res = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    check("壞訊息之後仍能正常回應", res && res.source, "mfood");
  }

  group("[6] 未知來源前綴不會被誤路由");
  {
    const bg = loadBackground();
    const res = await bg.send({ type: "SOMETHING_GET_DASHBOARD" });
    check("未知前綴不回傳 dashboard", res, undefined);
  }

  group("[7] cut-off date 過濾（全域設定，mfood）");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "OLD1",
      orderStatus: "completed",
      createdAt: "2026-09-23T09:32:08.000Z",
      amount: { businessAmount: 62 },
    };

    // cut-off 設在未來 → 所有單都應被略過
    bg.store.startDate = "2099-01-01";
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(120);

    let st = bg.store.mfoodState;
    check("早於 cut-off 的單不計為新單", st.counters.freshRows, 0);
    check("有記錄 skippedByCutoff", st.counters.skippedByCutoff, 1);

    const entry = (bg.store.mfoodLog || []).find((e) => e.kind === "mfood_order_list");
    check(
      "日誌有標示略過筆數",
      !!(entry && entry.detail && entry.detail.skippedByCutoff === 1),
      true,
    );
    check("日誌摘要提到 cut-off", !!(entry && entry.summary.includes("cut-off")), true);

    // 🔴 關鍵：被 cut-off 擋掉的單「不該」佔用去重記錄，
    //    否則使用者之後把日期放寬，同一張單會被誤判成「已見過」而永久漏掉。
    bg.store.startDate = "2020-01-01";
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(120);

    st = bg.store.mfoodState;
    check("放寬 cut-off 後同一張單仍被視為新單", st.counters.freshRows, 1);
  }

  group("[8] cut-off date 過濾（澳覓的本地時間字串）");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "TK_OLD",
      stateRaw: "訂單已送達",
      orderDateTime: "2026-09-17 19:07:11",
      amount: { turnoverAmount: 126 },
    };

    bg.store.startDate = "2099-01-01";
    await bg.send({ type: "AOMI_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(120);
    check("澳覓早於 cut-off 的單被略過", bg.store.aomiState.counters.freshRows, 0);

    bg.store.startDate = "2020-01-01";
    await bg.send({ type: "AOMI_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(120);
    check("放寬後被視為新單", bg.store.aomiState.counters.freshRows, 1);
  }

  group("[9] 設定形狀：不應再有端點與密鑰欄位");
  {
    const bg = loadBackground();
    const res = await bg.send({ type: "MFOOD_GET_DASHBOARD" });

    check("settings 不含 posEndpoint", "posEndpoint" in (res.settings || {}), false);
    check("settings 不含 posSecret", "posSecret" in (res.settings || {}), false);
    check("仍保留 pushEnabled", "pushEnabled" in (res.settings || {}), true);
  }

  group("[10] 逐單發送狀態註冊表");
  {
    const bg = loadBackground();
    const ROWS = [
      { externalOrderId: "O1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      { externalOrderId: "O2", orderStatus: "completed", createdAt: "2026-09-23T10:00:00.000Z", amount: { businessAmount: 70 } },
    ];

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(160);

    let orders = bg.store.mfoodState.orders || {};
    check("兩筆都登記了", Object.keys(orders).length, 2);
    check("未啟用同步 → 狀態 held（待同步；2026-09-25 由 observed 改，方便開啟同步時精準補送）", orders.O1 && orders.O1.state, "held");
    check("金額有帶入顯示欄位", orders.O1 && orders.O1.amount, 62);
    check("時間有帶入", !!(orders.O1 && orders.O1.at), true);
    check("重複次數初始為 0", orders.O1 && orders.O1.duplicates, 0);
    check("at 為 ISO 可排序", !!(orders.O2 && Date.parse(orders.O2.at)), true);

    // 同一批再送一次（模擬頁面刷新）→ 累加重複次數
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(160);
    orders = bg.store.mfoodState.orders;
    check("重複被累加", orders.O1 && orders.O1.duplicates, 1);
    check("沒有重複登記（仍為 2 筆）", Object.keys(orders).length, 2);

    // 再刷新一次
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(160);
    check("重複次數持續累加", bg.store.mfoodState.orders.O1.duplicates, 2);
  }

  group("[11] 🔴 已設密鑰 → 啟用同步就會真的打 POS 端點，並標記 sent");
  {
    // ⚠️ 2026-09-24 改寫：呢個 group 原本驗「未設密鑰 → 唔可以發請求」。
    //    POS 端個 route 做好、密鑰已填入 background.js 之後，
    //    嗰個前提**已經唔存在**（常數係 `const`，測試改唔到），
    //    所以改成驗另一半：**密鑰設定好之後，推送要真係出得去**。
    //    未設密鑰嘅守衛（`grabPush` 開頭嗰個 if）仍然保留喺程式碼裡，
    //    作用係新 clone 未填密鑰時唔會亂打一個唔存在嘅 API。
    const bg = loadBackground();
    bg.store.mfoodSettings = { pushEnabled: true };
    // 🔴 一定要有 Store ID：冇嘅話 grabPush 會喺本地就擋住（唔發請求）
    bg.store.machineId = "store-1";

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "P1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(220);

    const o = (bg.store.mfoodState.orders || {}).P1;
    check("狀態為 sent（推送成功）", o && o.state, "sent");
    check("嘗試次數為 1", o && o.attempts, 1);
    check(
      "🔴 確實有打 POS 端點",
      bg.fetchCalls.some((c) => c.url.indexOf("/api/integration/") >= 0),
      true,
    );
    check(
      "🔴 打嘅係 grabber 收單路徑",
      bg.fetchCalls.some((c) => c.url.indexOf("/api/integration/grabber/orders") >= 0),
      true,
    );
    check("冇殘留錯誤訊息", o && o.error, null);

    // 🔴 2026-09-24 補：斷言**送出嘅 payload 內容**。
    //    之前只斷言「有打端點」→ 捉唔到 `grabPush()` 參數錯配
    //    （storeId 永遠送空值，POS 回 400）呢種 bug。
    const call = bg.fetchCalls.find(
      (c) => c.url.indexOf("/api/integration/grabber/orders") >= 0,
    );
    const body = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    check("🔴 payload 有 storeId 而且唔係空", !!(body && body.storeId), true);
    check("🔴 payload.orders 係陣列（唔可以變成 settings 物件）", Array.isArray(body && body.orders), true);
    check(
      "🔴 payload.orders 帶到單號",
      !!(body && body.orders[0] && body.orders[0].externalOrderId),
      true,
    );
    check("🔴 有帶密鑰標頭", !!(call && call.init.headers && call.init.headers["X-Grabber-Secret"]), true);
  }

  group("[12] 詳情也會登記逐單狀態");
  {
    const bg = loadBackground();
    await bg.send({
      type: "AOMI_ORDER_DETAIL_CAPTURED",
      detail: {
        externalOrderId: "TK_D1",
        stateEnum: "ORDER_ARRIVED",
        occurredAt: "2026-09-17 19:07:21",
        items: [{ name: "A16.洋蔥炒雞", displayName: "洋蔥炒雞", itemCode: "A16", quantity: 1 }],
        amount: { payAmount: 121 },
      },
    });
    await bg.tick(180);

    const o = (bg.store.aomiState.orders || {}).TK_D1;
    check("詳情帶來的單有登記", !!o, true);
    check("金額取客人實付", o && o.amount, 121);
    check("時間用 occurredAt", o && o.at, "2026-09-17 19:07:21");
  }

  group("[13] 🔴 舊版時期已抓過的單，仍須出現在清單（本次 bug 回歸測試）");
  {
    const bg = loadBackground();
    const ROWS = [
      { externalOrderId: "H1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      { externalOrderId: "H2", orderStatus: "completed", createdAt: "2026-09-23T10:00:00.000Z", amount: { businessAmount: 70 } },
    ];

    // 模擬真實情境：舊版已經抓過（seen 有記錄），但 orders 註冊表是空的。
    // 修正前，這種情況下 fresh 永遠是空的 → 清單永遠空白。
    const keys = ROWS.map((r) => `${r.externalOrderId}|${r.orderStatus}`);
    bg.store.mfoodState = {
      seen: Object.fromEntries(keys.map((k) => [k, Date.now() - 86400000])),
      orders: {},
      counters: {},
    };

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(180);

    const orders = bg.store.mfoodState.orders || {};
    check("已見過的單仍被登記（清單不會空白）", Object.keys(orders).length, 2);
    check("標為 observed（歷史資料，本次不送出）", orders.H1 && orders.H1.state, "observed");
    check("金額有帶入", orders.H1 && orders.H1.amount, 62);
    check("沒有被誤判為新單", bg.store.mfoodState.counters.freshRows, 0);
    check("重複次數有累加", orders.H1 && orders.H1.duplicates, 1);
  }

  group("[14] 重新整理不得把已送出的狀態降級");
  {
    const bg = loadBackground();
    const ROWS = [
      { externalOrderId: "S1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
    ];

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(180);

    // 模擬成功送出後的狀態
    bg.store.mfoodState.orders.S1.state = "sent";
    bg.store.mfoodState.orders.S1.attempts = 1;

    // 再刷新兩次
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(180);
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: ROWS, meta: {} });
    await bg.tick(180);

    check("狀態仍為 sent（沒被降級）", bg.store.mfoodState.orders.S1.state, "sent");
    check("attempts 未被歸零", bg.store.mfoodState.orders.S1.attempts, 1);
    check("重複次數持續累加", bg.store.mfoodState.orders.S1.duplicates, 2);
  }

  group("[15] 重新掃描（不需要 tabs 權限）");
  {
    const bg = loadBackground();

    // 還沒偵測到分頁 → 必須給出可行動的錯誤，而不是靜默失敗
    const r1 = await bg.send({ type: "MFOOD_RESCAN" });
    check("沒有分頁時回 ok:false", !!(r1 && r1.ok === false), true);
    check("錯誤訊息提到 F5", !!(r1 && r1.reason && r1.reason.indexOf("F5") >= 0), true);

    // PAGE_READY 會記住回報的分頁
    await bg.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/trade/takeout" },
      { tab: { id: 42 } },
    );
    await bg.tick(140);
    check("PAGE_READY 記住分頁 id", bg.store.mfoodState.tabId, 42);

    // 有分頁之後，重新掃描要送到該分頁
    const r2 = await bg.send({ type: "MFOOD_RESCAN" });
    await bg.tick(80);
    check("有分頁時回 ok:true", !!(r2 && r2.ok), true);
    check("訊息送到正確的分頁", bg.state.sentTabs.some((t) => t.tabId === 42), true);
    check("訊息類型正確", bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_RESCAN"), true);

    // 澳覓要各自獨立，不能互相污染
    const r3 = await bg.send({ type: "AOMI_RESCAN" });
    check("澳覓尚未回報過分頁 → ok:false", !!(r3 && r3.ok === false), true);
  }

  group("[16] 🔴 診斷匯出：敏感值必須被遮蔽");
  {
    const bg = loadBackground();

    await bg.send({
      type: "MFOOD_TEMPLATE_CAPTURED",
      template: {
        url: "https://management-api.mfoodapp.com/merchants/takeouts/order/_get",
        method: "POST",
        headerNames: ["content-type", "cookie", "authorization", "x-ca-signature"],
        headers: {
          "content-type": "application/json",
          cookie: "session=SUPER_SECRET_VALUE",
          authorization: "Bearer SECRET",
          "x-ca-signature": "abc123",
        },
        body: '{"id":"202609230932086463403"}',
        sampleId: "202609230932086463403",
      },
    });
    await bg.tick(180);

    const diag = await bg.send({ type: "GRAB_DIAGNOSTICS" });
    check("診斷有回傳", !!diag, true);
    check("含版本號", typeof diag.extensionVersion, "string");
    check("含全部來源", !!(diag.sources && diag.sources.length === 2), true);
    check("含遮蔽說明備註", typeof diag.note, "string");

    const text = JSON.stringify(diag);
    check("沒有外流 cookie 值", text.indexOf("SUPER_SECRET_VALUE") < 0, true);
    check("沒有外流 authorization", text.indexOf("Bearer SECRET") < 0, true);
    check("沒有外流簽章", text.indexOf("abc123") < 0, true);
    check(
      "但保留標頭名稱（仍能判斷有沒有帶憑證）",
      text.indexOf("x-ca-signature") >= 0,
      true,
    );

    const log = bg.store.mfoodLog || [];
    check("日誌有記錄範本擷取", log.some((e) => e.kind === "mfood_template"), true);
  }

  group("[17] 自動化開關預設必須是關的");
  {
    const bg = loadBackground();
    const res = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    check("autoRefresh 預設關", res.settings.autoRefresh, false);
    check("autoFetchDetails 預設關", res.settings.autoFetchDetails, false);
    check("detailDelayMs 有預設值", res.settings.detailDelayMs > 0, true);
    check("maxDetailsPerRun 有預設值", res.settings.maxDetailsPerRun > 0, true);
  }

  group("[18] 品項合併進註冊表");
  {
    const bg = loadBackground();
    await bg.send({
      type: "MFOOD_ORDER_DETAIL_CAPTURED",
      detail: {
        externalOrderId: "D1",
        tradeNo: "CRDD1",
        items: [{ displayName: "表嫂手打肉餅", quantity: 1, unitPrice: 58 }],
        amount: { payAmount: 53.9 },
      },
    });
    await bg.tick(200);

    const o = (bg.store.mfoodState.orders || {}).D1;
    check("品項有寫進註冊表", o && (o.items || []).length, 1);
    check("itemCount 正確", o && o.itemCount, 1);
    check("detailState = done", o && o.detailState, "done");
    check("tradeNo 有記下來（DOM 定位要用）", o && o.tradeNo, "CRDD1");
  }

  group("[19] 定時查詢（autoTick）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 7 } });
    await bg.tick(160);

    await bg.fireAlarm("grabAutoTick");
    const rescans0 = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length;
    check("未開啟 autoRefresh 時不動作", rescans0, 0);

    // 開啟後應立即動作
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: true };
    await bg.fireAlarm("grabAutoTick");
    const rescans1 = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length;
    // 🔴 2026-09-30：每 tick 會用 grabApplyPagePrepare 重新套「訂單狀態＝全部」
    //    （單一分頁切去對帳頁再返嚟會 reset SPA 篩選，必須每輪補返），
    //    而套篩選後要再撳一次「查詢」⇒ 所以每 tick 除咗 autoRefresh 嗰次 rescan，
    //    仲多咗一次（套 filter 嗰次）。故預期 2。
    check("開啟後送出重新掃描", rescans1, 2);
    check("有記錄 lastAutoRefreshAt", !!bg.store.mfoodState.lastAutoRefreshAt, true);

    // 立刻再跑一次 → autoRefresh 嗰次被間隔節流，但套 filter 嗰次每 tick 都有
    await bg.fireAlarm("grabAutoTick");
    const rescans2 = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length;
    check("同一分鐘內不重複觸發（autoRefresh 有節流；filter 重套每 tick 一次）", rescans2, 3);
  }

  group("[20] 自動抓詳情：未開啟時不派工");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 9 } });
    await bg.tick(160);

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "L1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(220);

    check(
      "未開啟 autoFetchDetails 時不派工",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS"),
      false,
    );
    check("訂單仍在註冊表中（只是沒抓品項）", !!bg.store.mfoodState.orders.L1, true);
  }

  group("[21] 舊版遺留的設定欄位會被清掉");
  {
    const bg = loadBackground();

    // 模擬舊版（v1.8 以前）留在 storage 的設定
    bg.store.mfoodSettings = {
      pushEnabled: false,
      posEndpoint: "https://old.example.com/orders",
      posSecret: "OLD_SECRET_VALUE",
      pushTerminalStates: false,
      autoRefresh: true,
    };

    const res = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    check("posEndpoint 不再回傳", "posEndpoint" in res.settings, false);
    check("posSecret 不再回傳", "posSecret" in res.settings, false);
    check("pushTerminalStates 不再回傳", "pushTerminalStates" in res.settings, false);
    check("已知欄位仍保留", res.settings.autoRefresh, true);

    const text = JSON.stringify(res.settings);
    check("舊密鑰不會出現在輸出中", text.indexOf("OLD_SECRET_VALUE") < 0, true);
  }

  group("[22] 🔴 autoTick 會派工抓詳情（不依賴列表事件）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    // 先讓註冊表有一筆沒有品項的單
    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "N1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(220);

    const countFetch = () =>
      bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS").length;

    check("未開啟時不派工", countFetch(), 0);

    // 只開「自動抓詳情」，刻意不開「定時查詢」
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: false, autoFetchDetails: true };
    await bg.fireAlarm("grabAutoTick");

    check("只開自動抓詳情也會派工", countFetch(), 1);
    check(
      "沒有誤觸發重新掃描",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_RESCAN"),
      false,
    );
    check("派工只帶沒品項的單", (() => {
      const msg = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS").pop();
      return msg && msg.msg.orders.length;
    })(), 1);
  }

  group("[23] 🔴 手動抓取品項不受「自動開關」限制");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 9 } });
    await bg.tick(160);

    // 有訂單，但 autoFetchDetails 是關的
    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "M1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(240);

    const res = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("手動觸發成功（不受開關限制）", !!(res && res.ok), true);
    check("回報派工筆數", res && res.dispatched, 1);
    check(
      "確實有送出派工訊息",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS"),
      true,
    );
  }

  group("[24] 🔴 抓不到品項時必須回報原因，不得靜默失敗");
  {
    const bg1 = loadBackground();
    const r1 = await bg1.send({ type: "MFOOD_FETCH_DETAILS" });
    check("沒有任何訂單時回 ok:false", !!(r1 && r1.ok === false), true);
    check("並說明原因（不是 undefined）", !!(r1 && r1.reason && r1.reason.length > 0), true);

    const bg2 = loadBackground();
    await bg2.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 3 } });
    await bg2.tick(160);
    await bg2.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "M2", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg2.tick(240);

    // 讓這張單取得品項
    await bg2.send({
      type: "MFOOD_ORDER_DETAIL_CAPTURED",
      detail: { externalOrderId: "M2", items: [{ displayName: "菜" }], amount: { payAmount: 10 } },
    });
    await bg2.tick(220);

    const r2 = await bg2.send({ type: "MFOOD_FETCH_DETAILS" });
    check("全部已取得品項時回 ok:false", !!(r2 && r2.ok === false), true);
    check(
      "🔴 說明「已取得過品項、不再重複拿取」",
      !!(
        r2 &&
        r2.reason &&
        r2.reason.indexOf("已取得過品項") >= 0 &&
        r2.reason.indexOf("不再重複拿取") >= 0
      ),
      true,
    );
    check("🔴 並回報有幾筆是已抓過的（名冊有在運作）", r2 && r2.settled, 1);
  }

  group("[25] 🔴「開始」= 三個平台的總開關");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 11 } });
    await bg.send({ type: "AOMI_PAGE_READY", href: "y" }, { tab: { id: 12 } });
    await bg.tick(200);

    let mf = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    let am = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    check("mfood 初始為關", mf.settings.autoRefresh, false);
    check("aomi 初始為關", am.settings.autoRefresh, false);

    // 按下「開始」
    const r = await bg.send({ type: "GRAB_SET_AUTOMATION", enabled: true });
    await bg.tick(280);
    check("回報成功", !!(r && r.ok), true);
    check("涵蓋 2 個來源", r && r.sources, 2);

    mf = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    am = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    check("mfood autoRefresh 開啟", mf.settings.autoRefresh, true);
    check("mfood autoFetchDetails 開啟", mf.settings.autoFetchDetails, true);
    check("aomi autoRefresh 開啟", am.settings.autoRefresh, true);
    check("aomi autoFetchDetails 開啟", am.settings.autoFetchDetails, true);

    check(
      "按下後立即觸發一次查詢（不用等下一拍）",
      bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length >= 1,
      true,
    );
  }

  group("[26] 🔴「停止」= 三個平台全部停掉");
  {
    const bg = loadBackground();
    await bg.send({ type: "GRAB_SET_AUTOMATION", enabled: true });
    await bg.tick(260);

    const r2 = await bg.send({ type: "GRAB_SET_AUTOMATION", enabled: false });
    await bg.tick(260);

    const mf = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    const am = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    check("回報 enabled=false", r2 && r2.enabled, false);
    check("mfood 定時查詢關閉", mf.settings.autoRefresh, false);
    check("mfood 抓詳情關閉", mf.settings.autoFetchDetails, false);
    check("aomi 定時查詢關閉", am.settings.autoRefresh, false);

    // 停止後再跑一拍，不應再送出查詢
    const before = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length;
    await bg.fireAlarm("grabAutoTick");
    const after = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN").length;
    check("停止後不再自動查詢", after, before);
  }

  group("[27] alarm 週期為 30 秒（瀏覽器下限）");
  {
    const bg = loadBackground();
    const a = (bg.state.alarms || []).find((x) => x.name === "grabAutoTick");
    check("grabAutoTick 已註冊", !!a, true);
    check("週期 0.5 分鐘 = 30 秒", a && a.opts && a.opts.periodInMinutes, 0.5);
  }

  group("[28] 🔴 派工失敗不得消耗重試配額（「卡在抓取品項中」的根因）");
  {
    const bg = loadBackground();
    // 有訂單，但刻意不給 tabId → 派工必定失敗
    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "F1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(260);

    for (let i = 0; i < 4; i++) {
      const r = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
      check(`第 ${i + 1} 次派工失敗有原因`, !!(r && r.ok === false && r.reason), true);
      await bg.tick(180);
    }

    const e = (bg.store.mfoodState.orders || {}).F1;
    check("重試次數沒有被消耗（仍為 0）", e && (e.detailAttempts || 0), 0);
    check("狀態沒有卡在 fetching", e && e.detailState, "none");

    // 事後補上分頁 → 應該立刻能派工成功（證明配額沒被吃光）
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 21 } });
    await bg.tick(180);
    const ok = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("補上分頁後仍能派工（配額沒被吃光）", !!(ok && ok.ok), true);
  }

  group("[29] 卡在 fetching 超過 2 分鐘視為可重試");
  {
    const bg = loadBackground();
    bg.store.mfoodState = {
      seen: {},
      tabId: 5,
      orders: {
        ST1: {
          id: "ST1",
          at: "2026-09-23T09:00:00.000Z",
          state: "observed",
          items: [],
          detailState: "fetching",
          detailAttempts: 3,
          detailQueuedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
      },
      counters: {},
    };

    const r = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    await bg.tick(240);
    check("過期後可重新派工", !!(r && r.ok), true);
  }

  group("[30] 剛派工過的不要重複派，且說明是「抓取中」");
  {
    const bg = loadBackground();
    bg.store.mfoodState = {
      seen: {},
      tabId: 5,
      orders: {
        ST2: {
          id: "ST2",
          at: "2026-09-23T09:00:00.000Z",
          state: "observed",
          items: [],
          detailState: "fetching",
          detailAttempts: 1,
          detailQueuedAt: new Date().toISOString(),
        },
      },
      counters: {},
    };

    const r = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    await bg.tick(220);
    check("不重複派工", !!(r && r.ok === false), true);
    check(
      "原因說明是「抓取中」而不是「都已取得品項」",
      !!(r && r.reason && r.reason.indexOf("抓取中") >= 0),
      true,
    );
  }

  group("[31] 🔴 cut-off 要清掉「先前已登記」但超出範圍的舊單");
  {
    const bg = loadBackground();
    bg.store.startDate = "2026-09-22";

    // 模擬「先前用較寬鬆的 cut-off（例如 08-13）時就已經登記」的舊單
    const blank = (id, at) => ({
      id,
      at,
      state: "observed",
      items: [],
      detailState: "none",
      detailAttempts: 0,
      duplicates: 0,
    });
    bg.store.mfoodState = {
      seen: {},
      tabId: 5,
      orders: {
        OLD1: blank("OLD1", "2026-09-10T09:00:00.000Z"),
        OLD2: blank("OLD2", "2026-08-20T09:00:00.000Z"),
        NEW1: blank("NEW1", "2026-09-23T09:00:00.000Z"),
      },
      counters: {},
    };

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "NEW1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(280);

    const orders = bg.store.mfoodState.orders || {};
    check("09-10 的舊單被清除", !!orders.OLD1, false);
    check("08-20 的舊單被清除", !!orders.OLD2, false);
    check("範圍內的單保留", !!orders.NEW1, true);
    check("有記錄清除數量", bg.store.mfoodState.counters.prunedByCutoff, 2);

    const entry = (bg.store.mfoodLog || []).find((e) => e.kind === "mfood_order_list");
    check("日誌有提到清除（不是靜默）", !!(entry && entry.summary.indexOf("清除") >= 0), true);
  }

  group("[32] popup 的「開始」要夾住 30 秒下限");
  {
    // 純邏輯驗證：與 popup.js 相同的算法
    const clamp = (raw) => Math.max(30, parseInt(raw) || 60);
    check("填 10 → 30", clamp(10), 30);
    check("填 30 → 30", clamp(30), 30);
    check("填 60 → 60", clamp(60), 60);
    check("填 0（無效）→ 60", clamp(0), 60);
    check("空字串 → 60", clamp(""), 60);
  }

  group("[33] 🔴 清除所有訂單：清 orders、保留 seen（避免重複出單）");
  {
    const bg = loadBackground();
    await bg.send(
      {
        type: "MFOOD_ORDER_LIST_CAPTURED",
        rows: [
          { externalOrderId: "C1", orderStatus: "completed", createdAt: "2026-09-23T09:00:00.000Z", amount: { businessAmount: 62 } },
          { externalOrderId: "C2", orderStatus: "completed", createdAt: "2026-09-23T10:00:00.000Z", amount: { businessAmount: 70 } },
        ],
        meta: {},
      },
    );
    await bg.tick(240);

    check("清除前有訂單", Object.keys(bg.store.mfoodState.orders || {}).length, 2);
    const seenBefore = Object.keys(bg.store.mfoodState.seen || {}).length;
    check("清除前有去重記錄", seenBefore > 0, true);

    const r = await bg.send({ type: "GRAB_CLEAR_ALL_ORDERS" });
    await bg.tick(240);

    check("回報成功", !!(r && r.ok), true);
    check("訂單已清空", Object.keys(bg.store.mfoodState.orders || {}).length, 0);
    check(
      "🔴 去重記錄必須保留（否則會重複出單）",
      Object.keys(bg.store.mfoodState.seen || {}).length,
      seenBefore,
    );
  }

  group("[34] 套用同步間隔（可低於 30 秒）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 31 } });
    await bg.tick(160);

    const r = await bg.send({ type: "GRAB_APPLY_INTERVAL", secs: 10 });
    await bg.tick(220);

    check("回報成功", !!(r && r.ok), true);
    check("回報秒數", r && r.secs, 10);
    check(
      "有把間隔推給內容腳本",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_SET_INTERVAL" && t.msg.secs === 10),
      true,
    );

    // 停止：secs = 0
    await bg.send({ type: "GRAB_APPLY_INTERVAL", secs: 0 });
    await bg.tick(200);
    check(
      "可以推 0 來關閉計時",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_SET_INTERVAL" && t.msg.secs === 0),
      true,
    );
  }

  group("[35] 套用日期並逐頁抓全部");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 41 } });
    await bg.tick(160);

    const r = await bg.send({ type: "GRAB_SYNC_RANGE", startDate: "2026-09-21" });
    await bg.tick(260);

    check("回報成功", !!(r && r.ok), true);
    check(
      "有送出範圍同步指令",
      bg.state.sentTabs.some(
        (t) => t.msg && t.msg.type === "GRAB_SYNC_RANGE" && t.msg.startDate === "2026-09-21",
      ),
      true,
    );

    const log = bg.store.mfoodLog || [];
    check("有寫入日誌", log.some((e) => e.kind === "mfood_sync_range"), true);
  }

  group("[36] 🔴 頁面太久沒回報 → 自動重新載入（自我修復）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 71 } });
    await bg.tick(200);

    // 沒開 autoRefresh → 不應介入
    await bg.fireAlarm("grabAutoTick");
    check("未開啟自動時不重載", bg.state.reloadedTabs.length, 0);

    // 開啟自動，且上次擷取是 10 分鐘前（遠超 3 個週期）
    bg.store.mfoodSettings = {
      pushEnabled: false,
      autoRefresh: true,
      autoFetchDetails: false,
      autoReload: true,
      detailDelayMs: 1200,
      maxDetailsPerRun: 30,
    };
    const st = bg.store.mfoodState || {};
    st.tabId = 71;
    st.lastListCaptureAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    bg.store.mfoodState = st;

    // 🔴 2026-09-25 新語意：**頁面仲活住就唔應該 F5**（更新內容按「查詢」就得）。
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);
    check(
      "🔴 內容腳本活住時唔應該重載（資料過期 ≠ 頁面壞）",
      bg.state.reloadedTabs.length,
      0,
    );

    // 模擬「內容腳本已死」（sendMessage 報 lastError）→ 呢個才應該 F5 救援
    bg.state.tabDead = true;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(320);

    check("有呼叫 tabs.reload", bg.state.reloadedTabs.some((t) => t.tabId === 71), true);
    check("有記錄 lastAutoReloadAt", !!bg.store.mfoodState.lastAutoReloadAt, true);

    const log = bg.store.mfoodLog || [];
    check("有寫入自動重載日誌", log.some((e) => e.kind === "mfood_auto_reload"), true);

    // 冷卻：立刻再跑一次不該再重載
    const before = bg.state.reloadedTabs.length;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);
    check("冷卻期內不重複重載（避免無限重載）", bg.state.reloadedTabs.length, before);
  }

  group("[37] 自動重載可用開關關閉");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 81 } });
    await bg.tick(200);

    bg.store.mfoodSettings = {
      pushEnabled: false,
      autoRefresh: true,
      autoFetchDetails: false,
      autoReload: false,
      detailDelayMs: 1200,
      maxDetailsPerRun: 30,
    };
    const st = bg.store.mfoodState || {};
    st.tabId = 81;
    st.lastListCaptureAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    bg.store.mfoodState = st;

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);
    check("關掉後不重載", bg.state.reloadedTabs.length, 0);
  }

  group("[38] 剛擷取過就不該重載");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 91 } });
    await bg.tick(200);

    bg.store.mfoodSettings = {
      pushEnabled: false,
      autoRefresh: true,
      autoFetchDetails: false,
      autoReload: true,
      detailDelayMs: 1200,
      maxDetailsPerRun: 30,
    };
    const st = bg.store.mfoodState || {};
    st.tabId = 91;
    st.lastListCaptureAt = new Date(Date.now() - 3000).toISOString(); // 3 秒前
    bg.store.mfoodState = st;

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);
    check("剛擷取過不重載", bg.state.reloadedTabs.length, 0);
  }

  group("[39] 🔴 澳覓已取消／待退款：只記錄不推送，且不佔用去重記錄");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "CX1",
      storeSeqNo: "#9",
      orderDateTime: "2026-09-23 10:00:00",
      amount: { businessAmount: 50 },
    };

    await bg.send({
      type: "AOMI_ORDER_LIST_CAPTURED",
      rows: [ROW],
      observedOnly: true,
      meta: {},
    });
    await bg.tick(160);

    const st = bg.store.aomiState;
    check("🔴 不算新單（因此不會被推送）", st.counters.freshRows, 0);

    const orders = st.orders || {};
    check("🔴 但仍會登記，清單看得到", !!orders.CX1, true);
    check("🔴 狀態為 observed（只記錄）", orders.CX1 && orders.CX1.state, "observed");
    check("訂單編號仍有帶入", orders.CX1 && orders.CX1.seq, "#9");

    // 🔴 關鍵：不可寫入 seen。否則這張單日後轉為正常狀態時，
    //    會被當成「已見過」而永遠不推送 —— 那才是真正會漏單的情況。
    check("🔴 沒有寫入 seen", !!st.seen["CX1|"], false);

    const entry = (bg.store.aomiLog || []).find((e) => e.kind === "aomi_order_list");
    check(
      "日誌要說明只記錄不推送",
      !!(entry && entry.summary.includes("只記錄")),
      true,
    );
  }

  group("[40] 對照組：同一張單走正常輪次就會算新單並寫入 seen");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "CX1",
      storeSeqNo: "#9",
      orderDateTime: "2026-09-23 10:00:00",
      amount: { businessAmount: 50 },
    };

    await bg.send({ type: "AOMI_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);

    const st = bg.store.aomiState;
    check("有算為新單", st.counters.freshRows, 1);
    check("有寫入 seen", !!st.seen["CX1|"], true);

    const entry = (bg.store.aomiLog || []).find((e) => e.kind === "aomi_order_list");
    check(
      "日誌不該出現只記錄字樣",
      !!(entry && entry.summary.includes("只記錄")),
      false,
    );
  }

  group("[41] 🔴 同步結果要寫明「日期有沒有真的套用」");
  {
    const bg = loadBackground();
    const st = bg.store.aomiState || {};
    st.tabId = 77;
    bg.store.aomiState = st;

    // ① 頁面沒吃我們的日期 → 必須明說，不可以含糊帶過
    bg.state.tabReply = () => ({
      ok: true,
      via: "dom",
      dateOk: false,
      dateMode: null,
      types: [{ type: "GOING", verified: false }],
      verifiedTypes: 0,
      pages: 0,
    });

    await bg.send({ type: "GRAB_SYNC_RANGE", startDate: "2026-09-22" });
    await bg.tick(140);

    let entry = (bg.store.aomiLog || []).find((e) => e.kind === "aomi_sync_range");
    check("有寫入同步日誌", !!entry, true);
    check(
      "🔴 明說日期未能套用",
      !!(entry && entry.summary.includes("日期未能套用")),
      true,
    );

    // ② 日期有套用 → 要寫出用了哪種格式
    bg.store.aomiLog = [];
    bg.state.tabReply = () => ({
      ok: true,
      via: "dom",
      dateOk: true,
      dateMode: "datetime",
      types: [{ type: "GOING", verified: true }],
      verifiedTypes: 1,
      pages: 2,
    });

    await bg.send({ type: "GRAB_SYNC_RANGE", startDate: "2026-09-22" });
    await bg.tick(140);

    entry = (bg.store.aomiLog || []).find((e) => e.kind === "aomi_sync_range");
    check(
      "🔴 明說日期已套用且寫出格式",
      !!(entry && entry.summary.includes("日期已套用（含時間）")),
      true,
    );
    check(
      "帶出回讀驗證結果",
      !!(entry && entry.summary.includes("回讀驗證 1/1")),
      true,
    );
  }

  group("[42] 🔴 已拿過品項的單，連手動 force 都不再派工");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "M9",
      tradeNo: "CRD_M9",
      orderStatus: "completed",
      createdAt: "2026-09-23T09:00:00.000Z",
      amount: { businessAmount: 62 },
    };
    bg.store.mfoodSettings = { autoFetchDetails: false, maxDetailsPerRun: 30 };
    // 刻意關掉自動抓詳情：這兩個測試要驗的是「手動 force 也不會重抓」
    // 用 PAGE_READY 設定 tabId —— 與其他測試一致（sender.tab.id）
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);

    // 第一次派工 → 應該要有（還沒拿過品項）
    const r1 = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("第一次有派工", !!(r1 && r1.ok), true);
    await bg.tick(160);

    // 拿到品項
    await bg.send({
      type: "MFOOD_ORDER_DETAIL_CAPTURED",
      detail: {
        externalOrderId: "M9",
        tradeNo: "CRD_M9",
        items: [{ displayName: "菜" }],
        amount: { payAmount: 10 },
      },
    });
    await bg.tick(220);

    const st = bg.store.mfoodState;
    check("🔴 名冊用訂單號記下了", !!(st.detailDone && st.detailDone["CRD_M9"]), true);

    const r2 = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("不再派工", !!(r2 && r2.ok === false), true);

    // 🔴 手動 force 也不可以再抓（使用者的明確要求）
    const r3 = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("🔴 手動 force 也不再派工", !!(r3 && r3.ok === false), true);
    check(
      "訊息說明已抓過、不再重複",
      !!(r3 && r3.reason && r3.reason.indexOf("已取得過品項") >= 0),
      true,
    );
  }

  group("[43] 🔴 註冊表被重建後，名冊仍阻止重複拿取");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "M9",
      tradeNo: "CRD_M9",
      orderStatus: "completed",
      createdAt: "2026-09-23T09:00:00.000Z",
      amount: { businessAmount: 62 },
    };
    bg.store.mfoodSettings = { autoFetchDetails: false, maxDetailsPerRun: 30 };
    // 刻意關掉自動抓詳情：這兩個測試要驗的是「手動 force 也不會重抓」
    // 用 PAGE_READY 設定 tabId —— 與其他測試一致（sender.tab.id）
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);
    await bg.send({
      type: "MFOOD_ORDER_DETAIL_CAPTURED",
      detail: {
        externalOrderId: "M9",
        tradeNo: "CRD_M9",
        items: [{ displayName: "菜" }],
        amount: { payAmount: 10 },
      },
    });
    await bg.tick(220);

    // 模擬註冊表掉失（容量裁剪 / 舊版殘留 / 手動清過其他地方）
    const st = bg.store.mfoodState;
    st.orders = {};
    bg.store.mfoodState = st;

    // 列表再次擷取 → 重新登記這一筆
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);

    const st2 = bg.store.mfoodState;
    check("重新登記了", !!st2.orders.M9, true);
    check("🔴 名冊把狀態補回 done", st2.orders.M9 && st2.orders.M9.detailState, "done");

    const r = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    check("🔴 不會被重新抓取", !!(r && r.ok === false), true);
  }

  group("[44] 🔴 清除所有訂單要一併清掉名冊（否則永遠不再抓品項）");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "M9",
      tradeNo: "CRD_M9",
      orderStatus: "completed",
      createdAt: "2026-09-23T09:00:00.000Z",
      amount: { businessAmount: 62 },
    };
    bg.store.mfoodSettings = { autoFetchDetails: true, maxDetailsPerRun: 30 };

    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);
    await bg.send({
      type: "MFOOD_ORDER_DETAIL_CAPTURED",
      detail: {
        externalOrderId: "M9",
        tradeNo: "CRD_M9",
        items: [{ displayName: "菜" }],
        amount: { payAmount: 10 },
      },
    });
    await bg.tick(220);

    check(
      "名冊有記錄",
      !!bg.store.mfoodState.detailDone["CRD_M9"],
      true,
    );

    await bg.send({ type: "GRAB_CLEAR_ALL_ORDERS" });
    await bg.tick(200);

    check(
      "🔴 名冊已清空（否則那些單永遠不會再抓品項）",
      Object.keys(bg.store.mfoodState.detailDone || {}).length,
      0,
    );
  }

  group("[45] 🔴 模擬點擊的重試上限比請求重放低（少開彈窗）");
  {
    const bg = loadBackground();
    const ROW = {
      externalOrderId: "A9",
      storeSeqNo: "#9",
      orderStatus: "completed",
      orderDateTime: "2026-09-23 09:00:00",
      amount: { businessAmount: 62 },
    };
    bg.store.aomiSettings = { autoFetchDetails: true, maxDetailsPerRun: 30 };
    await bg.send({ type: "AOMI_PAGE_READY", href: "x" }, { tab: { id: 9 } });
    await bg.tick(160);

    await bg.send({ type: "AOMI_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(160);

    // 手動把這筆設定成「已重試 2 次、非進行中」
    let st = bg.store.aomiState;
    st.orders.A9.detailState = "failed";
    st.orders.A9.detailAttempts = 2;
    st.orders.A9.detailQueuedAt = null;
    bg.store.aomiState = st;

    // 走自動路徑（不 force，才會套用重試上限）
    bg.state.sentTabs.length = 0;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(260);

    const dispatched = bg.state.sentTabs.filter(
      (t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS",
    ).length;
    check("🔴 澳覓（模擬點擊）已達上限 2 → 不再派工", dispatched, 0);

    // 對照組：只重試過 1 次 → 應該還是會派工
    st = bg.store.aomiState;
    st.orders.A9.detailAttempts = 1;
    bg.store.aomiState = st;

    bg.state.sentTabs.length = 0;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(260);

    const dispatched2 = bg.state.sentTabs.filter(
      (t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS",
    ).length;
    check("只重試 1 次時仍會派工", dispatched2 > 0, true);
  }

  group("[46] 🔴 建假訂單：推送 payload 一定要係非空陣列（回歸）");
  {
    // 實測踩過：假單產生器傳**單一物件** → POS 端 Array.isArray 唔過
    // → 回 `ok:true, received:0`（**靜默假成功**：使用者見到「已推送」但一張都沒入）。
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.store.mfoodSettings = { pushEnabled: true };

    const res = await bg.send({ type: "GRAB_BUILD_FAKE_ORDER", source: "mfood" });
    await bg.tick(240);

    check("回報成功", !!(res && res.ok), true);

    const call = bg.fetchCalls.find(
      (c) => c.url.indexOf("/api/integration/grabber/orders") >= 0,
    );
    check("🔴 確實有發請求", !!call, true);

    const body = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    check("🔴 payload.orders 係陣列", Array.isArray(body && body.orders), true);
    check("🔴 payload.orders 唔可以係空（空 = POS 收到 0 張單）", (body && body.orders && body.orders.length) || 0, 1);
    check("🔴 假單有帶 storeId", !!(body && body.storeId), true);
    check("🔴 假單有帶來源", !!(body && body.orders[0] && body.orders[0].source), true);
  }

  group("[47] 🔴 grabPush 收到非陣列 orders 要即刻報錯，唔准靜默送出");
  {
    // 直接把 orders 由陣列改成物件嘅話，POS 會回 ok:true+created:0。
    // 呢個守衛令「呼叫端 bug」變成大聲失敗。
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.store.aomiSettings = { pushEnabled: true };

    // 用假單按鈕（正常路徑）證明佢係陣列；再由下面斷言守衛存在
    await bg.send({ type: "GRAB_BUILD_FAKE_ORDER", source: "aomi" });
    await bg.tick(240);

    const call = bg.fetchCalls.find(
      (c) => c.url.indexOf("/api/integration/grabber/orders") >= 0,
    );
    const body = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    check("🔴 澳覓假單一樣係非空陣列", (body && body.orders && body.orders.length) || 0, 1);

    // 🔴🔴 2026-09-24 更正：原本呢度斷言 `storeSeqNo`。
    //
    // 但**澳覓 bridge 從來冇發過呢個名** —— `aomi-bridge.js::normalizeDetail()` 出嘅係
    // `storeSeq`（`"10"`）＋ `localOrderNo`（`"#10"`）。
    // 即係話呢條斷言一直喺度「證明假單正常」，實際上係逼假單去啱一個**真單唔存在嘅欄位名**
    // → 真澳覓單嘅單號靜靜跌到 fallback（`澳覓#<外部單號尾6位>`）都冇人知。
    //
    // ⇒ 假資料一定要同真 payload 用**同一套欄位名**，否則測試只係自我安慰。
    const aomi0 = (body && body.orders && body.orders[0]) || {};
    check(
      "🔴 澳覓假單用真 bridge 嘅欄位名（storeSeq / localOrderNo）",
      !!(aomi0.storeSeq || aomi0.localOrderNo),
      true,
    );
  }

  group("[48] 🔴 假單要同真實 bridge 用同一套欄位名（防止假資料掩蓋真 bug）");
  {
    /** 觸發一次假單並回傳送出去嘅 payload。 */
    async function fakeOrderPayload(source, count) {
      const bg = loadBackground();
      bg.store.machineId = "store-1";
      bg.store.mfoodSettings = { pushEnabled: true };
      bg.store.aomiSettings = { pushEnabled: true };
      await bg.send({ type: "GRAB_BUILD_FAKE_ORDER", source: source, count: count });
      await bg.tick(240);
      const call = bg.fetchCalls.find(
        (c) => c.url.indexOf("/api/integration/grabber/orders") >= 0,
      );
      return call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    }

    // ── mfood ──
    const mf = await fakeOrderPayload("mfood");
    const mo = (mf && mf.orders && mf.orders[0]) || {};
    const ma = mo.amount || {};
    check("mfood：用真 bridge 嘅 orderNumber", typeof mo.orderNumber === "number", true);
    check("mfood：orderStatus = completed", mo.orderStatus, "completed");
    check("mfood：transactionStatus = paid", mo.transactionStatus, "paid");
    check(
      "mfood：fulfillmentType 係 delivery / pickup（真解碼值）",
      mo.fulfillmentType === "delivery" || mo.fulfillmentType === "pickup",
      true,
    );
    check("mfood：amount.businessAmount 係正數", (ma.businessAmount || 0) > 0, true);
    check(
      "mfood：費用欄位用 POS 讀嘅正規化名（boxFee / plasticBagFee / fullReductionAmount）",
      typeof ma.boxFee === "number" &&
        typeof ma.plasticBagFee === "number" &&
        typeof ma.fullReductionAmount === "number",
      true,
    );
    // 🔴 金額自洽：營業額 = 菜品 + 打包 + 膠袋 + 服務費 − 代金券 − 滿減 − 月卡紅包
    const mfExpected =
      Math.round(
        ((ma.totalAmount || 0) +
          (ma.boxFee || 0) +
          (ma.plasticBagFee || 0) +
          (ma.serviceFee || 0) -
          (ma.voucherAmount || 0) -
          (ma.fullReductionAmount || 0) -
          (ma.memberUpAmount || 0)) *
          100,
      ) / 100;
    check("🔴 mfood：businessAmount 同官方公式一致", ma.businessAmount, mfExpected);
    check(
      "mfood：items 有 displayName / quantity / unitPrice",
      (mo.items || []).length > 0 &&
        mo.items.every((it) => it.displayName && it.quantity > 0 && it.unitPrice > 0),
      true,
    );

    // ── 澳覓 ──
    const ao = await fakeOrderPayload("aomi");
    const a0 = (ao && ao.orders && ao.orders[0]) || {};
    const aa = a0.amount || {};
    check("澳覓：用真 bridge 嘅 storeSeq / localOrderNo", !!(a0.storeSeq || a0.localOrderNo), true);
    check("🔴 澳覓：唔應該再出 storeSeqNo（真 bridge 冇呢個名）", !!a0.storeSeqNo, false);
    check(
      "澳覓：stateEnum 含 ORDER（POS 靠 ASCII enum 判生命週期）",
      String(a0.stateEnum || "").indexOf("ORDER") >= 0,
      true,
    );
    check("澳覓：occurredAt 有值", !!a0.occurredAt, true);
    check("澳覓：amount.turnoverAmount 係正數", (aa.turnoverAmount || 0) > 0, true);
    check(
      "澳覓：費用欄位用 POS 讀嘅名（boxAmt / plasticAmt / merchantActAmt / sendAmt）",
      typeof aa.boxAmt === "number" &&
        typeof aa.plasticAmt === "number" &&
        typeof aa.merchantActAmt === "number" &&
        typeof aa.sendAmt === "number",
      true,
    );
    // 🔴 金額自洽：營業額 = 菜品 + 餐盒 + 膠袋 + 節假日服務費 − 商家活動支出
    const aoExpected =
      Math.round(
        ((aa.totalAmt || 0) +
          (aa.boxAmt || 0) +
          (aa.plasticAmt || 0) +
          (aa.holidayServiceAmt || 0) -
          (aa.merchantActAmt || 0)) *
          100,
      ) / 100;
    check("🔴 澳覓：turnoverAmount 同官方公式一致", aa.turnoverAmount, aoExpected);
    check(
      "澳覓：items 有 name / displayName / quantity / unitPrice",
      (a0.items || []).length > 0 &&
        a0.items.every((it) => it.name && it.displayName && it.quantity > 0 && it.unitPrice > 0),
      true,
    );

    // ── 張數 + 唯一性 ──
    const batch = await fakeOrderPayload("mfood", 5);
    check("可以一次建多張（count = 5）", (batch && batch.orders && batch.orders.length) || 0, 5);
    const ids = ((batch && batch.orders) || []).map((o) => o.externalOrderId);
    check("🔴 同一批嘅外部單號全部唯一", new Set(ids).size, 5);
    const nos = ((batch && batch.orders) || []).map((o) => o.orderNumber);
    check("🔴 同一批嘅顯示單號全部唯一", new Set(nos).size, 5);

    // 🔴 跨兩次呼叫都唔可以撞（舊版用 `Date.now().slice(-6)`，每 ~16.7 分鐘就循環一次）
    const first = await fakeOrderPayload("aomi");
    const second = await fakeOrderPayload("aomi");
    const id1 = first.orders[0].externalOrderId;
    const id2 = second.orders[0].externalOrderId;
    check("🔴 兩次呼叫嘅外部單號唔會撞", id1 === id2, false);
  }

  group("[49] 🔴 未啟用同步 → 標 held；開啟同步會放行補送（2026-09-25 實案）");
  {
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    const ROW = {
      externalOrderId: "HLD1",
      orderStatus: "completed",
      createdAt: "2026-09-25T09:00:00.000Z",
      amount: { businessAmount: 62 },
    };

    // ① 觀察模式（未啟用同步）：只登記，唔推
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(200);

    let o = (bg.store.mfoodState.orders || {}).HLD1;
    check("未啟用同步 → 狀態 held", o && o.state, "held");
    check("冇打 POS 端點", bg.fetchCalls.length, 0);
    check("日誌講明會自動補送", (() => {
      const e = (bg.store.mfoodLog || []).find((x) => x.kind === "push_skipped");
      return !!(e && e.summary.indexOf("自動補送") >= 0);
    })(), true);

    // ② 🔴 觀察模式嘅去重信號**唔可以**被改壞（重複攔截照樣要漲）
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(200);
    check("觀察模式下重複仍會被攔（duplicatesSkipped = 1）",
      bg.store.mfoodState.counters.duplicatesSkipped, 1);
    check("仍然係 held（冇被重複改壞）",
      (bg.store.mfoodState.orders || {}).HLD1.state, "held");
    check("仍然冇打 POS", bg.fetchCalls.length, 0);

    // ③ 開啟同步 → 放行（`seen` 要冇咗嗰個 key）＋ 觸發重新掃描
    const res = await bg.send({ type: "MFOOD_SAVE_SETTINGS", patch: { pushEnabled: true } });
    await bg.tick(260);
    check("設定已儲存", res && res.settings && res.settings.pushEnabled, true);
    check("🔴 去重名冊已放行（HLD1 唔再喺 seen）",
      Object.keys(bg.store.mfoodState.seen || {}).some((k) => k.indexOf("HLD1|") === 0), false);
    check("有寫放行日誌（mfood_release_held）",
      (bg.store.mfoodLog || []).some((x) => x.kind === "mfood_release_held"), true);

    // ④ 下一輪列表擷取 → 當新單 → 真的送出
    await bg.send({ type: "MFOOD_ORDER_LIST_CAPTURED", rows: [ROW], meta: {} });
    await bg.tick(260);
    o = (bg.store.mfoodState.orders || {}).HLD1;
    check("🔴 補送成功（狀態 sent）", o && o.state, "sent");
    check("🔴 真係有打 POS 端點",
      bg.fetchCalls.some((c) => c.url.indexOf("/api/integration/grabber/orders") >= 0), true);
  }

  group("[50] 🔴 自動重載冷卻：3 分鐘內唔可以再 reload（獨立 key 版）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    // 模擬「內容腳本已死」：好久冇列表回報 ＋ 完全冇冷卻記錄
    bg.store.mfoodState = {
      seen: {},
      orders: {},
      counters: {},
      tabId: 5,
      lastListCaptureAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    bg.store.mfoodSettings = {
      pushEnabled: false,
      autoRefresh: true,
      autoFetchDetails: false,
      autoReload: true,
    };

    // 內容腳本已死（自動重載只喺呢個情況下觸發）
    bg.state.tabDead = true;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(320);
    const first = bg.state.reloadedTabs.length;
    check("第一次應該要 reload", first, 1);
    check("🔴 冷卻時間戳寫入專用 key",
      typeof bg.store.mfoodReloadAt, "string");

    // 🔴 呢個就係實案：state 版本被其他 state 寫入覆蓋 → 冷卻失效 → 每 30 秒 reload 一次
    //    專用 key 唔會被覆蓋 ⇒ 第二次一定要被擋住。
    delete bg.store.mfoodState.lastAutoReloadAt; // 模擬「state 欄位被抹走」
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(220);
    check("🔴 state 欄位被抹走都唔可以再 reload（冷卻以專用 key 為準）",
      bg.state.reloadedTabs.length, first);
  }

  group("[51] 🔴 假單唔會派工抓詳情（每 30 秒失敗重試）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    // 註冊表入面有一張假單（測試用，永遠唔會喺真後台列表出現）＋ 一張真單
    bg.store.mfoodState = {
      seen: {},
      counters: {},
      tabId: 5,
      orders: {
        "FAKE-MFOOD-111111-2222": {
          id: "FAKE-MFOOD-111111-2222",
          at: "2026-09-25T09:00:00.000Z",
          state: "held",
          items: [],
          detailState: "none",
          detailAttempts: 0,
        },
        REAL1: {
          id: "REAL1",
          at: "2026-09-25T09:01:00.000Z",
          state: "held",
          items: [],
          detailState: "none",
          detailAttempts: 0,
        },
      },
    };
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: false, autoFetchDetails: true };

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(220);

    const detailMsg = bg.state.sentTabs
      .filter((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS")
      .pop();
    const ids = ((detailMsg && detailMsg.msg.orders) || []).map((o) => o.id || o.externalOrderId);
    check("有派工", !!detailMsg, true);
    check("🔴 派工名單一定唔含假單", ids.some((x) => String(x).indexOf("FAKE-") === 0), false);
    check("真單照樣派工", ids.indexOf("REAL1") >= 0, true);
  }

  group("[52] 🔴 推送 payload 一定要帶品項（POS 對冇品項嘅單會拒收）");
  {
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.store.mfoodSettings = { pushEnabled: true, autoRefresh: false, autoFetchDetails: false };
    // 實案形狀：列表 row **冇** items，但詳情早已抓到、items 躺在註冊表
    bg.store.mfoodState = {
      seen: {},
      counters: {},
      tabId: 5,
      orders: {
        "202609250937046870290": {
          id: "202609250937046870290",
          tradeNo: "CRD202609250937046870290",
          seq: 1,
          amount: 62,
          at: "2026-09-25T01:37:04.000Z",
          state: "held",
          duplicates: 0,
          items: [
            { name: "表嫂手打肉餅", displayName: "表嫂手打肉餅", quantity: 1, unitPrice: 64 },
          ],
          itemCount: 1,
          detailState: "done",
          detailAttempts: 1,
        },
      },
    };

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        {
          externalOrderId: "202609250937046870290",
          orderStatus: "completed",
          createdAt: "2026-09-25T01:37:04.000Z",
          amount: { businessAmount: 62 },
        },
      ],
      meta: {},
    });
    await bg.tick(240);

    const call = bg.fetchCalls.find((c) => c.url.indexOf("/api/integration/grabber/orders") >= 0);
    const body = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    check("🔴 payload 帶到註冊表嘅品項", ((body && body.orders[0] && body.orders[0].items) || []).length, 1);
    check(
      "品項名冇走樣",
      body && body.orders[0] && body.orders[0].items[0] && body.orders[0].items[0].name,
      "表嫂手打肉餅",
    );
    check("原本嘅列表欄位仍在", body && body.orders[0] && body.orders[0].externalOrderId,
      "202609250937046870290");
  }

  group("[53] 🔴 POS 回 rejected[] → 一定要標 failed（唔可以靜默假成功）");
  {
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.store.mfoodSettings = { pushEnabled: true };
    bg.state.fetchReply = () =>
      JSON.stringify({
        ok: true,
        received: 1,
        created: 0,
        rejected: [{ externalOrderId: "RJ1", reason: "payload 內冇可用品項" }],
        warnings: [],
      });

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "RJ1", orderStatus: "completed", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(240);

    const o = (bg.store.mfoodState.orders || {}).RJ1;
    check("🔴 狀態係 failed（唔可以係 sent）", o && o.state, "failed");
    check(
      "錯誤訊息帶住 POS 嘅拒收原因",
      String(o && o.error).indexOf("冇可用品項") >= 0,
      true,
    );
    check(
      "日誌唔可以出現「已送出」",
      (bg.store.mfoodLog || []).some((e) => e.kind === "push" && String(e.summary).indexOf("已送出") >= 0),
      false,
    );
    check(
      "日誌要寫明拒收",
      (bg.store.mfoodLog || []).some((e) => e.kind === "push" && String(e.summary).indexOf("拒收") >= 0),
      true,
    );
  }

  group("[54] 🔴 POS 回 created:0 但冇 rejected（＝重複單）→ 仍然算成功");
  {
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.store.mfoodSettings = { pushEnabled: true };
    bg.state.fetchReply = () =>
      JSON.stringify({ ok: true, received: 1, created: 0, rejected: [], warnings: [] });

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [
        { externalOrderId: "DUP1", orderStatus: "completed", amount: { businessAmount: 62 } },
      ],
      meta: {},
    });
    await bg.tick(240);

    const o = (bg.store.mfoodState.orders || {}).DUP1;
    check("已經喺 POS（重複）唔算失敗", o && o.state, "sent");
  }

  group("[55] 🔴 推送失敗會自動放行重試，並受重試上限保護");
  {
    const bg = loadBackground();
    bg.store.mfoodSettings = { pushEnabled: true, autoRefresh: false, autoFetchDetails: false };
    bg.store.mfoodState = {
      seen: { "F1|completed": Date.now(), "F3|completed": Date.now() },
      counters: {},
      tabId: 5,
      orders: {
        F1: { id: "F1", at: "2026-09-25T09:00:00.000Z", state: "failed", attempts: 1, items: [], duplicates: 0, detailState: "none" },
        F3: { id: "F3", at: "2026-09-25T09:00:00.000Z", state: "failed", attempts: 999, items: [], duplicates: 0, detailState: "none" },
      },
    };

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);

    const st = bg.store.mfoodState;
    check("🔴 未達上限嘅失敗單已放行（seen 冇咗 F1）",
      Object.keys(st.seen || {}).some((k) => k.indexOf("F1|") === 0), false);
    check("放行後狀態轉回 pending", st.orders.F1.state, "pending");
    check("🔴 已達上限（attempts 999）嘅唔再放行（唔會無限重試）",
      Object.keys(st.seen || {}).some((k) => k.indexOf("F3|") === 0), true);
    check("已達上限嘅維持 failed（大聲示人）", st.orders.F3.state, "failed");
    check("有寫重試日誌",
      (bg.store.mfoodLog || []).some((e) => e.kind === "mfood_push_retry"), true);

    // 🔴 冷卻期：剛剛失敗過（lastAt = 現在）→ 今個 tick 唔應該再重試
    //    （冇冷卻期嘅話，10 秒查詢節拍會令配額瞬間燒光）
    bg.store.mfoodState = {
      seen: { "F2|completed": Date.now() },
      counters: {},
      tabId: 5,
      orders: {
        F2: { id: "F2", at: "2026-09-25T09:00:00.000Z", state: "failed", attempts: 1, lastAt: new Date().toISOString(), items: [], duplicates: 0, detailState: "none" },
      },
    };
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(240);
    check(
      "🔴 兩分鐘冷卻期內唔會重試",
      Object.keys(bg.store.mfoodState.seen || {}).some((k) => k.indexOf("F2|") === 0),
      true,
    );
  }
  group("[56] 🔴 成功撳到「查詢」但長時間冇列表回報 → 一定要出警示（唔可以綠燈藏住）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    // 實案形狀：頁面會回「已代按查詢」成功（r.ok = true），但 90 分鐘冇任何列表回報
    bg.store.mfoodState = {
      seen: {},
      orders: {},
      counters: {},
      tabId: 5,
      lastListCaptureAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    };
    bg.store.mfoodSettings = {
      pushEnabled: false,
      autoRefresh: true,
      autoFetchDetails: false,
      autoReload: false,
    };

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(280);

    const err = String(bg.store.mfoodState.lastAutoRefreshError || "");
    check("🔴 要有警示（唔可以係 null）", err.length > 0, true);
    check("警示要叫商家 F5", err.indexOf("F5") >= 0, true);
    check("警示要講清楚係冇回報列表", err.indexOf("沒有回報訂單列表") >= 0, true);
  }

  group("[57] 🔴 有列表回報就唔應該再掛住「有問題」橫幅（假警報）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 5 } });
    await bg.tick(160);

    bg.store.mfoodState = {
      seen: {},
      orders: {},
      counters: {},
      tabId: 5,
      lastAutoRefreshAt: new Date().toISOString(),
      lastAutoRefreshError: "該分頁的內容腳本已失效（重新載入擴充功能後就會這樣）。請在該後台分頁按 F5。",
    };

    await bg.send({
      type: "MFOOD_ORDER_LIST_CAPTURED",
      rows: [{ externalOrderId: "E1", orderStatus: "completed", amount: { businessAmount: 62 } }],
      meta: {},
    });
    await bg.tick(220);

    check(
      "🔴 收到列表之後要清走錯誤（管道證明通咗）",
      bg.store.mfoodState.lastAutoRefreshError,
      null,
    );
  }

  group("[58] 🔴 啟用同步會強制開自動查詢／自動抓品項／自動重載（介面已冇呢三個開關）");
  {
    const bg = loadBackground();
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: false, autoFetchDetails: false, autoReload: false };
    const res = await bg.send({ type: "MFOOD_SAVE_SETTINGS", patch: { pushEnabled: true } });
    await bg.tick(200);
    const s1 = (res && res.settings) || {};
    check("autoRefresh 被強制開", s1.autoRefresh, true);
    check("autoFetchDetails 被強制開（冇品項 POS 一定拒收）", s1.autoFetchDetails, true);
    check("autoReload 被強制開", s1.autoReload, true);

    // 對照組：唔係「啟用同步」嘅 patch 唔應該被亂改
    const bg2 = loadBackground();
    bg2.store.mfoodSettings = { pushEnabled: true, autoRefresh: true, autoFetchDetails: true, autoReload: true };
    const res2 = await bg2.send({ type: "MFOOD_SAVE_SETTINGS", patch: { autoReload: false } });
    check("淨改其他設定時唔會被強制還原", res2.settings.autoReload, false);
  }

  group("[59] 🔴 查店名（輸入 Store ID 之後顯示係邊間店）");
  {
    const bg = loadBackground();
    bg.state.fetchReply = () => JSON.stringify({ ok: true, storeId: "S1", storeName: "表嫂美食", currency: "MOP" });
    const ok = await bg.send({ type: "GRAB_LOOKUP_STORE", storeId: "S1" });
    check("查到店名", ok && ok.storeName, "表嫂美食");
    const call = bg.fetchCalls.find((c) => c.url.indexOf("/api/integration/grabber/store") >= 0);
    check("有打 store 端點", !!call, true);
    check("有帶 X-Grabber-Secret", !!(call && call.init && call.init.headers && call.init.headers["X-Grabber-Secret"]), true);
    check("body 帶 storeId", call && JSON.parse(call.init.body).storeId, "S1");

    bg.state.fetchReply = () => JSON.stringify({ ok: false, error: "查唔到呢間店" });
    const bad = await bg.send({ type: "GRAB_LOOKUP_STORE", storeId: "NOPE" });
    check("查唔到要回原因（唔可以靜默）", bad && bad.reason, "查唔到呢間店");

    const empty = await bg.send({ type: "GRAB_LOOKUP_STORE", storeId: "   " });
    check("空 ID 本地擋住（唔打端點）", empty && empty.reason, "未填 Store ID");
  }

  group("[60] 🔴 按「開始」自動整備 mfood 頁面（訂單狀態＝全部 → 重新載入）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 21 } });
    await bg.tick(220);

    await bg.send({ type: "GRAB_SET_AUTOMATION", enabled: true });
    await bg.tick(500);

    const prep = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_SET_ORDER_STATUS_ALL");
    check("🔴 有叫分頁把「訂單狀態」切去「全部」", prep.length >= 1, true);
    check("係送去 mfood 分頁", prep.length > 0 && prep[0].tabId, 21);
    // 🔴 2026-09-25 使用者要求：**唔可以 F5 整個頁面** —— 更新內容按「查詢」就夠。
    //    （F5 會中斷頁面、令篩選還原、又要再設一次；純騷擾）
    check(
      "🔴 唔應該重新載入整個頁面（只代按查詢）",
      bg.state.reloadedTabs.some((t) => t.tabId === 21),
      false,
    );
    check(
      "有寫整備日誌（唔可以靜默）",
      (bg.store.mfoodLog || []).some((e) => e.kind === "mfood_page_prepare"),
      true,
    );
    // 🔴 設完篩選要再撳「查詢」（使用者明確指出：唔撳查詢，訂單唔會出）
    check(
      "🔴 有代按「查詢」重新查詢",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_RESCAN" && t.tabId === 21),
      true,
    );
    check(
      "日誌有講明已代按查詢",
      (bg.store.mfoodLog || []).some(
        (e) => e.kind === "mfood_page_prepare" && String(e.summary).indexOf("重新查詢") >= 0,
      ),
      true,
    );
  }

  group("[61] 🔴 存活探測：分頁有回應就寫 lastAliveAt");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 31 } });
    await bg.tick(220);
    bg.state.tabReply = (msg) =>
      msg.type === "GRAB_PING" ? { ok: true, href: "x", ready: "complete" } : { ok: true };

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(400);
    check("🔴 有回應 → 寫 lastAliveAt", typeof bg.store.mfoodState.lastAliveAt, "string");
  }

  group("[62] 🔴 撳到查詢但攔截器冇見到請求 → 一定要出聲（唔可以當成功）");
  {
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 41 } });
    await bg.tick(220);
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: true, autoFetchDetails: false, autoReload: false };
    // 內容腳本回報：撳到「查詢」，但攔截器冇交任何請求上嚟
    bg.state.tabReply = () => ({ ok: true, label: "查詢", listSeen: false });

    await bg.fireAlarm("grabAutoTick");
    await bg.tick(420);

    check(
      "🔴 要寫 error 日誌講明攔截器冇見到請求",
      (bg.store.mfoodLog || []).some(
        (e) => e.kind === "mfood_rescan" && e.level === "error" && String(e.summary).indexOf("攔截器") >= 0,
      ),
      true,
    );
    check(
      "🔴 橫幅要即刻轉紅（唔使等 3 個週期）",
      String(bg.store.mfoodState.lastAutoRefreshError || "").indexOf("攔截器") >= 0,
      true,
    );

    // 對照組：攔截器正常（listSeen: true）→ 唔應該出 error
    const bg2 = loadBackground();
    await bg2.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 42 } });
    await bg2.tick(220);
    bg2.store.mfoodSettings = { pushEnabled: false, autoRefresh: true, autoFetchDetails: false, autoReload: false };
    bg2.state.tabReply = () => ({ ok: true, label: "查詢", listSeen: true });
    await bg2.fireAlarm("grabAutoTick");
    await bg2.tick(420);
    check(
      "對照組：攔截器正常時唔應該出 error",
      (bg2.store.mfoodLog || []).some((e) => e.kind === "mfood_rescan" && e.level === "error"),
      false,
    );
  }

  group("[63] 🔴 平台結算（實收）：抓財務頁 → 推 POS settlement 端點");
  {
    const bg = loadBackground();
    // 有開住 mfood 財務頁
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    // 🔴 一定要有 Store ID，否則 grabPushSettlement 會喺本地就擋住（唔發請求）
    // 🔴🔴 2026-09-28 第九次真機：Store ID 嘅**真實** storage key 係 `machineId`
    //    （popup `#machineId` 嘅 change 寫入 `machineId`）。
    //    舊測試寫 `storeId` ⇒ 啱啱好配合咗 background 嘅讀錯 key，令 bug 靜默通過。
    //    呢度改成 `machineId` ＝ 同真機一致。
    bg.store.machineId = "store-1";
    bg.store.mfoodFinanceStoreName = "表嫂美食";

    // 財務頁 content script 回傳兩筆 transaction（用平台原始欄位名）
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return {
        ok: true,
        period: "2026-09-19 ~ 2026-09-26",
        // 🔴 2026-09-28：帳期 id 來源（改網絡攔截後新增）
        summaryIdVia: "network-event",
        // 🔴🔴 2026-09-28 第十次真機：帳期級金額（POS 報表三格）＋ `subsidy`
        //    POS 口徑係「補貼後優先」⇒ 漏 `subsidy` 會令金額**偏多**。
        receive: 1212.37,
        should: 1803.34,
        fee: 490.83,
        subsidy: 1212.37,
        receiveKey: "subsidyStoreReceiveAmtn",
        amountsVia: "list-field",
        transactions: [
          { tradeNo: "CRD001", storeReceiveAmtn: 31.91, subsidyStoreReceiveAmtn: 5 },
          { tradeNo: "CRD002", storeReceiveAmtn: 30.09 },
        ],
      };
    };

    const res = await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(320);

    check("回報成功", !!(res && res.ok), true);
    check("🔴 有問過分頁清單（要靠 query 搵財務頁）", bg.state.queriedTabs.length > 0, true);
    check(
      "🔴 有送 MFOODFIN_SYNC 去財務頁",
      bg.state.sentTabs.some((t) => t.tabId === 77 && t.msg && t.msg.type === "MFOODFIN_SYNC"),
      true,
    );
    check(
      "🔴 有帶商家名落去（多店唔選會配錯單）",
      lastSyncMsg(bg, 77) && lastSyncMsg(bg, 77).storeName,
      "表嫂美食",
    );
    check("🔴 有帶目標日期（今日）", /^\d{4}-\d{2}-\d{2}$/.test(String(lastSyncMsg(bg, 77) && lastSyncMsg(bg, 77).targetDate)), true);

    const call = bg.fetchCalls.find(
      (c) => c.url.indexOf("/api/integration/grabber/settlement") >= 0,
    );
    check("🔴 有打 settlement 端點", !!call, true);
    check("有帶密鑰標頭", !!(call && call.init.headers && call.init.headers["X-Grabber-Secret"]), true);

    const body = call && call.init.body ? JSON.parse(call.init.body) : null;
    check("body.storeId 正確", body && body.storeId, "store-1");
    check("body.source 為 mfood", body && body.source, "mfood");
    check("🔴 transactions 係非空陣列", (body && body.transactions && body.transactions.length) || 0, 2);
    check(
      "🔴 原樣轉送平台欄位名（改名係 POS 嘅責任）",
      !!(body && body.transactions[0] && body.transactions[0].tradeNo),
      true,
    );
    // 🔴🔴 2026-09-28 第十次真機：帳期級金額一定要送到，而且**必須帶 subsidy**
    //    （POS 口徑「補貼後優先」；漏咗會令報表金額偏多）。
    check("🔴 有帶 periodAmounts", !!(body && body.periodAmounts), true);
    check("🔴 periodAmounts.receive", body && body.periodAmounts && body.periodAmounts.receive, 1212.37);
    check("🔴 periodAmounts.should", body && body.periodAmounts && body.periodAmounts.should, 1803.34);
    check("🔴 periodAmounts.fee", body && body.periodAmounts && body.periodAmounts.fee, 490.83);
    check(
      "🔴🔴 periodAmounts.subsidy 一定要傳（POS 補貼後優先）",
      body && body.periodAmounts && body.periodAmounts.subsidy,
      1212.37,
    );

    check("有記錄上次對帳時間", typeof bg.store.mfoodState.lastSettleAt, "string");
    check("成功時唔應該留低錯誤", bg.store.mfoodState.lastSettleError, null);
    check(
      "🔴 有記錄帳期 id 來源（2026-09-28 新增）",
      bg.store.mfoodState.lastSettleResult &&
        bg.store.mfoodState.lastSettleResult.summaryIdVia,
      "network-event",
    );
  }

  group("[63b] 🔴🔴🔴 只填 Store ID（machineId）就要對帳成功 —— 唔可以讀錯 key");
  {
    // 2026-09-28 第九次真機（使用者截圖為證）：
    //   畫面明明填咗 Store ID（`8291f843-…`），但仍然報「未設定 Store ID」。
    //   真兇 ＝ background `grabSettleMfood` 讀 storage key `storeId`，
    //   但 popup 係寫入 `machineId` ⇒ 個 key 永遠對唔上。
    //
    // 呢個測試就係重現真機：**只設 `machineId`，堅決唔設 `storeId`**。
    //   舊程式（讀 storeId）喺呢度會 fail ⇒ 正好鎖住回歸。
    const bg = loadBackground();
    bg.store.machineId = "8291f843-9def-4956-9d0b-1cfef25aaaaa";
    bg.store.mfoodFinanceStoreName = "表嫂美食";
    // 確認冇任何 `storeId` key（防有人「順手」加返而令測試假綠）
    check("🔴 前置條件：storage 冇 storeId key", "storeId" in bg.store, false);
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            summaryIdVia: "network-event",
            transactions: [{ tradeNo: "T1", subsidyStoreReceiveAmtn: 100 }],
          }
        : { ok: true };

    const r = await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(320);

    check("🔴🔴🔴 對帳成功（唔可以再報未設定 Store ID）", !!(r && r.ok), true);
    check(
      "🔴 失敗原因唔可以係「未設定 Store ID」",
      // 成功時 reason 通常係 undefined；只要有值就唔可以係「未設定 Store ID」。
      !/未設定 Store ID/.test(String((r && r.reason) || "")),
      true,
    );
    const call = bg.fetchCalls.find((c) => c.url.indexOf("/grabber/settlement") >= 0);
    check("🔴 有打 POS 結算端點", !!call, true);
    let sent = null;
    try {
      sent = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    } catch (e) {
      sent = null;
    }
    check(
      "🔴 body.storeId 要係 machineId 嗰個值",
      sent && sent.storeId,
      "8291f843-9def-4956-9d0b-1cfef25aaaaa",
    );
  }

  group("[64] 🔴 結算要有低頻節流（唔可以每個 tick 都問平台）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? { ok: true, period: "x", transactions: [{ tradeNo: "T1", storeReceiveAmtn: 1 }] }
        : { ok: true, label: "查詢" };

    // ① 手動觸發一次 → 成功、寫 lastSettleAt
    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(320);
    const firstSyncs = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "MFOODFIN_SYNC").length;
    check("手動第一次有同步", firstSyncs, 1);

    // ② 立即再手動 → manual 唔受節流 → 應該再跑
    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(320);
    const afterManual2 = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "MFOODFIN_SYNC").length;
    check("🔴 手動唔受節流（使用者按就要跑）", afterManual2, 2);

    // ③ 自動 tick → 6 小時內應該被擋
    bg.store.mfoodSettings = { pushEnabled: false, autoRefresh: true, autoFetchDetails: false, autoReload: false };
    bg.store.mfoodState = Object.assign({}, bg.store.mfoodState, {
      tabId: 77,
      lastSettleAt: new Date().toISOString(),
    });
    bg.state.sentTabs.length = 0;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(420);
    check(
      "🔴 6 小時內自動對帳被節流（唔會每個 tick 問平台）",
      bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "MFOODFIN_SYNC").length,
      0,
    );

    // ④ 對照組（新模型：30 分鐘累加器驅動，唔係 6 小時 lastSettleAt）：
    //    開 autoSettle ＋ 預先累加去到 30 分鐘 ⇒ 今次 tick 應該對帳。
    //    🔴 2026-09-30 修：grabGlobalSettings 預設 intervalSecs = 30（唔係 60），
    //       若唔顯式定做 60，預填 29 分鐘 ＋ 30s 只會去到 29.5 分，跨唔過 30 分門檻。
    //       顯式 pin 60s，令下面「差一個 interval（60s）就到 30 分鐘」語意準確。
    bg.store.currentIntervalSecs = 60;
    bg.store.mfoodSettings = Object.assign({}, bg.store.mfoodSettings, { autoSettle: true });
    bg.store.mfoodState = Object.assign({}, bg.store.mfoodState, {
      settleAccumMs: 30 * 60 * 1000 - 60 * 1000, // 差一個 interval（60s）就到 30 分鐘
    });
    bg.state.sentTabs.length = 0;
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(420);
    check(
      "🔴 開咗 autoSettle ＋ 累加夠 30 分鐘 ⇒ 自動對帳放行",
      bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "MFOODFIN_SYNC").length >= 1,
      true,
    );
  }

  group("[65] 🔴 結算失敗一定要大聲回報（唔可以靜默）");
  {
    // ① 冇開財務頁
    const bg1 = loadBackground();
    bg1.store.machineId = "store-1";
    const r1 = await bg1.send({ type: "GRAB_SETTLE_NOW" });
    await bg1.tick(260);
    check("冇財務頁 → ok:false", !!(r1 && r1.ok === false), true);
    check(
      "🔴 講清楚要開邊個頁",
      !!(r1 && r1.reason && r1.reason.indexOf("tackout-check") >= 0),
      true,
    );
    check("有記錄落 state", typeof bg1.store.mfoodState.lastSettleError, "string");
    check(
      "有寫錯誤日誌",
      (bg1.store.mfoodLog || []).some((e) => e.kind === "mfood_settle" && e.level === "error"),
      true,
    );

    // ② 財務頁冇回應（內容腳本已死）
    const bg2 = loadBackground();
    bg2.store.machineId = "store-1";
    bg2.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg2.state.tabDead = true;
    const r2 = await bg2.send({ type: "GRAB_SETTLE_NOW" });
    await bg2.tick(260);
    check("內容腳本死 → ok:false", !!(r2 && r2.ok === false), true);
    check("🔴 提示要 F5", !!(r2 && r2.reason && r2.reason.indexOf("F5") >= 0), true);

    // ③ 未設定商家名 → 仍然要跑（單店商戶可以留空），但唔可以漏咗呢個決定
    const bg3 = loadBackground();
    bg3.store.machineId = "store-1";
    bg3.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg3.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? { ok: true, period: "x", transactions: [{ tradeNo: "T1", storeReceiveAmtn: 1 }] }
        : { ok: true };
    await bg3.send({ type: "GRAB_SETTLE_NOW" });
    await bg3.tick(320);
    check(
      "🔴 未填商家名時仍然同步（storeName 送空字串＝跟後台預設）",
      lastSyncMsg(bg3, 77) && lastSyncMsg(bg3, 77).storeName,
      "",
    );

    // ④ 未設定 Store ID → 本地就要擋住（唔可以打一個冇 storeId 嘅請求）
    const bg4 = loadBackground();
    bg4.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg4.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? { ok: true, period: "x", transactions: [{ tradeNo: "T1", storeReceiveAmtn: 1 }] }
        : { ok: true };
    const r4 = await bg4.send({ type: "GRAB_SETTLE_NOW" });
    await bg4.tick(320);
    check("冇 Store ID → ok:false", !!(r4 && r4.ok === false), true);
    check(
      "🔴 提示指向「店家設定」",
      !!(r4 && r4.reason && r4.reason.indexOf("Store ID") >= 0),
      true,
    );
    check(
      "🔴 唔應該打任何請求（本地擋住）",
      bg4.fetchCalls.some((c) => c.url.indexOf("/grabber/settlement") >= 0),
      false,
    );
  }

  group("[66] 🔴 帳期內冇 transaction ＝ 唔算失敗（唔可以誤報）");
  {
    const bg = loadBackground();
    bg.store.machineId = "store-1";
    bg.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC" ? { ok: true, period: "x", transactions: [] } : { ok: true };

    const r = await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(300);
    check("空帳期 → ok:true（唔算失敗）", !!(r && r.ok), true);
    check("pushed 為 0", (r && r.pushed) || 0, 0);
    check("🔴 唔應該留下錯誤", bg.store.mfoodState.lastSettleError, null);
    check(
      "🔴 唔應該亂打 POS（冇嘢好推）",
      bg.fetchCalls.some((c) => c.url.indexOf("/grabber/settlement") >= 0),
      false,
    );
  }

  group("[66b] 🔴🔴 零重放：帳期級金額要送 POS（即使冇逐筆 transaction）");
  {
    // 2026-09-28 第七次真機：平台載入財務頁時自己發 `summary/_list`，
    //   回應本身就有實收金額 ⇒ content script 直接讀到，**唔需要重放**。
    //   呢個情境下 `transactions` 可能係空（帳期已結算、唔再發明細），
    //   但**帳期級金額一定要送到 POS** —— 否則使用者最想要嘅「實收」就白攞。
    const bg = loadBackground();
    // 🔴 2026-09-28 第九次真機：只設 `machineId`（＝真機 popup 唯一會寫嘅 key）。
    //    刻意**唔設** `storeId` —— 一設就會掩蓋「讀錯 key」嘅 bug。
    bg.store.machineId = "store-1";
    bg.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? {
            ok: true,
            // 零重放：冇 transactions，但有帳期級金額
            source: "list-inline",
            period: "2026-09-16 ~ 2026-09-30",
            transactions: [],
            should: 1803.34,
            receive: 1212.37,
            fee: 490.83,
            receiveKey: "subsidyStoreReceiveAmtn",
            amountsVia: "list-field",
            details: [{ startDateStr: "2026-09-16", subsidyStoreReceiveAmtn: 114.82 }],
          }
        : { ok: true };

    const r = await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(320);

    const call = bg.fetchCalls.find((c) => c.url.indexOf("/grabber/settlement") >= 0);
    check("🔴 有打 POS 結算端點", !!call, true);
    let sent = null;
    try {
      sent = call && call.init && call.init.body ? JSON.parse(call.init.body) : null;
    } catch (e) {
      sent = null;
    }
    check("🔴 有帶 periodAmounts", !!(sent && sent.periodAmounts), true);
    check("🔴🔴 實收金額送到 POS", sent && sent.periodAmounts && sent.periodAmounts.receive, 1212.37);
    check("🔴 應收金額送到 POS", sent && sent.periodAmounts && sent.periodAmounts.should, 1803.34);
    check("🔴 服務費送到 POS", sent && sent.periodAmounts && sent.periodAmounts.fee, 490.83);
    check(
      "🔴 金額來源如實標示",
      sent && sent.periodAmounts && sent.periodAmounts.via,
      "list-field",
    );
    check("回報成功", !!(r && r.ok), true);
  }

  group("[67] 對帳頁結構診斷（GRAB_SETTLE_DOMDUMP）—— 只讀、唔可以撳嘢");
  {
    // 為什麼要有呢組：真頁面形狀同假設有出入時（實測 2026-09-28：真「詳情」係
    // 帳單明細彈窗），靠截圖猜會反覆修錯。診斷掣要確保：
    //   ① 有財務頁 → 原樣轉發 dump 結果
    //   ② 冇財務頁 → 大聲講「去開邊個頁」（同 settle 一致）
    //   ③ 內容腳本死 → 提示 F5
    const bg = loadBackground();
    const dumpPayload = {
      ok: true,
      finance: true,
      href: "https://merchant.mfoodapp.com/#/finance/tackout-check",
      inputs: [{ id: "a", placeholder: "請選擇商家", isElInputInner: true }],
      dateRows: [{ period: "2026-09-16 ~ 2026-09-30", hasVue: true }],
      detailButtons: [{ tag: "SPAN", text: "查看詳情" }],
      vueProbe: { appHasVue2: true },
    };
    bg.state.financeTabs = [{ id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" }];
    bg.state.tabReply = (msg) => (msg.type === "MFOODFIN_DOMDUMP" ? dumpPayload : { ok: true });

    const r = await bg.send({ type: "GRAB_SETTLE_DOMDUMP" });
    await bg.tick(120);
    check("有財務頁 → ok:true", !!(r && r.ok), true);
    check("真係轉發 dump（原樣回）", !!(r && r.finance), true);
    check(
      "🔴 dump 真係帶住結構（唔可以回一個空殼）",
      !!(r && Array.isArray(r.inputs) && Array.isArray(r.dateRows)),
      true,
    );

    // ② 冇財務頁
    const bg2 = loadBackground();
    bg2.state.financeTabs = [];
    const r2 = await bg2.send({ type: "GRAB_SETTLE_DOMDUMP" });
    await bg2.tick(120);
    check("冇財務頁 → ok:false", !!(r2 && r2.ok === false), true);
    check(
      "🔴 講清楚要開邊個頁",
      !!(r2 && r2.reason && r2.reason.indexOf("finance/tackout-check") >= 0),
      true,
    );

    // ③ 內容腳本死（sendMessage 報 lastError）
    //    🔴 2026-09-28 第十二次真機：背景會先嘗試**重新注入**再試一次。
    //       重新注入成功 ⇒ 第二次 sendMessage 就要成功（唔應該再報錯）。
    const bg3 = loadBackground();
    bg3.state.tabDead = true;
    bg3.state.injectFails = true; // 呢個 case 模擬「重新注入都失敗」
    bg3.state.injectFailMessage = "Could not establish connection. Receiving end does not exist.";
    bg3.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    const r3 = await bg3.send({ type: "GRAB_SETTLE_DOMDUMP" });
    await bg3.tick(160);
    check("內容腳本死 → ok:false", !!(r3 && r3.ok === false), true);
    check("🔴 提示要 F5", !!(r3 && r3.reason && r3.reason.indexOf("F5") >= 0), true);
    // 🔴 診斷唔可以打任何 POS 請求（純讀）
    // ④ 診斷唔可以打任何 POS 請求（純讀）
    check(
      "🔴 診斷唔應該打任何 POS 請求",
      bg.fetchCalls.some((c) => c.url.indexOf("/grabber/") >= 0),
      false,
    );
  }

  group("[68] 🔴 分頁開喺財務頁 → 篩選設定要「略過」而唔係「失敗」");
  {
    // 為什麼要有呢組：真機 2026-09-28 —— mfood 分頁開喺財務對帳頁時，
    // 因為嗰度冇「訂單狀態」篩選，`GRAB_SET_ORDER_STATUS_ALL` 一直回失敗
    // ⇒ 每次都寫 error 日誌 ⇒ popup 一直顯示假警報，掩蓋真正嘅問題。
    // 正確行為：內容腳本認得係財務頁 → 回 skipped；背景當成功（info）處理。
    const bg = loadBackground();
    await bg.send({ type: "MFOOD_PAGE_READY", href: "x" }, { tab: { id: 41 } });
    await bg.tick(220);
    bg.state.tabReply = (msg) => {
      if (msg.type === "GRAB_SET_ORDER_STATUS_ALL") {
        return { ok: true, skipped: true, reason: "呢個分頁係財務對帳頁，冇「訂單狀態」篩選" };
      }
      return { ok: true, label: "查詢" };
    };

    await bg.send({ type: "GRAB_SET_AUTOMATION", enabled: true });
    await bg.tick(500);

    const prep = (bg.store.mfoodLog || []).filter((e) => e.kind === "mfood_page_prepare");
    const skippedLog = prep.find((e) => String(e.summary).indexOf("略過") >= 0);
    check("🔴 有寫「略過」日誌", !!skippedLog, true);
    check("🔴 略過唔可以係 error 級", skippedLog && skippedLog.level, "info");
    check(
      "🔴 唔應該有 error 級嘅 page_prepare 日誌（假警報）",
      prep.some((e) => e.level === "error"),
      false,
    );
  }

  group("[69] 🔴🔴🔴 GRAB_FINANCE_RAW：拿全部訂單（唔配對、唔推 POS）");
  {
    // 2026-09-28 第十一次真機，使用者原話：
    //   「不如你先不要做配對, 先把所有的訂單都先拿在手上, 然後我再幫你分析好不好?」
    //
    // ⇒ 呢個 route 一定要：
    //   ① 有財務頁 → 原樣轉發（**唔可以**經過任何配對／改名／計算）
    //   ② 冇財務頁 → 大聲講「去開邊個頁」
    //   ③ 內容腳本死 → 提示 F5
    //   ④ 🔴 **唔可以**打任何 POS 請求（純讀取，唔推數據）
    const bg = loadBackground();
    const rawPayload = {
      ok: true,
      finance: true,
      href: "https://merchant.mfoodapp.com/#/finance/tackout-check",
      capturedAt: 1759000000000,
      periodRowCount: 1,
      periodRowKeys: ["id", "startDateStr", "endDateStr", "details"],
      periodRows: [
        {
          id: "202609170106005576278",
          startDateStr: "2026-09-16",
          details: [{ day: "2026-09-16", subsidyStoreReceiveAmtn: 100.5 }],
        },
      ],
      detailRowCount: 1,
      detailTotal: 1,
      detailSummaryId: "202609170106005576278",
      firstRowKeys: ["tradeNo", "subsidyStoreReceiveAmtn"],
      detailRows: [{ tradeNo: "CRD202609161003178839221", subsidyStoreReceiveAmtn: 31.91 }],
    };
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.state.tabReply = (msg) => (msg.type === "GRAB_FINANCE_RAW" ? rawPayload : { ok: true });

    const r = await bg.send({ type: "GRAB_FINANCE_RAW" });
    await bg.tick(120);
    check("有財務頁 → ok:true", !!(r && r.ok), true);
    check("🔴 原樣轉發帳期列", !!(r && Array.isArray(r.periodRows) && r.periodRows.length === 1), true);
    check("🔴 原樣轉發明細列", !!(r && Array.isArray(r.detailRows) && r.detailRows.length === 1), true);
    check(
      "🔴 明細保留平台欄位（tradeNo）",
      !!(r && r.detailRows[0] && r.detailRows[0].tradeNo),
      true,
    );
    // 🔴 最關鍵：呢條路**唔做配對** ⇒ 唔應該出現 updated / notFound
    check("🔴 唔應該有 updated（唔做配對）", r && "updated" in r, false);
    check("🔴 唔應該有 notFound（唔做配對）", r && "notFound" in r, false);
    // 🔴 純讀：唔可以打任何 POS 請求
    check(
      "🔴 拿全部訂單唔應該打任何 POS 請求",
      bg.fetchCalls.some((c) => c.url.indexOf("/grabber/") >= 0),
      false,
    );

    // ② 冇財務頁
    const bg2 = loadBackground();
    bg2.state.financeTabs = [];
    const r2 = await bg2.send({ type: "GRAB_FINANCE_RAW" });
    await bg2.tick(120);
    check("冇財務頁 → ok:false", !!(r2 && r2.ok === false), true);
    check(
      "🔴 講清楚要開邊個頁",
      !!(r2 && r2.reason && r2.reason.indexOf("finance/tackout-check") >= 0),
      true,
    );

    // ③ 內容腳本死 → 重新注入都失敗
    const bg3 = loadBackground();
    bg3.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg3.state.tabDead = true;
    bg3.state.injectFails = true;
    bg3.state.injectFailMessage = "Could not establish connection. Receiving end does not exist.";
    const r3 = await bg3.send({ type: "GRAB_FINANCE_RAW" });
    await bg3.tick(160);
    check("內容腳本死 → ok:false", !!(r3 && r3.ok === false), true);
    check("🔴 提示要 F5", !!(r3 && r3.reason && r3.reason.indexOf("F5") >= 0), true);

    // ⑤ 🔴🔴 第十二次真機：內容腳本死但**重新注入成功** → 第二次就要成功！
    //    呢個就係「唔可以要使用者理解載入次序」嘅落實。
    const bg4 = loadBackground();
    bg4.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    const rawReply = {
      ok: true,
      finance: true,
      periodRows: [{ id: "W1", details: [{ day: "2026-09-16" }] }],
      detailRows: [{ tradeNo: "CRD2026…1", subsidyStoreReceiveAmtn: 31.91 }],
      periodRowCount: 1,
      detailRowCount: 1,
    };
    bg4.state.tabDead = true;
    bg4.state.tabReply = (msg) => (msg.type === "GRAB_FINANCE_RAW" ? rawReply : { ok: true });
    // 重新注入成功 = 新腳本活了 ⇒ stub 嘅 `executeScript` 會把 tabDead 關掉。
    // （harness 嘅 scripting stub 已內建 `state.onInject` 鈎子）
    bg4.state.onInject = () => {
      bg4.state.tabDead = false;
    };
    const r4 = await bg4.send({ type: "GRAB_FINANCE_RAW" });
    await bg4.tick(200);
    check("🔴🔴 重新注入成功後 → 應該 ok:true（唔會再要使用者 F5）", !!(r4 && r4.ok), true);
    check("🔴 有嘗試重新注入", bg4.state.injectedScripts.length > 0, true);
    check(
      "🔴 重新注入包含 mfood-finance-bridge.js",
      bg4.state.injectedScripts.some(
        (o) => Array.isArray(o.files) && o.files.indexOf("mfood-finance-bridge.js") >= 0,
      ),
      true,
    );
    check(
      "🔴 重新注入包含 MAIN world（mfood-inject.js）",
      bg4.state.injectedScripts.some(
        (o) => o.world === "MAIN" && Array.isArray(o.files) && o.files.indexOf("mfood-inject.js") >= 0,
      ),
      true,
    );

    // 🔴🔴🔴 第十四次真機（最重要一條）：
    //   bridge **絕對唔可以**被注入 MAIN world。
    //
    //   真機紅字實證：「Uncaught ReferenceError: onFinancePage is not defined」。
    //   成因：`window` 喺 isolated / MAIN world 之間係**同一個物件**，
    //        bridge 嘅 IIFE 開頭 `if (window.__XX_INSTALLED__) return;` 會因此：
    //          MAIN 先跑 → 設記號 → 但 `onFinancePage` 等從未定義
    //          真正 isolated 跑 → 見記號即 return → 但舊 listener 仍在
    //          ⇒ 收到訊息就叫 `onFinancePage()` ⇒ ReferenceError（Uncaught）
    //
    //   ⇒ 呢條斷言係「防止同一個 bug 第三次回歸」嘅鎖。
    check(
      "🔴🔴 bridge 唔可以被注入 MAIN world（否則 window 記號被污染）",
      bg4.state.injectedScripts.some(
        (o) => o.world === "MAIN" && Array.isArray(o.files) && o.files.indexOf("mfood-finance-bridge.js") >= 0,
      ),
      false,
    );
    check(
      "🔴 bridge 要以 isolated（無 world）方式注入",
      bg4.state.injectedScripts.some(
        (o) =>
          !o.world &&
          Array.isArray(o.files) &&
          o.files.indexOf("mfood-finance-bridge.js") >= 0,
      ),
      true,
    );
    // 🔴 兩支腳本唔可以混在同一次 executeScript（world 唔同）
    check(
      "🔴 MAIN world 嗰次唔可以夾帶 bridge",
      bg4.state.injectedScripts
        .filter((o) => o.world === "MAIN")
        .every((o) => !Array.isArray(o.files) || o.files.indexOf("mfood-finance-bridge.js") < 0),
      true,
    );
  }

  // ══════════════════════════════════════════════════════════════
  //  第十七次真機（2026-09-29）—— 使用者四點需求
  //    ① 介面合併（實收價格）② 立即對帳自動化放落 timer
  //    ③ 多帳期（由開始日期一路行到最新）④ 數據完整後傳去 macau-pos
  // ══════════════════════════════════════════════════════════════

  group("[70] 🔴🔴🔴 多帳期 → 要**逐帳期**推送去 POS（唔可以撈埋一個請求）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.store.machineId = "store-1";

    // 🔴 真機形狀：bridge 行完三個帳期，逐個自己一份 transactions ＋ 金額
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return {
        ok: true,
        period: "2026-09-16 ~ 2026-09-30",
        transactions: [], // 頂層（舊欄位）保持空，真正嘅喺 periods[]
        periods: [
          {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            summaryId: "SID-SEP2",
            receive: 1212.37,
            subsidy: 1212.37,
            should: 1803.34,
            fee: 490.83,
            transactions: [
              { tradeNo: "CRD001", storeReceiveAmtn: 31.91, subsidyStoreReceiveAmtn: 23.51 },
              { tradeNo: "CRD002", storeReceiveAmtn: 30.09 },
            ],
          },
          {
            ok: true,
            period: "2026-09-01 ~ 2026-09-15",
            summaryId: "SID-SEP1",
            receive: 700,
            subsidy: 700,
            transactions: [
              { tradeNo: "CRD003", subsidyStoreReceiveAmtn: 11.1 },
            ],
          },
          {
            ok: true,
            period: "2026-08-16 ~ 2026-08-31",
            summaryId: "SID-AUG",
            receive: 500,
            subsidy: 500,
            transactions: [
              { tradeNo: "CRD004", subsidyStoreReceiveAmtn: 12.2 },
            ],
          },
        ],
        failedPeriods: [],
        transactionsTotal: 4,
        transactionsComplete: true,
      };
    };

    const r = await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(400);

    check("回報成功", !!(r && r.ok), true);
    check("🔴 有回報寫咗 3 個帳期", r && r.periodPushedCount, 3);

    const calls = bg.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0);
    // 🔴🔴 核心：POS 嘅 upsert key 係 (store_id, source, period)
    //    ⇒ 撈埋一個請求 = 只會寫到一個帳期，其餘**靜默消失**。
    check("🔴🔴🔴 打了 3 次 settlement（一個帳期一次）", calls.length, 3);

    const bodies = calls.map((c) => JSON.parse(c.init.body));
    check(
      "🔴 每個請求帶自己嘅帳期",
      bodies.map((b) => b.periodAmounts && b.periodAmounts.period),
      ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
    );
    check(
      "🔴 每個請求只帶自己嘅明細（唔可以撈埋）",
      bodies.map((b) => b.transactions.length),
      [2, 1, 1],
    );
    check("🔴 第一個帳期嘅實收有送到", bodies[0].periodAmounts.subsidy, 1212.37);
    check("🔴 8 月嗰個帳期嘅實收都有送到", bodies[2].periodAmounts.subsidy, 500);
    check("🔴 每次都有帶 storeId", bodies.every((b) => b.storeId === "store-1"), true);
  }

  group("[71] 🔴🔴 要帶「只同步此日後」（startDate）落財務頁 —— 多帳期靠佢");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.store.machineId = "store-1";
    // 🔴 使用者喺 popup「只同步此日後」填 8月30日
    bg.store.startDate = "2026-08-30";
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return { ok: true, period: "2026-09-16 ~ 2026-09-30", transactions: [], periods: [] };
    };

    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(300);

    const sent = lastSyncMsg(bg, 77);
    check("🔴🔴 有帶 startDate 落 MFOODFIN_SYNC", sent && sent.startDate, "2026-08-30");
  }

  group("[72] 🔴🔴 實收對照表要落 state（popup「實收價格」靠佢）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.store.machineId = "store-1";
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return {
        ok: true,
        period: "2026-09-16 ~ 2026-09-30",
        periods: [
          {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            receive: 900,
            transactions: [
              // 🔴 真機形狀：`subsidyStoreReceiveAmtn` ＝ 補貼後實收（POS 口徑）
              { tradeNo: "CRD001", storeReceiveAmtn: 35.11, subsidyStoreReceiveAmtn: 23.51, storeBusinessAmtn: 62, platformServiceFee: 14.89 },
            ],
          },
        ],
      };
    };

    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(400);

    const m = (bg.store.mfoodState && bg.store.mfoodState.settleMap) || {};
    check("🔴 有落到 state", !!m.CRD001, true);
    // 🔴🔴 口徑一定要「補貼後優先」（同 POS `periodPayout()` 一致）
    check("🔴🔴 實收 = 補貼後嗰個（23.51 而唔係 35.11）", m.CRD001 && m.CRD001.receive, 23.51);
    check("有記低未補貼嘅數（對帳用）", m.CRD001 && m.CRD001.gross, 35.11);
    check("有記低屬邊個帳期", m.CRD001 && m.CRD001.period, "2026-09-16 ~ 2026-09-30");

    // ② 第二輪只帶另一張單 ⇒ 第一張**唔可以消失**（一定要累積，唔係覆寫）
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return {
        ok: true,
        period: "2026-09-01 ~ 2026-09-15",
        periods: [
          { ok: true, period: "2026-09-01 ~ 2026-09-15", receive: 700, transactions: [{ tradeNo: "CRD002", subsidyStoreReceiveAmtn: 9.9 }] },
        ],
      };
    };
    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(400);
    const m2 = bg.store.mfoodState.settleMap || {};
    check("🔴🔴 要累積（上一輪嘅單唔可以消失）", !!m2.CRD001, true);
    check("新嗰張要喺度", m2.CRD002 && m2.CRD002.receive, 9.9);
  }

  group("[73] 🔴🔴 定時自動對帳：開咗就按 30 分鐘累加器跑（唔係 6 小時、唔係同步間隔）");
  {
    // ① 未開 autoSettle ⇒ 完全唔對帳（新模型：30 分鐘累加器由 autoSettle 開關控制）
    const bgA = loadBackground();
    bgA.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bgA.store.machineId = "store-1";
    bgA.store.currentIntervalSecs = 60;
    bgA.store.mfoodSettings = { autoRefresh: true, autoSettle: false };
    bgA.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return { ok: true, period: "P1", periods: [{ ok: true, period: "P1", receive: 1, transactions: [{ tradeNo: "T1", subsidyStoreReceiveAmtn: 1 }] }] };
    };
    await bgA.fireAlarm("grabAutoTick");
    await bgA.tick(300);
    const first = bgA.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0).length;
    check("未開自動對帳：完全唔對帳（唔使 6 小時制）", first, 0);

    // ② 開咗 autoSettle ＋ 預先累加去到 30 分鐘 ⇒ 呢次 tick 應該對帳
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 77, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.store.machineId = "store-1";
    bg.store.currentIntervalSecs = 60;
    bg.store.mfoodSettings = { autoRefresh: false, autoSettle: true };
    // 🔴 預先累加去到「差一個 interval 就 30 分鐘」，令今次 tick 即刻觸發
    bg.store.mfoodState = { settleAccumMs: 30 * 60 * 1000 - 60 * 1000 };
    bg.state.tabReply = (msg) => {
      if (msg.type !== "MFOODFIN_SYNC") return { ok: true, label: "查詢" };
      return { ok: true, period: "P1", periods: [{ ok: true, period: "P1", receive: 1, transactions: [{ tradeNo: "T1", subsidyStoreReceiveAmtn: 1 }] }] };
    };

    // 🔴 就算冇開 autoRefresh，開咗 autoSettle 都要跑
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(300);
    const n1 = bg.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0).length;
    check("🔴🔴 開咗自動對帳 ＋ 累加夠 30 分鐘 ⇒ tick 會對帳（唔使 autoRefresh）", n1 >= 1, true);

    // 即刻再 tick ⇒ 累加器已歸零（對帳完會 reset）⇒ 未到 30 分鐘 ⇒ 唔應該再跑
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(300);
    const n2 = bg.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0).length;
    check("🔴 同一個 30 分鐘內唔可以重複跑（有節流）", n2, n1);

    // 把累加器再預先推去 30 分鐘 ⇒ 應該再跑一次
    bg.store.mfoodState = Object.assign({}, bg.store.mfoodState, {
      settleAccumMs: 30 * 60 * 1000 - 60 * 1000,
    });
    await bg.fireAlarm("grabAutoTick");
    await bg.tick(300);
    const n3 = bg.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0).length;
    check("🔴🔴 過咗 30 分鐘（累加器再滿）就再跑一次", n3 > n1, true);
  }

  group("[74] 🔴 GRAB_SET_AUTO_SETTLE 要真係寫入設定（唔可以淨係改 DOM）");
  {
    const bg = loadBackground();
    const r1 = await bg.send({ type: "GRAB_SET_AUTO_SETTLE", enabled: true });
    await bg.tick(160);
    check("回報 ok", !!(r1 && r1.ok), true);
    check("🔴 settings.autoSettle 變 true", bg.store.mfoodSettings && bg.store.mfoodSettings.autoSettle, true);

    const r2 = await bg.send({ type: "GRAB_SET_AUTO_SETTLE", enabled: false });
    await bg.tick(160);
    check("可以關返", r2 && r2.autoSettle, false);
    check("🔴 真係寫咗落 storage", bg.store.mfoodSettings && bg.store.mfoodSettings.autoSettle, false);
  }

  // -------------------------------------------------------------------------
  // 🔴🔴 2026-09-29：推送前由註冊表回填單號
  //
  // 背景：mfood **詳情路徑**嘅 payload 冇單號（見 `test/mfood.test.cjs` [9]），
  // 但**列表擷取**嗰陣已經把平台單號記咗落註冊表 `entry.seq`。
  // ⇒ `grabEnrichOrdersWithItems()` 喺推送前補返，POS 就唔會跌去
  //   「外部單號尾 6 位」（實案 `MFOOD#883658`，同 popup 嘅 `#75` 對唔上）。
  //
  // 必須鎖死嘅三條邊界：
  //   ① 完全冇單號 → 要補
  //   ② 已經有單號 → **原樣放行**（唔可以用註冊表蓋過新資料）
  //   ③ 註冊表都冇 → 唔可以憑空生一個（寧願交返 POS 自己 fallback）
  // -------------------------------------------------------------------------

  group("[75] 🔴 推送前要由註冊表回填單號（mfood 詳情路徑嘅洞）");
  {
    const bg = loadBackground();
    const enrich = bg.sandbox.grabEnrichOrdersWithItems;
    check("掂得到 grabEnrichOrdersWithItems", typeof enrich, "function");

    const state = {
      orders: {
        "202609241710000786777": { id: "202609241710000786777", seq: "#75", items: [] },
        "202609291313345883658": { id: "202609291313345883658", seq: 883658, items: [] },
        "202609250000000000001": { id: "202609250000000000001", seq: null, items: [] },
      },
    };

    // ① 詳情路徑（冇單號）→ 一定要由註冊表補返
    const detail = { source: "mfood", externalOrderId: "202609241710000786777", items: [] };
    const out1 = enrich(state, [detail])[0];
    check("🔴 冇單號 → 要補 orderNumber 75", out1.orderNumber, 75);
    check("🔴 冇單號 → 要補 localOrderNo '#75'", out1.localOrderNo, "#75");

    // ①b 註冊表記嘅係數字都得
    const out1b = enrich(state, [
      { source: "mfood", externalOrderId: "202609291313345883658", items: [] },
    ])[0];
    check("註冊表係數字 883658 → localOrderNo '883658'", out1b.localOrderNo, "883658");

    // ② 🔴 已經有單號 → 原樣放行，唔可以畀註冊表蓋過
    const already = {
      source: "mfood",
      externalOrderId: "202609241710000786777",
      localOrderNo: "#99",
      items: [],
    };
    check(
      "🔴 已有 localOrderNo → 原樣放行（唔可以變 #75）",
      enrich(state, [already])[0].localOrderNo,
      "#99",
    );

    // ③ 註冊表都冇 → 唔可以憑空生
    const out3 = enrich(state, [{ source: "mfood", externalOrderId: "202609250000000000001" }])[0];
    check("🔴 註冊表冇 seq → orderNumber 要係 undefined", out3.orderNumber, undefined);
    check("🔴 註冊表冇 seq → localOrderNo 要係 undefined", out3.localOrderNo, undefined);

    // ④ 註冊表冇呢張單 → 照樣唔可以憑空生
    const out4 = enrich(state, [{ source: "mfood", externalOrderId: "NOT_IN_REGISTRY" }])[0];
    check("🔴 唔喺註冊表 → 唔可以憑空生單號", out4.orderNumber, undefined);

    // ⑤ 原本嘅 items 補邏輯唔可以因為今次改動而爛
    const withItems = {
      orders: { AAA: { id: "AAA", seq: "7", items: [{ name: "肉餅飯" }] } },
    };
    const out5 = enrich(withItems, [{ source: "mfood", externalOrderId: "AAA" }])[0];
    check("items 補邏輯仍然生效", out5.items.length, 1);
    check("items ＋ 單號可以同時補", out5.localOrderNo, "7");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  澳覓對帳（2026-09-29）——「mfood 對帳原樣複製」
  //
  //  🔴 為什麼要逐項鎖住：
  //    對帳流程由「mfood 專用」泛化為「按來源」之後，**每一個**原本寫死
  //    mfood 嘅地方都係一個潛在嘅靜默出錯點：
  //      · storage key（`mfoodFinanceStoreName` → 按來源）
  //      · 財務頁分頁 URL 特徵（`*.mfoodapp.com` → 按來源）
  //      · 發去財務頁嘅訊息型別（`MFOODFIN_SYNC` → `AOMIFIN_SYNC`）
  //      · 重新注入嘅檔案名（`mfood-*.js` → `aomi-*.js`）
  //      · 推去 POS 嘅 `source` 欄位（POS 靠佢分平台）
  //    任何一項漏咗，澳覓都係「有做但永遠唔生效」或者「寫錯平台」。
  // ═══════════════════════════════════════════════════════════════════════

  group("[76] 🔴🔴 澳覓立即對帳：GRAB_SETTLE_AOMI_NOW → AOMIFIN_SYNC → 推 POS");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" },
    ];
    bg.store.machineId = "store-aomi-1";
    // 🔴 澳覓嘅商家名 storage key 同 mfood **唔同** —— 呢個就係要驗嘅重點之一
    bg.store.aomiFinanceStoreName = "澳覓表嫂美食";

    bg.state.tabReply = (msg) => {
      if (msg.type !== "AOMIFIN_SYNC") return { ok: true, label: "查詢" };
      return {
        ok: true,
        period: "2026-09-16 ~ 2026-09-30",
        // 🔴 澳覓列表層冇金額 ⇒ 帳期金額由 bridge 用明細逐筆加總
        receive: 115.42,
        subsidy: null, // 澳覓冇補貼兩段口徑
        periods: [
          {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            receive: 115.42,
            subsidy: null,
            transactions: [
              { tradeNo: "TK00115260929133047856", netAmount: 115.42, grossAmount: 120.42 },
            ],
          },
        ],
      };
    };

    const res = await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(400);

    // ═══════════════════════════════════════════════════════════════════
    //  🔴🔴 2026-09-29 真機回歸：澳覓對帳頁 URL 特徵
    //
    //  實機 URL（使用者提供）：
    //    列表 `#/qrAccountmanage/takeoutAccountManage/takeoutAccount`
    //    明細 `#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=…`
    //  ⚠️ **完全冇 `settle` 字**（`settle` 只喺 API 路徑 `settleService/…`）。
    //  舊寫法 `/settle/i.test(url)` ⇒ 永遠搵唔到分頁 ⇒
    //  「對帳失敗：未開啟澳覓財務對帳頁」（真機症狀）。
    //  舊測試之所以綠燈，係因為假 URL 寫咗 `#/settle/merchant`（**錯假設**）。
    // ═══════════════════════════════════════════════════════════════════
    const aomiCfg = bg.sandbox.grabSettleCfg("aomi");
    check(
      "🔴🔴 認得真機列表頁 URL（唔可以再靠 `settle` 字）",
      aomiCfg.tabUrlMatch(
        "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount",
      ),
      true,
    );
    check(
      "🔴🔴 認得真機明細頁 URL（走訪期間換 route 唔可以掉線）",
      aomiCfg.tabUrlMatch(
        "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857&storeName=%E8%A1%A8%E5%AB%82%E7%BE%8E%E9%A3%9F",
      ),
      true,
    );
    check(
      "🔴🔴 真機 URL 冇 `settle` 字（證明舊特徵必然失效）",
      /settle/i.test(
        "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount",
      ),
      false,
    );
    check(
      "🔴 唔可以誤認訂單管理頁做財務頁",
      aomiCfg.tabUrlMatch("https://merchant.aomiapp.com/#/order/orderManage"),
      false,
    );
    check(
      "🔴 唔可以認到 mfood 嘅頁",
      aomiCfg.tabUrlMatch("https://merchant.mfoodapp.com/#/finance/tackout-check"),
      false,
    );

    check("回報成功", !!(res && res.ok), true);
    check(
      "🔴 有送 AOMIFIN_SYNC 去澳覓財務頁",
      bg.state.sentTabs.some((t) => t.tabId === 91 && t.msg && t.msg.type === "AOMIFIN_SYNC"),
      true,
    );
    check(
      "🔴 冇誤送 MFOODFIN_SYNC（撞錯命名空間會靜默無回應）",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "MFOODFIN_SYNC"),
      false,
    );
    check(
      "🔴 商家名由 `aomiFinanceStoreName` 讀（唔可以讀 mfood 嗰個）",
      lastSyncMsg(bg, 91) && lastSyncMsg(bg, 91).storeName,
      "澳覓表嫂美食",
    );

    const call = bg.fetchCalls.find((c) => c.url.indexOf("/grabber/settlement") >= 0);
    check("🔴 有打 POS settlement 端點", !!call, true);
    const body = call && call.init.body ? JSON.parse(call.init.body) : null;
    check("🔴🔴 body.source ＝ 'aomi'（POS 靠佢分平台）", body && body.source, "aomi");
    check("body.storeId ＝ machineId", body && body.storeId, "store-aomi-1");
    check("有帶非空 transactions", (body && body.transactions.length) || 0, 1);
    check(
      "🔴 body.periodAmounts 帶澳覓實收",
      body && body.periodAmounts && body.periodAmounts.receive,
      115.42,
    );

    check("有記錄上次對帳時間", typeof bg.store.aomiState.lastSettleAt, "string");
    check(
      "🔴 日誌 kind 係 aomi_settle（唔可以寫錯 mfood_settle）",
      (bg.store.aomiLog || []).some((e) => e.kind === "aomi_settle"),
      true,
    );
  }

  group("[77] 🔴🔴 找澳覓財務頁要用澳覓嘅 URL 特徵（唔可以搵 mfood）");
  {
    const bg = loadBackground();
    // 同時開住兩個平台嘅財務頁 ⇒ 一定要揀返自己嗰個
    bg.state.financeTabs = [
      { id: 71, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
      { id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" },
    ];
    bg.store.machineId = "store-1";
    bg.store.aomiFinanceStoreName = "澳覓店";
    bg.state.tabReply = (msg) =>
      msg.type === "AOMIFIN_SYNC"
        ? { ok: true, period: "P1", periods: [{ ok: true, period: "P1", receive: 1, transactions: [{ tradeNo: "TK1", netAmount: 1 }] }] }
        : { ok: true };

    await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(400);

    check(
      "🔴🔴 訊息一定要送去澳覓分頁（91），唔可以送去 mfood（71）",
      bg.state.sentTabs.some((t) => t.tabId === 91 && t.msg.type === "AOMIFIN_SYNC"),
      true,
    );
    check(
      "🔴 完全冇碰過 mfood 分頁",
      bg.state.sentTabs.some((t) => t.tabId === 71),
      false,
    );
    // 🔴 query 一定要用澳覓嘅 URL pattern
    check(
      "🔴 query 用 `https://merchant.aomiapp.com/*`",
      bg.state.queriedTabs.some((q) => String(q.url).indexOf("aomiapp.com") >= 0),
      true,
    );
  }

  group("[78] 🔴 冇開澳覓財務頁 ⇒ 大聲失敗＋講清楚要開邊個頁");
  {
    const bg1 = loadBackground();
    bg1.store.machineId = "store-1";
    const r1 = await bg1.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg1.tick(260);
    check("回 ok:false", !!(r1 && r1.ok === false), true);
    check(
      "🔴 講明係澳覓（唔可以講 mfood）",
      !!(r1 && r1.reason && r1.reason.indexOf("澳覓") >= 0),
      true,
    );
    check(
      "🔴 提示頁面冇提 mfood",
      !!(r1 && r1.reason && r1.reason.indexOf("mfoodapp") < 0),
      true,
    );
    check("有寫錯誤日誌", (bg1.store.aomiLog || []).some((e) => e.kind === "aomi_settle" && e.level === "error"), true);

    // ② 未設 Store ID ⇒ 本地就要擋住
    const bg2 = loadBackground();
    bg2.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    bg2.state.tabReply = (msg) =>
      msg.type === "AOMIFIN_SYNC"
        ? { ok: true, period: "P1", periods: [{ ok: true, period: "P1", receive: 1, transactions: [{ tradeNo: "T1", netAmount: 1 }] }] }
        : { ok: true };
    const r2 = await bg2.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg2.tick(320);
    check("🔴 未設 Store ID ⇒ ok:false", !!(r2 && r2.ok === false), true);
    check(
      "🔴 講明未設定 Store ID",
      !!(r2 && r2.reason && r2.reason.indexOf("Store ID") >= 0),
      true,
    );
    check(
      "🔴 冇亂打一個冇 storeId 嘅請求",
      bg2.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0).length,
      0,
    );
  }

  group("[79] 🔴🔴 多帳期（澳覓）⇒ 一樣要逐帳期推送去 POS");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    bg.store.machineId = "store-aomi-2";
    bg.state.tabReply = (msg) => {
      if (msg.type !== "AOMIFIN_SYNC") return { ok: true };
      return {
        ok: true,
        period: "2026-09-16 ~ 2026-09-30",
        transactions: [],
        periods: [
          {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            receive: 115.42,
            transactions: [{ tradeNo: "TK-A", netAmount: 115.42 }],
          },
          {
            ok: true,
            period: "2026-09-01 ~ 2026-09-15",
            receive: 200,
            transactions: [{ tradeNo: "TK-B", netAmount: 200 }],
          },
          {
            ok: true,
            period: "2026-08-16 ~ 2026-08-31",
            receive: 300,
            transactions: [{ tradeNo: "TK-C", netAmount: 300 }],
          },
        ],
      };
    };

    const r = await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(500);

    check("回報成功", !!(r && r.ok), true);
    check("🔴 回報寫咗 3 個帳期", r && r.periodPushedCount, 3);
    const calls = bg.fetchCalls.filter((c) => c.url.indexOf("/grabber/settlement") >= 0);
    check("🔴🔴 打了 3 次 settlement（一個帳期一次）", calls.length, 3);
    const bodies = calls.map((c) => JSON.parse(c.init.body));
    check(
      "🔴 每次 source 都係 aomi",
      bodies.every((b) => b.source === "aomi"),
      true,
    );
    check(
      "🔴 每個請求帶自己嘅帳期",
      bodies.map((b) => b.periodAmounts.period),
      ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
    );
    check(
      "🔴 每個請求只帶自己嘅明細",
      bodies.map((b) => b.transactions.length),
      [1, 1, 1],
    );
  }

  group("[80] 🔴🔴 要帶「只同步此日後」（startDate）落澳覓財務頁（多帳期靠佢）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    bg.store.machineId = "store-1";
    bg.store.startDate = "2026-08-30";
    bg.state.tabReply = (msg) =>
      msg.type === "AOMIFIN_SYNC"
        ? { ok: true, period: "P1", transactions: [], periods: [] }
        : { ok: true };

    await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(320);

    const sent = lastSyncMsg(bg, 91);
    check("🔴🔴 有帶 startDate", sent && sent.startDate, "2026-08-30");
    check("有帶 targetDate（今日）", /^\d{4}-\d{2}-\d{2}$/.test(String(sent && sent.targetDate)), true);
  }

  group("[81] 🔴🔴 實收對照表（澳覓）要落 state 而且要累積");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    bg.store.machineId = "store-1";
    bg.state.tabReply = (msg) => {
      if (msg.type !== "AOMIFIN_SYNC") return { ok: true };
      return {
        ok: true,
        period: "2026-09-16 ~ 2026-09-30",
        periods: [
          {
            ok: true,
            period: "2026-09-16 ~ 2026-09-30",
            receive: 115.42,
            // 🔴 澳覓嘅明細欄位係 `netAmount`（bridge 已 ÷100）；POS 端 popup 靠 tradeNo 配對
            transactions: [{ tradeNo: "TK00115260929133047856", netAmount: 115.42, grossAmount: 120.42 }],
          },
        ],
      };
    };

    await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(400);

    const m = (bg.store.aomiState && bg.store.aomiState.settleMap) || {};
    const k = "TK00115260929133047856";
    check("🔴 有落到 aomiState.settleMap", !!m[k], true);
    check("🔴 實收 ＝ netAmount（115.42）", m[k] && m[k].receive, 115.42);
    check("有記低屬邊個帳期", m[k] && m[k].period, "2026-09-16 ~ 2026-09-30");

    // ② 第二輪只帶另一張單 ⇒ 第一張**唔可以消失**
    bg.state.tabReply = (msg) => {
      if (msg.type !== "AOMIFIN_SYNC") return { ok: true };
      return {
        ok: true,
        period: "2026-09-01 ~ 2026-09-15",
        periods: [
          { ok: true, period: "2026-09-01 ~ 2026-09-15", receive: 9.9, transactions: [{ tradeNo: "TK-OTHER", netAmount: 9.9 }] },
        ],
      };
    };
    await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(400);
    const m2 = bg.store.aomiState.settleMap || {};
    check("🔴🔴 要累積（上一輪嘅單唔可以消失）", !!m2[k], true);
    check("新嗰張要喺度", m2["TK-OTHER"] && m2["TK-OTHER"].receive, 9.9);
  }

  group("[82] 🔴 澳覓同 mfood 嘅 state／settings 完全獨立（唔可以互相污染）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 71, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
      { id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" },
    ];
    bg.store.machineId = "store-1";
    bg.store.mfoodFinanceStoreName = "表嫂美食";
    bg.store.aomiFinanceStoreName = "澳覓表嫂美食";
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_SYNC"
        ? { ok: true, period: "M1", periods: [{ ok: true, period: "M1", receive: 11, transactions: [{ tradeNo: "M-1", subsidyStoreReceiveAmtn: 11 }] }] }
        : msg.type === "AOMIFIN_SYNC"
          ? { ok: true, period: "A1", periods: [{ ok: true, period: "A1", receive: 22, transactions: [{ tradeNo: "A-1", netAmount: 22 }] }] }
          : { ok: true };

    await bg.send({ type: "GRAB_SETTLE_NOW" });
    await bg.tick(400);
    await bg.send({ type: "GRAB_SETTLE_AOMI_NOW" });
    await bg.tick(400);

    check("🔴 mfood state 有 mfood 嗰張", !!(bg.store.mfoodState.settleMap["M-1"]), true);
    check("🔴 aomi state 有澳覓嗰張", !!(bg.store.aomiState.settleMap["A-1"]), true);
    check(
      "🔴🔴 mfood state 唔可以撈到澳覓嘅單",
      bg.store.mfoodState.settleMap["A-1"],
      undefined,
    );
    check(
      "🔴🔴 aomi state 唔可以撈到 mfood 嘅單",
      bg.store.aomiState.settleMap["M-1"],
      undefined,
    );
    check("🔴 mfood 商家名冇被覆蓋", bg.store.mfoodFinanceStoreName, "表嫂美食");
    check("🔴 澳覓商家名冇被覆蓋", bg.store.aomiFinanceStoreName, "澳覓表嫂美食");
  }

  group("[83] 🔴 GRAB_SET_AUTO_SETTLE{sourceKey:'aomi'} 要寫入澳覓自己嘅 settings");
  {
    const bg = loadBackground();
    const r1 = await bg.send({ type: "GRAB_SET_AUTO_SETTLE", sourceKey: "aomi", enabled: true });
    await bg.tick(160);
    check("回報 ok", !!(r1 && r1.ok), true);
    check("🔴 回報 sourceKey ＝ aomi", r1 && r1.sourceKey, "aomi");
    check("🔴 寫入 aomiSettings.autoSettle", bg.store.aomiSettings && bg.store.aomiSettings.autoSettle, true);
    check(
      "🔴🔴 唔可以寫錯 mfoodSettings",
      bg.store.mfoodSettings && bg.store.mfoodSettings.autoSettle,
      undefined,
    );

    // ② 唔帶 sourceKey（舊 popup）⇒ 仍然要係 mfood（向後相容）
    const bg2 = loadBackground();
    const r2 = await bg2.send({ type: "GRAB_SET_AUTO_SETTLE", enabled: true });
    await bg2.tick(160);
    check("🔴 舊呼叫（冇 sourceKey）⇒ 預設 mfood", r2 && r2.sourceKey, "mfood");
    check("🔴 寫入 mfoodSettings", bg2.store.mfoodSettings && bg2.store.mfoodSettings.autoSettle, true);
  }

  group("[84] 🔴🔴 重新注入澳覓腳本：MAIN 只注入 inject、bridge 一定要 isolated（分兩次）");
  {
    const bg = loadBackground();
    const fn = bg.sandbox.grabReinjectFinanceScripts;
    check("掂得到 grabReinjectFinanceScripts", typeof fn, "function");

    // ① 澳覓
    await fn(91, "aomi");
    const injA = bg.state.injectedScripts;
    check("🔴 分兩次 executeScript（唔可以合成一個 files 陣列）", injA.length, 2);
    check(
      "🔴 第一次注入 aomi-inject.js 且 world='MAIN'",
      !!(injA[0] && injA[0].files && injA[0].files[0] === "aomi-inject.js" && injA[0].world === "MAIN"),
      true,
    );
    check(
      "🔴 第二次注入 aomi-finance-bridge.js 且**冇** world（＝isolated）",
      !!(injA[1] && injA[1].files && injA[1].files[0] === "aomi-finance-bridge.js" && injA[1].world === undefined),
      true,
    );
    check(
      "🔴🔴 bridge 絕對唔可以跟 inject 混同一次呼叫",
      !injA.some((c) => Array.isArray(c.files) && c.files.length > 1),
      true,
    );

    // ② 對照組：mfood 要注入 mfood 嘅檔（唔可以互相污染）
    const bg2 = loadBackground();
    await bg2.sandbox.grabReinjectFinanceScripts(71, "mfood");
    const injM = bg2.state.injectedScripts;
    check("mfood 分兩次", injM.length, 2);
    check("mfood inject 檔名正確", injM[0].files[0], "mfood-inject.js");
    check("mfood bridge 檔名正確", injM[1].files[0], "mfood-finance-bridge.js");
  }

  group("[85] 🔴 grabDashboard 要帶 sourceKey（popup 靠佢揀正確 storage key）");
  {
    // 🔴 popup 嘅刷新入口係 `send({ type: `${s.prefix}_GET_DASHBOARD` })`
    //    （`refreshGrab(s)`，popup.js:1299）⇒ 澳覓嘅型別係 **AOMI_GET_DASHBOARD**。
    //    `GRAB_SETTLE_*` 嗰批係「全域路由」，dashboard 係「按前綴分派」—— 兩套並存。
    const bg = loadBackground();
    bg.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    const d = await bg.send({ type: "AOMI_GET_DASHBOARD" });
    await bg.tick(150);
    check("有回應", !!d, true);
    check(
      "🔴🔴 帶 sourceKey ＝ 'aomi'（popup 靠佢揀 `aomiState`／`aomiFinanceStoreName`）",
      d && d.sourceKey,
      "aomi",
    );
    check("有 source 欄位", d && d.source, "aomi");

    // 對照組：mfood 亦要有（唔可以只加澳覓令 mfood 冇）
    const bg2 = loadBackground();
    const d2 = await bg2.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg2.tick(150);
    check("mfood dashboard 亦有 sourceKey", d2 && d2.sourceKey, "mfood");
  }

  group("[86] 🔴 AOMIFIN_RAW 路由：讀澳覓財務頁已攔到嘅原始資料（唔配對）");
  {
    const bg = loadBackground();
    bg.state.financeTabs = [{ id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" }];
    bg.state.tabReply = (msg) =>
      msg.type === "AOMIFIN_RAW"
        ? {
            ok: true,
            finance: true,
            periodRowCount: 2,
            detailRowCount: 3,
            detailRows: [{ orderId: "TK1", costAmount: 11542 }],
          }
        : { ok: true };

    const r = await bg.send({ type: "GRAB_FINANCE_RAW", sourceKey: "aomi" });
    await bg.tick(200);
    check("回報 ok", !!(r && r.ok), true);
    check(
      "🔴 送去財務頁嘅訊息係 AOMIFIN_RAW（唔可以係 mfood 嗰個）",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "AOMIFIN_RAW"),
      true,
    );
    check(
      "🔴 冇誤送 GRAB_FINANCE_RAW（mfood 專用）",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_FINANCE_RAW"),
      false,
    );
  }

  group("[87] 🔴🔴 「開啟平台後台分頁」只開訂單頁（單一分頁：對帳頁絕對唔另開）");
  {
    // 使用者原話：「我看到是成功登入, 但是只看到打開了訂單頁面, 我想問一下對帳的頁面去那裡啦?」
    //
    // 2026-09-30 單一分頁模型下嘅正解：
    //   · 對帳頁**唔可以**係一個常駐嘅第二個分頁 —— mfood 多個同 origin 分頁會互相搶 session，
    //     令訂單／對帳輪流失效（使用者原話：「mfood 分頁是不允許的」）。
    //   · 對帳頁係由 `grabSettleSingleTab` 喺每次對帳時，用**同一個 tab** 經 SPA
    //     跳去 `#/finance/tackout-check` 抓完再跳返訂單頁，唔需要常駐第二個分頁。
    //   · 所以「開啟平台後台分頁」只負責確保**唯一嗰個訂單頁 tab** 存在；對帳頁交返對帳流程。
    //
    // ⇒ 本組鎖住：無論訂單頁喺唔喺，對帳頁都**絕對唔可以**被另開成分頁。

    // ① 兩頁都冇 → 單一分頁：只開訂單頁（對帳頁唔另開，對帳時由同一 tab 跳過去）
    const bg = loadBackground();
    bg.state.tabsCreated = [];
    bg.state.creds = { mfood: { username: "u", password: "p" } };
    await bg.sandbox.grabOpenAdminTabs();
    await bg.tick(200);
    check("兩頁都冇時，至少開咗訂單頁", bg.state.tabsCreated.length >= 1, true);
    check(
      "🔴🔴 單一分頁：開嘅係訂單頁（trade/tackout）",
      bg.state.tabsCreated.some((u) => String(u).indexOf("#/trade/tackout") >= 0),
      true,
    );
    check(
      "🔴🔴 單一分頁：絕對唔可以另開對帳頁（finance/tackout-check）",
      bg.state.tabsCreated.some((u) => String(u).indexOf("#/finance/tackout-check") >= 0),
      false,
    );

    // ② 🔴 關鍵情境：訂單頁已經開住 → 對帳頁更加唔可以開（多分頁會搶 session）
    const bg2 = loadBackground();
    bg2.state.tabsCreated = [];
    bg2.state.tabs = [
      { id: 1, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
    ];
    bg2.state.creds = { mfood: { username: "u", password: "p" } };
    await bg2.sandbox.grabOpenAdminTabs();
    await bg2.tick(200);
    check(
      "🔴🔴 訂單頁已在時，對帳頁仍然唔開（單一分頁）",
      bg2.state.tabsCreated.some((u) => String(u).indexOf("#/finance/tackout-check") >= 0),
      false,
    );
    check(
      "訂單頁已在 → 唔好重複開訂單頁",
      bg2.state.tabsCreated.some((u) => String(u).indexOf("#/trade/tackout") >= 0),
      false,
    );

    // ③ 對帳頁已在 → 唔好重複開（兩個方向都要對）
    const bg3 = loadBackground();
    bg3.state.tabsCreated = [];
    bg3.state.tabs = [
      { id: 1, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 2, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg3.state.creds = { mfood: { username: "u", password: "p" } };
    await bg3.sandbox.grabOpenAdminTabs();
    await bg3.tick(200);
    check("兩頁都在 → 一個都唔開", bg3.state.tabsCreated.length, 0);

    // ④ 澳覓同樣：單一分頁，只開訂單頁，唔開對帳頁（唔可以只修 mfood）
    const bg4 = loadBackground();
    bg4.state.tabsCreated = [];
    bg4.state.tabs = [
      { id: 1, url: "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord" },
    ];
    bg4.state.creds = { aomi: { username: "u", password: "p" } };
    await bg4.sandbox.grabOpenAdminTabs();
    await bg4.tick(200);
    check(
      "🔴 澳覓：訂單頁已在 → 唔開任何分頁（單一分頁，唔開對帳頁亦唔重複開訂單頁）",
      bg4.state.tabsCreated.length,
      0,
    );
    check(
      "🔴 澳覓：絕對唔開對帳頁（takeoutAccountManage）",
      bg4.state.tabsCreated.some((u) => String(u).indexOf("takeoutAccountManage/takeoutAccount") >= 0),
      false,
    );

    // ⑤ 冇帳密 → 唔應該開任何分頁（唔好未設定就彈頁出嚟）
    const bg5 = loadBackground();
    bg5.state.tabsCreated = [];
    bg5.state.creds = {};
    await bg5.sandbox.grabOpenAdminTabs();
    await bg5.tick(200);
    check("冇設帳密 → 唔開任何分頁", bg5.state.tabsCreated.length, 0);

    // ⑥ 🔴 2026-09-30 日誌分析後補：呢條路徑**一定要有 log**，
    //    否則對帳失敗講「未開啟財務頁」時，查唔到當時有冇開過。
    const mfoodLog = bg2.store.mfoodLog || [];
    check(
      "🔴🔴 開分頁有寫 log（mfood_open_tabs）",
      mfoodLog.some((e) => e.kind === "mfood_open_tabs"),
      true,
    );
    const openEvt = mfoodLog.find((e) => e.kind === "mfood_open_tabs");
    check(
      "🔴 log 記錄「對帳頁開咗」= false（單一分頁：對帳頁唔另開，由對帳流程跳過去）",
      !!(openEvt && openEvt.detail && openEvt.detail.openedFinancePage === false),
      true,
    );
    check(
      "log 有帶兩個目標 URL",
      !!(openEvt && openEvt.detail && openEvt.detail.orderPageUrl && openEvt.detail.financePageUrl),
      true,
    );
    check("🔴 log level = info（成功開到）", openEvt && openEvt.level, "info");

    // ⑦ 兩頁都在時 → log 要顯示「冇新開」（openedFinancePage = false）
    const log3 = bg3.store.mfoodLog || [];
    const evt3 = log3.find((e) => e.kind === "mfood_open_tabs");
    check(
      "兩頁都在 → log 記錄 openedFinancePage = false",
      !!(evt3 && evt3.detail && evt3.detail.openedFinancePage === false),
      true,
    );

    // ⑧ 冇帳密都要有 log（唔可以靜靜地略過）
    const log5 = bg5.store.mfoodLog || [];
    check(
      "冇帳密 → 都有寫 log（唔可以靜默略過）",
      log5.some((e) => e.kind === "mfood_open_tabs"),
      true,
    );
  }

  /**
   * 🔴🔴 2026-09-30：`GRAB_MFOOD_STORE_OPTIONS` —— popup 讀後台商家清單。
   *
   * 使用者原話：「你需要給商家在extension 上, 選擇用那家店, 去做mfood 對帳」
   *
   * ⚠️ 呢個路由有**兩個必須正確嘅點**，兩者錯任何一個都係「靜默失敗」：
   *   ① 要轉發 `MFOODFIN_STORE_OPTIONS`（**唔可以**誤用 `MFOODFIN_DOMDUMP`
   *      或 `GRAB_FINANCE_RAW` —— 撞錯型別 bridge 唔會應，popup 呆等）；
   *   ② 分頁**未開**時要回 actionable 原因（**唔可以**回一個空 ok:true，
   *      否則 popup 會顯示「0 個店家」，商家以為後台真係冇店）。
   */
  group("[88] 🔴🔴 讀商家清單路由（畀商家揀店，唔使出錯）");
  {
    // ① 正常：財務頁開住 → 要轉發正確型別，並原樣交返清單
    const bg = loadBackground();
    bg.state.financeTabs = [
      { id: 71, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg.state.tabReply = (msg) =>
      msg.type === "MFOODFIN_STORE_OPTIONS"
        ? {
            ok: true,
            options: ["表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)", "表嫂美食(海贼龍蝦飯)"],
            optionCount: 2,
            current: "",
            hasTags: true,
          }
        : { ok: true, wrongType: true };

    const r = await bg.send({ type: "GRAB_MFOOD_STORE_OPTIONS" });
    await bg.tick(200);

    check("有回應", !!r, true);
    check("🔴 路由成功", !!(r && r.ok), true);
    check("🔴🔴 原樣交返清單（2 個）", (r && r.options || []).length, 2);
    check(
      "🔴 商家名連括號都保留（商家要認得）",
      (r && (r.options || []).some((x) => String(x).indexOf("蒸煎手打肉餅") >= 0)),
      true,
    );
    check("🔴 冇誤用其他型別（wrongType 唔應該出現）", !!(r && r.wrongType), false);
    const sentMsg = bw(bg, 71);
    check("🔴🔴 發去財務頁嘅型別係 MFOODFIN_STORE_OPTIONS", sentMsg && sentMsg.type, "MFOODFIN_STORE_OPTIONS");

    // ② 財務頁未開 → 一定要回 actionable 原因（唔可以空 ok:true）
    const bg2 = loadBackground();
    bg2.state.financeTabs = [];
    const r2 = await bg2.send({ type: "GRAB_MFOOD_STORE_OPTIONS" });
    await bg2.tick(200);
    check("🔴🔴 財務頁未開 → 唔可以回 ok:true（會顯示成「後台冇店家」）", !!(r2 && r2.ok), false);
    check(
      "🔴 要講明係「未開啟財務對帳頁」＋畀出點去",
      /未開啟/.test(String((r2 && r2.reason) || "")) &&
        /finance\/tackout-check/.test(String((r2 && r2.reason) || "")),
      true,
    );

    // ③ 只有澳覓財務頁開住 → mfood 專用路由**唔可以**誤用澳覓分頁
    //    （`storeoptions` 刻意只分流去 mfood；澳覓未有對應實作）
    const bg3 = loadBackground();
    bg3.state.financeTabs = [
      { id: 91, url: "https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount" },
    ];
    const r3 = await bg3.send({ type: "GRAB_MFOOD_STORE_OPTIONS" });
    await bg3.tick(200);
    check("🔴 唔可以攞澳覓分頁當 mfood 用（要如實話未開啟）", !!(r3 && r3.ok), false);
    check("🔴 完全冇發過任何訊息去澳覓分頁", bg3.state.sentTabs.filter((t) => t.tabId === 91).length, 0);
  }

  group("[89] 🔴🔴 同平台開多過一個分頁 → dashboard 要出聲（2026-09-30 使用者真機）");
  {
    // 使用者原話：
    //   「我需要同時讓多個頁面各自獨立運行才能正常操作，目前的做法是在 Google Chrome
    //     裡同時打開 4 個分頁，想讓它們各自自動執行，但似乎無法正常運作。」
    //
    // 根因：`state.tabId` 只喺 PAGE_READY 記低 + `tabs[0]` 冇消歧 ⇒「有時得有時唔得」。
    // 擴充功能阻止唔到人開分頁，所以**唯一負責嘅做法係講清楚**。
    const bg = loadBackground();
    bg.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 12, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 13, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
      { id: 21, url: "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord" },
    ];
    const d = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg.tick(200);
    check("有回應", !!d, true);
    check("🔴🔴 mfood 數到 3 個分頁", d && d.openTabCount, 3);
    check("🔴🔴 標記 duplicateTabs = true", d && d.duplicateTabs, true);

    // 對照組①：只有 1 個分頁 → 唔可以出警示（唔可以誤報）
    const bg2 = loadBackground();
    bg2.state.tabs = [{ id: 31, url: "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord" }];
    const d2 = await bg2.send({ type: "AOMI_GET_DASHBOARD" });
    await bg2.tick(200);
    check("單一分頁 ⇒ openTabCount = 1", d2 && d2.openTabCount, 1);
    check("🔴 單一分頁 ⇒ 唔出警示", d2 && d2.duplicateTabs, false);

    // 對照組②：查唔到（環境冇 chrome.tabs.query）→ 一定要回 null，
    //    **唔可以**回 0（0 會變成「確定冇問題」嘅假安心）。
    const bg3 = loadBackground();
    const savedQuery = bg3.chrome.tabs.query;
    delete bg3.chrome.tabs.query;
    const d3 = await bg3.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg3.tick(200);
    check("🔴 查唔到 ⇒ openTabCount = null（唔可以當 0）", d3 && d3.openTabCount, null);
    check("🔴 查唔到 ⇒ 唔出警示", d3 && d3.duplicateTabs, false);
    bg3.chrome.tabs.query = savedQuery;
  }

  /**
   * [90]~[94]：2026-09-30 真機確診 —— 「推送失敗 / 登入迴圈 / 分頁誤報」
   * 其實係**同一個成因**：命令被送去錯嘅分頁（`state.tabId` 只認最後 PAGE_READY）。
   */
  group("[90] 🔴🔴 命令一定要送去『訂單頁』分頁（唔可以靠 state.tabId）");
  {
    const bg = loadBackground();
    bg.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 12, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
      { id: 13, url: "https://merchant.mfoodapp.com/#/login" },
    ];
    // 真機實況：最後載入嘅係「登入頁」分頁 ⇒ state.tabId 指住佢
    await bg.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/login" },
      { tab: { id: 13 } },
    );
    await bg.tick(120);
    check("重現真機：state.tabId 指住登入頁", bg.store.mfoodState && bg.store.mfoodState.tabId, 13);

    await bg.send({ type: "MFOOD_RESCAN" });
    await bg.tick(150);
    const rs = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_RESCAN");
    check("🔴🔴 代按查詢送去訂單頁（11）", rs.length > 0 && rs[rs.length - 1].tabId, 11);
    check(
      "🔴 完全冇送過去登入頁（舊症狀：找不到「查詢」按鈕）",
      bg.state.sentTabs.filter((t) => t.tabId === 13 && t.msg && t.msg.type === "GRAB_RESCAN").length,
      0,
    );

    // 🔴 抓詳情要有「需要抓品項嘅單」才會派工 ⇒ 先種一筆入冊（否則提早 return）。
    const st90 = bg.store.mfoodState || {};
    st90.orders = Object.assign({}, st90.orders, {
      A1: {
        id: "A1",
        state: "pending",
        amount: 10,
        at: new Date().toISOString(),
        detailState: "none",
        detailAttempts: 0,
        items: [],
      },
    });
    st90.seen = st90.seen || {};
    st90.counters = st90.counters || {};
    bg.store.mfoodState = st90;

    await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    await bg.tick(250);
    const fd = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "GRAB_FETCH_DETAILS");
    check(
      "🔴 抓詳情亦送去訂單頁（舊症狀：在列表中找不到這一列）",
      fd.length > 0 && fd[fd.length - 1].tabId,
      11,
    );
    check(
      "🔴 完全冇送過去登入頁（13）",
      bg.state.sentTabs.filter((t) => t.tabId === 13 && t.msg && t.msg.type === "GRAB_FETCH_DETAILS")
        .length,
      0,
    );
  }

  group("[91] 🔴🔴 登入乒乓：已有已登入分頁 ⇒ 唔可以再填表登入");
  {
    const bg = loadBackground();
    bg.state.creds = { mfood: { username: "u", password: "p" } };
    bg.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 13, url: "https://merchant.mfoodapp.com/#/login" },
    ];
    await bg.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/login" },
      { tab: { id: 13 } },
    );
    await bg.tick(300);
    const fills = bg.state.sentTabs.filter((t) => t.msg && t.msg.type === "MFOOD_LOGIN_FILL");
    check("🔴🔴 唔可以再送登入請求（短時間重複登入會互踢 session）", fills.length, 0);
    check(
      "🔴 要寫 log 解釋點解唔登（唔可以靜默）",
      (bg.store.mfoodLog || []).some(
        (e) => e.kind === "mfood_login" && String(e.summary).indexOf("略過自動重登") >= 0,
      ),
      true,
    );

    // 對照組：冇任何已登入分頁 ⇒ 應該照樣自動登入（唔可以過度抑制）
    const bg2 = loadBackground();
    bg2.state.creds = { mfood: { username: "u", password: "p" } };
    bg2.state.tabs = [{ id: 13, url: "https://merchant.mfoodapp.com/#/login" }];
    await bg2.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/login" },
      { tab: { id: 13 } },
    );
    await bg2.tick(1700); // 有 1200ms 延遲
    check(
      "對照組：真係全部未登入 ⇒ 照樣自動登入",
      bg2.state.sentTabs.some((t) => t.msg && t.msg.type === "MFOOD_LOGIN_FILL"),
      true,
    );
  }

  group("[92] 🔴🔴 卡片「重試」＝真正重試推送（重置配額＋放行去重名冊）");
  {
    const bg = loadBackground();
    bg.state.tabs = [{ id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" }];
    await bg.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { tab: { id: 11 } },
    );
    await bg.tick(120);

    bg.store.mfoodState = {
      seen: { "202609301740088747767|3": 1, "999|3": 1 },
      orders: {
        // 🔴🔴 key 一定要**加引號**！無引號嘅 21 位數字字面量會被 JS 用
        //    Number→String 轉換 ⇒ 超出 2^53 精度 ⇒ key 變成
        //    `202609301740088750000`（尾 6 位唔同）⇒ 搵唔返嗰筆單。
        //    真機單號係 JSON **字串**（財務頁 tradeNo 位數完整），所以生產無事；
        //    但測試寫法一定要同真實一致。
        "202609301740088747767": {
          id: "202609301740088747767",
          state: "failed",
          attempts: 10,
          error: "POS 拒收 1/1 張 —— payload 內冇可用品項",
          lastAt: new Date().toISOString(),
        },
      },
      counters: {},
    };

    const resp = await bg.send({ type: "MFOOD_RETRY_PUSH" });
    await bg.tick(250);
    check("有回應", !!(resp && resp.ok), true);

    const st = bg.store.mfoodState || {};
    const o = (st.orders || {})["202609301740088747767"] || {};
    check("🔴 attempts 歸零（否則配額用完永遠唔再試）", o.attempts, 0);
    check("🔴 狀態改回 pending", o.state, "pending");
    check("🔴 清走 error", o.error, null);
    check("🔴 放行該單嘅去重記錄", "202609301740088747767|3" in (st.seen || {}), false);
    check("🔴 唔可以誤刪其他單嘅記錄", "999|3" in (st.seen || {}), true);
    check(
      "🔴 即刻重新查詢（唔等下一次 tick）",
      bg.state.sentTabs.some((t) => t.msg && t.msg.type === "GRAB_RESCAN" && t.tabId === 11),
      true,
    );
    check(
      "有寫手動重試日誌",
      (bg.store.mfoodLog || []).some((e) => e.kind === "mfood_push_retry_manual"),
      true,
    );
  }

  group("[93] 🔴🔴 分頁警示唔可以誤報（1 訂單 + 1 對帳 = 正常）");
  {
    const bg = loadBackground();
    bg.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 12, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    const d = await bg.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg.tick(200);
    check("分類 order = 1", d && d.tabInfo && d.tabInfo.order, 1);
    check("分類 finance = 1", d && d.tabInfo && d.tabInfo.finance, 1);
    check(
      "🔴🔴 正常狀態（1+1）唔可以出警示（舊寫法令警示永遠唔走）",
      d && d.duplicateTabs,
      false,
    );

    // 真正重複：兩張訂單頁
    const bg2 = loadBackground();
    bg2.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 14, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 12, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    const d2 = await bg2.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg2.tick(200);
    check("🔴 兩張訂單頁 ⇒ 要出警示", d2 && d2.duplicateTabs, true);

    // o2o portal 等其他分頁唔會影響命令分派 ⇒ 唔警示
    const bg3 = loadBackground();
    bg3.state.tabs = [
      { id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { id: 15, url: "https://merchant.o2o.mfoodapp.com/#/welcome" },
    ];
    const d3 = await bg3.send({ type: "MFOOD_GET_DASHBOARD" });
    await bg3.tick(200);
    check("其他分頁唔算重複", d3 && d3.duplicateTabs, false);
    check("其他分頁要分類成 other", d3 && d3.tabInfo && d3.tabInfo.other, 1);
  }

  group("[94] 🔴 抓品項失敗要計 attempts（舊寫法永遠 0 ⇒ 每 30 秒無限重派）");
  {
    const bg = loadBackground();
    bg.state.tabs = [{ id: 11, url: "https://merchant.mfoodapp.com/#/trade/tackout" }];
    await bg.send(
      { type: "MFOOD_PAGE_READY", href: "https://merchant.mfoodapp.com/#/trade/tackout" },
      { tab: { id: 11 } },
    );
    await bg.tick(120);

    // ⚠️ 一定要**合併**而唔係整份覆蓋：`MFOOD_PAGE_READY` 啱啱先寫入 `tabId: 11`，
    //    整份換走就會冇咗 ⇒ `grabMaybeFetchDetails()` 提早 return
    //    「還沒偵測到該後台分頁」⇒ 根本冇派工（呢個係測試自己嘅錯，唔係產品 bug）。
    bg.store.mfoodState = Object.assign({}, bg.store.mfoodState, {
      seen: {},
      orders: {
        A1: {
          id: "A1",
          state: "pending",
          amount: 10,
          at: new Date().toISOString(),
          detailState: "none",
          detailAttempts: 0,
          items: [],
        },
      },
      counters: {},
    });
    bg.state.tabReply = (msg) =>
      msg.type === "GRAB_FETCH_DETAILS"
        ? {
            ok: true,
            total: 1,
            failed: 1,
            batchOk: 0,
            dispatched: 1,
            failures: [{ id: "A1", reason: "在列表中找不到這一列" }],
            strategy: "replay",
          }
        : { ok: true };

    const resp = await bg.send({ type: "MFOOD_FETCH_DETAILS" });
    await bg.tick(300);
    const e = (bg.store.mfoodState.orders || {}).A1 || {};
    check("有回應（派工本身成功）", !!(resp && resp.ok), true);
    check("🔴 抓取失敗要計 attempts（唔可以停在 0）", e.detailAttempts, 1);
    check("🔴 detailState 標成 failed（唔會無限期重派）", e.detailState, "failed");
    check("🔴 detailError 要如實寫低原因", e.detailError, "在列表中找不到這一列");
    check(
      "日誌要講明係「抓取品項失敗」而唔係「派工失敗：undefined」",
      (bg.store.mfoodLog || []).some(
        (ev) => ev.kind === "mfood_detail_batch" && String(ev.summary).indexOf("抓取品項失敗") >= 0,
      ),
      true,
    );
  }

  group("[95] 🔴🔴 `navigateOnAlready` 唔可以係死代碼（只喺『新建分頁』時授權導頁）");
  {
    /**
     * 為什麼要鎖：`login.js` 有個分支係「已登入但唔喺訂單頁 ⇒ 導過去」，
     * 條件係 `payload.navigateOnAlready`。但全個 repo **冇任何地方設定過佢**
     * ⇒ 呢個分支由 2026-09-29 起就一直係**死代碼**（實測 grep 只中 login.js 一行）。
     *
     * 🔴 而修好佢**唔可以**無腦加：`grabLoginEnsureTab()` 攞 `tabs.query(...)[0]`，
     *    **冇保證**係訂單頁 —— 有可能係**對帳頁**。若果對已存在嘅分頁都授權導頁，
     *    就會把對帳頁搬去訂單頁 ⇒ 財務頁從此消失 ⇒ 永久「未開啟財務對帳頁」。
     * ⇒ 正解：**只有背景自己開嘅新分頁**才授權。
     */
    const bg = loadBackground();
    bg.state.creds = { mfood: { username: "u", password: "p" } };
    bg.state.tabs = []; // 查唔到任何 mfood 分頁 ⇒ 背景會自己開
    bg.state.tabReply = () => ({ ok: true, stage: "already" });
    await bg.send({ type: "GRAB_LOGIN_TEST_ONE", sourceKey: "mfood" });
    await bg.tick(3200); // grabLoginEnsureTab 開完分頁要等 2500ms
    const fill1 = bg.state.sentTabs
      .filter((t) => t.msg && t.msg.type === "MFOOD_LOGIN_FILL")
      .pop();
    check("新建分頁：有送登入請求", !!fill1, true);
    check(
      "🔴 新建分頁 ⇒ 要授權導頁（否則 login.js 嘅導頁分支永遠行唔到）",
      fill1 && fill1.msg.navigateOnAlready,
      true,
    );

    const bg2 = loadBackground();
    bg2.state.creds = { mfood: { username: "u", password: "p" } };
    // 已存在嘅分頁可能係**對帳頁** ⇒ 一定唔可以授權導頁
    bg2.state.tabs = [
      { id: 12, url: "https://merchant.mfoodapp.com/#/finance/tackout-check" },
    ];
    bg2.state.tabReply = () => ({ ok: true, stage: "already" });
    await bg2.send({ type: "GRAB_LOGIN_TEST_ONE", sourceKey: "mfood" });
    await bg2.tick(400);
    const fill2 = bg2.state.sentTabs
      .filter((t) => t.msg && t.msg.type === "MFOOD_LOGIN_FILL")
      .pop();
    check("已有分頁：有送登入請求", !!fill2, true);
    check(
      "🔴 已有分頁 ⇒ **唔可以**授權導頁（會把對帳頁搬去訂單頁）",
      !!(fill2 && fill2.msg.navigateOnAlready),
      false,
    );
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);

  process.exit(failed > 0 ? 1 : 0);
})();
