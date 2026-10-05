/**
 * aomi-finance-bridge.js 測試（澳覓 財務／對帳 抓取）
 *
 * 為什麼需要這支測試（同 mfood-finance 對照）：
 *   澳覓對帳係「mfood 對帳嘅原樣複製」，但**三個地方同 mfood 唔一樣**，
 *   每一處都會靜默出錯：
 *
 *     · ① 🔴 金額單位係**分（cents）** —— `costAmount: 11542` 係 MOP 115.42。
 *          唔 ÷100 ＝ 金額放大 100 倍（報表爆表）。
 *          （mfood 直接用「元」，所以 mfood 嘅「原樣保留」斷言喺呢度係錯嘅。）
 *
 *     · ② 🔴 三支財務 API（hadSettlement / unSettlement / order/list）
 *          回應形狀**完全一樣**（`detailMsg.list`）
 *          ⇒ 一定要靠 **URL** 分類，唔可以靠 body 形狀。
 *          （mfood 三支形狀唔同，可以靠形狀分 —— 呢個係兩者最大分別。）
 *
 *     · ③ 🔴 `estSettleAmt`（應結算金額）係**假數**（平台自認冇扣活動扣款）
 *          ⇒ 只認 `costAmount`，**刻意唔做 fallback**。
 *          寧願回 null（＝「待對帳」）都唔可以回一個偏多嘅假數
 *          （「有值但錯」係最難察覺嘅失敗模式）。
 *
 *   另外仲要鎖住（同 mfood 一致嘅紀律）：
 *     · 每頁筆數一定要**代撳到最大**（Q4：「要, 不然後拿不了全部」）
 *     · 🔴 **必須翻頁**（`total` 大過一頁就一定要翻到底）—— 漏翻頁 ＝ 實收靜默偏少
 *     · 跨頁**累積**（唔可以新覆蓋舊）；換帳期（`accountId` 唔同）要清空
 *     · 有 `startDate` 就**行全部**帳期（Q5：「只要是在商家 set 的日期內, 你都要去拿到」）
 *     · 全程唔可以 F5
 *
 * 執行：node test/aomi-finance.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BRIDGE = path.join(__dirname, "..", "aomi-finance-bridge.js");

/**
 * 🔴🔴 2026-09-29 真機修正：原本係 `"#/settle/merchant"` —— **錯嘅假設**。
 *
 * 澳覓前端 SPA 路由**完全冇 `settle` 字**（`settle` 只喺 API 路徑
 * `…/settleService/hadSettlement`）。實機路由係：
 *   · 帳期列表 `#/qrAccountmanage/takeoutAccountManage/takeoutAccount`
 *   · 明細    `#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=…`
 *
 * 舊嘅假 URL 令「非財務頁守衛」測試**假綠**（因為假 URL 自己帶 `settle`），
 * 而真機永遠判 false ⇒「對帳失敗：未開啟澳覓財務對帳頁」。
 * ⇒ 一定要用**真機 URL** 做預設，先守得住呢個 bug。
 */
const FINANCE_HASH = "#/qrAccountmanage/takeoutAccountManage/takeoutAccount";

// ------------------------------------------------------------ DOM 替身

function classListOf(cls) {
  const set = new Set(String(cls || "").split(/\s+/).filter(Boolean));
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
  };
}

function makeEl(tag, opts) {
  opts = opts || {};
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    // 🔴 `textContent` 要係**聚合值**（真實 DOM：父節點包含子節點文字）。
    //    寫死一個字串 ⇒ `rowPeriodText(row)` 喺 `<tr>` 上讀唔到 `<td>` 嘅帳期
    //    ⇒ `listPeriodRows()` 永遠回空 ⇒ 測試靜默走「帳期列表係空」分支（假綠）。
    selfText: opts.text || "",
    get textContent() {
      let s = el.selfText;
      for (const c of el.children || []) s += c.textContent;
      return s;
    },
    value: opts.value === undefined ? "" : opts.value,
    className: opts.cls || "",
    type: opts.type || "",
    disabled: !!opts.disabled,
    children: [],
    parentElement: null,
    _attrs: Object.assign({}, opts.attrs),
    _w: opts.w === undefined ? 40 : opts.w,
    _h: opts.h === undefined ? 20 : opts.h,
    clicked: 0,
    getAttribute(k) {
      return k in el._attrs ? el._attrs[k] : null;
    },
    setAttribute(k, v) {
      el._attrs[k] = v;
    },
    getBoundingClientRect: () => ({ width: el._w, height: el._h }),
    click() {
      el.clicked++;
      if (typeof opts.onClick === "function") opts.onClick(el);
    },
    closest(sel) {
      let n = el;
      while (n) {
        if (_matches(n, sel)) return n;
        n = n.parentElement;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      (function walk(node) {
        for (const c of node.children || []) {
          if (_matches(c, sel)) out.push(c);
          walk(c);
        }
      })(el);
      return out;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
    matches(sel) {
      return _matches(el, sel);
    },
  };
  el.classList = classListOf(opts.cls);
  return el;
}

/** 純字串比對（支援 tag、.class、#id、[attr]，忽略後代選擇器嘅父層部分）。 */
function _matches(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  // 🔴 選擇器可能係 `tbody tr` 呢種後代組合 —— 假 DOM 冇完整 CSS 引擎，
  //    所以只比對**最後一段**（真正嘅目標 tag）。
  return String(sel)
    .split(",")
    .some((part) => {
      const segs = part.trim().split(/\s+/).filter(Boolean);
      const last = segs[segs.length - 1];
      if (!last) return false;
      return last
        .split(/(?=[.#\[])/)
        .every((tok) => {
          if (!tok) return false;
          // 🔴 `*`（萬用選擇器）—— bridge 嘅「帳期文字反查」用咗
          //    `document.querySelectorAll("*")` 掃全頁。假 DOM 唔支援就會
          //    永遠回空 ⇒ 反查路徑靜默失效（假綠）。
          if (tok === "*") return true;
          if (tok[0] === ".") return el.classList.contains(tok.slice(1));
          if (tok[0] === "#") return el._attrs.id === tok.slice(1);
          if (tok[0] === "[") {
            const m = tok.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
            if (!m) return false;
            return m[2] === undefined
              ? m[1] in el._attrs
              : String(el._attrs[m[1]]) === m[2];
          }
          return el.tagName === tok.toUpperCase();
        });
    });
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

/**
 * 砌出一個貼近真實澳覓財務頁嘅 DOM。
 *
 * 照 2026-09-29 使用者提供嘅真機 DOM：
 *   · 帳期列係 `<tr>`，每列有帳期文字（`YYYY-MM-DD ~ YYYY-MM-DD`）
 *   · 「查看」係 `<button class="el-button el-button--default el-button--medium">
 *        <span>查看</span></button>`
 *   · 明細頁分頁器：`.el-pagination__sizes > .el-select`
 *       input 值 = `N項/頁`，選項 = 10/20/30/40/50 項/頁
 *       ＋ `.el-pagination .btn-next`
 *   · 冇 `__vue__`（Vue 3）⇒ 帳期 id 只可以靠 URL（`accountId`）
 */
function buildPage(opts) {
  opts = opts || {};
  const root = makeEl("body", { w: 1280, h: 900 });

  // ── 帳期列表 ──
  //
  // 🔴🔴 2026-09-29 真機實錄：澳覓對帳頁**唔係** Element-UI 表格 —— 係自訂 div
  //    列表（分組「未出帳單」／「已出帳單」，帳期文字用「至」分隔）。
  //    `listPeriodRows()` 嘅 class 選擇器路徑對 div 完全失效，必須靠
  //    「帳期文字反查」先抓到呢啲列。
  //
  //    ⇒ `buildPage()` 支援 `opts.layout === "div"` 模擬呢個真機結構，
  //      令「文字反查」路徑有得驗（唔係假綠）。
  const useDiv = opts.layout === "div";
  const useDetail = !!opts.detail;
  let rowEls;

  if (!useDetail && useDiv) {
    const periods = opts.periods || ["2026-09-16 ~ 2026-09-30"];
    const sections =
      opts.divSections ||
      [{ title: "未出帳單", indexes: periods.map((_, i) => i) }];
    const infoEls = [];
    sections.forEach((sec) => {
      const section = append(
        root,
        makeEl("div", { cls: "bill-section", w: 1280, h: 240 }),
      );
      append(
        section,
        makeEl("div", {
          cls: "bill-section__title",
          text: sec.title,
          w: 200,
          h: 30,
        }),
      );
      sec.indexes.forEach((idx) => {
        const p = periods[idx];
        const item = append(
          section,
          makeEl("div", { cls: "bill-item", w: 1280, h: 60 }),
        );
        // 左欄：每日明細（**唔含帳期區間**，避免 `countPeriods` 誤判成多期）
        append(
          item,
          makeEl("div", {
            cls: "bill-item__main",
            text: "訂單明細 " + (idx + 1),
            w: 600,
            h: 60,
          }),
        );
        // 右欄：帳期資訊（呢個就係 `rowEls` 指向嘅元素）
        const info = append(
          item,
          makeEl("div", { cls: "bill-item__info", w: 600, h: 60 }),
        );
        // 🔴 帳期文字用「至」（仿真機）；`rowPeriodText` 兩種都識讀
        const periodText = String(p).replace(/\s*~\s*/g, "至");
        info.selfText = periodText + "  $ 870.94";
        append(
          info,
          makeEl("button", {
            cls: "el-button el-button--default",
            text: "查看",
            w: 80,
            h: 30,
            onClick: () => {
              if (typeof opts.onDetail === "function") opts.onDetail(idx, p);
            },
          }),
        );
        infoEls.push(info);
      });
    });
    rowEls = infoEls;
  } else if (!useDetail) {
    // ── 帳期表格（Element-UI，舊假設）──
    const table = append(root, makeEl("table", { cls: "el-table" }));
    const tbody = append(table, makeEl("tbody", {}));
    const periods = opts.periods || ["2026-09-16 ~ 2026-09-30"];
    rowEls = periods.map((p, idx) => {
      const tr = append(tbody, makeEl("tr", { cls: "el-table__row" }));
      append(tr, makeEl("td", { text: p, w: 200 }));
      const actionTd = append(tr, makeEl("td", { cls: "el-table_1_column_6", w: 120 }));
      append(
        actionTd,
        makeEl("button", {
          cls: "el-button el-button--default el-button--medium",
          // 🔴 真機係 `<button><span>查看</span></button>` —— 「查看」二字喺 span 內。
          //    `findByText({root:row, maxLen:6})` 要命中呢個 span（或 button）。
          text: "查看",
          w: 80,
          onClick: () => {
            if (typeof opts.onDetail === "function") opts.onDetail(idx, p);
          },
        }),
      );
      return tr;
    });
  }
  if (useDetail) rowEls = [];

  /**
   * 🔴 2026-09-29 真機：使用者會「睇緊某期明細」就撳立即對帳
   *    （URL ＝ `…/takeoutAccountManage/takeoutDetail?accountId=…`）。
   *
   * `listPeriodRows()` 靠 `visible()`（寬高 > 0）過濾 ⇒ 把列 `_w/_h` 設 0
   * 就等於「企喺明細頁，列表唔喺畫面」。
   */
  const startOnDetail = !!opts.startOnDetail;
  if (startOnDetail) {
    rowEls.forEach((tr) => {
      tr._w = 0;
      tr._h = 0;
    });
  }

  // ── 明細頁分頁器（每頁筆數 ＋ 下一頁 ＋ 返回）──
  let dialog = null;
  let sizeInput = null;
  let sizeOptions = [];
  let nextBtn = null;
  let backBtn = null;
  let detailQueryBtn = null;

  if (opts.pageSizeSelect) {
    dialog = append(root, makeEl("div", { cls: "el-dialog", w: 900, h: 600 }));
    // 🔴 真機彈窗一定有大標題（「帳單明細」之類），令 `dialog` 嘅**聚合 textContent**
    //    遠遠長過 `findByText` 嘅 `maxLen`（6）⇒ 唔會揀中容器本體。
    //    ⚠️ 假 DOM 若冇呢行，`dialog.textContent` 啱啱好就係 "返回"（連長度都一樣），
    //       `findByText` 會揀中個容器（長度相等唔會替換）⇒ 撳空白 ⇒ 測試假紅。
    append(dialog, makeEl("div", { cls: "el-dialog__title", text: "帳單明細", w: 200, h: 30 }));
    const pagination = append(dialog, makeEl("div", { cls: "el-pagination", w: 860, h: 40 }));
    const sizes = append(pagination, makeEl("div", { cls: "el-pagination__sizes", w: 110, h: 32 }));
    const wrap = append(sizes, makeEl("div", { cls: "el-select", w: 110, h: 32 }));
    sizeInput = append(
      wrap,
      makeEl("input", {
        cls: "el-input__inner",
        value: (opts.pageSizeSelect.current || 20) + "項/頁",
        w: 100,
        h: 30,
      }),
    );
    // 下拉選項放喺 root（Element-UI 會 teleport 去 body）
    const pgDropdown = append(root, makeEl("div", { cls: "el-select-dropdown" }));
    sizeOptions = (opts.pageSizeSelect.options || [10, 20, 30, 40, 50]).map((n) =>
      append(
        pgDropdown,
        makeEl("li", {
          cls: "el-select-dropdown__item",
          text: n + "項/頁",
          w: 100,
          h: 30,
          onClick: () => {
            // 模擬真後台：撳完選項 → input 值變 → 平台用新 pageSize 再發請求
            sizeInput.value = n + "項/頁";
            if (typeof opts.onPageSizeChange === "function") opts.onPageSizeChange(n);
          },
        }),
      ),
    );
    nextBtn = append(
      pagination,
      makeEl("button", {
        cls: "el-pagination__next btn-next",
        text: "",
        w: 32,
        h: 32,
        onClick: () => {
          if (typeof opts.onNextPage === "function") opts.onNextPage();
        },
      }),
    );
    // 澳覓明細頁有「返回」掣（唔一定用 history.back）
    backBtn = append(
      dialog,
      makeEl("button", {
        cls: "el-button el-button--text",
        text: "返回",
        w: 60,
        h: 30,
        onClick: () => {
          if (typeof opts.onBack === "function") opts.onBack();
        },
      }),
    );
  }

  if (useDetail && dialog) {
    // 明細頁：彈窗一開始就顯示（我哋企喺明細頁，唔係列表）
    dialog._w = 900;
    dialog._h = 600;
    // 帳期區間文字（令 `detailPagePeriodText` 搵到 ⇒ period key 同列表流程一致）
    if (!opts.noDetailPeriod) {
      append(
        dialog,
        makeEl("div", {
          cls: "detail-period",
          text: opts.detailPeriod || "2026-09-16至2026-09-30",
          w: 300,
          h: 30,
        }),
      );
    }
    // 訂單號輸入框（旁邊就係「查詢」掣）
    append(
      dialog,
      makeEl("input", {
        cls: "detail-order-input",
        value: opts.detailOrderInput || "",
        w: 160,
        h: 30,
      }),
    );
    // 「查詢」掣（撳佢 ＝ 平台重發明細）
    detailQueryBtn = append(
      dialog,
      makeEl("button", {
        cls: "el-button detail-query",
        text: "查詢",
        w: 60,
        h: 30,
        onClick: () => {
          if (!opts.silentQuery && typeof opts.onQuery === "function") opts.onQuery();
        },
      }),
    );
    // 「重置」掣（模擬真機：撳咗清空輸入框）
    append(
      dialog,
      makeEl("button", {
        cls: "el-button detail-reset",
        text: "重置",
        w: 60,
        h: 30,
        onClick: () => {},
      }),
    );
  }

  return {
    root,
    rowEls,
    sizeInput,
    sizeOptions,
    nextBtn,
    backBtn,
    dialog,
    detailQueryBtn,
    /** 模擬「撳查看 ⇒ 明細開喺同一版但彈窗顯示」（列表被明細頁蓋住）。 */
    openDialog() {
      if (dialog) {
        dialog._w = 900;
        dialog._h = 600;
      }
      // 🔴 真機明細頁係**換 route**（列表唔喺畫面）⇒ 列要一齊收埋，
      //    否則 `listPeriodRows()` 仲見到列，就測唔到「啟動時喺明細頁」。
      rowEls.forEach((tr) => {
        tr._w = 0;
        tr._h = 0;
      });
    },
    /** 模擬「返回列表 ⇒ 彈窗關閉，帳期列重新可見」。 */
    closeDialog() {
      if (dialog) {
        dialog._w = 0;
        dialog._h = 0;
      }
      rowEls.forEach((tr) => {
        tr._w = 200;
        tr._h = 40;
      });
    },
  };
}

// ------------------------------------------------------------ 載入 bridge

function loadBridge(opts) {
  opts = opts || {};
  let listener = null;
  let reloaded = 0;

  // 模擬 aomi-inject.js 攔截到嘅「最近一次財務請求」（診斷用，唔重放）
  const postedFinance = [];

  const location = {
    // 🔴 `href` 一定要由 `hash` 砌出嚟（唔可以寫死財務路徑）——
    //    `onFinancePage()` 會 fallback 檢查 `href` 有冇 `/settle|settleService|finance`，
    //    寫死就會令「非財務頁」嘅測試永遠假綠（連 [1] 守衛都測唔到）。
    href: "https://merchant.aomiapp.com/" + (opts.hash || FINANCE_HASH),
    hash: opts.hash || FINANCE_HASH,
    origin: "https://merchant.aomiapp.com",
    reload() {
      reloaded++;
    },
  };

  const msgListeners = [];
  const clickListeners = [];
  const postedMsgs = [];

  /** 模擬 MAIN world（aomi-inject.js）post 一條財務事件過嚟。 */
  function emitInjectEvent(obj) {
    const ev = { source: win.window, data: obj };
    for (const fn of msgListeners) {
      try {
        fn(ev);
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  // ── 分頁器狀態（每頁筆數 / 第幾頁 / 目前帳期）──
  const pgState = {
    size: (opts.pageSizeSelect && opts.pageSizeSelect.current) || 20,
    page: 1,
    idx: 0,
  };
  const pgClicks = { sizeChanges: [], nextPages: 0, backClicks: 0 };

  /** `undefined` ⇒ 用「而家撳開咗邊個帳期」（舊測試冇分帳期 ⇒ 0）。 */
  function normIdx(idx) {
    if (typeof idx === "number") return idx;
    return typeof pgState.idx === "number" ? pgState.idx : 0;
  }

  function rowsForIndex(idx) {
    const i = normIdx(idx);
    if (Array.isArray(opts.captureRowsByIndex)) return opts.captureRowsByIndex[i] || [];
    return opts.captureRows;
  }

  function accountIdForIndex(idx) {
    if (!Array.isArray(opts.accountIds)) return undefined; // 交返舊邏輯：fallback [0]
    const i = normIdx(idx);
    const v = opts.accountIds[i];
    return v === undefined || v === null ? null : String(v);
  }

  /**
   * 模擬「MAIN world 被動抄低平台自己發嘅明細回應」。
   *
   * 🔴 呢個係澳覓嘅**唯一**資料來源（簽章無法重放 ⇒ 只能搭便車）。
   */
  function emitDetailCapture(rows, total, aid) {
    const list = Array.isArray(rows) ? rows : [];
    emitInjectEvent({
      __aomiFinance: true,
      kind: "finance_detail_captured",
      payload: {
        url:
          "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/order/list",
        // 🔴 `undefined` ＝ 冇畀 ⇒ 跌返 `accountIds[0]`（舊測試行為）；
        //    `null` ＝ 測試**刻意**話「呢個帳期冇 accountId」。
        accountId:
          aid === undefined
            ? (opts.accountIds && String(opts.accountIds[0])) || null
            : aid == null
              ? null
              : String(aid),
        result: list,
        rawResult: list,
        total: total == null ? list.length : total,
        firstRowKeys:
          list.length && list[0] && typeof list[0] === "object" ? Object.keys(list[0]) : [],
      },
      meta: { transport: "capture" },
    });
  }

  /** 按「目前每頁筆數 / 頁數」切片回應（模擬平台伺服器）。 */
  function servePage(idx) {
    const i = normIdx(idx);
    const rows = rowsForIndex(i);
    if (!Array.isArray(rows)) return;
    const start = (pgState.page - 1) * pgState.size;
    const slice = rows.slice(start, start + pgState.size);
    setTimeout(() => emitDetailCapture(slice, rows.length, accountIdForIndex(i)), 120);
  }

  const pageOpts = Object.assign({}, opts, {
    onPageSizeChange: (n) => {
      pgClicks.sizeChanges.push(n);
      pgState.size = Number(n) || pgState.size;
      pgState.page = 1;
      servePage();
      if (typeof opts.onPageSizeChange === "function") opts.onPageSizeChange(n);
    },
    onNextPage: () => {
      pgClicks.nextPages++;
      const all = rowsForIndex(pgState.idx);
      if (!Array.isArray(all)) return;
      if (pgState.page * pgState.size >= all.length) return; // 已經最後一頁
      pgState.page += 1;
      servePage(pgState.idx);
      if (pgState.page * pgState.size >= all.length && page.nextBtn) {
        page.nextBtn.disabled = true;
      }
    },
    onBack: () => {
      pgClicks.backClicks++;
      page.closeDialog();
      if (typeof opts.onBack === "function") opts.onBack();
    },
    onDetail: (idx) => {
      // 🔴 撳「查看」＝ 開一個**新**彈窗（每頁筆數還原、頁數還原 1）
      pgState.idx = idx;
      pgState.page = 1;
      if (opts.keepPageSize !== true) {
        pgState.size = (opts.pageSizeSelect && opts.pageSizeSelect.current) || 20;
        if (page.sizeInput) page.sizeInput.value = pgState.size + "項/頁";
      }
      page.openDialog();
      if (page.nextBtn) page.nextBtn.disabled = false;
      // 🔴 平台撳「查看」時一定發明細請求 ⇒ MAIN world 一定抄到。
      //    ⚠️ 冇設 `captureRows*` 就唔會發（等於「明細頁冇回應」嘅情境）。
      servePage(idx);
      if (typeof opts.onDetail === "function") opts.onDetail(idx);
    },
  });
  pageOpts.onQuery = function () {
    pgState.page = 1;
    servePage(pgState.idx);
  };
  const page = buildPage(pageOpts);

  const win = {
    window: {
      location,
      __AOMI_FINANCE_BRIDGE_INSTALLED__: false,
      addEventListener(type, fn) {
        if (type === "message") msgListeners.push(fn);
      },
      postMessage(msg) {
        // bridge 主動問 MAIN world「上次有冇財務請求」時回應。
        if (msg && msg.__aomiCmd === true && msg.cmd === "finance_last_request") {
          const last = [...postedFinance].reverse().find((p) => p.url);
          emitInjectEvent({
            __aomiFinance: true,
            kind: "finance_last_request",
            payload: last ? { url: last.url, accountId: last.accountId || null } : null,
            meta: {},
          });
        }
      },
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: win.window,
    location,
    document: {
      readyState: "complete",
      querySelectorAll: (sel) => page.root.querySelectorAll(sel),
      querySelector: (sel) => page.root.querySelector(sel),
      body: page.root,
      addEventListener(type, fn) {
        if (type === "click") clickListeners.push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of clickListeners) {
          try {
            fn(ev);
          } catch (e) {
            /* 忽略 */
          }
        }
      },
    },
    chrome: {
      runtime: {
        // 🔴 `id` 一定要有：bridge 有「係唔係 extension context」嘅 guard
        //    （`chrome.runtime.id` 唔存在 ⇒ 直接 return，唔註冊任何嘢）。
        //    （見 [20] 嘅 guard 測試。）
        id: "test-extension-id",
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage(msg, cb) {
          postedMsgs.push(msg);
          if (typeof cb === "function") cb();
        },
      },
    },
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
    encodeURIComponent,
    decodeURIComponent,
    structuredClone:
      typeof structuredClone === "function" ? structuredClone : (v) => JSON.parse(JSON.stringify(v)),
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), sandbox, { filename: "aomi-finance-bridge.js" });

  if (!listener) throw new Error("bridge 冇註冊 onMessage listener");

  /**
   * 送訊息並等回應。
   *
   * 🔴 每個 `send()` 都必須 `clearTimeout` 兩個保險 timer ——
   *    否則每次呼叫留低兩個 dangling timer（9s / 20s），
   *    Node 事件迴圈要等到全部到期才收工 ⇒ 症狀係「跑到一半被 SIGTERM」，
   *    而且掛死位置每次唔同（睇落似 bridge 卡死，其實係 harness 病）。
   */
  function send(msg) {
    return new Promise((resolve) => {
      let done = false;
      let softTimer = null;
      let hardTimer = null;
      const finish = (v) => {
        if (!done) {
          done = true;
          if (softTimer) clearTimeout(softTimer);
          if (hardTimer) clearTimeout(hardTimer);
          resolve(v);
        }
      };
      try {
        listener(msg, {}, finish);
      } catch (e) {
        finish({
          ok: false,
          reason: "bridge 同步拋錯：" + ((e && e.stack) || e),
          __harnessError: true,
        });
      }
      softTimer = setTimeout(() => finish(undefined), opts.timeout || 9000);
      const hard = opts.hardTimeout || 20000;
      hardTimer = setTimeout(() => {
        if (!done) console.log("[harness] send 超時 " + hard + "ms，強制返回（可能流程卡死）");
        finish(undefined);
      }, hard);
    });
  }

  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

  return {
    page,
    send,
    tick,
    document: sandbox.document,
    /**
     * 🔴 直接問 bridge：「呢個 hash 算唔算財務對帳頁？」
     *
     * 為什麼要開呢個口：`onFinancePage()` 係 route 守衛嘅**唯一真源**，
     * 而 2026-09-29 真機事故正正係佢判錯（只認 `settle`，真機路由冇呢個字）。
     * 舊測試只用假 URL 間接測 ⇒ 假綠。開一個直接入口，先守得住。
     *
     * ⚠️ `onFinancePage` 喺 bridge 嘅 IIFE 內部，**攞唔到**（唔似頂層 function 會掛 sandbox）
     *    ⇒ 用 bridge 自己嘅 `GRAB_PING` 回應（帶 `finance` 旗標）間接讀，
     *    呢個亦係 popup／background 真正用嘅介面（更貼近真實）。
     */
    finance() {
      let got = null;
      listener({ type: "GRAB_PING" }, {}, (r) => {
        got = r;
      });
      return !!(got && got.finance);
    },
    postedFinance,
    postedMsgs,
    emitInjectEvent,
    /** 🔴 餵一條「帳期列表回應」（hadSettlement / unSettlement）。 */
    emitPeriods(periods, source) {
      emitInjectEvent({
        __aomiFinance: true,
        kind: "finance_periods",
        payload: {
          url:
            "https://manager-gateway.aomiapp.com/aomi-settle-merchant/merchant/settleService/" +
            (source === "unSettlement" ? "unSettlement" : "hadSettlement"),
          periods: (Array.isArray(periods) ? periods : []).map((r) => ({ raw: r })),
          source: source === "unSettlement" ? "unSettlement" : "hadSettlement",
        },
        meta: { transport: "capture" },
      });
    },
    /** 🔴 餵一條「平台自己發嘅明細回應」（被動搭便車）。 */
    emitDetailCapture,
    pgClicks,
    pgState,
    location,
    get reloaded() {
      return reloaded;
    },
  };
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

/** 剝走 JS 註解（只保留真正會執行嘅碼）—— 避免註解文字造成假紅燈。 */
function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 真機形狀嘅一筆澳覓明細列（金額全部都係**分**）。 */
function aomiRow(orderId, costAmount, extra) {
  return Object.assign(
    {
      orderId: orderId,
      costAmount: costAmount,
      totalAmout: costAmount + 500,
      tradeNo: "TK" + orderId,
    },
    extra || {},
  );
}

// ------------------------------------------------------------ 測試

(async () => {
  group("[1] 🔴 唔係財務頁就唔可以亂撳（route 守衛）");
  {
    const bg = loadBridge({ hash: "#/order/list" });
    const r = await bg.send({ type: "AOMIFIN_SYNC", storeName: "澳覓店", targetDate: "2026-09-29" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("說明唔係財務頁", !!(r && r.reason && r.reason.indexOf("財務對帳頁") >= 0), true);
    check("完全冇撳過「查看」", bg.page.rowEls[0].querySelectorAll("button")[0].clicked, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🔴🔴 2026-09-29 真機回歸：`onFinancePage()` 嘅 route 判準
  //
  //  舊寫法只認 `settle` / `finance`，而澳覓前端路由**冇呢兩個字**
  //  ⇒ 真機永遠回「未開啟澳覓財務對帳頁」。
  //  實機：`#/qrAccountmanage/takeoutAccountManage/takeoutAccount`（列表）
  //        `#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=…`（明細）
  // ═══════════════════════════════════════════════════════════════════════
  group("[1b] 🔴🔴 真機 URL 一定要認得（列表 ＋ 明細）");
  {
    const list = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutAccount",
    });
    check("🔴 列表頁 ＝ 財務頁", list.finance(), true);

    const detail = loadBridge({
      hash:
        "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857&storeName=%E8%A1%A8%E5%AB%82%E7%BE%8E%E9%A3%9F",
    });
    check("🔴🔴 明細頁都係財務頁（走訪換 route 唔可以掉線）", detail.finance(), true);

    const orders = loadBridge({ hash: "#/order/orderManage" });
    check("🔴 訂單管理頁唔係財務頁", orders.finance(), false);

    const home = loadBridge({ hash: "#/home" });
    check("🔴 首頁唔係財務頁", home.finance(), false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🔴🔴 2026-09-29 真機回歸：啟動時喺**明細頁**都要行得通
  //
  //  真機情境：使用者開住
  //    `…/takeoutAccountManage/takeoutDetail?accountId=unExp_16857`
  //  就撳「立即對帳」。
  //
  //  舊寫法把 `prevHash` 記喺**最開頭**（＝明細頁 hash）⇒ 行完一期
  //  `backToList` 見 `location.hash === prevHash` **唔 back** ⇒
  //  卡死明細頁 ⇒ 只拿到第一期，其餘**靜默消失**（最難查嗰種）。
  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  //  🔴🔴 v1.74（2026-09-29 使用者需求）：
  //    進入對帳記錄明細頁後，唔可以強制跳返列表先對帳 —— 就喺明細頁
  //    就地抓「當前在睇嗰一期」並推 POS。所以「啟動時喺明細頁」嘅新行為係：
  //      · backClicks = 0（唔撳「返回」／唔跳主頁）
  //      · periodCount = 1（只抓當前期，唔 walk 晒所有帳期）
  //      · trace 有 `detail-shortcut`、冇 `ensure-list`
  //    （舊嘅「自動退回列表、全部帳期照行」已按需求移除。）
  // ═══════════════════════════════════════════════════════════════════════
  group("[1c] 🔴🔴 啟動時喺明細頁 ⇒ 就地單期對帳、唔跳列表（v1.74 新行為）");
  {
    const DETAIL_HASH =
      "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857";
    const bg = loadBridge({
      hash: DETAIL_HASH,
      detail: true, // 🔴 正確模擬「企喺明細頁」：彈窗顯示 ＋ 有「查詢」掣
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-A", 11542), aomiRow("TK-B", 2000)],
    });

    check("🔴 明細頁 URL 都算財務頁（唔可以報「未開啟」）", bg.finance(), true);

    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      storeName: "澳覓表嫂美食",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });

    check("🔴🔴 回 ok:true（明細頁就地對帳成功，唔可以失敗）", !!(r && r.ok), true);
    check(
      "🔴🔴 冇跳返列表（backClicks = 0，唔強制返主頁）",
      bg.pgClicks.backClicks,
      0,
    );
    check(
      "🔴🔴 只抓「當前在睇嗰一期」（periodCount = 1，唔 walk 全部帳期）",
      (r && r.periodCount) || 0,
      1,
    );
    check(
      "🔴🔴 period key 同列表流程一致（由明細頁 header 抽）",
      r && r.period,
      "2026-09-16 ~ 2026-09-30",
    );
    check(
      "🔴 trace 有 detail-shortcut（短路生效，冇行 ensure-list）",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-shortcut")),
      true,
    );
    check(
      "🔴 trace 冇 ensure-list（確認唔會退回列表）",
      !!(r && r.trace && r.trace.every((t) => t.step !== "ensure-list")),
      true,
    );
    check("🔴 兩筆明細全部抄到", (r && r.transactions && r.transactions.length) || 0, 2);
    check("🔴 實收 = (115.42 + 20.00) = 135.42", r && r.receive, 135.42);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🔴🔴 2026-09-29 真機回歸：澳覓對帳頁**係 div 列表、唔係表格**
  //
  //  使用者截圖：分組「未出帳單」／「已出帳單」，帳期文字用「至」分隔，
  //  `.el-table__row` / `tbody tr` 全部唔中。
  //
  //  `listPeriodRows()` 嘅 class 選擇器路徑對 div 完全失效 ⇒ 一定要靠
  //  「帳期文字反查」先抓到。呢兩條測試就係證明：廢咗文字反查就會紅。
  // ═══════════════════════════════════════════════════════════════════════
  group("[1d] 🔴🔴 真機 div 列表（非表格）⇒ 文字反查抓到全部帳期");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutAccount",
      layout: "div",
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15"],
      accountIds: ["ACC-1", "ACC-2"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-A", 11542), aomiRow("TK-B", 2000)],
      startDate: "2026-09-01",
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      storeName: "澳覓表嫂美食",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });
    check("🔴🔴 回 ok:true（div 列表都認到）", !!(r && r.ok), true);
    check(
      "🔴🔴 兩個帳期都行到（文字反查生效，class 選擇器對 div 失效）",
      (r && r.periods && r.periods.length) || 0,
      2,
    );
    check("🔴 兩個帳期都成功", (r && r.periods || []).every((p) => p.ok), true);
  }

  group("[1e] 🔴🔴 div 列表情境下，啟動喺明細頁一樣就地單期、唔理 div 列表（v1.74）");
  {
    const DETAIL_HASH =
      "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857";
    const bg = loadBridge({
      hash: DETAIL_HASH,
      detail: true,
      // 🔴 明細頁模式下底 list 結構唔會被讀（短路直接抓明細頁），
      //    呢個確認「底 list 係 div 定表格」完全唔影響新行為。
      layout: "div",
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-A", 11542), aomiRow("TK-B", 2000)],
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      storeName: "澳覓表嫂美食",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });
    check("🔴🔴 回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 冇跳返列表（backClicks = 0）", bg.pgClicks.backClicks, 0);
    check("🔴🔴 只抓當前期（periodCount = 1）", (r && r.periodCount) || 0, 1);
    check(
      "🔴 period key 由明細頁 header 抽（唔受 div list 影響）",
      r && r.period,
      "2026-09-16 ~ 2026-09-30",
    );
    check(
      "🔴 trace 有 detail-shortcut、冇 ensure-list",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-shortcut") && r.trace.every((t) => t.step !== "ensure-list")),
      true,
    );
  }

  group("[2] 🔴🔴 金額係分 ⇒ 一定要 ÷100（11542 → 115.42）");
  {
    const bg = loadBridge({
      accountIds: ["ACC-1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK00115260929133047856", 11542)],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 一筆 transaction", (r && r.transactions && r.transactions.length) || 0, 1);
    check(
      "🔴🔴 costAmount 11542（分）→ netAmount 115.42（元）",
      r && r.transactions[0].netAmount,
      115.42,
    );
    check(
      "🔴 orderId → tradeNo（POS 端靠佢配對）",
      r && r.transactions[0].tradeNo,
      "TK00115260929133047856",
    );
    check(
      "🔴 澳覓冇補貼兩段口徑 ⇒ subsidyNet 一律 null",
      r && r.transactions[0].subsidyNet,
      null,
    );
    check("🔴 帳期實收 ＝ 逐筆加總（115.42）", r && r.receive, 115.42);
    check(
      "🔴🔴 帳期營業額 should ＝ 逐筆 grossAmount 加總（12042÷100 = 120.42）",
      r && r.should,
      120.42,
    );
  }

  group("[3] 🔴🔴 estSettleAmt（應結算金額）係假數 ⇒ 唔可以拿嚟頂替");
  {
    // 真機：`estSettleAmt` 有值但係「冇扣活動扣款」嘅假數
    // ⇒ 只認 `costAmount`，冇就回 null（＝「待對帳」），**刻意唔 fallback**。
    const bg = loadBridge({
      accountIds: ["ACC-1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [
        { orderId: "TK001", estSettleAmt: 99999, totalAmout: 20000 },
        // ↑ 冇 costAmount ⇒ 一定要 netAmount:null，唔可以用 estSettleAmt / totalAmout 頂
      ],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("仍然回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 冇 costAmount ⇒ netAmount 係 null（唔可以用假數）", r && r.transactions[0].netAmount, null);
    check("🔴 帳期實收都唔可以靠假數加出嚟", r && r.receive, null);
    check(
      "🔴🔴 但營業額 should 仍然讀到（20000÷100 = 200，唔受 netAmount 影響）",
      r && r.should,
      200,
    );
  }

  group("[4] 🔴 有 costAmount 時，唔可以攞 estSettleAmt（即使佢更大）");
  {
    const bg = loadBridge({
      accountIds: ["ACC-A"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [{ orderId: "TK002", costAmount: 10000, estSettleAmt: 15000, totalAmout: 20000 }],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴🔴 實收 = 100.00（costAmount ÷100），唔係 150.00", r && r.transactions[0].netAmount, 100);
    check("帳期實收跟住 = 100", r && r.receive, 100);
  }

  group("[5] 🔴🔴 必須翻頁（total 大過一頁 ⇒ 一定要翻到底）");
  {
    // 120 筆、每頁上限 50 ⇒ 一定要翻 3 頁（漏翻 ＝ 實收靜默少一大截）
    const mk = (n, from) =>
      Array.from({ length: n }, (_, i) => aomiRow("TK" + (from + i), 1000));
    const bg = loadBridge({
      accountIds: ["ACC-2"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: mk(120, 0),
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 三頁加起來 120 筆（唔可以只拿第一頁）", (r && r.transactions.length) || 0, 120);
    check("🔴 真係撳過「下一頁」（≥2 次）", bg.pgClicks.nextPages >= 2, true);
    check("🔴 每頁筆數撳到 50", bg.pgClicks.sizeChanges.indexOf(50) >= 0, true);
    check("🔴 帳期實收 = 120 × 10.00 = 1200", r && r.receive, 1200);
  }

  group("[6] 🔴 每頁筆數一定要「代撳到最大」（使用者 Q4）");
  {
    const bg = loadBridge({
      accountIds: ["ACC-3"],
      pageSizeSelect: { current: 10, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 有撳「每頁筆數」下拉", bg.pgClicks.sizeChanges.length >= 1, true);
    check("🔴 撳到最大嘅 50（唔係 20）", bg.pgClicks.sizeChanges[0], 50);
  }

  group("[7] 🔴 每頁筆數已經係 50 ⇒ 唔需要再撳（但唔可以失敗）");
  {
    const bg = loadBridge({
      accountIds: ["ACC-4"],
      pageSizeSelect: { current: 50, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 已經夠大就唔撳（省一次請求）", bg.pgClicks.sizeChanges.length, 0);
    check("照樣拿得到數", (r && r.transactions.length) || 0, 1);
  }

  group("[8] 🔴 帳期列表係空 ⇒ 要講清楚，唔可以靜默回空");
  {
    const bg = loadBridge({ periods: [], captureRows: [aomiRow("TK1", 100)] });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("🔴 講明帳期列表係空", !!(r && r.reason && r.reason.indexOf("帳期") >= 0), true);
  }

  group("[9] 🔴 目標日期唔喺任何帳期內 ⇒ 跌返第一個（澳覓列表可能只有一個帳期）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30"],
      accountIds: ["ACC-9"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-01-01" });
    check("回 ok:true（跌返第一個帳期）", !!(r && r.ok), true);
    check("帳期係第一個", r && r.period, "2026-09-16 ~ 2026-09-30");
  }

  group("[10] 🔴 目標日期命中特定帳期 ⇒ 一定要揀啱嗰個");
  {
    const bg = loadBridge({
      periods: ["2026-09-01 ~ 2026-09-15", "2026-09-16 ~ 2026-09-30"],
      accountIds: ["OLD", "NEW"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [
        [aomiRow("TK-OLD", 100)],
        [aomiRow("TK-NEW", 200)],
      ],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 命中第二個帳期", r && r.period, "2026-09-16 ~ 2026-09-30");
    check("🔴 拿嘅係第二個帳期嘅單", r && r.transactions[0].tradeNo, "TK-NEW");
  }

  group("[11] 🔴🔴 有 startDate ⇒ 要行『全部』帳期（使用者 Q5）");
  {
    // 「只要是在商家 set 的日期內, 你都要去拿到…跟 unsettle 的一樣」
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
      accountIds: ["SEP2", "SEP1", "AUG"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [
        [aomiRow("TK-SEP2", 1000), aomiRow("TK-SEP2b", 2000)],
        [aomiRow("TK-SEP1", 3000)],
        [aomiRow("TK-AUG", 4000)],
      ],
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-08-30",
    });
    check("回 ok:true", !!(r && r.ok), true);
    // 🔴 8/16~8/31 嘅「結束日 8/31 >= 8/30」⇒ 要行；三個帳期全部要行
    check("🔴 行咗 3 個帳期", r && r.periodCount, 3);
    check(
      "🔴 逐帳期結果各自一份（background 要逐個推 POS）",
      r && r.periods.map((p) => p.period),
      ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
    );
    check("🔴 每個帳期各有自己嘅實收", r && r.periods.map((p) => p.receive), [30, 30, 40]);
    check("🔴 全部帳期實收加總 = 100", r && r.receiveSum, 100);
    check("🔴 periodWalk 記錄齊全", r && r.periodWalk && r.periodWalk.ok, 3);
    check("🔴 行完一個帳期要返列表（撳過返回）", bg.pgClicks.backClicks >= 2, true);
  }

  group("[12] 🔴 有 startDate 但冇任何帳期喺其後 ⇒ 如實回報（唔可以靜默回空）");
  {
    const bg = loadBridge({
      periods: ["2026-01-01 ~ 2026-01-15"],
      accountIds: ["JAN"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-08-30",
    });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("🔴 講明冇帳期喺該日之後", !!(r && r.reason && r.reason.indexOf("2026-08-30") >= 0), true);
  }

  group("[13] 🔴🔴 跨頁要累積（唔可以新覆蓋舊）");
  {
    // 100 筆、每頁 50 ⇒ 兩頁。若覆寫就只剩第二頁 50 筆。
    const mk = (n, from) =>
      Array.from({ length: n }, (_, i) => aomiRow("TK" + (from + i), 100));
    const bg = loadBridge({
      accountIds: ["ACC-13"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: mk(100, 0),
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴🔴 100 筆全部抄到（跨頁累積）", (r && r.transactions.length) || 0, 100);
    check("🔴 帳期實收 = 100 × 1.00 = 100", r && r.receive, 100);
  }

  group("[14] 🔴 翻頁重疊邊界 ⇒ 一定要去重（否則實收翻倍）");
  {
    // 平台翻頁時回重疊邊界：page1 = 0..49，page2 又回 40..79 ⇒ 去重後應為 80 筆
    const all = Array.from({ length: 80 }, (_, i) => aomiRow("TK" + i, 100));
    const bg = loadBridge({
      accountIds: ["ACC-14"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: all,
    });
    // 先手動餵重疊嘅兩頁（模擬平台行為）
    bg.emitDetailCapture(all.slice(0, 50), 80, "ACC-14");
    bg.emitDetailCapture(all.slice(40, 80), 80, "ACC-14");
    await bg.tick(60);
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 去重後 = 80 筆（唔可以 90）", (r && r.transactions.length) || 0, 80);
  }

  group("[15] 🔴 換帳期（accountId 唔同）⇒ 上一批要清空");
  {
    const bg = loadBridge({
      accountIds: ["ACC-A", "ACC-B"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [[aomiRow("TK-A", 100)], [aomiRow("TK-B", 200)]],
      periods: ["2026-09-01 ~ 2026-09-15", "2026-09-16 ~ 2026-09-30"],
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 兩個帳期各自一筆（冇撈埋）", r && r.periods.map((p) => p.transactions.length), [1, 1]);
    check(
      "🔴 第一個帳期只有自己嗰筆",
      r && r.periods[0].transactions[0].tradeNo,
      "TK-A",
    );
    check(
      "🔴 第二個帳期只有自己嗰筆（冇被上一批污染）",
      r && r.periods[1].transactions[0].tradeNo,
      "TK-B",
    );
  }

  group("[16] 🔴 撳「查看」但等唔到明細回應 ⇒ 要如實回報（唔可以當冇單）");
  {
    // 冇 `captureRows` ⇒ 平台唔會發明細 ⇒ bridge 等唔到
    const bg = loadBridge({
      accountIds: ["ACC-16"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check(
      "🔴 講明等唔到明細",
      !!(r && r.reason && /明細|回應/.test(r.reason)),
      true,
    );
    check(
      "🔴 trace 有記 detail-captured 失敗",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-captured" && t.ok === false)),
      true,
    );
  }

  group("[16b] 🔴🔴 明細回應「有到但係空」＝ 正常空帳期（唔可以同 [16] 混為一談）");
  {
    // 分別好重要：`first` 有值、`rawResult` 空 ⇒ 平台真係話「冇單」（正常）。
    // 若一律當失敗，收銀台日日見到紅字（假警報）；若一律當成功，
    // 平台改版時又會靜默漏數。兩個分支都要各有測試鎖住。
    const bg = loadBridge({
      accountIds: ["ACC-16B"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [], // ← 平台回一個空陣列
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 回 ok:true（空帳期係正常）", !!(r && r.ok), true);
    check("冇 transaction", (r && r.transactions.length) || 0, 0);
    check("帳期實收為 null（唔係 0）", r && r.receive, null);
  }

  group("[17] 🔴 全程唔可以 F5（使用者明確要求）");
  {
    const bg = loadBridge({
      accountIds: ["ACC-17"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 執行期間完全冇 reload 過頁面", bg.reloaded, 0);

    // 🔴 一定要剝註解 —— 檔頭註解**故意**提到「冇任何 location.reload()」，
    //    唔剝就會永遠紅燈，而下一個人只會學到「呢條斷言可以無視」。
    const src = stripComments(fs.readFileSync(BRIDGE, "utf8"));
    check("🔴 原始碼冇 location.reload()", /location\s*\.\s*reload\s*\(/.test(src), false);
    check("🔴 原始碼冇 window.location.href 賦值", /location\s*\.\s*href\s*=[^=]/.test(src), false);
  }

  group("[18] PROBE 診斷端點（唔會撳任何嘢，只量度）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
    });
    const r = await bg.send({ type: "AOMIFIN_PROBE" });
    check("PROBE 有回應", !!(r && r.ok), true);
    check("PROBE 認得呢個係財務頁", r && r.finance, true);
    check("🔴 PROBE 量到帳期列", !!(r && r.periodRows && r.periodRows.length), true);
    check("🔴 PROBE 冇撳過「查看」", bg.page.rowEls[0].querySelectorAll("button")[0].clicked, 0);
    check(
      "🔴 PROBE 冇撳過「每頁筆數」",
      bg.pgClicks.sizeChanges.length,
      0,
    );
  }

  group("[19] GRAB_PING 要標示 finance 旗標（background 靠佢分流）");
  {
    const bg = loadBridge({});
    const r = await bg.send({ type: "GRAB_PING" });
    check("回 ok", !!(r && r.ok), true);
    check("🔴 有 finance: true", r && r.finance, true);

    const bg2 = loadBridge({ hash: "#/order/list" });
    const r2 = await bg2.send({ type: "GRAB_PING" });
    check("🔴 非財務頁 finance: false", r2 && r2.finance, false);
  }

  group("[20] 🔴🔴 IN_EXTENSION_CONTEXT guard（防被注入 MAIN world 污染記號）");
  {
    // ① 靜態：原始碼一定要有 guard，而且**先** guard 後設記號
    const src = fs.readFileSync(BRIDGE, "utf8");
    check(
      "🔴 原始碼有 IN_EXTENSION_CONTEXT guard",
      /IN_EXTENSION_CONTEXT/.test(src),
      true,
    );
    check(
      "🔴 有 chrome.runtime.id 檢查",
      /chrome\.runtime\.id/.test(src),
      true,
    );
    const guardIdx = src.indexOf("IN_EXTENSION_CONTEXT");
    const flagIdx = src.indexOf("__AOMI_FINANCE_BRIDGE_INSTALLED__ = true");
    check("🔴 guard 一定要喺「設記號」之前", guardIdx > 0 && guardIdx < flagIdx, true);

    // ② 動態：冇 chrome.runtime.id ⇒ 唔可以註冊 listener（＝乜都唔做）
    let registered = false;
    const win = {
      location: { href: "https://merchant.aomiapp.com/#/settle", hash: "#/settle", origin: "https://merchant.aomiapp.com" },
      __AOMI_FINANCE_BRIDGE_INSTALLED__: false,
      addEventListener() {},
      postMessage() {},
    };
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      window: win,
      location: win.location,
      document: { readyState: "complete", querySelectorAll: () => [], body: null },
      chrome: { runtime: { onMessage: { addListener() { registered = true; } } } },
      Promise, setTimeout, clearTimeout, Object, Array, Number, String, Boolean,
      JSON, Math, Date, isFinite, parseInt, parseFloat, RegExp, Set, Map,
      encodeURIComponent, decodeURIComponent,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "aomi-finance-bridge.js" });
    check("🔴 冇 runtime.id ⇒ 唔註冊 listener（guard 生效）", registered, false);
    check("🔴 記號冇被設成 true", win.__AOMI_FINANCE_BRIDGE_INSTALLED__, false);
  }

  group("[21] AOMIFIN_RAW：原樣交返全部已攔到嘅原始資料（唔配對）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30"],
      accountIds: ["ACC-21"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 11542), aomiRow("TK2", 2000)],
    });
    // 🔴 `periodRows` 帳本係由 MAIN world 嘅 `finance_periods` 事件累積 ——
    //    DOM 上有帳期列**唔等於**帳本有（兩條獨立路徑）。
    bg.emitPeriods(
      [{ accountId: "ACC-21", startDate: "2026-09-16", endDate: "2026-09-30" }],
      "hadSettlement",
    );
    await bg.tick(60);
    await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    const raw = await bg.send({ type: "AOMIFIN_RAW" });
    check("回 ok:true", !!(raw && raw.ok), true);
    check("🔴 有帳期列", raw && raw.periodRowCount, 1);
    check("🔴 有明細列（原樣）", raw && raw.detailRowCount, 2);
    check(
      "🔴 原樣保留 costAmount（唔會 ÷100）",
      raw && raw.detailRows[0].costAmount,
      11542,
    );
    check("🔴 帶住 accountId（診斷用）", raw && raw.detailAccountId, "ACC-21");
    check("🔴 有記低每頁記錄", Array.isArray(raw && raw.detailPages), true);
  }

  group("[22] 🔴 AOMIFIN_SYNC 出現內部錯誤 ⇒ 一定要回報（唔可以變 unhandled rejection）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30"],
      accountIds: ["ACC-22"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    // 送一個會令流程爆嘅 targetDate（非字串物件）—— runFinanceSync 內部 catch 應該接住
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: { bad: 1 }, startDate: null });
    check("🔴 一定有回應（唔會掛死）", r !== undefined, true);
    check("🔴 有 ok 欄位", !!(r && typeof r.ok === "boolean"), true);
  }

  group("[23] 🔴 帳期文字支援 `YYYY/MM/DD`（唔可以只認 `-`）");
  {
    const bg = loadBridge({
      periods: ["2026/09/16 ~ 2026/09/30"],
      accountIds: ["ACC-23"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    const probe = await bg.send({ type: "AOMIFIN_PROBE" });
    check("🔴 認得 `YYYY/MM/DD` 帳期", probe && probe.periodRows[0], "2026-09-16 ~ 2026-09-30");
  }

  group("[24] 🔴 標題（原文：`totalAmout` 拼錯）都要讀到營業額");
  {
    const bg = loadBridge({
      accountIds: ["ACC-24"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      // 真機係 `totalAmout`（少一個 n）—— 唔可以只認正確串法
      captureRows: [{ orderId: "TK1", costAmount: 10000, totalAmout: 20000 }],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 營業額讀得到（totalAmout ÷100）", r && r.transactions[0].grossAmount, 200);
    check("實收照樣係 costAmount ÷100", r && r.transactions[0].netAmount, 100);
  }

  group("[25] 🔴 多帳期（3 個）獨立累積 —— 第 3 個唔可以帶住前面嘅單");
  {
    const bg = loadBridge({
      periods: [
        "2026-09-16 ~ 2026-09-30",
        "2026-09-01 ~ 2026-09-15",
        "2026-08-16 ~ 2026-08-31",
      ],
      accountIds: ["P3", "P2", "P1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [
        [aomiRow("TK-P3-1", 100), aomiRow("TK-P3-2", 200)],
        [aomiRow("TK-P2-1", 300)],
        [aomiRow("TK-P1-1", 400)],
      ],
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-08-01",
    });
    check("🔴 三個帳期", r && r.periodCount, 3);
    check("🔴 每帳期明細數 = [2,1,1]", r && r.periods.map((p) => p.transactions.length), [2, 1, 1]);
    check(
      "🔴 第三個帳期只有 TK-P1-1（唔可以帶住前面嘅）",
      r && r.periods[2].transactions.map((t) => t.tradeNo),
      ["TK-P1-1"],
    );
    check("🔴 各帳期實收 = [3, 3, 4]", r && r.periods.map((p) => p.receive), [3, 3, 4]);
    check("🔴🔴 各帳期營業額 should = [13, 8, 9]", r && r.periods.map((p) => p.should), [13, 8, 9]);
    check("🔴🔴 primary 帳期 should = 13", r && r.should, 13);
    check("🔴🔴 總營業額 shouldSum = 30", r && r.shouldSum, 30);
    check("🔴 總實收 = 10", r && r.receiveSum, 10);
  }

  group("[26] 🔴 帳期走訪中途返回失敗 ⇒ 停止並如實回報（唔可以當行完）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15"],
      accountIds: ["P2", "P1"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [[aomiRow("TK-P2", 100)], [aomiRow("TK-P1", 200)]],
      // 撳「返回」之後**唔**重現帳期列（模擬返回失敗）
      onBack: () => {
        for (const tr of bg.page.rowEls) {
          tr._w = 0;
          tr._h = 0;
        }
      },
    });
    const r = await bg.send({
      type: "AOMIFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });
    // 第一個帳期成功 ⇒ 整體仍然 ok（但有 trace 記低咗走訪中止）
    check("回 ok:true（第一個帳期已成功）", !!(r && r.ok), true);
    check(
      "🔴 trace 記低走訪中止",
      !!(r && r.trace && r.trace.some((t) => t.step === "walk-aborted")),
      true,
    );
  }

  group("[27] 🔴 冇帳期列時唔可以亂估 targetDate（`pickPeriodTargets` 要回 false）");
  {
    const bg = loadBridge({ periods: [] });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29", startDate: "2026-08-01" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("有 trace（除錯用）", Array.isArray(r && r.trace), true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🔴🔴 2026-09-29 使用者需求：對帳記錄頁（明細頁）自動獲取優化
  //    · 進入明細頁撳立即對帳 ⇒ 唔可以強制跳返列表，就地抓當前期
  //    · 明細頁點「查詢」（真人 click）⇒ 自動重抓並推 POS
  // ═══════════════════════════════════════════════════════════════════════
  group("[28] 🔴🔴 明細頁就地對帳：唔跳列表、只抓當前期（使用者 2026-09-29）");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857",
      detail: true,
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-DETAIL"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-D1", 100), aomiRow("TK-D2", 200)],
    });
    // 🔴 核心：喺明細頁撳立即對帳，唔可以跳返列表（唔可以撳「返回」）
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 冇跳返列表（backClicks = 0）", bg.pgClicks.backClicks, 0);
    check(
      "🔴🔴 period key 同列表流程一致（由明細頁 header 抽）",
      r && r.period,
      "2026-09-16 ~ 2026-09-30",
    );
    check("🔴 只抓一個帳期（當前期）", r && r.periodCount, 1);
    check("🔴 兩筆明細全部抄到", (r && r.transactions.length) || 0, 2);
    check("🔴 實收 = (1+2) = 3", r && r.receive, 3);
    check("🔴 營業額 should 讀到 = 13", r && r.should, 13);
    check(
      "🔴 trace 有 detail-shortcut 步驟",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-shortcut")),
      true,
    );
    check(
      "🔴 trace 有 detail-captured 步驟（ok）",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-captured" && t.ok)),
      true,
    );
  }

  group("[29] 🔴 明細頁撳查詢但平台無回應 ⇒ 如實回報（唔可以靜默成功）");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857",
      detail: true,
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-DETAIL"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      silentQuery: true, // 模擬平台對「查詢」完全無反應（唔會發明細）
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 回 ok:false", !!(r && r.ok === false), true);
    check(
      "🔴 講明等唔到明細",
      !!(r && r.reason && /明細|回應/.test(r.reason)),
      true,
    );
    check(
      "🔴 trace 有 detail-captured 失敗",
      !!(r && r.trace && r.trace.some((t) => t.step === "detail-captured" && t.ok === false)),
      true,
    );
    check("🔴🔴 完全冇跳返列表", bg.pgClicks.backClicks, 0);
  }

  group("[30] 🔴 明細頁 header 冇帳期文字 ⇒ 改由明細列日期兜 period key");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857",
      detail: true,
      noDetailPeriod: true, // 冇 header 文字 ⇒ 靠明細列日期
      accountIds: ["ACC-DETAIL"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [
        Object.assign(aomiRow("TK-D1", 100), { settleTime: "2026-09-20 10:00:00" }),
        Object.assign(aomiRow("TK-D2", 200), { settleTime: "2026-09-25 18:30:00" }),
      ],
    });
    const r = await bg.send({ type: "AOMIFIN_SYNC", targetDate: "2026-09-29" });
    check("🔴 回 ok:true", !!(r && r.ok), true);
    check(
      "🔴 period 由明細列日期兜出區間",
      r && r.period,
      "2026-09-20 ~ 2026-09-25",
    );
    check("🔴 兩筆明細抄到", (r && r.transactions.length) || 0, 2);
  }

  group("[31] 🔴 明細頁點「查詢」（真人 click）⇒ 自動重抓並推 POS（GRAB_SETTLE_AOMI_NOW）");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857",
      detail: true,
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-DETAIL"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-D1", 100)],
    });
    check("🔴 事前冇送過 GRAB_SETTLE_AOMI_NOW", bg.postedMsgs.length, 0);
    // 模擬真人撳「查詢」（isTrusted = true）
    bg.document.dispatchEvent({ target: bg.page.detailQueryBtn, isTrusted: true });
    check("🔴 真人 click 查詢 ⇒ 送 GRAB_SETTLE_AOMI_NOW", bg.postedMsgs.length, 1);
    check(
      "🔴 送嘅係 aomi 立即對帳",
      bg.postedMsgs[0] && bg.postedMsgs[0].type,
      "GRAB_SETTLE_AOMI_NOW",
    );
    check(
      "🔴 manual: true（忽略節流）",
      !!(bg.postedMsgs[0] && bg.postedMsgs[0].manual),
      true,
    );
  }

  group("[31b] 🔴 程序化 click（isTrusted=false，即 syncDetailPage 內部撳查詢）唔可以觸發 listener（防自 loop）");
  {
    const bg = loadBridge({
      hash: "#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=unExp_16857",
      detail: true,
      detailPeriod: "2026-09-16至2026-09-30",
      accountIds: ["ACC-DETAIL"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK-D1", 100)],
    });
    bg.document.dispatchEvent({ target: bg.page.detailQueryBtn, isTrusted: false });
    check("🔴 isTrusted=false ⇒ 唔送 GRAB_SETTLE_AOMI_NOW", bg.postedMsgs.length, 0);
  }

  group("[31c] 🔴 列表頁點「查詢」唔關事（listener 只喺明細頁生效）");
  {
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30"],
      accountIds: ["ACC-L"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: [aomiRow("TK1", 100)],
    });
    // 列表頁 onDetailRoute() = false ⇒ listener 直接 return（唔使 detailQueryBtn）
    bg.document.dispatchEvent({ target: { textContent: "查詢" }, isTrusted: true });
    check("🔴 列表頁 click 查詢 ⇒ 唔送 GRAB_SETTLE_AOMI_NOW", bg.postedMsgs.length, 0);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed > 0 ? 1 : 0);
})();
