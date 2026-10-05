/**
 * popup.js（2026-09-29 登入前移 redesign 版）渲染測試
 *
 * 為什麼要改寫：
 *   舊版 popup 係「每平台一個 olist + 一條 banner」（`renderOrders` / `renderBanner`），
 *   redesign 之後變成三個視圖（主面板／明細／精靈），訂單渲染改由 `renderDetail()`
 *   統一畫 `.ocard`。舊測試針對嘅 DOM id 同函式名全部消失 ⇒ 直接紅。
 *
 *   🔴 但舊測試鎖住嘅**使用者痛點**一條都冇過時，全部搬過嚟繼續鎖：
 *     · [1][2][3] 每張單一定要睇到 tradeNo（只顯示 #序號會撞號）
 *     · [4]       品項同規格要顯示
 *     · [6]       狀態標籤要正確（held = 待同步，要計入待送）
 *     · [7][8]    實收：有就顯示，冇就寫「待對帳」—— 唔可以 NaN／留白
 *     · [9]       對照表認 tradeNo，唔可以認錯單
 *     · [14]      孤兒 id（popup.js 搵、popup.html 冇生）＝ render 會拋錯
 *
 * 執行：node test/popup-render.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = path.join(__dirname, "..");
const POPUP = path.join(DIR, "popup.js");
const POPUP_HTML = path.join(DIR, "popup.html");

// ------------------------------------------------------------ DOM 替身

function makeEl(tag) {
  const parent = {
    className: "",
    innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  const el = {
    tagName: tag || "div",
    innerHTML: "",
    textContent: "",
    value: "",
    title: "",
    disabled: false,
    checked: false,
    hidden: false,
    className: "",
    style: {},
    dataset: {},
    children: [],
    firstChild: null,
    parentElement: parent,
    parentNode: parent,
    nextSibling: null,
    previousSibling: null,
    offsetWidth: 10,
    offsetHeight: 10,
    scrollHeight: 10,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    cloneNode() { return makeEl(el.tagName); },
    contains() { return false; },
    insertAdjacentHTML() {},
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    remove() {},
    replaceWith() {},
    focus() {},
    blur() {},
    select() {},
    click() {},
    getBoundingClientRect() { return { width: 10, height: 10, top: 0, left: 0 }; },
  };
  return el;
}

/**
 * 喺 vm context 入面載入 popup.js。
 *
 * 🔴 重點：popup.js 頂層用 `const dash = {...}`，`const` **唔會**變成 sandbox 嘅屬性
 *    （只喺 context 嘅 lexical scope 入面）⇒ 一定要用 `runInContext` 讀寫，
 *    唔可以 `sandbox.dash`。
 */
function loadPopup(opts) {
  opts = opts || {};
  const byId = {};

  const documentObj = {
    getElementById(id) {
      if (!byId[id]) byId[id] = makeEl("div");
      return byId[id];
    },
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    activeElement: null,
    body: makeEl("body"),
  };

  const store = Object.assign({}, opts.store || {});

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: documentObj,
    window: {
      addEventListener() {}, removeEventListener() {},
      location: { href: "chrome-extension://x/popup.html" },
      setInterval() { return 0; }, clearInterval() {},
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) { if (typeof cb === "function") cb(opts.msg ? opts.msg(msg) : null); },
        getManifest() { return { version: "1.75" }; },
        getURL(p) { return "chrome-extension://x/" + p; },
      },
      storage: {
        local: {
          get(keys, cb) {
            const arr = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
            const out = {};
            arr.forEach((k) => { if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); });
            if (typeof cb === "function") cb(out);
          },
          set(obj, cb) { Object.assign(store, JSON.parse(JSON.stringify(obj || {}))); if (typeof cb === "function") cb(); },
        },
      },
      tabs: { query(q, cb) { if (typeof cb === "function") cb([]); }, create(o, cb) { if (cb) cb({ id: 1 }); }, update(i, o, cb) { if (cb) cb({ id: i }); } },
    },
    alert() {},
    confirm() { return false; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Promise, Object, Array, Number, String, Boolean, JSON, Math, Date,
    isNaN, isFinite, parseInt, parseFloat, RegExp, Set, Map,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(POPUP, "utf8"), sandbox, { filename: "popup.js" });

  /** 喺 popup.js 嘅作用域入面執行一段程式碼（可以碰到 const dash / storeLookup） */
  const run = (code) => vm.runInContext(code, sandbox);

  return {
    sandbox, document: documentObj, byId, store, run,
    el: (id) => documentObj.getElementById(id),
  };
}

/** 塞 dashboard 資料入 popup.js 嘅 `dash` */
function setDash(h, dashObj) {
  h.run("dash.mfood = " + JSON.stringify(dashObj.mfood || null) + ";");
  h.run("dash.aomi  = " + JSON.stringify(dashObj.aomi || null) + ";");
}

const mkOrders = (o) => o;

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

function has(label, haystack, needle) {
  check(label, String(haystack).indexOf(needle) >= 0, true);
}

function hasnt(label, haystack, needle) {
  check(label, String(haystack).indexOf(needle) < 0, true);
}

function group(n) { console.log(`\n${n}`); }

// ============================================================ 測試本體

const H = loadPopup({ store: { machineId: "8291f843-9def-4956-9d0b-1cfef2598306", currentIntervalSecs: 30 } });

// ---- [1] 🔴 mfood：每一張單都要顯示訂單號（tradeNo）
group("[1] 🔴 mfood：每一張單都要顯示訂單號（tradeNo）—— 只顯示 #序號會撞號");

setDash(H, {
  mfood: {
    hasCreds: true,
    orders: {
      A: { tradeNo: "CRD202609250937046870290", seq: "#1", amount: 128.5, state: "sent", at: "2026-09-25 10:00:00", items: [{ name: "乾炒牛河", quantity: 1, unitPrice: 60 }] },
    },
  },
});
H.run("renderDetail()");
let html = H.el("dList").innerHTML;
has("mfood 顯示 tradeNo", html, "CRD202609250937046870290");
has("訂單編號仍喺度", html, "#1");

// ---- [2] 澳覓：tradeNo 就係平台單號 TK…，一樣要顯示
group("[2] 澳覓：tradeNo 係 TK… 平台單號，一樣要顯示");

setDash(H, {
  aomi: {
    hasCreds: true,
    orders: {
      B: { tradeNo: "TK0011526091200001", seq: "#7", amount: 88, state: "pending", at: "2026-09-25 11:00:00", items: [{ name: "凍檸茶", quantity: 2, unitPrice: 18 }] },
    },
  },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
has("澳覓顯示 TK 單號", html, "TK0011526091200001");
has("澳覓仍顯示訂單編號", html, "#7");

// ---- [3] 不可出現 undefined / NaN
group("[3] 渲染結果不可出現 undefined / NaN / [object Object]");

setDash(H, {
  mfood: { hasCreds: true, orders: { A: { tradeNo: "CRD1", amount: 10, state: "sent", items: [] } } },
  aomi: { hasCreds: true, orders: { B: { tradeNo: "TK2", amount: 20, state: "held", items: [] } } },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
hasnt("冇 undefined", html, "undefined");
hasnt("冇 NaN", html, "NaN");
hasnt("冇 [object Object]", html, "[object Object]");

// ---- [4] 品項與規格
group("[4] 品項與規格仍要顯示（回歸）");

setDash(H, {
  mfood: {
    hasCreds: true,
    orders: { A: { tradeNo: "CRD3", amount: 50, state: "sent", items: [{ name: "奶茶", specs: ["大杯", "少冰"], quantity: 2, unitPrice: 20 }] } },
  },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
has("品項名", html, "奶茶");
has("規格要顯示", html, "大杯/少冰");
has("數量", html, "×2");

// ---- [5] 空清單
group("[5] 空清單要顯示空狀態");

setDash(H, { mfood: { hasCreds: true, orders: {} }, aomi: { hasCreds: true, orders: {} } });
H.run("renderDetail()");
html = H.el("dList").innerHTML;
has("空狀態提示", html, "尚未擷取到訂單");
check("計數顯示 —", H.el("dCount").textContent, "—");

// ---- [6] 狀態標籤
group("[6] 狀態標籤要正確（held = 待同步，要計入待送）");

setDash(H, {
  mfood: { hasCreds: true, orders: { A: { tradeNo: "C1", amount: 1, state: "held", items: [] } } },
  aomi: { hasCreds: true, orders: { B: { tradeNo: "T1", amount: 1, state: "sent", items: [] } } },
});
H.run("renderDetail()");
H.run("renderStats()");
html = H.el("dList").innerHTML;
has("held → 待同步", html, "待同步");
check("pending 計數含 held", H.el("stPend").textContent, 1);
check("sent 計數", H.el("stSent").textContent, 1);

// ---- [7][8] 實收
group("[7] 🔴 有對帳資料要顯示「實收」，且唔可以係 NaN");

setDash(H, {
  mfood: {
    hasCreds: true,
    orders: { A: { tradeNo: "CRD9", amount: 100, state: "sent", items: [] } },
    settleMap: { CRD9: { receive: 88.4 } },
  },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
has("顯示實收", html, "實收");
has("實收金額", html, "88.40");
has("營業額", html, "100.00");

group("[8] 🔴 未對帳要寫「待對帳」，唔可以留白或出 NaN");

setDash(H, {
  mfood: { hasCreds: true, orders: { A: { tradeNo: "CRD8", amount: 100, state: "sent", items: [] } }, settleMap: {} },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
has("寫「待對帳」", html, "待對帳");
hasnt("冇 NaN", html, "NaN");

// ---- [9] 對照表認 tradeNo
group("[9] 🔴 對照表要認 tradeNo，唔可以認錯單");

setDash(H, {
  mfood: {
    hasCreds: true,
    orders: {
      A: { tradeNo: "CRDA", amount: 100, state: "sent", items: [] },
      B: { tradeNo: "CRDB", amount: 200, state: "sent", items: [] },
    },
    settleMap: { CRDB: { receive: 150 } },
  },
});
H.run("renderDetail()");
html = H.el("dList").innerHTML;
// CRDA 冇對照 → 應顯示待對帳；CRDB 有 → 150.00
const cardA = html.slice(html.indexOf("CRDA"), html.indexOf("CRDB"));
const cardB = html.slice(html.indexOf("CRDB"));
has("CRDA（冇對照）→ 待對帳", cardA, "待對帳");
has("CRDB（有對照）→ 150.00", cardB, "150.00");

// ---- [10] 門店列：店名 + Store ID
group("[10] 🔴 門店列要顯示「店名」+「Store ID」兩行（2026-09-29 新增）");

H.run("storeLookup = { id: '8291f843-9def-4956-9d0b-1cfef2598306', at: Date.now(), ok: true, name: '表嫂美食（黑沙環店）' };");
H.run("globalCache.storeId = '8291f843-9def-4956-9d0b-1cfef2598306';");
H.run("renderStoreBars()");
check("店名", H.el("storeNameTop").textContent, "表嫂美食（黑沙環店）");
check("Store ID", H.el("storeIdTop").textContent, "8291f843-9def-4956-9d0b-1cfef2598306");
check("連線狀態", H.el("storeConn").className, "conn ok");
has("連線文字", H.el("storeConn").innerHTML, "已連線");

group("[11] 未驗證 → 「未驗證門店」但唔可以報錯");

H.run("storeLookup = { id: '8291f843-9def-4956-9d0b-1cfef2598306', at: Date.now(), ok: false, name: null };");
H.run("renderStoreBars()");
check("未驗證文字", H.el("storeNameTop").textContent, "未驗證門店");
check("未驗證 class", H.el("storeConn").className, "conn bad");

// ---- [12] 未啟用平台 → dim 卡
group("[12] 🔴 平台未啟用（商家冇呢個平台）→ 降格灰卡，唔報錯");

setDash(H, { mfood: { hasCreds: false }, aomi: { hasCreds: true, orders: {} } });
H.run("renderCards()");
html = H.el("cards").innerHTML;
has("灰卡 class", html, "pcard dim");
has("顯示未啟用", html, "未啟用");
has("有「設定帳號」掣", html, "設定帳號");
hasnt("唔可以有 undefined", html, "undefined");

// ---- [13] 日誌雙平台分流
group("[13] 日誌要雙平台分流（每條有 [mfood] / [澳覓] 前綴）");

setDash(H, {
  mfood: { hasCreds: true, log: [{ at: "2026-09-29T10:00:00Z", level: "push_ok", summary: "推送成功 1 筆" }], orders: {} },
  aomi: { hasCreds: true, log: [{ at: "2026-09-29T10:01:00Z", level: "error", summary: "送出失敗" }], orders: {} },
});
H.run("renderLogs()");
html = H.el("logList").innerHTML;
has("mfood 前綴", html, "[mfood]");
has("澳覓前綴", html, "[澳覓]");
check("筆數", H.el("logCount").textContent, "共 2 筆");

// ---- [14] 孤兒 id 靜態檢查（正向 + 🔴 反向）
group("[14] 🔴 popup.js 搵嘅每個 id，popup.html 一定要有（孤兒 id = render 會拋錯）");

const htmlSrc = fs.readFileSync(POPUP_HTML, "utf8");
const jsSrc = fs.readFileSync(POPUP, "utf8");

function collectIds(src) {
  const set = new Set();
  const re = /\sid="([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}
const declared = collectIds(htmlSrc + jsSrc);

const used = new Set();
[/\$\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g].forEach((re) => {
  let m;
  while ((m = re.exec(jsSrc))) used.add(m[1]);
});
const orphans = [...used].filter((id) => !declared.has(id));
check("冇孤兒 id（正向）", orphans, []);

// 🔴🔴 2026-09-30 使用者真機回報：「沒方法登出，我也設不了account」
//   根因：`btnSwitchStore` / `btnDetailSwitch` 兩粒「切換」掣喺 HTML 有，
//   但 popup.js 從來冇 `$()` 過佢哋 ⇒ 撳落去完全冇反應。
//   上次只查「正向」（js 攞嘅 id 有冇喺 HTML）⇒ 兩粒掣漏網。
//   ⇒ 今次補反向：**可撳嘅 HTML 元素一定要被 js 碰過**。
const clickables = [];
const reClickable = /<(button|input|select|textarea)[^>]*\sid="([^"]+)"/g;
let mc;
while ((mc = reClickable.exec(htmlSrc))) {
  const tag = mc[1];
  const id = mc[2];
  // checkbox 由 [data-push] 委派 / input 由 label 包住，唔需要獨立接線
  const near = htmlSrc.slice(Math.max(0, mc.index - 260), mc.index + 260);
  if (tag === "input" && /type="(checkbox|radio)"/.test(near)) continue;
  clickables.push(id);
}

// 動態拼接嘅 id：$(`wiz${cap}User`) ⇒ 產生前綴 "wiz" / "wbody" / "wcard" 等
const dynPrefixes = [];
let md;
const reDyn = /\$\(`([A-Za-z]+)\$\{/g;
while ((md = reDyn.exec(jsSrc))) dynPrefixes.push(md[1]);

const deadControls = clickables.filter((id) => {
  if (used.has(id)) return false;
  // 係咪由某個動態前綴產生？例如 id 以 "wiz" 開頭而 js 有 $(`wiz${...}`)
  return !dynPrefixes.some((p) => id.startsWith(p));
});
console.log(
  `      （HTML 有 ${clickables.length} 個可撳元素；動態前綴 ${[...new Set(dynPrefixes)].join("/")}；` +
    `js 完全冇碰過嘅：${deadControls.length}）`,
);
check("🔴 冇「撳咗冇反應」嘅 HTML 控件（反向）", deadControls, []);

// 🔴🔴 2026-09-30 新一類（比孤兒 id 更隱蔽）：**視圖有、入口冇**。
//   實案：`#view-detail` 連同 `renderDetail()` 全套都實作好，
//   但 popup.html **冇任何掣**開得到佢、popup.js 亦冇任何 `showView('detail')`
//   ⇒ 使用者真機問「我怎樣看到訂單明細?」。
//   孤兒 id（js 搵唔到 HTML）／死控件（HTML 冇 js 碰）**兩者都捉唔到呢種**，
//   因為視圖元素本身存在、js 亦有 `$('view-detail')`（喺 showView 動態組合）。
//   ⇒ 唯一可靠檢查：每個 `view-<x>` 都要有**靜態** `showView('<x>')` 入口
//     （`showView(name)` 遍歷組合嘅寫法唔算 —— 嗰個正正係掩蓋問題嘅原因）。
const views = [];
const reView = /<div class="view" id="view-([a-z]+)"/g;
let mv;
while ((mv = reView.exec(htmlSrc))) views.push(mv[1]);
const unreachableViews = views.filter(
  (v) => v !== "main" && !new RegExp("showView\\((['\"])" + v + "\\1\\)").test(jsSrc),
);
console.log(
  `      （HTML 有 ${views.length} 個視圖：${views.join("/")}；` +
    `冇靜態入口嘅：${unreachableViews.length}）`,
);
check("🔴🔴 冇「視圖整好但入唔到去」嘅孤島視圖", unreachableViews, []);

// 🔴 函式定義檢查：popup.js 叫嘅 function 一定要有定義
//    實案：`openWizard()` 被 wireCards / wireDetail 叫，但從來冇定義 ⇒ ReferenceError
const defined = new Set();
[/function\s+([A-Za-z_$][\w$]*)\s*\(/g, /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g].forEach((re) => {
  let m;
  while ((m = re.exec(jsSrc))) defined.add(m[1]);
});
// 瀏覽器 / 標準 API 同關鍵字，唔算「自己嘅 function」
const builtin = new Set([
  "alert", "confirm", "prompt", "parseInt", "parseFloat", "isFinite", "isNaN",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch",
  "String", "Number", "Boolean", "Array", "Object", "JSON", "parse",
  "Promise", "Date", "Math", "RegExp", "Set", "Map", "Blob", "URL",
  "resolve", "reject", "if", "for", "while", "switch", "catch", "return", "typeof",
  "function", "var", "let", "const", "new", "delete", "void", "in", "of", "do", "else",
  // 🔴 物件方法都好易誤中：`chrome.storage.local.remove(...)` 嘅 `remove`
  //    （我個 regex 用 `[^.\w$]` 做前綴，但 `.` 就係嗰個前綴之前嘅字元 ⇒ 攔唔住）
  "remove", "then", "catch", "map", "filter", "forEach", "join", "slice", "replace",
  "includes", "indexOf", "push", "pop", "sort", "keys", "values", "entries",
  "get", "set", "has", "add", "send", "test", "exec", "match", "split", "trim",
  "toFixed", "toISOString", "getTime", "parse", "stringify", "assign",
]);
const called = new Set();
const reCall = /(?:^|[^.\w$])([a-z_$][\w$]*)\s*\(/g;
let mr;
while ((mr = reCall.exec(jsSrc))) called.add(mr[1]);
const undefinedCalls = [...called].filter((fn) => !defined.has(fn) && !builtin.has(fn));
console.log(`      （檢查 ${called.size} 個被叫嘅名字；冇定義嘅：${undefinedCalls.length}）`);
check("🔴 冇「叫咗但冇定義」嘅函式", undefinedCalls, []);

// ---- [15] 總控
group("[15] 總控掣：冇平台 → 「未設定平台」；有 → 運行中／已停止");

setDash(H, { mfood: { hasCreds: false }, aomi: { hasCreds: false } });
H.run("renderRunCtl()");
check("未設定平台", H.el("runState").innerHTML.indexOf("未設定平台") >= 0, true);
check("掣顯示開始", H.el("btnRun").textContent, "開始");

setDash(H, {
  mfood: { hasCreds: true, settings: { autoRefresh: true }, orders: {} },
  aomi: { hasCreds: true, settings: { autoRefresh: true }, orders: {} },
});
H.run("renderRunCtl()");
has("全部運行中", H.el("runState").innerHTML, "全部運行中");
check("掣顯示暫停", H.el("btnRun").textContent, "暫停");
has("提示含間隔秒數", H.el("runHint").textContent, "30 秒");

// ============================================================ 總結

console.log("\n==================================================");
console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
process.exit(failed === 0 ? 0 : 1);
