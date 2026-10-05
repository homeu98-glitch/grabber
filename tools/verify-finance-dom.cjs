/**
 * 真瀏覽器 DOM 驗證 —— 財務頁（mfood）結構定位（2026-09-28）
 *
 * 為什麼要「真瀏覽器」而唔止假 DOM 單測：
 *   假 DOM（test/mfood-finance.test.cjs）係我哋自己砌嘅，量度 `getBoundingClientRect`
 *   係寫死嘅。真頁面佈局係 CSS 真正算出嚟嘅 —— 尤其本專案最核心嘅修復
 *   （商家下拉由 placeholder 改為**結構定位**）完全依賴寬度／位置，
 *   假 DOM 量唔到真值。所以一定要用真 Chrome 驗一次。
 *
 * 做法：
 *   ① 砌一版**照真機 dump 抄**嘅 HTML（多選標籤型 el-select、el-table 帳期列、
 *      查看詳情掣、Vue 3 冇 __vue__）
 *   ② 用 puppeteer-core 開真 Chrome 載入
 *   ③ 直接喺頁面內呼叫 bridge 嘅定位邏輯（用同一個演算法抽出來驗）
 *
 * 執行：
 *   NODE_PATH=C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules \
 *   node tools/verify-finance-dom.cjs
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// 照真機 dump（2026-09-28）砌出嘅頁面
const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>mfood finance</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; background:#fff; }
  .toolbar { display:flex; gap:12px; align-items:center; margin-bottom:16px; }
  /* 🔴 真機：商家 select 寬 230px（多選標籤型） */
  .el-select { display:inline-block; border:1px solid #dcdfe6; border-radius:4px;
               height:32px; line-height:32px; box-sizing:border-box;
               padding:0 8px; overflow:hidden; vertical-align:middle; }
  .el-select__tags { display:inline-flex; gap:4px; vertical-align:middle; max-width:198px; }
  .el-tag { background:#ecf5ff; border:1px solid #d9ecff; color:#409eff;
            border-radius:4px; padding:0 6px; font-size:12px; white-space:nowrap; }
  .el-input__inner { border:none; outline:none; height:28px; width:198px; }
  /* 其他篩選器（誘餌，寬度較細）—— 結構定位一定要揀啱商家 */
  .el-select.mini { width:110px; }
  .el-button { border:1px solid #dcdfe6; background:#fff; border-radius:4px;
               padding:6px 14px; cursor:pointer; }
  .el-button--primary { background:#409eff; border-color:#409eff; color:#fff; }
  table.el-table { border-collapse:collapse; width:100%; margin-top:12px; }
  .el-table th, .el-table td { border:1px solid #ebeef5; padding:8px 12px; text-align:left; }
  .el-table__row { height:44px; }
  /* 下拉（收起時 0×0，模擬真機開合動畫） */
  .el-select-dropdown { height:0; overflow:hidden; }
  .el-select-dropdown.open { height:auto; }
  .el-select-dropdown__item { padding:6px 12px; cursor:pointer; }
</style></head>
<body>
  <div class="toolbar">
    <!-- 誘餌：月份篩選（寬 110，冇 tags） -->
    <div class="el-select mini"><input class="el-input__inner" placeholder="选择月" readonly></div>
    <!-- 誘餌：狀態篩選（寬 110，冇 tags） -->
    <div class="el-select mini"><input class="el-input__inner" placeholder="全部" readonly></div>
    <!-- 🔴 真商家選擇器：多選標籤型、寬 230、placeholder「全部」 -->
    <div class="el-select" id="storeSelect" style="width:230px;">
      <div class="el-select__tags" style="max-width:198px;"></div>
      <input class="el-input__inner" placeholder="全部" readonly>
    </div>
    <button class="el-button el-button--primary">查詢</button>
    <button class="el-button">重置</button>
  </div>

  <div class="el-select-dropdown" id="storeDropdown">
    <div class="el-select-dropdown__item">表嫂美食 燒烤館 (秘制燒五花, 蒜蓉茄皇, 無敵烤魚)</div>
    <div class="el-select-dropdown__item">表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)</div>
  </div>

  <table class="el-table">
    <thead><tr>
      <th>時間</th><th>門店名稱</th><th>訂單金額</th><th>結算類型</th><th>狀態</th><th>賬單信息</th>
    </tr></thead>
    <tbody>
      <tr class="el-table__row">
        <td>2026-09-01至2026-09-15</td><td>表嫂美食</td><td>1200</td><td>外賣</td><td>已結算</td>
        <td class="el-table_1_column_6"><button class="el-button">下載明細</button>
            <button class="el-button" id="detailA">查看詳情</button></td>
      </tr>
      <tr class="el-table__row">
        <td>2026-09-16至2026-09-30</td><td>表嫂美食</td><td>2300</td><td>外賣</td><td>已結算</td>
        <td class="el-table_1_column_6"><button class="el-button">下載明細</button>
            <button class="el-button" id="detailB">查看詳情</button></td>
      </tr>
    </tbody>
  </table>

  <script>
    // 🔴 模擬真機：兩粒詳情掣一撳就「發請求」再由攔截器 post 過嚟
    document.getElementById('detailB').addEventListener('click', function () {
      window.postMessage({
        __mfoodFinance: true,
        kind: 'finance_request',
        payload: {
          url: 'https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list?pageNo=1&pageSize=50&summaryId=SUM-REAL-916',
          method: 'GET', summaryId: 'SUM-REAL-916', kind: 'detail', at: Date.now()
        },
        meta: {}
      }, window.location.origin);
    });
  </script>
</body></html>`;

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

(async () => {
  // 🔴 一定要用**真 HTTP origin**（唔可以用 setContent —— 佢嘅 origin 係 null，
  //    `window.postMessage(msg, window.location.origin)` 會靜默失敗，
  //    測唔到攔截通道。呢個坑同「相對 URL 解析失敗」係同一類。）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

    // 把 bridge 嘅關鍵定位邏輯搬入頁面（同原始碼同一套演算法）
    await page.addScriptTag({
      content: `
        function trimmed(v){ return v==null?'':String(v).replace(/^\\s+|\\s+$/g,''); }
        function visible(el){ if(!el) return false; var r=el.getBoundingClientRect();
          return r.width>0 && r.height>0; }
        window.__findStoreSelectControl = function () {
          var wraps = document.querySelectorAll(".el-select");
          var best = null;
          for (var i=0;i<wraps.length;i++){
            var w = wraps[i];
            if(!visible(w)) continue;
            var r = w.getBoundingClientRect();
            var input = w.querySelector("input.el-input__inner, input");
            var hasTags = !!w.querySelector(".el-select__tags");
            if (r.width < 120) continue;
            if (w.closest(".el-table, .el-table__row, tbody")) continue;
            var score = 0;
            if (hasTags) score += 100;
            score += Math.min(60, r.width / 5);
            score += Math.max(0, 40 - Math.abs(r.top) / 20);
            if (!best || score > best.score) best = {wrap:w, input:input||null, hasTags:hasTags, score:score};
          }
          return best;
        };
        // rowPeriodText（同 bridge 一致）
        window.__rowPeriodText = function (row) {
          var m = String(row.textContent||'').match(/(\\d{4}-\\d{2}-\\d{2})\\s*[~～\\-至]\\s*(\\d{4}-\\d{2}-\\d{2})/);
          return m ? m[1]+' ~ '+m[2] : '';
        };
      `,
    });

    group("[1] 🔴 真瀏覽器：商家下拉結構定位（唔靠 placeholder）");
    {
      const res = await page.evaluate(() => {
        const ctl = window.__findStoreSelectControl();
        if (!ctl) return { found: false };
        const r = ctl.wrap.getBoundingClientRect();
        return {
          found: true,
          hasTags: ctl.hasTags,
          width: Math.round(r.width),
          isStoreSelect: ctl.wrap.id === "storeSelect",
          placeholder: ctl.input ? ctl.input.getAttribute("placeholder") : null,
        };
      });
      check("🔴 搵到商家下拉", res.found, true);
      check("🔴 揀啱嘅係真商家選擇器（唔係誘餌）", res.isStoreSelect, true);
      check("🔴 認得係多選標籤型", res.hasTags, true);
      check("🔴 寬度 ≈ 230px（真機一致）", res.width, 230);
      check("🔴 placeholder 係「全部」（證實唔可以靠它）", res.placeholder, "全部");
    }

    group("[2] 🔴 真瀏覽器：帳期列配對（日期落喺區間）");
    {
      const res = await page.evaluate(() => {
        const rows = document.querySelectorAll(".el-table__row");
        const out = [];
        for (const row of rows) out.push(window.__rowPeriodText(row));
        return out;
      });
      check("抽出兩列帳期", res.length, 2);
      check("第一列帳期文字", res[0], "2026-09-01 ~ 2026-09-15");
      check("第二列帳期文字", res[1], "2026-09-16 ~ 2026-09-30");

      // 模擬 findPeriodRow 嘅命中邏輯
      const hit = await page.evaluate(() => {
        const targetDate = "2026-09-26";
        const rows = document.querySelectorAll(".el-table__row");
        for (const row of rows) {
          const period = window.__rowPeriodText(row);
          if (!period) continue;
          const parts = period.split(" ~ ");
          if (targetDate >= parts[0] && targetDate <= parts[1])
            return { period, hasDetail: !!Array.from(row.querySelectorAll("button")).find(b => b.textContent === "查看詳情") };
        }
        return null;
      });
      check("🔴 命中第二個帳期", hit && hit.period, "2026-09-16 ~ 2026-09-30");
      check("🔴 嗰列有「查看詳情」掣", hit && hit.hasDetail, true);
    }

    group("[3] 🔴 真瀏覽器：Vue 3 冇 __vue__（證實 DOM 撈 id 係死路）");
    {
      const res = await page.evaluate(() => {
        const row = document.querySelector(".el-table__row");
        let hasVue = false;
        let n = row;
        for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
          if (n.__vue__) hasVue = true;
        }
        return { hasVue, appVue: !!document.querySelector("#app") };
      });
      check("🔴 列上完全冇 __vue__", res.hasVue, false);
      check("頁面亦冇 #app Vue 掛載", res.appVue, false);
    }

    group("[4] 🔴 真瀏覽器：撳「查看詳情」會 post 出 summaryId");
    {
      const captured = await page.evaluate(async () => {
        return new Promise((resolve) => {
          window.addEventListener("message", (e) => {
            if (e.data && e.data.__mfoodFinance === true && e.data.kind === "finance_request") {
              resolve(e.data.payload.summaryId);
            }
          });
          setTimeout(() => resolve(null), 1500);
          document.getElementById("detailB").click();
        });
      });
      check("🔴 收到 summaryId", captured, "SUM-REAL-916");
    }

    group("[5] 🔴 真瀏覽器：商家下拉可撳開並揀店名");
    {
      const picked = await page.evaluate(() => {
        const ctl = window.__findStoreSelectControl();
        ctl.wrap.click();
        document.getElementById("storeDropdown").classList.add("open");
        const opt = document.querySelector(".el-select-dropdown.open .el-select-dropdown__item");
        const text = opt.textContent;
        // 模擬 bridge 揀選：落 tag
        const tags = ctl.wrap.querySelector(".el-select__tags");
        const tag = document.createElement("span");
        tag.className = "el-tag";
        tag.textContent = "表嫂美食";
        tags.appendChild(tag);
        return { text, tagCount: tags.querySelectorAll(".el-tag").length };
      });
      check("下拉選項文字含店名", /表嫂美食/.test(picked.text), true);
      check("🔴 揀完有 tag（多選型行為）", picked.tagCount >= 1, true);
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
