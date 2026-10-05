/**
 * login.js 靜態守衛測試
 *
 * 來源：2026-09-29 真 Chrome 實證捉到嘅靜默 bug。
 *
 *   `chrome.runtime.sendMessage(message, options, responseCallback)`
 *   第二個參數係 **options**，唔係第二份 message。
 *   login.js 原本寫：
 *       sendMessage({type:'..._LOGIN_STATUS', href}, {status, stage, error}, cb)
 *   ⇒ status/stage/error 全部被 Chrome 當 options 吞掉，
 *     背景收到嘅得 `{type, href}`，`request.status === undefined`
 *     ⇒ 主面板永遠顯示「自動登入失敗：未知原因」。
 *     呢種「明明登入咗但話失敗」最難查 —— 所以要有一條測試鎖住。
 *
 * 執行：node test/login-report.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "login.js"), "utf8");

/**
 * 🔴 剝註釋先好掃：呢個檔嘅註釋入面有**反面教材嘅範例碼**
 *    （`sendMessage({type…}, {status…}, cb)` 嗰種錯寫法），
 *    唔剝嘅話測試會把註釋入面嘅錯碼當成真碼（實測就係咁紅咗兩條）。
 *
 * 🔴🔴 但**唔可以真係「刪走」**——要換成**同等長度嘅空白**（保留換行）：
 *    [1] 組用 `CODE` 上搵到嘅 `m.index` 去 `SRC` 度抽參數列。
 *    如果 CODE 短過 SRC（註釋被刪），索引就會錯位，
 *    抽到嘅參數列係另一段碼 ⇒ 數出「參數個數 = 1, 3」呢種假警報
 *    （實測 2026-09-30 就係咁紅咗一條，明明兩個呼叫都係 2 個參數）。
 *    ⚠️ 註釋內容換成空白之後，反面教材照樣唔會被當真碼，
 *       而索引同 SRC **完全對齊**。
 */
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}
const CODE = maskComments(SRC);

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

/** 由 `(` 起做括號配對，攞成個參數列嘅原文 */
function argsOf(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** 數參數列嘅 top-level 逗號（忽略字串／括號／大括號入面） */
function topLevelCommas(s) {
  let depth = 0;
  let commas = 0;
  let inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("([{".indexOf(c) >= 0) depth++;
    else if (")]}".indexOf(c) >= 0) depth--;
    else if (c === "," && depth === 0) commas++;
  }
  return commas;
}

group("[1] 🔴 sendMessage 第 2 個參數係 options，status 一定要合併入 message");

const calls = [];
const re = /chrome\.runtime\.sendMessage\s*\(/g;
let m;
while ((m = re.exec(CODE))) {
  // 🔴 一定要喺 **CODE（已遮蔽註釋）** 度抽參數列：
  //    ① 註釋若含逗號會被當成真參數（假警報）；
  //    ② maskComments 係等長替換 ⇒ 索引同 SRC 完全對齊，唔會抽錯段。
  // 🔴 再剝走**尾隨逗號**：`sendMessage(msg, cb,)` 係 2 個參數，
  //    但 `topLevelCommas` 會數到 2 個逗號 ⇒ 誤報「3 個參數」
  //    （實測 2026-09-30 就係咁紅咗一條）。
  const args = argsOf(CODE, m.index + m[0].length - 1);
  const clean = String(args || "").replace(/[\s,]+$/, "");
  calls.push({ args, commas: topLevelCommas(clean) });
}

console.log(`      （login.js 有 ${calls.length} 個 sendMessage 呼叫；參數個數 = ${calls.map((c) => c.commas + 1).join(", ")}）`);
check("至少有一個 sendMessage（否則測試自己寫錯）", calls.length > 0, true);
check("全部 sendMessage 參數個數 <= 2", calls.every((c) => c.commas <= 1), true);

group("[2] 🔴 reportStatus 要把 status / stage / error 合併入同一份 message");

const rsIdx = CODE.indexOf("function reportStatus");
check("有 reportStatus", rsIdx >= 0, true);
const rsBody = CODE.slice(rsIdx, CODE.indexOf("\n  }", rsIdx));
check("用 Object.assign 合併", rsBody.indexOf("Object.assign(") >= 0, true);
check("合併入 type 嗰份", /Object\.assign\(\s*\{[^}]*type:\s*prefix\s*\+\s*'_LOGIN_STATUS'/.test(rsBody), true);

group("[3] 平台識別與表單選擇器（兩平台實測一致）");

check("認 mfood host", SRC.indexOf("mfoodapp.com") >= 0 && SRC.indexOf("'MFOOD'") >= 0, true);
check("認 aomi host", SRC.indexOf("aomiapp.com") >= 0 && SRC.indexOf("'AOMI'") >= 0, true);
check("搵 input[name=username]", SRC.indexOf('input[name="username"]') >= 0, true);
check("搵 input[name=password]", SRC.indexOf('input[name="password"]') >= 0, true);
check("撳 button.el-button--primary", SRC.indexOf("button.el-button--primary") >= 0, true);

group("[4] 🔴 Element UI 受控元件：填值必須 native setter + dispatchEvent");

check("用 getOwnPropertyDescriptor 攞 setter", SRC.indexOf("getOwnPropertyDescriptor") >= 0, true);
check("call setter 而唔係直接 .value =", SRC.indexOf("setter.set.call(") >= 0, true);
check("dispatchEvent(new Event('input'", SRC.indexOf("new Event('input'") >= 0, true);

group("[5] 防護：唔可以喺登入流程入面 throw 穿（背景會 await 佢）");

check("runLogin 永遠 resolve（冇 reject）", CODE.indexOf("reject") < 0, true);
check("有 loginRunning 防重入", CODE.indexOf("loginRunning") >= 0, true);
check("有 loginNeededSent 防重複廣播", CODE.indexOf("loginNeededSent") >= 0, true);

group("[6] 🔴 導向訂單頁一定要用 gotoPage()（純 hash 導航，唔可以整頁重載）");

/**
 * 為什麼要鎖：`location.href = 目標URL` 喺 SPA（Vue hash 路由）入面，
 * 只要當前 URL 同目標有任何非 fragment 差異（登入頁實測係
 * `#/login?redirect=%2F`），就會變成**整頁重新載入**。
 * 整頁重載 ＝ SPA 由頭啟動 ＝ 再問一次 session
 * ⇒ 自動化期間表現為「不停跳返登入頁」。
 */
check("有 gotoPage 輔助函式", CODE.indexOf("function gotoPage") >= 0, true);
check("gotoPage 用 location.hash（同一份文件內導航）", /\blocation\.hash\s*=/.test(CODE), true);
check(
  "🔴 唔可以再直接 `location.href = orderPageUrl`",
  /location\.href\s*=\s*orderPageUrl/.test(CODE),
  false,
);
check(
  "🔴 三個導頁點全部行 gotoPage（登入前已登入／SPA 自己跳走／提交成功）",
  (CODE.match(/gotoPage\(orderPageUrl\)/g) || []).length,
  3,
);
check(
  "gotoPage 會比對 origin/pathname/search（唔係所有情況都硬用 hash）",
  CODE.indexOf("t.pathname === location.pathname") >= 0 &&
    CODE.indexOf("t.search === location.search") >= 0,
  true,
);
check(
  "🔴 已經喺目標 route 時唔再導（否則抹走啱啱設好嘅篩選）",
  CODE.indexOf("have === want") >= 0,
  true,
);

console.log("\n==================================================");
console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
process.exit(failed === 0 ? 0 : 1);
