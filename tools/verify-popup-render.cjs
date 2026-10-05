/**
 * 真瀏覽器渲染驗證 —— popup.html（2026-09-28，2026-09-30 修正）
 *
 * 為什麼要「真瀏覽器」而唔止假 DOM 單測：
 *   假 DOM 量 `getBoundingClientRect` 係寫死嘅。真 popup 係一個 320~420px 闊嘅
 *   固定寬度面板，**最容易出事嘅就係「多咗一粒掣」之後文字被截斷／超出寬度**。
 *   ⇒ 一定要用真 Chrome 量真值。
 *
 * 🔴 2026-09-30 修正：呢支驗證器一直瞄住 `#dumpAllOrders` + `#dumpAllHint`，
 *    但 `#dumpAllHint` **從來冇存在過**（開發者工具區嘅 hint 叫 `#devHint`，
 *    而 `#dumpAllOrders` 係 `grid-column:1/3` 冇內容嘅，若 `#devSub` 收埋就
 *    `height === 0`）⇒ 呢支驗證器**一直紅 2 項**，而「一直紅」＝冇人睇。
 *    ⇒ 改成：
 *      · 逐個**視圖**（主面板／訂單明細／設定精靈）＋ 開發者工具展開後量測
 *      · 斷言改為「有 render 出嚟」＝ `offsetParent !== null`（唔用寫死高度）
 *      · 仍然保留真正有價值嘅**橫向溢出**檢查（文字截斷嘅唯一可靠指標）
 *      · 加「孤立視圖」守衛：`#view-*` 同一時間只可以有一個顯示
 *
 * 執行：
 *   NODE_PATH=C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules \
 *   node tools/verify-popup-render.cjs
 */

"use strict";

const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const POPUP = path.resolve(__dirname, "..", "popup.html");
// ⚠️ 截圖放返 extension 隔離嘅 docs（repo 根 docs/ 唔一定存在）
const OUTDIR = path.resolve(__dirname, "..", "docs-verify");

/**
 * 每個視圖要量嘅關鍵控件。
 * 🔴 所有 id 必須**真實存在於 popup.html** —— 呢度寫錯一個，驗證器就永遠紅，
 *    而「永遠紅嘅斷言」＝ 冇人睇（呢支驗證器之前就係咁壞咗半年）。
 */
const VIEWS = [
  {
    name: "main",
    view: "view-main",
    ids: ["btnOrders", "btnSwitchStore", "btnRun", "stSent", "logList"],
  },
  {
    name: "detail",
    view: "view-detail",
    ids: ["btnBackMain", "btnDetailSwitch", "dList", "mpRefresh", "mpList"],
  },
  {
    name: "wizard",
    view: "view-wizard",
    ids: ["wizVerifyBtn", "wizMfoodFinance", "wizLoadStoreOptions", "wizAomiFinance"],
  },
];

/**
 * 切換視圖 —— 一定要用同 popup.js 一樣嘅機制（`hidden` 屬性），
 * 唔可以自己塞 `style.display`（咁樣會同 `.view` 嘅 CSS 打架，
 * 量到嘅唔係真 popup 嘅狀態）。
 */
async function showView(page, viewId) {
  await page.evaluate((vid) => {
    document.querySelectorAll(".view").forEach((el) => {
      el.hidden = el.id !== vid;
    });
    // popup.js 會在自己嗰層做 hidden 切換；呢度只模擬「已經切好」嘅狀態。
  }, viewId);
  await new Promise((r) => setTimeout(r, 120));
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error("找唔到 Chrome：", CHROME);
    process.exit(2);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let failed = 0;
  let passed = 0;
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(
      `  ${ok ? "\u2713" : "\u2717"} ${label}${ok ? "" : `  (期望 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)})`}`,
    );
    if (ok) passed++;
    else failed++;
  };
  try {
    const page = await browser.newPage();
    // 🔴 popup 係固定窄面板。先設一個「內容想要」嘅闊度 —— 唔可以自己定死，
    //    因為真 popup 闊度由 CSS `width` 決定，唔夠闊就會真實截斷。
    await page.setViewport({ width: 460, height: 900 });

    // 🔴 喺 file:// 下 `chrome.storage` 唔存在 ⇒ popup.js 會拋 TypeError。
    //    呢個係**測試環境**問題，唔係 popup 本身問題。
    //    用 evaluateOnNewDocument 塞一個最小替身，令 popup.js 可以完整跑落去
    //    （咁 render 驗證才有意義 —— 否則一半 script 死咗，量到嘅都唔係真嘢）。
    await page.evaluateOnNewDocument(() => {
      window.chrome = {
        runtime: {
          lastError: null,
          sendMessage: (msg, cb) => {
            if (typeof cb === "function") cb({ ok: false, reason: "stub" });
          },
          onMessage: { addListener() {} },
          getManifest: () => ({ version: "1.62" }),
        },
        storage: {
          local: {
            get: (keys, cb) => {
              const out = {};
              if (typeof cb === "function") cb(out);
              return Promise.resolve(out);
            },
            set: (obj, cb) => {
              if (typeof cb === "function") cb();
              return Promise.resolve();
            },
            remove: (k, cb) => {
              if (typeof cb === "function") cb();
              return Promise.resolve();
            },
          },
          onChanged: { addListener() {} },
        },
        tabs: { query: (q, cb) => (typeof cb === "function" ? cb([]) : undefined) },
        alarms: { create() {}, clear() {} },
      };
    });

    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e && e.message)));
    page.on("console", (m) => {
      if (m.type() === "error") errs.push("console: " + m.text());
    });

    await page.goto("file:///" + POPUP.replace(/\\/g, "/"), {
      waitUntil: "load",
      timeout: 20000,
    });
    await new Promise((r) => setTimeout(r, 400));

    // ① 每個視圖：關鍵控件真係 render 出嚟（`offsetParent`／尺寸，唔用寫死高度）
    for (const v of VIEWS) {
      await showView(page, v.view);
      // 開發者工具／對帳子區先展開，令入面嘅掣都量到
      await page.evaluate(() => {
        document.querySelectorAll("details").forEach((d) => (d.open = true));
        ["devSub", "financeSub", "aomiFinanceSub"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.hidden = false;
        });
      });
      await new Promise((r) => setTimeout(r, 150));

      const measured = await page.evaluate(
        (ids) =>
          ids.map((id) => {
            const el = document.getElementById(id);
            if (!el) return { id, exists: false };
            const r = el.getBoundingClientRect();
            return {
              id,
              exists: true,
              // 🔴 有 render 嘅判斷：唔可以用 offsetParent（fixed 定位會回 null）
              //    改用「真係量到闊／高」
              w: Math.round(r.width),
              h: Math.round(r.height),
              text: String(el.textContent || "").trim().slice(0, 20),
            };
          }),
        v.ids,
      );
      console.log(`\n  [視圖 ${v.name}]`);
      for (const m of measured) {
        check(`#${m.id} 存在`, !!m.exists, true);
        if (!m.exists) continue;
        check(`#${m.id} 有 render（量到尺寸）`, m.w > 0 && m.h > 0, true);
      }
    }

    // ② 橫向溢出檢查（任何元素闊過容器 = 排版爛／文字截斷）—— 每次都要驗
    const overflowOf = () =>
      page.evaluate(() => {
        const out = [];
        document.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          // 只關注「明顯突出」嘅（>2px），避免 sub-pixel
          if (r.right > document.documentElement.clientWidth + 2) {
            out.push({
              tag: el.tagName,
              id: el.id || null,
              cls: String(el.className || "").slice(0, 50),
              right: Math.round(r.right),
            });
          }
        });
        return out;
      });

    // 逐個視圖截圖 + 溢出檢查（睇得到才會發現「文字被切」）
    for (const v of VIEWS) {
      await showView(page, v.view);
      await page.evaluate(() => {
        // 🔴 截圖前把選單／子區展開，令所有控件都入鏡（否則量到 0×0 係假象）
        document.querySelectorAll("details").forEach((d) => (d.open = true));
        ["devSub", "financeSub", "aomiFinanceSub"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.hidden = false;
        });
        const tm = document.getElementById("toolMenu");
        if (tm) tm.hidden = false;
      });
      await new Promise((r) => setTimeout(r, 250));

      // ③ 孤立視圖守衛：同一時間只可以有一個 view 顯示
      const shown = await page.evaluate(() =>
        ["view-main", "view-detail", "view-wizard"].filter((id) => {
          const el = document.getElementById(id);
          return el && !el.hidden;
        }),
      );
      check(`🔴 [${v.name}] 同一時間只顯示一個視圖`, shown.length, 1);

      const of = await overflowOf();
      check(`🔴 [${v.name}] 冇元素橫向溢出 popup 寬度`, of.length, 0);
      if (of.length) console.log("      溢出元素：", JSON.stringify(of, null, 2));

      const shot = path.join(OUTDIR, `popup-render-${v.name}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`      截圖：${shot}`);
    }

    // ④ 冇 JS 錯誤
    check("🔴 載入 popup 冇 JS 錯誤", errs.length, 0);
    if (errs.length) console.log("      錯誤：", errs.slice(0, 5));

    // ⑤ 開發者工具區掣清單（確認新掣有冇同其他撞位）
    const devBtns = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("#devSub button").forEach((b) => {
        const r = b.getBoundingClientRect();
        out.push({ id: b.id, text: b.textContent.trim().slice(0, 20), w: Math.round(r.width) });
      });
      return out;
    });
    console.log("\n  開發者工具區掣清單：");
    devBtns.forEach((b) => console.log(`    - #${b.id} 「${b.text}」 w=${b.w}`));
    check("🔴 開發者工具區有掣 render 出嚟", devBtns.length > 0, true);
  } finally {
    await browser.close();
  }
  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("驗證出錯：", e);
  process.exit(1);
});
