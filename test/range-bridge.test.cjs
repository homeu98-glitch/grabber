/**
 * 「套用日期並抓全部」+「切換狀態自動載入」的 bridge 流程測試
 *
 * 為什麼需要這支測試：
 *   兩個平台的實作路線不同，但對使用者而言必須是同一件事：
 *   「我設了 2026-09-22，平台頁面就真的只給我看那之後的單」。
 *
 *   ① mfood：簽章不含 request body → 直接重放列表請求（via: 'api'）
 *   ② 澳覓 ：簽章涵蓋完整 query → 只能操作頁面 + 回讀驗證（via: 'dom'）
 *
 *   這支測試鎖住：
 *     · mfood 優先走 API；API 失敗時要退回 DOM，並把原因帶出來
 *     · 澳覓 要走遍 4 個狀態（進行中/已完成/已取消/待退款）
 *     · 🔴 已取消／待退款只記錄不推送（observedOnly）
 *     · 🔴 切了狀態但頁面沒自己載入 → 要重試（不可把上一狀態當成這一輪）
 *     · 🔴 使用者手動切狀態而頁面沒自己查 → 代按查詢（讓頁面不必 F5）
 *     · 🔴 同步期間不得有額外的補償查詢（不然每個狀態會查兩次）
 *
 *   ⚠️ 兩處刻意貼近真實：
 *      1. 頁籤文字用真實後台的樣子（「進行中訂單」… 帶「訂單」後綴）
 *         —— 先前用假文字「進行中」，掩蓋了全字錨定 regex 命中不了的 bug。
 *      2. 假頁籤的 click() 會**把事件冒泡到 document**（真實瀏覽器就是這樣），
 *         否則測不到 autoDriving 守衛。
 *
 * 執行：node test/range-bridge.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MFOOD_BRIDGE = path.join(__dirname, "..", "mfood-bridge.js");
const AOMI_BRIDGE = path.join(__dirname, "..", "aomi-bridge.js");

const AOMI_LIST_URL = "https://merchant.aomiapp.com/aomi-merchant-order/takeoutOrderRecord/list";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ DOM 替身

const SEL_CLICKABLE = 'button, a, [role="button"], span';
const SEL_NEXTPAGE = 'button, a, li, span, [role="button"]';
const SEL_TAB = '[role="tab"], .el-tabs__item, .ant-tabs-tab, li, button, a, span';

/** 真實後台的頁籤文字（截圖：進行中訂單 / 已完成訂單 / 已取消訂單 / 待退款訂單） */
const TAB_LABELS = [
  ["GOING", "進行中訂單"],
  ["FINISH", "已完成訂單"],
  ["CANCEL", "已取消訂單"],
  ["REFUND", "待退款訂單"],
];

function makeEl(text, opts) {
  opts = opts || {};
  const parent = {
    nodeType: 1,
    textContent: "",
    className: "",
    parentElement: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  const el = {
    // tabSpecOf 會檢查 nodeType === 1
    nodeType: 1,
    textContent: text,
    disabled: false,
    parentElement: parent,
    clicked: 0,
    getBoundingClientRect: () => ({ width: 12, height: 12 }),
    click() {
      el.clicked++;
      // 真實瀏覽器：click() 會派發事件並冒泡到 document。
      // 順序很重要 —— 先讓 document 上的監聽器看到（記錄 clickedAt），
      // 再讓頁面自己的 handler 跑（它才可能發出請求）。
      if (typeof opts.beforeClick === "function") opts.beforeClick(el);
      if (typeof opts.onClick === "function") opts.onClick(el);
    },
    // tabSpecOf 會用 matches() 確認真的是頁籤容器，不是表格儲存格
    matches: () => !!opts.matches,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  return el;
}

/** 假的日期輸入框 —— 重點是 value 可寫、且會記錄收到哪些事件 */
function makeInput(opts) {
  opts = opts || {};
  const parent = {
    nodeType: 1,
    textContent: "",
    // 可以模擬「線索只寫在祖先容器上」的選擇器（例如 el-date-editor）
    className: opts.containerCls || "",
    parentElement: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return {
    nodeType: 1,
    type: opts.type || "text",
    placeholder: opts.placeholder || "",
    className: opts.className || "el-range-input",
    readOnly: !!opts.readOnly,
    disabled: false,
    value: opts.value == null ? "" : opts.value,
    parentElement: parent,
    events: [],
    focus() {},
    blur() {},
    select() {},
    dispatchEvent(ev) {
      this.events.push(ev && ev.type);
      return true;
    },
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 120, height: 32 }),
  };
}

/**
 * 真的 Element-UI「訂單狀態」篩選（2026-09-30 使用者提供嘅真機 DOM）。
 *
 * 🔴 為什麼一定要有：
 *   之前呢個 harness 嘅 `querySelectorAll("input.el-input__inner")` **永遠回 []**
 *    ⇒ `findOrderStatusSelect()` 永遠搵唔到欄位
 *    ⇒ `setOrderStatusAll()` 嘅 **成功路徑從來冇被測過**（只有「搵唔到」嘅失敗路徑）。
 *   呢個就係測試盲點：產品碼明明正確，但一旦有人改壞，CI 都唔會紅。
 *
 * 真機形狀（使用者貼嘅）：
 *   <div class="el-input el-input--mini el-input--suffix">
 *     <input type="text" readonly autocomplete="off" placeholder="請選擇" class="el-input__inner">
 *   <ul class="el-select-dropdown__list">
 *     <li class="el-select-dropdown__item"><span>全部</span></li> … 「已完成」係 selected
 *
 * ⚠️ 動畫：Element-UI 嘅下拉係 `transform: scaleY(0→1)`，
 *    動畫期間 `getBoundingClientRect()` 回 0×0 ⇒ 選項會被「必須可見」剔走。
 *    harness 用 `opt.animMs` 模擬（預設 0 = 已展開完成）。
 */
function makeOrderStatusSelect(opts) {
  opts = opts || {};
  const current = opts.current == null ? "已完成" : opts.current;
  const labels = ["全部", "待接單", "商家已接單", "待送達", "待退款", "已完成", "已退款"];

  // 「訂單狀態」label 所在嘅容器（`nearOrderStatusLabel` 由 input 向上搵 6 層）
  const labelCell = {
    nodeType: 1,
    textContent: "訂單狀態",
    parentElement: null,
    className: "filter-item",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  const selectWrap = {
    nodeType: 1,
    textContent: "訂單狀態",
    parentElement: labelCell,
    className: "el-select el-select--mini",
    // 🔴🔴 之前呢度係 `contains: () => false` ⇒ `closestByClass(box,"el-select")` 永遠返 null
    //    ⇒ bridge 永遠用 document 全頁掃，scoped 分支從未被測（盲點）。
    //    改返 `c === "el-select"` 先可以真正行到 scoped 分支。
    classList: { add() {}, remove() {}, toggle() {}, contains: (c) => c === "el-select" },
    querySelectorAll(sel) {
      // 🔴🔴 模擬 Element-UI `popper-append-to-body`：
      //   optionsInBody===true（Element-UI **預設**）→ dropdown 被 teleport 去 <body>，
      //     .el-select 子樹入面搵唔到選項 ⇒ 回 []（逼 bridge 退返 document 全頁掃）。
      //   optionsInBody===false（popper-append-to-body=false）→ dropdown 在 .el-select 子樹 ⇒ 回 optionEls。
      if (opts.optionsInBody === true) return [];
      return optionEls;
    },
  };

  const state = { open: opts.optionsVisible === true, value: current };

  const input = {
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    readOnly: true,
    disabled: false,
    className: "el-input__inner",
    placeholder: "請選擇",
    value: current,
    parentElement: selectWrap,
    clicked: 0,
    events: [],
    getBoundingClientRect: () => ({ width: 130, height: 32 }),
    click() {
      input.clicked++;
      // 真機：撳 input 開／閂面板
      state.open = !state.open;
      optionEls.forEach((o) => (o.visible = state.open));
    },
    dispatchEvent(ev) {
      input.events.push(ev && ev.type);
      return true;
    },
    focus() {},
    blur() {},
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const optionEls = labels.map((label) => {
    const el = {
      nodeType: 1,
      tagName: "LI",
      className: "el-select-dropdown__item",
      textContent: label,
      parentElement: null,
      visible: state.open,
      clicked: 0,
      getBoundingClientRect: () =>
        el.visible ? { width: 200, height: 30 } : { width: 0, height: 0 },
      click() {
        el.clicked++;
        // 真機：撳選項 ⇒ 欄位值變、面板閂
        state.value = label;
        input.value = label;
        state.open = false;
        optionEls.forEach((o) => (o.visible = false));
      },
      dispatchEvent: () => true,
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return el;
  });

  // 「訂單類型」誘餌 —— 佢嘅值**本身**就係「全部」
  // ⇒ 如果實作只靠「邊個欄位係全部」而唔靠 label，就會攞錯欄位（假成功）。
  const decoyInput = {
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    readOnly: true,
    disabled: false,
    className: "el-input__inner",
    placeholder: "請選擇",
    value: "全部",
    parentElement: {
      nodeType: 1,
      textContent: "訂單類型",
      parentElement: null,
      className: "",
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    },
    clicked: 0,
    getBoundingClientRect: () => ({ width: 130, height: 32 }),
    click() {
      decoyInput.clicked++;
    },
    dispatchEvent: () => true,
    focus() {},
    blur() {},
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  return {
    input,
    decoyInput,
    optionEls,
    state,
    /** 目前欄位值（真機睇法） */
    get value() {
      return state.value;
    },
  };
}

function makeDocument(opts) {
  opts = opts || {};

  const listeners = {};
  const status = opts.orderStatus ? makeOrderStatusSelect(opts.orderStatus) : null;
  const doc = {
    __queryBtn: null,
    __tabs: null,
    __status: status,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    __fire(type, ev) {
      (listeners[type] || []).forEach((fn) => fn(ev));
    },
    querySelectorAll(sel) {
      if (sel === SEL_TAB) return opts.tabs === false ? [] : doc.__tabs;
      if (sel === SEL_CLICKABLE) return opts.queryLabel === null ? [] : [doc.__queryBtn];
      if (sel === SEL_NEXTPAGE) return [];
      if (sel === "input") return opts.dateInputs || [];
      // 🔴 真正嘅「訂單狀態」欄位（見 makeOrderStatusSelect 嘅說明）
      if (sel === "input.el-input__inner") {
        return status ? [status.input, status.decoyInput] : [];
      }
      if (/el-select-dropdown__item|el-select-dropdown li|role='option'|role="option"/.test(sel)) {
        return status ? status.optionEls : [];
      }
      return []; // 其他（例如 [role=tab] 容器）
    },
  };

  doc.__queryBtn = makeEl(opts.queryLabel === undefined ? "查詢" : opts.queryLabel);
  doc.__tabs = TAB_LABELS.map(([key, label]) => {
    const el = makeEl(label, {
      matches: true, // 真的頁籤容器
      beforeClick: () => doc.__fire("click", { target: el }),
      onClick: opts.onTabClick ? () => opts.onTabClick(key) : null,
    });
    el.__key = key;
    return el;
  });

  return doc;
}

// ------------------------------------------------------------ bridge 載入器

function loadBridge(file, opts) {
  opts = opts || {};
  const posted = [];
  const sent = [];
  const doc = makeDocument(opts);
  let winMsgListener = null;
  let onMessage = null;
  let responseDone = null;
  const done = new Promise((r) => {
    responseDone = r;
  });

  const flag = file.indexOf("mfood") >= 0 ? "__mfoodGrabber" : "__aomiGrabber";

  function replyToBridge(kind, payload) {
    if (!winMsgListener) return;
    winMsgListener({
      source: windowObj,
      data: { [flag]: true, kind: kind, payload: payload, meta: {} },
    });
  }

  const windowObj = {
    location: {
      href:
        opts.hash !== undefined
          ? "https://merchant.mfoodapp.com/" + opts.hash
          : file.indexOf("mfood") >= 0
            ? "https://merchant.mfoodapp.com/#/trade/tackout"
            : "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord",
      hash: opts.hash !== undefined ? opts.hash : undefined,
      origin: "https://x.example",
    },
    document: doc,
    addEventListener(type, fn) {
      if (type === "message") winMsgListener = fn;
    },
    postMessage(msg) {
      posted.push(msg);
      if (opts.onCmd) opts.onCmd(msg, io);
    },
  };

  const io = {
    reply: replyToBridge,
    /** 模擬頁面的列表回應到達 bridge */
    list: (rows) =>
      replyToBridge("order_list", {
        resultCode: "200",
        detailMsg: {
          list: rows || [{ orderId: "TK1", storeSeqNo: "#1", goodsAmount: 100 }],
          pageNum: 1,
          pageSize: 20,
          total: 1,
        },
      }),
    /** 回讀時回「頁面上最後被點過的那個頁籤」—— 模擬頁面真的有跟著切 */
    replyWithCurrentTab(msg) {
      if (!msg || msg.cmd !== "probe_list") return;
      const last = doc.__tabs.filter((t) => t.clicked > 0).pop();
      const type = last ? last.__key : "GOING";
      replyToBridge("list_probe", {
        reqId: msg.reqId,
        req: {
          url: `${AOMI_LIST_URL}?beginDate=2026-09-22&endDate=2026-09-23&type=${type}&sign=abc`,
          method: "POST",
          at: Date.now(),
        },
      });
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: windowObj,
    document: doc,
    chrome: {
      runtime: {
        sendMessage(msg, cb) {
          sent.push(msg);
          if (typeof cb === "function") cb();
        },
        lastError: null,
        onMessage: {
          addListener(fn) {
            onMessage = fn;
          },
        },
      },
    },
    Promise,
    setTimeout,
    clearTimeout,
    // setAutoInterval 會用；唔補嘅話 GRAB_SET_INTERVAL 一測就 ReferenceError
    setInterval,
    clearInterval,
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
    // 受控元件的輸入框要靠事件才會更新 —— harness 必須真的提供這兩個，
    // 否則 dispatchInput 會靜默失敗，測試就驗不到「有沒有派發事件」。
    Event: function Event(type, o) {
      this.type = type;
      this.bubbles = !!(o && o.bubbles);
    },
    InputEvent: function InputEvent(type, o) {
      this.type = type;
      this.bubbles = !!(o && o.bubbles);
      this.data = (o && o.data) || null;
      this.inputType = (o && o.inputType) || "";
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.basename(file) });

  /** 送一個 GRAB_SYNC_RANGE 給 bridge，等它的回應 */
  function syncRange(msg) {
    if (!onMessage) throw new Error("bridge 沒有註冊 onMessage");
    onMessage(Object.assign({ type: "GRAB_SYNC_RANGE" }, msg), {}, (r) => {
      responseDone(r);
    });
    return done;
  }

  /** 送一個任意訊息入 bridge（測 GRAB_SET_INTERVAL 等用） */
  function send(msg) {
    if (!onMessage) throw new Error("bridge 沒有註冊 onMessage");
    return onMessage(Object.assign({}, msg), {}, () => {});
  }

  /** 送一個訊息並等它的（非同步）回應。 */
  function sendAsync(msg, timeoutMs) {
    if (!onMessage) throw new Error("bridge 沒有註冊 onMessage");
    return new Promise((resolve) => {
      let done2 = false;
      const finish = (v) => {
        if (!done2) {
          done2 = true;
          resolve(v);
        }
      };
      onMessage(Object.assign({}, msg), {}, finish);
      setTimeout(() => finish(undefined), timeoutMs || 3000);
    });
  }

  return { posted, sent, doc, io, syncRange, send, sendAsync };
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
  group("[1] mfood：優先直接重放列表請求（via: 'api'）");
  {
    const b = loadBridge(MFOOD_BRIDGE, {
      onCmd(msg, io) {
        if (msg && msg.cmd === "sync_range") {
          check("命令帶上 startDate", msg.startDate, "2026-09-22");
          check("命令帶上 endDate", msg.endDate, "2026-09-23");
          io.reply("list_range_result", {
            reqId: msg.reqId,
            ok: true,
            rows: 42,
            total: 45,
            applied: { startTime: 1789920000000, endTime: 1790092799999, status: "" },
          });
        }
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    check("回報成功", r && r.ok, true);
    check("🔴 走 API 路線", r && r.via, "api");
    check("帶回筆數", r && r.rows, 42);
    check("🔴 平台總數要透傳（才能發現漏抓）", r && r.total, 45);
    check("帶回實際套用的區間", r && r.applied.startTime, 1789920000000);
  }

  group("[2] mfood：API 失敗要退回 DOM，並說明原因（不可靜默）");
  {
    const b = loadBridge(MFOOD_BRIDGE, {
      onCmd(msg, io) {
        if (msg && msg.cmd === "sync_range") {
          io.reply("list_range_result", {
            reqId: msg.reqId,
            ok: false,
            status: 403,
            reason: "HTTP 403（回應不是訂單列表）",
          });
        }
      },
      // 🔴🔴 2026-09-30 補：呢組一直**冇提供日期輸入框** ⇒ `applyDateRange()` 一開頭
      //    就回 `{ok:false}` ⇒ 舊寫法直接 return，**根本冇走到「按查詢」**
      //    ⇒ 斷言 `有按到查詢按鈕` 一直靠「其實冇執行到嗰段碼」而過關（假綠）。
      //    加入真實形狀嘅日期框＋訂單狀態欄位之後，呢條路才真係被執行到。
      dateInputs: [
        Object.assign(makeInput({ className: "el-range-input", placeholder: "開始日期" }), {
          value: "",
        }),
        Object.assign(makeInput({ className: "el-range-input", placeholder: "結束日期" }), {
          value: "",
        }),
      ],
      orderStatus: { current: "已完成", optionsVisible: true },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    check("🔴 改用 DOM 路線", r && r.via, "dom");
    check("🔴 帶出 API 失敗原因", r && r.fallbackReason, "HTTP 403（回應不是訂單列表）");
    check("有按到查詢按鈕", b.doc.__queryBtn.clicked > 0, true);
    check("🔴 而且係先設好「全部」才查（見 [DOM 保底] 組）", b.doc.__status.value, "全部");
  }

  group("[3] mfood：沒有回應（逾時）也要退回 DOM");
  {
    const b = loadBridge(MFOOD_BRIDGE, { onCmd() {} });
    const p = b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    await sleep(200);
    check("有送出 sync_range 命令", b.posted.some((m) => m && m.cmd === "sync_range"), true);
    void p;
  }

  group("[4] 🔴 澳覓：4 個狀態都走到、都驗證通過，且同步期間零額外查詢");
  {
    let b = null;
    b = loadBridge(AOMI_BRIDGE, {
      onCmd(msg) {
        b.io.replyWithCurrentTab(msg);
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("回報成功", r && r.ok, true);
    check("🔴 走 DOM 路線", r && r.via, "dom");
    check("🔴 4 個狀態都跑了", r && r.types.length, 4);
    check("順序：進行中", r && r.types[0].type, "GOING");
    check("順序：已完成", r && r.types[1].type, "FINISH");
    check("順序：已取消", r && r.types[2].type, "CANCEL");
    check("順序：待退款", r && r.types[3].type, "REFUND");
    check("🔴 4 個都通過回讀驗證（regex 要容得下「訂單」後綴）", r && r.verifiedTypes, 4);
    check(
      "進行中／已完成可推送",
      r && [r.types[0].observeOnly, r.types[1].observeOnly],
      [false, false],
    );
    check(
      "🔴 已取消／待退款只記錄不推送",
      r && [r.types[2].observeOnly, r.types[3].observeOnly],
      [true, true],
    );
    check("4 個頁籤都被點到", b.doc.__tabs.filter((t) => t.clicked > 0).length, 4);
    check("每個狀態一次就驗證通過（沒重試）", r && r.types.map((t) => t.attempts), [1, 1, 1, 1]);
    // 🔴 頁籤點擊會冒泡到 document，若 autoDriving 守衛失效就會多按 4 次查詢
    check("🔴 總共只按了 4 次查詢（無補償多按）", b.doc.__queryBtn.clicked, 4);
    check(
      "同步期間沒有自動查詢回報",
      b.sent.filter((m) => m.type === "AOMI_AUTO_QUERY").length,
      0,
    );
  }

  group("[5] 🔴 已取消／待退款那一輪的列表要標成 observedOnly（bridge→background 契約）");
  {
    let b = null;
    b = loadBridge(AOMI_BRIDGE, {
      onTabClick() {
        b.io.list();
      },
      // 回讀要回正確的狀態，否則每個狀態都會被判成「沒載到」而重試，
      // 列表訊息就會變成 8 筆而不是 4 筆。
      onCmd(msg) {
        b.io.replyWithCurrentTab(msg);
      },
    });

    await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    const lists = b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED");
    check("4 輪都有列表進來", lists.length, 4);
    check("進行中的列表可推送", lists[0] && lists[0].observedOnly, false);
    check("已完成的列表可推送", lists[1] && lists[1].observedOnly, false);
    check("🔴 已取消的列表只記錄", lists[2] && lists[2].observedOnly, true);
    check("🔴 待退款的列表只記錄", lists[3] && lists[3].observedOnly, true);
  }

  group("[6] 🔴 澳覓：頁面一直沒切到該狀態 → 必須誠實標成未通過（且只重試一次）");
  {
    const b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      onCmd(msg, io) {
        if (msg && msg.cmd === "probe_list") {
          io.reply("list_probe", {
            reqId: msg.reqId,
            req: {
              url: `${AOMI_LIST_URL}?beginDate=2026-09-20&endDate=2026-09-20&type=GOING&sign=abc`,
              method: "POST",
              at: Date.now(),
            },
          });
        }
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    check("只有一輪", r && r.types.length, 1);
    check("🔴 驗證不通過", r && r.verifiedTypes, 0);
    check("🔴 重試過一次就不再試（不會無限迴圈）", r && r.types[0].attempts, 2);
    check("記錄下頁面實際用的日期（證據）", r && r.types[0].request.beginDate, "2026-09-20");
    check("步驟裡有 retry", !!(r && r.steps.some((s) => s.step === "retry")), true);
  }

  group("[7] 澳覓：頁面完全沒有回應時，不可假裝驗證通過");
  {
    const b = loadBridge(AOMI_BRIDGE, { tabs: false, onCmd() {} });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    check("🔴 驗證不通過", r && r.verifiedTypes, 0);
    check("request 為 null（沒有觀察到請求）", r && r.types[0].request, null);
  }

  group("[8] 🔴 補償：手動點狀態頁籤、頁面沒自己查 → 代按一次「查詢」");
  {
    const b = loadBridge(AOMI_BRIDGE, { onCmd() {} });
    b.send({ type: "GRAB_SET_INTERVAL", secs: 5 }); // 先「開始」：補償器只喺自動化開啟時才動
    const before = b.doc.__queryBtn.clicked;

    b.doc.__fire("click", { target: b.doc.__tabs[1] }); // 使用者點了「已完成訂單」
    await sleep(1150);

    check("🔴 有代按查詢", b.doc.__queryBtn.clicked, before + 1);
    const q = b.sent.filter((m) => m.type === "AOMI_AUTO_QUERY");
    check("有回報自動查詢", q.length, 1);
    check("原因說明是切到已完成", !!(q[0] && q[0].reason.includes("已完成")), true);
  }

  group("[9] 頁面自己已經查了 → 不要多按一次");
  {
    const b = loadBridge(AOMI_BRIDGE, { onCmd() {} });
    b.send({ type: "GRAB_SET_INTERVAL", secs: 5 }); // 先「開始」：補償器只喺自動化開啟時才動
    const before = b.doc.__queryBtn.clicked;

    b.doc.__fire("click", { target: b.doc.__tabs[1] });
    b.io.list(); // 頁面在同一個 tick 就把列表送回來
    await sleep(1150);

    check("🔴 沒有多按查詢", b.doc.__queryBtn.clicked, before);
    check("沒有自動查詢回報", b.sent.filter((m) => m.type === "AOMI_AUTO_QUERY").length, 0);
  }

  group("[10] 🔴 不是狀態頁籤的點擊 → 不理會（含表格裡的「已完成」儲存格）");
  {
    const b = loadBridge(AOMI_BRIDGE, { onCmd() {} });
    b.send({ type: "GRAB_SET_INTERVAL", secs: 5 }); // 先「開始」：補償器只喺自動化開啟時才動
    const before = b.doc.__queryBtn.clicked;

    // 一般按鈕
    b.doc.__fire("click", { target: makeEl("匯出") });
    // 🔴 訂單列表「訂單狀態」欄的儲存格，文字正好是「已完成」——
    //    它不是頁籤容器，不可以觸發代按查詢。
    b.doc.__fire("click", { target: makeEl("已完成") });
    await sleep(1150);

    check("沒有多按查詢", b.doc.__queryBtn.clicked, before);
    check("沒有自動查詢回報", b.sent.filter((m) => m.type === "AOMI_AUTO_QUERY").length, 0);
  }


  group("[10b] 🔴 按「停止」之後，補償器唔准再干預頁面（回歸）");
  {
    // 使用者回報：「按咗停止之後，grabber 好似仲喺度操控我個網頁」。
    // 根因：補償器（切狀態頁籤後代按查詢）本來冇受開始／停止管。
    const b = loadBridge(AOMI_BRIDGE, { onCmd() {} });
    b.send({ type: "GRAB_SET_INTERVAL", secs: 5 }); // 開始
    b.send({ type: "GRAB_SET_INTERVAL", secs: 0 }); // 停止
    const before = b.doc.__queryBtn.clicked;

    // 停止之後，使用者自己點狀態頁籤 —— 我哋完全唔應該插手
    b.doc.__fire("click", { target: b.doc.__tabs[1] });
    await sleep(1150);

    check("🔴 停止後點頁籤唔會代按查詢", b.doc.__queryBtn.clicked, before);
    check(
      "亦唔會有自動查詢回報",
      b.sent.filter((m) => m.type === "AOMI_AUTO_QUERY").length,
      0,
    );
  }
  group("[11] 🔴 第一次沒載到該狀態 → 重試一次後成功");
  {
    let probe = 0;
    const b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      onCmd(msg, io) {
        if (msg && msg.cmd !== "probe_list") return;
        probe++;
        const bad = probe === 1; // 第一次回上一個狀態的日期
        io.reply("list_probe", {
          reqId: msg.reqId,
          req: {
            url: `${AOMI_LIST_URL}?beginDate=${bad ? "2026-09-20" : "2026-09-22"}&endDate=${
              bad ? "2026-09-20" : "2026-09-23"
            }&type=GOING&sign=abc`,
            method: "POST",
            at: Date.now(),
          },
        });
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    check("🔴 重試後通過驗證", r && r.verifiedTypes, 1);
    check("🔴 attempts = 2", r && r.types[0].attempts, 2);
    check("步驟裡有 retry", !!(r && r.steps.some((s) => s.step === "retry")), true);
    check("按了兩次查詢", b.doc.__queryBtn.clicked, 2);
  }

  group("[12] 🔴 日期要照「輸入框現在的格式」填，不要猜 —— 帶時間就用帶時間");
  {
    const startEl = makeInput({ placeholder: "开始日期", value: "2026-09-20 00:00:00" });
    const endEl = makeInput({ placeholder: "结束日期", value: "2026-09-20 23:59:59" });

    let b = null;
    b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      dateInputs: [startEl, endEl],
      onCmd(msg) {
        b.io.replyWithCurrentTab(msg);
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 日期套用成功", r && r.dateOk, true);
    check("🔴 判斷出是帶時間的格式", r && r.dateMode, "datetime");
    check("開始填當日零點", startEl.value, "2026-09-22 00:00:00");
    check("結束填當日最後一刻", endEl.value, "2026-09-23 23:59:59");

    // 受控元件靠事件更新 —— 沒有派發事件就等於沒填
    check("🔴 有派發 input 事件", startEl.events.includes("input"), true);
    check("🔴 有派發 change 事件", startEl.events.includes("change"), true);

    const dateStep = (r.steps || []).filter((s) => s.step === "date")[0];
    check("步驟記錄了偵測到的格式", dateStep && dateStep.detected, "datetime");
    check("步驟記錄了填之前的舊值（證據）", dateStep && dateStep.before, "2026-09-20 00:00:00");
    // 🔴 填完之後的實際值 —— 元件若要還原或只留一半，這裡就是唯一的線索
    check("回報填完後開始框的值", dateStep && dateStep.afterStart, "2026-09-22 00:00:00");
    check("回報填完後結束框的值", dateStep && dateStep.afterEnd, "2026-09-23 23:59:59");
    check("兩個框都找到（不是只有一個）", dateStep && dateStep.onlyOneInput, false);
    check("有回讀驗證日期", !!(r.steps || []).some((s) => s.step === "date_verify" && s.verified), true);
  }

  group("[13] 🔴 第一種格式沒生效 → 自動換另一種再試");
  {
    const startEl = makeInput({ placeholder: "开始日期", value: "2026-09-20" });
    const endEl = makeInput({ placeholder: "结束日期", value: "2026-09-20" });

    let probe = 0;
    const b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      dateInputs: [startEl, endEl],
      onCmd(msg, io) {
        if (!msg || msg.cmd !== "probe_list") return;
        probe++;
        // 第一次（純日期）頁面沒吃，維持舊區間；第二次（帶時間）才吃
        const good = probe > 1;
        io.reply("list_probe", {
          reqId: msg.reqId,
          req: {
            url: `${AOMI_LIST_URL}?beginDate=${good ? "2026-09-22" : "2026-09-20"}&endDate=${
              good ? "2026-09-23" : "2026-09-20"
            }&type=GOING&sign=abc`,
            method: "POST",
            at: Date.now(),
          },
        });
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 換格式後套用成功", r && r.dateOk, true);
    check("第二次用帶時間的格式", r && r.dateMode, "datetime");
    check("實際填了帶時間的值", startEl.value, "2026-09-22 00:00:00");
    check(
      "有兩次 date 嘗試（純日期 → 帶時間）",
      (r.steps || []).filter((s) => s.step === "date").length,
      2,
    );
    check(
      "第一次的驗證是不通過的（有記錄下來）",
      (r.steps || []).some((s) => s.step === "date_verify" && s.verified === false),
      true,
    );
  }

  group("[14] 🔴 只找到一個日期框 → 當成「區間只填一半」，並說出原因");
  {
    const only = makeInput({ placeholder: "开始日期", value: "2026-09-20" });

    const b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      dateInputs: [only],
      onCmd(msg, io) {
        if (!msg || msg.cmd !== "probe_list") return;
        io.reply("list_probe", {
          reqId: msg.reqId,
          req: {
            url: `${AOMI_LIST_URL}?beginDate=2026-09-20&endDate=2026-09-20&type=GOING&sign=abc`,
            method: "POST",
            at: Date.now(),
          },
        });
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 日期未套用", r && r.dateOk, false);
    check(
      "🔴 原因直指「只找到一個日期框」",
      !!(r && r.dateReason.includes("只找到一個日期框")),
      true,
    );

    const step = (r.steps || []).filter((s) => s.step === "date")[0];
    check("步驟有標 onlyOneInput", step && step.onlyOneInput, true);
    check("結束日期本來就沒有值", step && step.afterEnd, null);
  }

  group("[15] 🔴 線索只在祖先容器上時，兩個日期框都要找得到");
  {
    // input 自己沒有任何日期線索（沒有 placeholder），只有包住它的容器有
    const startEl = makeInput({ placeholder: "", containerCls: "el-date-editor el-range-editor" });
    const endEl = makeInput({ placeholder: "", containerCls: "el-date-editor el-range-editor" });
    startEl.value = "2026-09-20";
    endEl.value = "2026-09-20";

    let b = null;
    b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      dateInputs: [startEl, endEl],
      onCmd(msg) {
        b.io.replyWithCurrentTab(msg);
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 兩個框都找到、日期套用成功", r && r.dateOk, true);
    check("兩個框都填了", [startEl.value, endEl.value], ["2026-09-22", "2026-09-23"]);

    const step = (r.steps || []).filter((s) => s.step === "date")[0];
    check("步驟記錄找到 2 個框", step && step.count, 2);
    check(
      "診斷欄位標明是靠容器認出來的",
      !!(step && step.fields[0] && step.fields[0].match.indexOf("container:") === 0),
      true,
    );
  }

  group("[16] 🔴 元件把我們填的值還原 → afterStart 要看得見真相");
  {
    // 模擬一個「會還原」的輸入框：寫入被忽略，值永遠是舊的
    let stored = "2026-08-24";
    const startEl = makeInput({ placeholder: "开始日期", value: "2026-08-24" });
    const endEl = makeInput({ placeholder: "结束日期", value: "2026-09-23" });
    Object.defineProperty(startEl, "value", {
      get: () => stored,
      set: () => {
        /* 元件把值還原 → 寫入無效 */
      },
      configurable: true,
    });

    const b = loadBridge(AOMI_BRIDGE, {
      tabs: false,
      dateInputs: [startEl, endEl],
      onCmd(msg, io) {
        if (!msg || msg.cmd !== "probe_list") return;
        io.reply("list_probe", {
          reqId: msg.reqId,
          req: {
            // 頁面仍用舊區間 —— 這就是「看起來填了、其實沒生效」
            url: `${AOMI_LIST_URL}?beginDate=2026-08-24&endDate=2026-09-23&type=GOING&sign=abc`,
            method: "POST",
            at: Date.now(),
          },
        });
      },
    });

    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 日期未套用", r && r.dateOk, false);

    const step = (r.steps || []).filter((s) => s.step === "date")[0];
    check("🔴 afterStart 顯示被還原的舊值", step && step.afterStart, "2026-08-24");
    check(
      "🔴 原因寫出頁面實際用的區間（可直接對症下藥）",
      !!(r && r.dateReason.includes("2026-08-24")),
      true,
    );
    check("還原後框內仍是舊值", startEl.value, "2026-08-24");
  }

  group("[財務頁] 🔴 分頁開喺財務對帳頁 → 篩選設定要 skipped（唔可以報失敗）");
  {
    // 真機 2026-09-28：mfood 分頁開喺 `#/finance/tackout-check` 時，
    // 嗰度冇「訂單狀態」篩選 ⇒ 舊寫法回 ok:false ⇒ popup 假警報。
    const fin = loadBridge(MFOOD_BRIDGE, { hash: "#/finance/tackout-check" });
    const r = await fin.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" });
    check("回 ok:true（唔算失敗）", !!(r && r.ok), true);
    check("🔴 標明 skipped", !!(r && r.skipped), true);
    check(
      "🔴 原因講明係財務頁",
      !!(r && r.reason && r.reason.indexOf("財務") >= 0),
      true,
    );

    // 對照：訂單頁＋搵唔到欄位 → 仍然要老實報失敗（唔可以靜靜當成功）
    const ord = loadBridge(MFOOD_BRIDGE, { hash: "#/trade/tackout" });
    const r2 = await ord.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" });
    check("訂單頁搵唔到欄位 → ok:false", !!(r2 && r2.ok === false), true);
    check("冇 skipped 標記", r2 && r2.skipped, undefined);
  }

  // ==========================================================================
  // 2026-09-30 使用者真機：
  //   「mfood 個邊, 我見到無選個訂單狀態為全部. … 你沒選這個, mfood 訂單不會出來.」
  //
  // 🔴🔴 呢一組係**補一個存在咗幾個月嘅測試盲點**：
  //    呢個 harness 一直令 `querySelectorAll("input.el-input__inner")` 回 []
  //    ⇒ `findOrderStatusSelect()` 永遠搵唔到 ⇒ `setOrderStatusAll()` 嘅
  //    **成功路徑從來冇被測過**（只測到「搵唔到」）。
  //    產品碼其實正確（已用獨立重現腳本驗證），但冇守衛 ＝ 下次改壞都唔會紅。
  // ==========================================================================
  group("[訂單狀態＝全部] 🔴 真機 DOM 形狀下，成功路徑必須真的切到「全部」");
  {
    // 真機：欄位顯示「已完成」、面板已開
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      orderStatus: { current: "已完成", optionsVisible: true },
    });
    const r = await b.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" }, 4000);
    const st = b.doc.__status;

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 欄位真的變成「全部」（唔可以淨係回 ok）", st.value, "全部");
    check("🔴 「全部」選項被撳過", st.optionEls[0].clicked >= 1, true);
    check("唔會撳錯「訂單類型」誘餌欄位（佢個值本身都係「全部」）", st.decoyInput.clicked, 0);
  }

  group("[訂單狀態＝全部] 🔴 面板未開（動畫未完成）都要自己開再揀");
  {
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      orderStatus: { current: "待送達", optionsVisible: false },
    });
    const r = await b.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" }, 4000);
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 欄位變成「全部」", b.doc.__status.value, "全部");
  }

  group("[訂單狀態＝全部] 已經係「全部」→ 唔應該再撳（already）");
  {
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      orderStatus: { current: "全部", optionsVisible: false },
    });
    const r = await b.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" }, 4000);
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 標記 already", !!(r && r.already), true);
    check("完全冇撳任何選項", b.doc.__status.optionEls.every((o) => o.clicked === 0), true);
  }

  // ==========================================================================
  // 🔴🔴 2026-09-30 當晚回歸：修復「popper-append-to-body 預設 true（dropdown 喺 <body>）」
  //    導致 scoped 搵唔到「全部」、停留「已完成」嘅真機 bug。
  //    下面兩組分別鎖實「dropdown 喺 body（真機預設）」同「dropdown 喺 .el-select 子樹」兩種掛載。
  // ==========================================================================
  group("[訂單狀態＝全部] 🔴 回歸：Element-UI 預設 popper-append-to-body=true（dropdown 喺 <body>）都要設到「全部」");
  {
    // optionsInBody:true ⇒ .el-select 子樹搵唔到選項，必須靠 fallback 返 document 全頁掃。
    // 舊 code（淨係 scoped、冇 fallback）呢個會 ok:false ⇒ 欄位停留「已完成」。
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      orderStatus: { current: "已完成", optionsVisible: true, optionsInBody: true },
    });
    const r = await b.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" }, 4000);
    const st = b.doc.__status;
    check("回 ok:true（舊 code 呢個會 ok:false ⇒ 停留「已完成」）", !!(r && r.ok), true);
    check("🔴 欄位真係「全部」", st.value, "全部");
    check("唔會撳錯「訂單類型」誘餌欄位", st.decoyInput.clicked, 0);
  }

  group("[訂單狀態＝全部] 🔴 回歸：popper-append-to-body=false（dropdown 在 .el-select 子樹）scoped 分支都要 work");
  {
    // optionsInBody:false ⇒ 選項在 .el-select 子樹，scoped 分支直接搵到。
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      orderStatus: { current: "已完成", optionsVisible: true, optionsInBody: false },
    });
    const r = await b.sendAsync({ type: "GRAB_SET_ORDER_STATUS_ALL" }, 4000);
    const st = b.doc.__status;
    check("回 ok:true（只靠 scoped 分支）", !!(r && r.ok), true);
    check("🔴 欄位真係「全部」", st.value, "全部");
    check("唔會撳錯「訂單類型」誘餌欄位", st.decoyInput.clicked, 0);
  }

  // ==========================================================================
  // 🔴🔴 以下係今次真機 bug 嘅**根因守衛**（唔止守 setOrderStatusAll 本身，
  //     而係守「DOM 保底路線有冇先設篩選才查詢」）。
  //
  // 舊寫法 `runSyncRangeDom()`：填日期 → 按查詢 → 翻頁。
  //   完全冇設過「訂單狀態」⇒ 頁面仍係「已完成」時：
  //     · 攞到嘅單全部係已完成單（新單永遠唔會出現）
  //     · 而 `paginateAll()` 仲會翻足 12 頁（全部同一批已完成單）
  //   ⇒ 使用者就係見到「訂單唔會出來」。
  // ==========================================================================
  group("[DOM 保底] 🔴🔴 API 重放失敗時，一定要先設「全部」才按查詢");

  /** 一個「API 重放一定失敗」嘅頁面 —— 逼 runSyncRange 跌落 DOM 保底。 */
  function forcedDomFallbackOpts(statusOpts) {
    return {
      hash: "#/trade/tackout",
      orderStatus: statusOpts || { current: "已完成", optionsVisible: true },
      // 唔回 list_range_result ⇒ syncRangeViaApi 會 20 秒逾時。
      // ⚠️ 20 秒太慢，所以下面會用一個「即刻失敗」嘅 onCmd：
      onCmd(msg, io) {
        if (msg && msg.cmd === "sync_range") {
          // 模擬「MAIN world 即刻回報重放失敗」⇒ 唔使等 20 秒
          io.reply("list_range_result", {
            reqId: msg.reqId,
            ok: false,
            reason: "測試：重放被閘道拒絕",
          });
        }
      },
    };
  }

  {
    const b = loadBridge(MFOOD_BRIDGE, forcedDomFallbackOpts({ current: "已完成", optionsVisible: true }));
    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });
    const steps = (r && r.steps) || [];
    const statusStep = steps.filter((s) => s.step === "status")[0];

    check("🔴 走咗 DOM 保底", r && r.via, "dom");
    check("🔴🔴 有「設定訂單狀態」呢一步（舊寫法完全冇）", !!statusStep, true);
    check("🔴 該步成功", !!(statusStep && statusStep.ok), true);
    check("🔴🔴 欄位最終真係「全部」", b.doc.__status.value, "全部");

    // 次序：status 一定要**先於** query（否則查詢已經用錯篩選）
    const iStatus = steps.findIndex((s) => s.step === "status");
    const iQuery = steps.findIndex((s) => s.step === "query");
    check("🔴 status 步驟排在 query 之前", iStatus >= 0 && iQuery >= 0 && iStatus < iQuery, true);
    check("有按過查詢", b.doc.__queryBtn.clicked >= 1, true);
  }

  group("[DOM 保底] 🔴 設唔到「全部」就**唔可以**查詢（唔可以攞錯單入庫）");
  {
    // 訂單頁但冇「訂單狀態」欄位（版面改咗／仲未 render 完）
    const b = loadBridge(MFOOD_BRIDGE, {
      hash: "#/trade/tackout",
      // 刻意唔提供 orderStatus ⇒ findOrderStatusSelect() 搵唔到
      onCmd(msg, io) {
        if (msg && msg.cmd === "sync_range") {
          io.reply("list_range_result", { reqId: msg.reqId, ok: false, reason: "測試：重放失敗" });
        }
      },
    });
    const r = await b.syncRange({ startDate: "2026-09-22", endDate: "2026-09-23" });

    check("🔴 回 ok:false（唔可以當成功）", !!(r && r.ok === false), true);
    check(
      "🔴 原因講明係「訂單狀態」設唔到（可對症下藥）",
      !!(r && r.reason && r.reason.indexOf("訂單狀態") >= 0),
      true,
    );
    check("🔴🔴 完全冇按過查詢（唔可以用錯篩選攞單）", b.doc.__queryBtn.clicked, 0);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
