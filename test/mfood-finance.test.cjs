/**
 * mfood-finance-bridge.js 測試（財務頁／平台結算抓取）
 *
 * 為什麼需要這支測試：
 *   使用者 2026-09-26 的需求是「取得商家真實到手的金額」。
 *   營業額（`businessAmount`）同實收（`storeReceiveAmtn`）係**兩個唔同嘅數**，
 *   差額就係平台抽成 —— 呢條流程錯一格，報表上嘅「差額率」就全錯。
 *
 *   這支測試鎖住四個最容易靜默出錯嘅位：
 *     · ① 商家名一定要命中最短候選（唔可以撳到包住整個表單嘅大 div）
 *     · ② 「查詢」唔可以撳成「重置」（同排嘅誘餌）
 *     · ③ 🔴 帳期列表嘅 `details` 係**空陣列** —— 一定要另外呼叫 API
 *     · ④ 🔴 `total: 231` 但 `result: 22` ⇒ **必須翻頁**
 *          漏翻頁 = 實收靜默偏少一大截（最危險嘅一種 bug）
 *
 *   另外鎖住「唔可以 F5」：全程不得出現 location.reload。
 *
 * 執行：node test/mfood-finance.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BRIDGE = path.join(__dirname, "..", "mfood-finance-bridge.js");
const FINANCE_HASH = "#/finance/tackout-check";

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
    // 🔴 textContent 要係**聚合值**（真實 DOM：父節點包含子節點文字）。
    //    之前寫死一個字串 → `rowPeriodText(row)` 喺 `<tr>` 上讀唔到 `<td>` 嘅帳期
    //    ⇒ findPeriodRow 永遠搵唔到列（測試會靜默回「帳期列表係空」）。
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
    // 🔴🔴 2026-09-30：真機 `getBoundingClientRect()` 係**有** `top`/`left` 嘅。
    //    舊假 DOM 淨係返 `{width,height}` ⇒ `r.top` 係 `undefined`
    //    ⇒ `40 - Math.abs(r.top)/20` 變 **NaN** ⇒ **所有候選分數都係 NaN**
    //    ⇒ `sort` 比較 NaN 變 no-op ⇒ 永遠淨係揀「DOM 入面第一個」`.el-select`
    //    ⇒ 「評分揀錯下拉」呢個真機 bug 喺測試入面**永遠唔會現形**（假綠）。
    _top: opts.top === undefined ? 0 : opts.top,
    _left: opts.left === undefined ? 0 : opts.left,
    clicked: 0,
    // 🔴🔴 2026-09-30：假 DOM 需要支援**事件監聽 + 派發**，先測得到
    //    「bridge 有冇用真實 pointer 序列（mousedown/mouseup/click）開下拉」。
    //    舊假 DOM 只有 `click()` ⇒ 就算 bridge 只寫 `el.click()` 都一定綠，
    //    完全測唔到真機嘅重點（真機 `.click()` 係開唔到嗰個下拉）。
    //    只實作本測試需要嘅（bubbles 向上冒泡）。
    _listeners: Object.create(null),
    _dispatchCount: 0,
    addEventListener(type, fn) {
      (el._listeners[type] = el._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = el._listeners[type];
      if (a) el._listeners[type] = a.filter((f) => f !== fn);
    },
    dispatchEvent(ev) {
      if (!ev || !ev.type) return true;
      ev.target = el;
      el._dispatchCount++;
      let n = el;
      while (n) {
        const ls = n._listeners && n._listeners[ev.type];
        if (ls) for (const fn of ls.slice()) fn.call(n, ev);
        n = n.parentElement;
      }
      return true;
    },
    getAttribute(k) {
      return k in el._attrs ? el._attrs[k] : null;
    },
    setAttribute(k, v) {
      el._attrs[k] = v;
    },
    getBoundingClientRect: () => ({
      width: el._w,
      height: el._h,
      top: el._top,
      left: el._left,
    }),
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
  // 🔴 選擇器可能係 `tbody tr` 呢種後代組合 —— 假 DOM 冇做完整 CSS 引擎，
  //    所以只比對**最後一段**（真正嘅目標 tag）。呢個簡化對本測試足夠：
  //    bridge 用嘅選擇器都係「column + 目標 tag」，父層只係收窄範圍。
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
 * 砌出一個貼近真實後台嘅財務頁。
 *
 * 關鍵細節（照 2026-09-28 真機 DOM dump 抄）：
 *   · 商家下拉 ＝ **多選標籤型** `.el-select` ＋ `.el-select__tags`（寬 230px）
 *     placeholder 係「全部」而唔係「商家」—— 所以 bridge 一定要**結構定位**。
 *   · 「查詢」係 `el-button--primary`，「重置」係普通掣（同排誘餌）
 *   · 帳期表格 `.el-table__row`，每列有帳期文字 + 「查看詳情」
 *   · 🔴 列表列的 `details` 係**空**（真實 payload 就是這樣）
 *   · 🔴 Vue 3：`__vue__` **唔存在**（vueProbe 全 false）
 *     ⇒ 帳期 id 只能靠**網絡攔截**（`onDetail` 模擬平台發請求）
 */
function buildPage(opts) {
  opts = opts || {};
  const root = makeEl("body", { w: 1280, h: 900 });

  // ── 商家下拉（多選標籤型，同真機一致）──
  // ⚠️ `noStoreSelect:true` ⇒ 完全唔起商家下拉（模擬「去錯頁／未入對帳頁」）。
  //    用嚟驗 `MFOODFIN_STORE_OPTIONS` 嘅情境①（搵唔到容器）。
  const selectWrap = opts.noStoreSelect
    ? null
    : append(root, makeEl("div", { cls: "el-select el-select--mini", w: 230, h: 32 }));
  // 🔴🔴 2026-09-30：支援 `singleSelect` —— 真機 mfood 商家選擇器其實係**單選**
  //    （readonly input ＋ placeholder「全部」，冇 `.el-select__tags`；揀咗之後
  //    值顯示喺 input.value）。多選型（tags）同單選型都要測到。
  const isSingle = !!opts.singleSelect && !opts.noStoreSelect;
  const storeInput = selectWrap
    ? append(
        selectWrap,
        makeEl("input", {
          cls: "el-input__inner",
          value: "",
          w: 198,
          h: 28,
          attrs: { placeholder: "全部", readonly: "" },
        }),
      )
    : null;
  const tagsWrap = selectWrap && !isSingle
    ? append(selectWrap, makeEl("div", { cls: "el-select__tags", w: 198, h: 28 }))
    : null;
  if (selectWrap && opts.storeValue) {
    if (isSingle) storeInput.value = opts.storeValue;
    else append(tagsWrap, makeEl("span", { cls: "el-tag", text: opts.storeValue, w: 100, h: 22 }));
  }

  const dropdown = opts.noStoreSelect
    ? null
    : append(root, makeEl("div", { cls: "el-select-dropdown" }));
  const storeNames = opts.storeOptions || ["表嫂美食", "另一家分店"];
  const optionEls = opts.noStoreSelect
    ? []
    : storeNames.map((name) => {
        // 🔴🔴 2026-09-30：選項嘅「揀中」邏輯**一定要掛 `addEventListener("click")`**，
        //    唔可以只靠 `makeEl` 嘅 `opts.onClick`（後者只有 `.click()` 會觸發）。
        //    原因：真機平台自己嘅選項 handler 係 DOM 事件監聽；
        //    bridge 改用真實 pointer 序列（`dispatchEvent`）之後，
        //    `.click()` 唔再係唯一入口 ⇒ 只掛 `opts.onClick` 嘅假選項
        //    會「搵到但撳唔到」，令測試誤報「名稱唔啱」（實測中過）。
        const picked = () => {
          // 🔴🔴 2026-09-30：`clicked` 一定要喺**呢度**累加。
          //    以前只有 `makeEl` 嘅 `click()` 會加 `clicked`；bridge 改用真實
          //    pointer 序列（`dispatchEvent`）之後，`.click()` 唔再係唯一入口
          //    ⇒ 選項明明撳中咗，`clicked` 仍然係 0 ⇒ 一堆「撳中 index N」斷言假紅。
          li.clicked++;
          if (isSingle) {
            // 單選型：撳完把值寫入 input（同真後台一致）
            storeInput.value = name;
          } else {
            // 多選型：撳完會多一個 tag（模擬真後台行為）
            append(tagsWrap, makeEl("span", { cls: "el-tag", text: name, w: 100, h: 22 }));
          }
          if (typeof opts.onPickStore === "function") opts.onPickStore(name);
        };
        const li = append(
          dropdown,
          makeEl("li", {
            cls: "el-select-dropdown__item",
            w: 200,
            h: 30,
            // 兩條路都要通：`.click()`（舊路）同真實事件序列（新路）
            onClick: picked,
          }),
        );
        li.addEventListener("click", picked);
        // 真機選項文字喺 `<li><span>店名</span></li>` 入面 —— 加個 span 子節點，
        // 令 `textContent` 同真 DOM 一致（bridge 靠 textContent 比對）。
        append(li, makeEl("span", { text: name }));
        return li;
      });
  // 未展開時選項量到 0×0（模擬開合動畫）
  if (opts.dropdownOpen === false) {
    for (const o of optionEls) {
      o._w = 0;
      o._h = 0;
    }
  }

  // ── 🔴🔴 2026-09-30（真機）：商家下拉嘅「撳開」行為 ─────────────────
  //
  //  ① `storeNeedsPointer:true` ⇒ `el.click()` **完全冇反應**。
  //     只有真實 pointer 序列（有 `mousedown`，且 `bubbles:true`）先開到。
  //     呢個係照真機抄：用家手動撳一下就有選項，程式 `.click()` 就 0 個選項。
  //  ② `storeLazyOptions:true` ⇒ 選項**懶載入**：開咗之後要再派一次
  //     `keydown`（ArrowDown，即人手撳方向鍵）先 render 得出選項。
  //     `storeLazyDelayMs` 可以令佢延遲先出現（模擬遠端搜尋）。
  //
  //  ⚠️ 兩者都**只影響商家下拉**，唔會拖慢其他測試（預設全部唔開）。
  if (selectWrap && (opts.storeNeedsPointer || opts.storeLazyOptions)) {
    const lazyState = { on: false, rendered: false, timer: null };
    const caret = append(
      selectWrap,
      makeEl("i", { cls: "el-select__caret el-input__icon el-icon-arrow-up", w: 14, h: 14 }),
    );
    const boxOpen = () => {
      selectWrap.classList.add("is-focus");
      caret.classList.add("is-reverse");
    };
    const boxClose = () => {
      selectWrap.classList.remove("is-focus");
      caret.classList.remove("is-reverse");
    };
    const renderOptions = () => {
      if (lazyState.rendered) return;
      lazyState.rendered = true;
      for (const o of optionEls) {
        // 由「未展開尺寸」還原到真實尺寸 ⇒ `visible()` 先會係 true
        o._w = 200;
        o._h = 30;
      }
    };
    const open = () => {
      lazyState.on = true;
      boxOpen();
      if (!opts.storeLazyOptions) {
        renderOptions();
        return;
      }
      const delay = opts.storeLazyDelayMs || 0;
      if (delay > 0) {
        lazyState.timer = setTimeout(renderOptions, delay);
      }
      // 延遲模式：等 ArrowDown（或超時）先 render
    };
    const toggle = () => {
      if (lazyState.on) {
        lazyState.on = false;
        boxClose();
      } else {
        open();
      }
    };
    // ① 只有真實 pointer 序列（帶 mousedown）先會行到呢個 handler
    const onPointerPress = (ev) => {
      if (!ev.bubbles) return;
      toggle();
    };
    selectWrap.addEventListener("mousedown", onPointerPress);
    storeInput.addEventListener("mousedown", onPointerPress);
    // ② 鍵盤 fallback：ArrowDown ⇒ 令選項（即刻）出現
    const onKeyDown = (ev) => {
      if (ev.key !== "ArrowDown") return;
      if (!lazyState.on) open();
      if (lazyState.timer) {
        clearTimeout(lazyState.timer);
        lazyState.timer = null;
      }
      renderOptions();
    };
    selectWrap.addEventListener("keydown", onKeyDown);
    storeInput.addEventListener("keydown", onKeyDown);
    // 真機撳 body 會收埋 popper
    root.addEventListener("click", () => {
      lazyState.on = false;
      boxClose();
    });
  }

  // ── 查詢／重置 ──
  const btnRow = append(root, makeEl("div", { cls: "toolbar" }));
  const queryBtn = append(
    btnRow,
    makeEl("button", { cls: "el-button el-button--primary", text: "查詢", onClick: opts.onQuery }),
  );
  append(
    btnRow,
    makeEl("button", { cls: "el-button el-button--default", text: "重置", onClick: opts.onReset }),
  );

  // ── 帳期表格 ──
  const table = append(root, makeEl("table", { cls: "el-table" }));
  const tbody = append(table, makeEl("tbody", {}));
  const periods = opts.periods || ["2026-09-19 ~ 2026-09-26"];
  const rowEls = periods.map((p, idx) => {
    const tr = append(tbody, makeEl("tr", { cls: "el-table__row" }));
    append(tr, makeEl("td", { text: p, w: 200 }));
    const actionTd = append(tr, makeEl("td", { cls: "el-table_1_column_6", w: 120 }));
    append(
      actionTd,
      makeEl("button", {
        cls: "el-button el-button--default",
        text: "查看詳情",
        w: 80,
        onClick: () => {
          // 🔴 模擬「平台自己發 detail 請求」→ MAIN world 攔截 → post 過嚟。
          //    呢個係 2026-09-28 之後嘅**唯一可靠**帳期 id 來源（Vue 3 冇 __vue__）。
          if (typeof opts.onDetail === "function") opts.onDetail(idx, p);
        },
      }),
    );
    // 🔴 刻意**唔**掛 __vue__ —— 真機 Vue 3 就係冇。舊測試靠佢係脫離現實。
    return tr;
  });

  // ── 🔴 第十六次真機：明細彈窗嘅分頁器（「每頁筆數」下拉 ＋ 「下一頁」掣）──
  //
  //    真機 DOMDUMP 實證：
  //      `.el-dialog > .el-pagination > .el-pagination__sizes > .el-select`
  //      input 值 = "20項/頁"，闊 110px，冇 tags，
  //      選項 = 10項/頁 | 20項/頁 | 30項/頁 | 40項/頁 | 50項/頁
  //
  //    冇呢幾粒嘢，「立即對帳要自己撳到 50」呢條需求就**冇得測**——
  //    測試會全部靜默走「搵唔到下拉」嘅分支（假綠）。
  const pgSize = opts.pageSizeSelect || null;
  let sizeInput = null;
  let sizeOptions = [];
  let nextBtn = null;
  // 🔴🔴 一定要喺 `if (pgSize)` **外面**宣告：
  //    `openDialog()` 喺區塊外，若 `dialog` 只喺區塊內 `const`，
  //    冇 pageSizeSelect 嘅舊測試（如 [2]）一撳「查看詳情」就會
  //    `ReferenceError: dialog is not defined` ⇒ 假紅。
  let dialog = null;
  let closeBtn = null;

  if (pgSize) {
    dialog = append(root, makeEl("div", { cls: "el-dialog", w: 900, h: 600 }));
    // 🔴🔴 第十七次真機：彈窗一定要有「關閉」掣 ——
    //    行完一個帳期要閂彈窗先撳到下一列；冇呢粒掣，「多帳期走訪」冇得測。
    const header = append(dialog, makeEl("div", { cls: "el-dialog__header", w: 860, h: 40 }));
    closeBtn = append(
      header,
      makeEl("button", {
        cls: "el-dialog__headerbtn",
        text: "×",
        w: 30,
        h: 30,
        onClick: () => {
          // 模擬平台：撳關閉 ⇒ 彈窗消失（量度 0×0 ⇒ `visible()` 為 false）
          dialog._w = 0;
          dialog._h = 0;
          if (typeof opts.onDialogClose === "function") opts.onDialogClose();
        },
      }),
    );
    const pagination = append(dialog, makeEl("div", { cls: "el-pagination", w: 860, h: 40 }));
    const sizes = append(pagination, makeEl("div", { cls: "el-pagination__sizes", w: 110, h: 32 }));
    const wrap = append(sizes, makeEl("div", { cls: "el-select", w: 110, h: 32 }));
    sizeInput = append(
      wrap,
      makeEl("input", {
        cls: "el-input__inner",
        value: (pgSize.current || 20) + "項/頁",
        w: 100,
        h: 30,
      }),
    );
    const pgDropdown = append(root, makeEl("div", { cls: "el-select-dropdown" }));
    sizeOptions = (pgSize.options || [10, 20, 30, 40, 50]).map((n) => {
      const setSize = () => {
        // 模擬真後台：撳完選項 → input 值變 → 平台用新 pageSize 再發請求
        sizeInput.value = n + "項/頁";
        if (typeof opts.onPageSizeChange === "function") opts.onPageSizeChange(n);
      };
      const li = append(
        pgDropdown,
        makeEl("li", {
          cls: "el-select-dropdown__item",
          text: n + "項/頁",
          w: 100,
          h: 30,
          onClick: setSize,
        }),
      );
      // 同上：真實 pointer 序列都要生效（bridge 已改用 dispatchEvent）
      li.addEventListener("click", setSize);
      return li;
    });
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
  }

  // ── 🔴🔴 誘餌下拉（2026-09-30 真機 bug 守衛）────────────────────────
  //
  //    真機財務頁有**好幾個** `.el-select`（月份／狀態／商家／分頁）。
  //    商家欄其實係**單選**（冇 `.el-select__tags`），而誘餌係**多選帶 tags 而且更闊**
  //    ⇒ 舊 `findStoreSelectControl()` 嘅 `hasTags +100` 一定壓過真商家欄
  //    ⇒ 撳開錯嘅下拉 ⇒ 商家選項永遠唔會出現 ⇒ 對帳卡喺 `store` 步
  //    （就係「撳咗商家下拉但 1620ms 內一個可見選項都冇」）。
  //
  //    🔴 誘餌一定要**有自己嘅 popper 同選項**（唔可以淨係得個殼），
  //      否則測唔到「撳開咗另一個下拉」呢個真機情境。
  const decoy = { wrap: null, input: null, tags: null, options: [], picked: 0 };
  if (opts.decoySelect) {
    decoy.wrap = append(
      root,
      makeEl("div", { cls: "el-select el-select--mini", w: 300, h: 32, top: 0 }),
    );
    decoy.input = append(
      decoy.wrap,
      makeEl("input", {
        cls: "el-input__inner",
        value: "",
        w: 268,
        h: 28,
        attrs: { placeholder: "請選擇" },
      }),
    );
    // 🔴 帶 tags ⇒ 舊評分 +100，排喺真商家欄（單選冇 tags）前面
    decoy.tags = append(decoy.wrap, makeEl("div", { cls: "el-select__tags", w: 268, h: 28 }));
    const dDrop = append(root, makeEl("div", { cls: "el-select-dropdown" }));
    decoy.options = ["10項/頁", "20項/頁", "50項/頁"].map((t) => {
      const bump = () => {
        decoy.picked++;
      };
      const li = append(
        dDrop,
        makeEl("li", {
          cls: "el-select-dropdown__item",
          w: 200,
          h: 30,
          onClick: bump,
        }),
      );
      // 同上：真實 pointer 序列都要計到（否則「冇撳中誘餌」會變成永遠通過）
      li.addEventListener("click", bump);
      append(li, makeEl("span", { text: t }));
      return li;
    });
  }

  return {
    root,
    decoy,
    storeInput,
    tagsWrap,
    optionEls,
    queryBtn,
    rowEls,
    dropdown,
    selectWrap,
    storeInput,
    sizeInput,
    sizeOptions,
    nextBtn,
    dialog: dialog,
    closeBtn: closeBtn,
    /** 模擬「撳查看詳情 ⇒ 彈窗打開」（多帳期走訪用）。 */
    openDialog() {
      if (!dialog) return;
      dialog._w = 900;
      dialog._h = 600;
    },
  };
}

// ------------------------------------------------------------ 載入 bridge

function loadBridge(opts) {
  opts = opts || {};
  const fetchCalls = [];
  let listener = null;
  let reloaded = 0;

  // 🔴 記錄「平台自己發嘅財務請求」—— 模擬 mfood-inject.js 嘅攔截行為。
  //    真機 Vue 3 冇 `__vue__`，帳期 id 只可以由此路嚟。
  const postedFinance = [];

  // 逐次呼叫嘅回應（可以係陣列，模拟翻頁）
  const replies = Array.isArray(opts.replies) ? opts.replies.slice() : null;
  let replyIdx = 0;

  /**
   * 假 fetch —— 同時扮 bridge（isolated）**同** MAIN world 嘅請求。
   *
   * 🔴 2026-09-28 第四次真機：`_get-order-summary-list` 係 **POST-only**。
   *    真機用 GET 打會 404。測試替身一定要**模仿呢個行為**，
   *    否則「用錯 method」呢類 bug 會喺測試全綠嘅情況下溜過（今次正正係咁）。
   *
   * 🔴 2026-09-28 第六次真機：請求一定要**帶簽章標頭**（`x-ca-*`），
   *    否則真機（Alibaba 閘道）會拒收 ⇒ `Failed to fetch`。
   *    替身亦要模擬呢點：冇簽章就回一個「網絡層失敗」。
   */
  function sandboxFetch(url, init) {
    fetchCalls.push({ url: String(url), init: init || {} });

    const method = String((init && init.method) || "GET").toUpperCase();
    const hdrs = (init && init.headers) || {};
    const hasSig = Object.keys(hdrs).some((k) =>
      /^x-ca-|signature|nonce|timestamp|token|authorization/i.test(k),
    );

    const isSummaryList = String(url).indexOf("_get-order-summary-list") >= 0;
    if (isSummaryList && method !== "POST") {
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("404 Not Found"),
        json: () => Promise.reject(new Error("404")),
      });
    }

    // 🔴 冇簽章 ⇒ 模擬閘道拒收（真機表現為 fetch reject `Failed to fetch`）
    if (isSummaryList && !hasSig) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }

    let body;
    // 🔴 2026-09-28 第八次真機：`paginate` ＝ 更貼近真機嘅假伺服器。
    //    真機係「按請求嘅 pageNo/pageSize 切片」，唔係「按呼叫次序回」。
    //    若唔模擬呢點，一旦 pageSize 由 50 拉到 200，
    //    「每頁固定回 50」嘅舊替身就會令 `rows.length(50) < pageSize(200)`
    //    ⇒ 生產邏輯誤判「已係最後一頁」而停手（假陰性）。
    if (Array.isArray(opts.paginate)) {
      const allRows = opts.paginate;
      let reqPageNo = 1;
      let reqPageSize = 20;
      try {
        const b = JSON.parse((init && init.body) || "{}");
        if (isFinite(Number(b.pageNo))) reqPageNo = Number(b.pageNo);
        if (isFinite(Number(b.pageSize))) reqPageSize = Number(b.pageSize);
      } catch (e) {
        /* 保持預設 */
      }
      const startIdx = (reqPageNo - 1) * reqPageSize;
      body = {
        result: allRows.slice(startIdx, startIdx + reqPageSize),
        total: allRows.length,
      };
    } else if (replies) {
      body = replies[Math.min(replyIdx, replies.length - 1)];
      replyIdx++;
    } else {
      body = opts.response !== undefined ? opts.response : { result: [], total: 0 };
    }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    // 🔴 2026-09-28 第八次真機：模擬「平台對 pageSize 有上限」。
    //    設 `rejectPageSizeAbove: 100` ⇒ 任何 pageSize > 100 都回 400。
    //    用途：驗證降級階梯（200 → 100 → 50 → 20）真係會重試而唔係直接失敗。
    if (isSummaryList && isFinite(Number(opts.rejectPageSizeAbove))) {
      let reqSize = null;
      try {
        reqSize = JSON.parse((init && init.body) || "{}").pageSize;
      } catch (e) {
        reqSize = null;
      }
      if (isFinite(Number(reqSize)) && Number(reqSize) > Number(opts.rejectPageSizeAbove)) {
        const msg = JSON.stringify({ code: 400, message: "pageSize 超出上限" });
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve(msg),
          json: () => Promise.resolve(JSON.parse(msg)),
        });
      }
    }
    return Promise.resolve({
      ok: opts.httpOk !== false,
      status: opts.status || 200,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(parsed),
    });
  }

  const location = {
    href: "https://merchant.mfoodapp.com/" + (opts.hash || FINANCE_HASH),
    hash: opts.hash || FINANCE_HASH,
    origin: "https://merchant.mfoodapp.com",
    reload() {
      reloaded++;
    },
  };

  // message 監聽（bridge 會 addEventListener("message")）
  const msgListeners = [];

  /**
   * 模擬 MAIN world（mfood-inject.js）post 一條財務事件過嚟。
   * 真機上呢個係由頁面自己發請求時被攔截觸發。
   *
   * 🔴 2026-09-28 第六次真機：MAIN world 會**記低最近一次財務請求範本**
   *    （`lastFinanceReq`，含 url/method/headers/body）。重放就係用佢。
   *    所以 harness 每次收到 `finance_request` 都要記低 —— 包括測試自訂注入嘅，
   *    否則重放時冇範本（＝模擬失真）。
   */
  function emitInjectEvent(obj) {
    const ev = { source: win.window, data: obj };
    if (
      obj &&
      obj.__mfoodFinance === true &&
      obj.kind === "finance_request" &&
      obj.payload
    ) {
      const p = obj.payload;
      // 🔴 2026-09-28 第六次真機：只認 `-list`（明細，有 pageNo/pageSize）。
      //    `-data`（匯總）後到唔可以覆蓋成範本 —— 同 mfood-inject.js 一致。
      if (p.url && p.summaryId && /_get-order-summary-list/i.test(String(p.url))) {
        lastMainWorldTemplate = p;
      }
    }
    for (const fn of msgListeners) {
      try {
        fn(ev);
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  const postMessageCount = { headers: null, url: null, replayCmds: 0 };
  // 🔴 MAIN world 記低嘅「最近一次帶 id 嘅財務請求範本」（＝ `lastFinanceReq`）
  let lastMainWorldTemplate = null;

  // 「今次查詢」類型嘅請求範本（帳期列表請求；欄位齊全，重放時照抄）。
  //   真機上呢個係平台按「查詢」時發嘅，MAIN world 一定攔到。
  const DEFAULT_LIST_TEMPLATE = {
    url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
    origin: "https://management-api.mfoodapp.com",
    path: "/merchants/summarys/summary/_get-order-summary-list",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      "x-ca-key": "203800000",
      "x-ca-nonce": "test-nonce-default",
      "x-ca-timestamp": "1789488000000",
      "x-ca-signature": "TESTSIGNATURE==",
    },
    body: JSON.stringify({ storeId: "STORE-DEFAULT", pageNo: 1, pageSize: 50 }),
  };

  /** 模擬「按查看詳情 → 平台發 detail 請求 → inject 攔截 → post」 */
  function simulateDetailRequest(idx, period) {
    // summaryIds 選項：由測試指定每列嘅 id（無 → 唔發，模擬撈唔到）
    const ids = opts.summaryIds || [];
    const id = ids[idx];
    // `full` ＝ 完整請求範本（MAIN world 重放時照抄）—— 第六次真機新增。
    const fullPayload = {
      url:
        "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
      origin: "https://management-api.mfoodapp.com",
      path: "/merchants/summarys/summary/_get-order-summary-list",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json;charset=UTF-8",
        "x-ca-key": "203800000",
        "x-ca-nonce": "test-nonce-" + idx,
        "x-ca-timestamp": "1789488000000",
        "x-ca-signature": "TESTSIGNATURE==",
      },
      body: opts.listBody
        ? String(opts.listBody).replace("__WEEKID__", String(id))
        : JSON.stringify({ weekId: String(id), pageNo: 1, pageSize: 50 }),
    };
    postedFinance.push({
      url: "detail",
      summaryId: id || null,
      kind: "detail",
      at: Date.now(),
      full: id ? fullPayload : null,
    });
    if (!id) return; // 撈唔到 → 唔 post（模擬真機搵唔到嘅情況）
    // 🔴 2026-09-28 第四次真機：真機請求係 **POST + `weekId` 喺 body**（POST-only 路由）。
    //    舊測試替身寫成 GET + query ⇒ 掩蓋咗「用錯 method」嘅 bug。
    //    同時帶上 `origin`/`path`（第五次真機：真機 host ≠ 頁面 origin）。
    emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_request",
      payload: Object.assign({ summaryId: String(id), kind: "detail", at: Date.now() }, fullPayload),
      meta: { transport: "capture" },
    });
  }

  // 🔴 2026-09-28 第六次真機：**重放改由 MAIN world 執行**。
  //    所以 harness 一定要模擬 MAIN world 收到 `__mfoodCmd` 之後：
  //      ① 用攔截到嘅標頭（含簽章）自己發請求
  //      ② 把結果 post 返 `finance_replay_result` 過嚟
  //    呢個替身如果唔做，bridge 永遠等唔到回覆 → 測試掛死。
  function simulateMainWorldReplay(cmd) {
    const summaryId = cmd.summaryId == null ? null : String(cmd.summaryId);
    const reqId = cmd.reqId || null;

    // 範本 ＝ MAIN world 嘅 `lastFinanceReq`（最近一次**帶 id** 嘅財務請求）
    const tpl = lastMainWorldTemplate;

    if (!tpl || !summaryId) {
      emitInjectEvent({
        __mfoodFinance: true,
        kind: "finance_replay_result",
        payload: {
          reqId,
          ok: false,
          reason: tpl ? "冇帳期 id" : "MAIN world 未有財務請求範本",
          requestUrl: tpl ? tpl.url : null,
        },
        meta: { transport: "replay" },
      });
      return;
    }

    const url = tpl.url;
    // 標頭：照抄範本。
    //   · 範本**有** headers 欄位（真機一定有）⇒ 原樣照抄（空就係空，忠實反映
    //     「攔唔到簽章」→ 閘道拒收 → 重放必須大聲失敗）。
    //   · 範本**冇** headers 欄位（舊式測試注入嘅精簡 payload）⇒ 補一組含簽章，
    //     因為真機 MAIN world 由 `captureFinanceRequest` 記低嘅一定含簽章。
    let headers;
    if (Object.prototype.hasOwnProperty.call(tpl, "headers")) {
      headers = Object.assign({}, tpl.headers);
    } else {
      headers = {
        Accept: "application/json",
        "Content-Type": "application/json;charset=UTF-8",
        "x-ca-key": "203800000",
        "x-ca-nonce": "test-nonce",
        "x-ca-timestamp": "1789488000000",
        "x-ca-signature": "TESTSIGNATURE==",
      };
    }

    // body：照抄範本 body 內其他欄位（storeId/orderType…），只換 weekId/pageNo
    let baseObj = {};
    try {
      baseObj = tpl.body ? JSON.parse(tpl.body) : {};
    } catch (e) {
      baseObj = {};
    }
    if (!baseObj || typeof baseObj !== "object") baseObj = {};
    // 🔴 2026-09-28 第八次真機：替身要**鏡像生產邏輯** ——
    //    pageSize 一律拉到最大（`MAX_PAGE_SIZE`），唔可以照抄範本。
    //    否則「有冇拉到最大」嘅測試會因為替身自己嘅行為而假綠。
    const MAX_PAGE_SIZE = 200;
    const PAGE_SIZE_LADDER = [200, 100, 50, 20];
    const bodyObj = Object.assign({}, baseObj, {
      weekId: summaryId,
      pageNo: 1,
      pageSize:
        isFinite(Number(baseObj.pageSize)) && Number(baseObj.pageSize) > MAX_PAGE_SIZE
          ? Number(baseObj.pageSize)
          : MAX_PAGE_SIZE,
    });

    postMessageCount.headers = headers;
    postMessageCount.url = url;

    // 逐頁抓（模擬 MAIN world 嘅翻頁邏輯）
    const all = [];
    let page = 1;
    const maxPages = 40;
    // 降級狀態（鏡像生產）
    let sizeIdx = 0;
    let downgrades = 0;
    const MAX_DOWNGRADES = PAGE_SIZE_LADDER.length - 1;

    function fetchPage() {
      bodyObj.pageNo = page;
      return sandboxFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyObj),
        credentials: "include",
      }).then(
        (r) =>
          r.text().then((txt) => {
            if (!r.ok) {
              // 🔴 鏡像生產：4xx 且仲有得降 ⇒ 降級重試同一頁（唔跳頁）
              if (
                r.status >= 400 &&
                r.status < 500 &&
                downgrades < MAX_DOWNGRADES &&
                Number(bodyObj.pageSize) > PAGE_SIZE_LADDER[sizeIdx + 1]
              ) {
                sizeIdx += 1;
                downgrades += 1;
                bodyObj.pageSize = PAGE_SIZE_LADDER[sizeIdx];
                return fetchPage();
              }
              return { ok: false, reason: "HTTP " + r.status + "｜" + url, status: r.status };
            }
            let body = null;
            try {
              body = JSON.parse(txt);
            } catch (e) {
              body = null;
            }
            if (!body) return { ok: false, reason: "平台回應不是 JSON", status: r.status };
            const container = body.data && typeof body.data === "object" ? body.data : body;
            let rows = container.result || container.records || container.list || [];
            if (!Array.isArray(rows)) rows = [];
            for (const x of rows) all.push(x);
            const total = Number(container.total);
            const pageSize = Number(bodyObj.pageSize) || PAGE_SIZE_LADDER[sizeIdx];
            const enough =
              rows.length === 0 ||
              (isFinite(total) && total > 0 && all.length >= total) ||
              rows.length < pageSize;
            if (enough || page >= maxPages) {
              return {
                ok: true,
                transactions: all,
                pages: page,
                total: isFinite(total) ? total : null,
                pageSize: pageSize,
                downgraded: downgrades,
              };
            }
            page += 1;
            return fetchPage();
          }),
        (err) => ({
          ok: false,
          reason: "請求失敗: " + ((err && err.message) || err),
          networkError: true,
        }),
      );
    }

    fetchPage().then((res) => {
      emitInjectEvent({
        __mfoodFinance: true,
        kind: "finance_replay_result",
        payload: {
          reqId,
          ok: !!res.ok,
          transactions: res.transactions || [],
          pages: res.pages || 0,
          total: res.total == null ? null : res.total,
          reason: res.reason || null,
          status: res.status == null ? null : res.status,
          requestUrl: url,
          requestBody: JSON.stringify(bodyObj),
          headerKeys: Object.keys(headers),
          hasSignature: Object.keys(headers).some((k) =>
            /^x-ca-|signature|nonce|timestamp|token|authorization/i.test(k),
          ),
          // 🔴 2026-09-28 第八次真機：鏡像生產 —— 帶出實際 pageSize ＋ 降級次數
          pageSize: res.pageSize == null ? null : res.pageSize,
          downgraded: res.downgraded || 0,
        },
        meta: { transport: "replay" },
      });
    });
  }

  // 🔴 第十六次真機：分頁器狀態（每頁筆數 / 第幾頁）＋「平台自己重發請求」模擬
  const pgState = {
    size: (opts.pageSizeSelect && opts.pageSizeSelect.current) || 20,
    page: 1,
    idx: 0,
  };
  const pgClicks = { sizeChanges: [], nextPages: 0, dialogCloses: 0 };

  /**
   * 模擬「MAIN world 被動抄低平台自己發嘅明細回應」。
   *
   * 🔴 呢個先係第十六次真機嘅**主力資料來源**（零 CORS、零重放）。
   *    測試一定要有方法餵呢個事件，否則「被動搭便車」條路冇得驗。
   */
  function emitDetailCapture(rows, total, sid) {
    const list = Array.isArray(rows) ? rows : [];
    emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_detail_captured",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
        // 🔴🔴 第十七次真機：`undefined` ＝ 冇畀 ⇒ 跌返 `summaryIds[0]`（舊測試行為）；
        //    `null` ＝ 測試**刻意**話「呢個帳期撈唔到 id」⇒ 一定要照傳 null，
        //    唔可以跌返 fallback（否則多帳期測試會假綠）。
        summaryId:
          sid === undefined
            ? (opts.summaryIds && String(opts.summaryIds[0])) || null
            : sid == null
              ? null
              : String(sid),
        result: list,
        rawResult: list,
        total: total == null ? list.length : total,
        firstRowKeys: list.length && list[0] && typeof list[0] === "object" ? Object.keys(list[0]) : [],
      },
      meta: { transport: "capture" },
    });
  }

  /** 按「目前每頁筆數 / 頁數」切片回應（模擬平台伺服器）。 */
  function servePage(idx) {
    const i = normIdx(idx);
    const rows = rowsForIndex(i);
    if (!Array.isArray(rows)) return;
    const all = rows;
    const start = (pgState.page - 1) * pgState.size;
    const slice = all.slice(start, start + pgState.size);
    // 網絡有延遲 ⇒ 用 setTimeout（bridge 嗰邊係「撳完再等新回應」）
    setTimeout(() => emitDetailCapture(slice, all.length, sidForIndex(i)), 120);
  }

  /** `undefined` ⇒ 用「而家撳開咗邊個帳期」（舊測試冇分帳期 ⇒ 0）。 */
  function normIdx(idx) {
    if (typeof idx === "number") return idx;
    return typeof pgState.idx === "number" ? pgState.idx : 0;
  }

  /**
   * 🔴 第十七次真機：**每個帳期可以有自己嘅明細**。
   *    `opts.captureRows`          → 全部帳期共用一份（舊測試）
   *    `opts.captureRowsByIndex`   → `[rows0, rows1, ...]` 逐帳期唔同
   */
  function rowsForIndex(idx) {
    const i = normIdx(idx);
    if (Array.isArray(opts.captureRowsByIndex)) {
      return opts.captureRowsByIndex[i] || [];
    }
    return opts.captureRows;
  }

  function sidForIndex(idx) {
    const i = normIdx(idx);
    // 🔴🔴 第十七次真機：**每個帳期有自己嘅 id**（`summaryIds:[a,b,c]`）。
    //    呢個函式原本係空嘅 ⇒ `servePage()` 永遠傳 `undefined`
    //    ⇒ `emitDetailCapture` 一律跌返 `summaryIds[0]`
    //    ⇒ 三個帳期撈同一個 id，多帳期測試全部假紅／假綠。
    if (!Array.isArray(opts.summaryIds)) return undefined; // 交返舊邏輯：fallback [0]
    const v = opts.summaryIds[i];
    return v === undefined || v === null ? null : String(v);
  }

  // 🔴 一定要喺 buildPage 之前準備好 callback（buildPage 會即刻綁 onClick）
  const pageOpts = Object.assign({}, opts, {
    onDialogClose: () => {
      pgClicks.dialogCloses++;
      if (typeof opts.onDialogClose === "function") opts.onDialogClose();
    },
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
      // 到尾就 disable（模擬真分頁器）
      if (pgState.page * pgState.size >= all.length && page.nextBtn) {
        page.nextBtn.disabled = true;
      }
    },
    onDetail: (idx, period) => {
      // 🔴 第十七次真機：撳「查看詳情」＝ 打開一個**新**彈窗
      //    （每頁筆數還原 20、頁數還原 1 —— 真機都係咁）
      pgState.idx = idx;
      pgState.page = 1;
      if (opts.keepPageSize !== true) {
        pgState.size = (opts.pageSizeSelect && opts.pageSizeSelect.current) || 20;
        // 真機：重新開彈窗，每頁筆數會還原（唔會記住上次揀嘅 50）
        if (page.sizeInput) page.sizeInput.value = pgState.size + "項/頁";
      }
      page.openDialog();
      if (page.nextBtn) page.nextBtn.disabled = false;
      simulateDetailRequest(idx, period);
      // 🔴 2026-09-28 第六次真機：真機撳「查看詳情」時，平台**一定**會發請求
      //    （至少發一次查詢用的 `_list`）。所以 MAIN world 一定有個可重放嘅範本。
      //    測試若冇畀 summaryIds（模擬「詳情彈窗快取，冇新請求」），
      //    仍要讓 MAIN world 有一個範本 —— 否則重放會失真地失敗。
      if (!lastMainWorldTemplate) lastMainWorldTemplate = DEFAULT_LIST_TEMPLATE;
      if (typeof opts.onDetail === "function") opts.onDetail(idx, period);
      // 🔴 第十六次真機：真機撳「查看詳情」時，平台**一定**會發明細請求，
      //    而 MAIN world **一定會被動抄低**回應（就係使用者喺 Network 見到嗰個）。
      //    冇呢一步，「被動搭便車」條路喺測試入面永遠係空（假綠）。
      //    ⚠️ 冇設 `captureRows` 就唔會發（唔影響舊測試）。
      servePage();
    },
  });
  const page = buildPage(pageOpts);

// ── 🔴🔴 事件替身（2026-09-30）────────────────────────────────────────
// 真機教訓：mfood 個商家下拉用 `.click()` **開唔到**（開完 0 個選項），
// 但人手撳一下就即刻有。所以 bridge 一定要行真實 pointer 序列
// （`pointerdown`/`mousedown`/`mouseup`/`click`，`bubbles`+`cancelable`）。
// 呢度提供最小可用嘅 event 類別，令測試真係驗得到「派咗乜嘢、有冇 bubbles」。
function FakeEvent(type, init) {
  init = init || {};
  this.type = type;
  this.bubbles = !!init.bubbles;
  this.cancelable = !!init.cancelable;
  this.composed = !!init.composed;
  this.detail = init.detail || 0;
  this.button = init.button === undefined ? 0 : init.button;
  this.buttons = init.buttons === undefined ? 0 : init.buttons;
  this.clientX = init.clientX || 0;
  this.clientY = init.clientY || 0;
  this.screenX = init.screenX || 0;
  this.screenY = init.screenY || 0;
  this.key = init.key || "";
  this.code = init.code || "";
  this.keyCode = init.keyCode || 0;
  this.which = init.which || 0;
  this.isTrusted = false;
  this.defaultPrevented = false;
  this.target = null;
}
FakeEvent.prototype.preventDefault = function () {
  this.defaultPrevented = true;
};
FakeEvent.prototype.stopPropagation = function () {
  this._stopped = true;
};
function FakePointerEvent(type, init) {
  FakeEvent.call(this, type, init);
}
FakePointerEvent.prototype = Object.create(FakeEvent.prototype);
function FakeMouseEvent(type, init) {
  FakeEvent.call(this, type, init);
}
FakeMouseEvent.prototype = Object.create(FakeEvent.prototype);
function FakeKeyboardEvent(type, init) {
  FakeEvent.call(this, type, init);
}
FakeKeyboardEvent.prototype = Object.create(FakeEvent.prototype);

// ── `document` 替身：除咗本來嘅查詢，仲要支援**事件監聽/派發** + `activeElement`
//    （bridge 嘅鍵盤 fallback 會派 `keydown` 落 input，亦會 `document.body.click()`）。
const documentStub = {
  readyState: "complete",
  querySelectorAll: (sel) => page.root.querySelectorAll(sel),
  querySelector: (sel) => page.root.querySelector(sel),
  body: page.root,
  activeElement: null,
  _listeners: Object.create(null),
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  },
  removeEventListener(type, fn) {
    const a = this._listeners[type];
    if (a) this._listeners[type] = a.filter((f) => f !== fn);
  },
  dispatchEvent(ev) {
    if (!ev || !ev.type) return true;
    const ls = this._listeners[ev.type];
    if (ls) for (const fn of ls.slice()) fn.call(this, ev);
    return true;
  },
};

  const win = {
    window: {
      location,
      __MFOOD_FINANCE_BRIDGE_INSTALLED__: false,
      // 🔴 2026-09-30：`realPointerPress()` 靠呢兩個 constructor 派事件，
      //    缺咗就會 fallback 去 `window.MouseEvent`（同樣 undefined）而拋錯。
      PointerEvent: FakePointerEvent,
      MouseEvent: FakeMouseEvent,
      KeyboardEvent: FakeKeyboardEvent,
      addEventListener(type, fn) {
        if (type === "message") msgListeners.push(fn);
      },
      postMessage(msg) {
        // bridge 主動問 MAIN world「上次有冇 detail 請求」時回應。
        // 真機上係 inject 側監聽 `__mfoodCmd` 再 post 返 `finance_last_request`。
        if (msg && msg.__mfoodCmd === true && msg.cmd === "finance_last_request") {
          const last = [...postedFinance].reverse().find((p) => p.summaryId);
          emitInjectEvent({
            __mfoodFinance: true,
            kind: "finance_last_request",
            payload: last ? { summaryId: last.summaryId } : { summaryId: null },
            meta: {},
          });
        }
        // 🔴 2026-09-28 第六次真機：bridge 改為「叫 MAIN world 重放」。
        //    harness 要扮 MAIN world：自己發請求，再把結果 post 返。
        if (msg && msg.__mfoodCmd === true && msg.cmd === "finance_replay_list") {
          postMessageCount.replayCmds++;
          setTimeout(() => simulateMainWorldReplay(msg), 0);
        }
      },
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: win.window,
    location,
    document: documentStub,
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    KeyboardEvent: FakeKeyboardEvent,
    chrome: {
      runtime: {
        // 🔴 2026-09-28 第十四次真機：`id` 一定要有。
        //    bridge 新加咗「係唔係 extension context」嘅 guard
        //    （`chrome.runtime.id` 唔存在 ⇒ 直接 return，唔註冊任何嘢），
        //    目的係防止被錯誤注入 MAIN world 時污染 `window` 記號。
        //    呢個 stub 唔加 `id` 就會令所有測試「bridge 乜都唔做」而全紅。
        id: "test-extension-id",
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    fetch: sandboxFetch,
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
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), sandbox, {
    filename: "mfood-finance-bridge.js",
  });

  if (!listener) throw new Error("bridge 冇註冊 onMessage listener");

  /**
   * 送訊息並等回應。
   *
   * 🔴 2026-09-28 修（**測試「無故掛死」嘅真兇**）：
   *    舊寫法每次呼叫都留低**兩個未 clear 嘅 `setTimeout`**（9 秒保險 + 20 秒硬保險）。
   *    一個測試檔有 37 個 group、每個 group 可能呼叫 `send()` 一至兩次
   *    ⇒ 累積數十個 pending timer（每個 9~20 秒）。
   *    Node 事件迴圈要等到**全部** timer 到期才肯收工；而且佢哋會互相排隊，
   *    令後段測試推進極慢。症狀就係：
   *      · `--test` 跑幾十秒後 SIGTERM、輸出被截斷（睇落似「卡死喺某個 group」）
   *      · **掛死位置每次唔同**（取決於 timer 到期 vs 測試推進嘅相對時序）
   *    ⇒ 每次 `finish` 都必須 `clearTimeout` 兩個保險。
   *    ⚠️ 呢個係 harness 病，唔係產品病 —— 但症狀同「bridge 真係卡死」一模一樣，
   *       曾經令人查錯方向（以為係流程邏輯問題）。
   */
  function send(msg) {
    return new Promise((resolve) => {
      let done = false;
      let softTimer = null;
      let hardTimer = null;
      const finish = (v) => {
        if (!done) {
          done = true;
          // 🔴 一定要清 —— 否則每次 send 都留低兩個 dangling timer
          if (softTimer) clearTimeout(softTimer);
          if (hardTimer) clearTimeout(hardTimer);
          resolve(v);
        }
      };
      // 🔴 「一定 resolve」保證：bridge 若同步拋錯（例如改流程時漏咗 guard），
      //    舊寫法會令 `listener(...)` 拋出 ⇒ Promise 永遠 pending / 被 reject
      //    ⇒ 測試「完全冇輸出、被 SIGTERM」，要查好久。
      //    呢個 try/catch ＋ 兩個保險 timer 令佢**一定**返一個結果，
      //    並把錯誤當成「回報物件」傳出去（唔會靜默）。
      try {
        listener(msg, {}, finish);
      } catch (e) {
        finish({
          ok: false,
          reason: "bridge 同步拋錯：" + ((e && e.stack) || e),
          __harnessError: true,
        });
      }
      // 流程有 sleep（300+1800+1200ms…）→ 預留足夠時間
      softTimer = setTimeout(() => finish(undefined), opts.timeout || 9000);
      // 更長嘅硬保險（防某個 Promise 卡死）
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
    fetchCalls,
    postedFinance,
    emitInjectEvent,
    postMessageCount,
    /**
     * 🔴 直接送一條訊息並等回應（唔經 `send` 的流程保鮮）。
     * 用於**唯讀診斷型** handler（例如 `MFOODFIN_AMOUNTS`）——
     * 呢啲 handler 同步回覆，唔會牽動慢路。
     */
    ask(msg, timeoutMs) {
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (v) => {
          if (!done) {
            done = true;
            // 🔴 同 `send()` 一樣：一定要清 timer（見該處註釋）
            if (timer) clearTimeout(timer);
            resolve(v);
          }
        };
        try {
          listener(msg, {}, finish);
        } catch (e) {
          finish({ ok: false, reason: "同步拋錯：" + ((e && e.message) || e) });
        }
        timer = setTimeout(() => finish(undefined), timeoutMs || 3000);
      });
    },
    /** 模擬 MAIN world 完全冇攔截到財務請求（清走範本）。 */
    clearMainWorldTemplate() {
      lastMainWorldTemplate = null;
    },
    get reloaded() {
      return reloaded;
    },
    /**
     * 🔴 2026-09-28 第七次真機：餵一條「帳期列表回應」事件。
     *
     * 真機形狀（DOMDUMP 實證）：
     *   POST .../summarys/summary/_list
     *   回應 result[] 每項都有 id / startDateStr / endDateStr /
     *   subsidyStoreReceiveAmtn（實收，平台口徑）/ storeReceiveAmtn /
     *   platformServiceFee / details[]。
     *
     * `periods` 可以係：
     *   · 原始 raw 陣列（最貼近真機）→ 自動包成 `{url, periods:[{id,raw}]}`
     *   · 已包好嘅 `{url, periods}` 物件
     */
    emitPeriods(periods) {
      let payload;
      if (Array.isArray(periods)) {
        payload = {
          url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
          periods: periods.map((r) => ({
            id: r && r.id != null ? String(r.id) : null,
            raw: r,
          })),
        };
      } else {
        payload = periods;
      }
      emitInjectEvent({
        __mfoodFinance: true,
        kind: "finance_periods",
        payload,
        meta: { transport: "capture" },
      });
    },
    /** 🔴 第十六次真機：餵一條「平台自己發嘅明細回應」（被動搭便車）。 */
    emitDetailCapture,
    /** 🔴 分頁器被撳嘅記錄（用嚟驗「立即對帳有冇自己撳」）。 */
    pgClicks,
    pgState,
    location,
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

/**
 * 🔴 2026-09-28 第四次真機：帳期 id 唔再喺 URL query，喺 **POST body 嘅 `weekId`**。
 *    所以呢個 helper 兩邊都查（query 或 body），唔好逐個測試改字串。
 */
function fetchUsedId(fetchCalls, id) {
  return fetchCalls.some((c) => {
    if (c.url.indexOf("summaryId=" + id) >= 0) return true;
    if (c.url.indexOf("weekId=" + id) >= 0) return true;
    try {
      const b = c.init && c.init.body ? JSON.parse(c.init.body) : null;
      return !!(b && (String(b.weekId) === String(id) || String(b.summaryId) === String(id)));
    } catch (e) {
      return false;
    }
  });
}

/** 剝走 JS 註解（只保留真正會執行嘅碼）—— 避免註解文字造成假紅燈。 */
function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, "") // 區塊註解
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // 行註解（避開 http://）
}

// ------------------------------------------------------------ 測試

(async () => {
  group("[1] 🔴 唔係財務頁就唔可以亂撳（SPA hash 守衛）");
  {
    const bg = loadBridge({ hash: "#/trade/takeout" });
    const r = await bg.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("說明唔係財務頁", !!(r && r.reason && r.reason.indexOf("財務對帳頁") >= 0), true);
    check("完全冇撳過查詢", bg.page.queryBtn.clicked, 0);
    check("完全冇打 API", bg.fetchCalls.length, 0);
  }

  group("[2] 🔴 四步流程：選商家 → 查詢 → 查看詳情 → 呼叫 API");
  {
    const bg = loadBridge({
      period: "2026-09-19 ~ 2026-09-26",
      summaryIds: ["SUM-1"],
      // 🔴🔴 2026-09-30：以前呢度刻意 `dropdownOpen:false`（「選項未展開時量到 0×0」）。
      //    舊 bridge 只係**讀** `.value` 去假裝「已經揀好」，根本冇真係撳過選項
      //    ⇒ 呢個設定從來冇阻礙過測試（亦因此掩蓋咗「其實撳唔到」）。
      //    而家 bridge 係真係要開下拉、真係要撳選項 ⇒ 一定要令下拉開得到，
      //    否則就係逼 bridge 通過一個**真機上開得到但測試入面永遠開唔到**嘅下拉。
      //    呢個唔係為咗遷就實作，而係修正測試同真機嘅落差（真機選項係睇得到、撳得到）。
      dropdownOpen: true,
      response: {
        result: [
          { tradeNo: "CRD001", storeReceiveAmtn: 31.91, subsidyStoreReceiveAmtn: 5 },
          { tradeNo: "CRD002", storeReceiveAmtn: 30.09 },
        ],
        total: 2,
      },
    });

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 有撳「查詢」", bg.page.queryBtn.clicked >= 1, true);
    check(
      "🔴 有撳「查看詳情」",
      bg.page.rowEls[0].querySelectorAll("button")[0].clicked >= 1,
      true,
    );
    check("回報帳期", r && r.period, "2026-09-19 ~ 2026-09-26");
    check("拿回兩筆 transaction", (r && r.transactions && r.transactions.length) || 0, 2);
    check(
      "🔴 金額原樣保留（元，唔除 100）",
      r && r.transactions[0].storeReceiveAmtn,
      31.91,
    );
    check(
      "🔴 補貼欄位冇被吃掉",
      r && r.transactions[0].subsidyStoreReceiveAmtn,
      5,
    );

    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    check("🔴 有呼叫 transaction detail API", !!api, true);
    // 🔴 2026-09-28 第四次真機：id 唔喺 query，喺 **POST body 叫 `weekId`**。
    //    舊寫法 GET + `?summaryId=` 會 404（POST-only 路由）。
    check("🔴 API 係 POST（唔可以係 GET ⇒ 404）", api && api.init.method, "POST");
    let apiBody = null;
    try {
      apiBody = api && api.init.body ? JSON.parse(api.init.body) : null;
    } catch (e) {
      apiBody = null;
    }
    check("🔴 id 喺 body 嘅 `weekId`", apiBody && apiBody.weekId, "SUM-1");
    check(
      "🔴 query 唔再帶 summaryId（會 404）",
      !!(api && api.url.indexOf("summaryId=") < 0),
      true,
    );
    check(
      "API 用 cookie 認身分（credentials include）",
      api && api.init.credentials,
      "include",
    );
    check(
      "🔴 summaryId 來源係網絡攔截（唔係 DOM／Vue）",
      !!(r && r.trace && r.trace.some((t) => t.step === "summaryId" && t.via === "network-event")),
      true,
    );
    // 🔴 一定要絕對 URL。相對路徑靠 `location.origin` 解析，而某啲環境
    //    （about:blank / data: / 測試替身）origin 係 "null"
    //    ⇒ fetch 拋 "Failed to parse URL from /merchants/..."
    //    ⇒ 上層包成「帳期內冇 transaction」＝ **假成功**（最危險嘅一種）。
    check(
      "🔴 API 用絕對 URL（唔可以係相對路徑）",
      !!(api && api.url.indexOf("https://") === 0),
      true,
    );
    check("trace 有記錄四步", (r && r.trace && r.trace.length) >= 4, true);
  }

  group("[3] 🔴 必須翻頁（total 120，pageSize 拉到最大都一定要翻）");
  {
    // 🔴 2026-09-28 第八次真機：改用 `paginate`（真機語意：按 pageNo/pageSize 切片）。
    //    舊寫法「固定回 50/50/20」係 pageSize=50 時代嘅產物；
    //    pageSize 拉到 200（或降級到 50）之後，固定回 50 會令生產誤判「冇下一頁」。
    const mk = (n, from) =>
      Array.from({ length: n }, (_, i) => ({ tradeNo: "T" + (from + i), storeReceiveAmtn: 1 }));
    const bg = loadBridge({
      summaryIds: ["SUM-2"],
      // 120 筆：若 pageSize 生效為 200，真機一次就回得完 —— 所以用 120 筆驗「total 拐點」。
      paginate: mk(120, 0),
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 總共 120 筆（唔可以只拿第一頁）", (r && r.transactions.length) || 0, 120);
    const apiCalls = bg.fetchCalls.filter((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    const bodyOf = (c, k) => {
      try {
        return c.init && c.init.body ? JSON.parse(c.init.body)[k] : null;
      } catch (e) {
        return null;
      }
    };
    check("🔴 打到最後一頁（pageSize 內一頁拿完 120 ⇒ 1 次）", apiCalls.length, 1);
    check("🔴 請求 pageSize 唔係 20（一定要拉到最大）", bodyOf(apiCalls[0], "pageSize"), 200);
    check("🔴 由 pageNo=1 開始", bodyOf(apiCalls[0], "pageNo"), 1);
  }

  group("[3b] 🔴 total 大過一頁 ⇒ 一定要翻到第 3 頁");
  {
    // 每頁最多 50（頁面範本 50）→ 120 筆要 3 頁。
    // 🔴 用 `rejectPageSizeAbove: 50` 逼降級到 50，再驗真係翻到第 3 頁。
    const mk = (n, from) =>
      Array.from({ length: n }, (_, i) => ({ tradeNo: "T" + (from + i), storeReceiveAmtn: 1 }));
    const bg = loadBridge({
      summaryIds: ["SUM-2B"],
      rejectPageSizeAbove: 50,
      paginate: mk(120, 0),
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 降級後三頁加起來 120 筆", (r && r.transactions.length) || 0, 120);
    const apiCalls = bg.fetchCalls.filter((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    const okCalls = apiCalls.filter((c) => {
      try {
        return Number(JSON.parse(c.init.body).pageSize) <= 50;
      } catch (e) {
        return false;
      }
    });
    const pageOf = (c) => {
      try {
        return c.init && c.init.body ? JSON.parse(c.init.body).pageNo : null;
      } catch (e) {
        return null;
      }
    };
    check("🔴 用 pageSize=50 真係打咗 3 次", okCalls.length, 3);
    check("第二頁 body 帶 pageNo=2", pageOf(okCalls[1]), 2);
    check("第三頁 body 帶 pageNo=3", pageOf(okCalls[2]), 3);
  }

  group("[4] 🔴 帳期列表嘅 details 係空 → 唔可以靠佢交差");
  {
    // 模擬「DOM 上明明有帳期資料，但 details 係空陣列」嘅真實情況
    const bg = loadBridge({
      summaryIds: ["SUM-3"],
      response: { result: [], total: 0 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("仍然回 ok:true（空帳期係正常）", !!(r && r.ok), true);
    check("transaction 為空", (r && r.transactions.length) || 0, 0);
    check(
      "🔴 但一定有呼叫過 API（唔可以只睇 DOM 就當做完）",
      bg.fetchCalls.some((c) => c.url.indexOf("_get-order-summary-list") >= 0),
      true,
    );
  }

  group("[5] 🔴 撈唔到帳期 id ＝ 硬失敗（唔可以亂猜）");
  {
    // 唔提供 summaryIds → 撳「查看詳情」時 inject 唔會 post detail 請求
    // ⇒ resolveSummaryId 三條路都冇 ⇒ 硬失敗
    const bg = loadBridge({
      response: { result: [{ tradeNo: "X", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check(
      "🔴 講明撈唔到帳期 id",
      !!(r && r.reason && r.reason.indexOf("帳期 id") >= 0),
      true,
    );
    check(
      "🔴 冇亂打一個冇 summaryId 嘅請求",
      bg.fetchCalls.filter((c) => c.url.indexOf("_get-order-summary-list") >= 0).length,
      0,
    );
  }

  group("[6] 🔴 揀錯帳期嘅後果：目標日期一定要落喺區間內");
  {
    const bg = loadBridge({
      periods: ["2026-09-01 ~ 2026-09-15", "2026-09-16 ~ 2026-09-30"],
      summaryIds: ["OLD", "NEW"],
      response: { result: [{ tradeNo: "N1", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 命中第二個帳期", r && r.period, "2026-09-16 ~ 2026-09-30");
    check(
      "🔴 用嘅係第二列嘅 summaryId（唔可以攞錯）",
      fetchUsedId(bg.fetchCalls, "NEW"),
      true,
    );
    check("冇誤用第一個帳期", fetchUsedId(bg.fetchCalls, "OLD"), false);
  }

  group("[7] 🔴 目標日期唔喺任何帳期內 → 要講清楚（唔可以靜默回空）");
  {
    const bg = loadBridge({
      periods: ["2026-09-01 ~ 2026-09-15"],
      summaryIds: ["OLD"],
      response: { result: [], total: 0 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check(
      "🔴 說明邊個日期冇帳期",
      !!(r && r.reason && r.reason.indexOf("2026-09-26") >= 0),
      true,
    );
    check("完全冇打 API", bg.fetchCalls.length, 0);
  }

  group("[8] 🔴 商家名空 → 跟後台預設（唔可以硬開下拉）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-4"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", storeName: "", targetDate: "2026-09-26" });
    check("仍然成功", !!(r && r.ok), true);
    check("🔴 冇撳過商家下拉（單店商戶唔需要選）", bg.page.optionEls[0].clicked, 0);
    check("流程照樣行落去", bg.page.queryBtn.clicked >= 1, true);
  }

  group("[9] 🔴 商家名對唔上 → 大聲失敗（唔可以靜默用錯商家）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-5"],
      response: { result: [], total: 0 },
    });
    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "唔存在嘅店",
      targetDate: "2026-09-26",
    });
    check("回 ok:false", !!(r && r.ok === false), true);
    check(
      "🔴 講明搵唔到呢個商家",
      !!(r && r.reason && r.reason.indexOf("唔存在嘅店") >= 0),
      true,
    );
    check("唔會繼續跑落去（冇打 API）", bg.fetchCalls.length, 0);
  }

  group("[10] 🔴 「查詢」唔可以撳成「重置」");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-6"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    const resetBtn = bg.page.root
      .querySelectorAll("button")
      .find((b) => b.textContent === "重置");
    check("🔴 有撳到「查詢」", bg.page.queryBtn.clicked >= 1, true);
    check("🔴 完全冇撳過「重置」（重置會清空篩選）", resetBtn.clicked, 0);
  }

  group("[11] 🔴 API 出錯要如實回報（唔可以當成「冇 transaction」）");
  {
    const bg = loadBridge({ summaryIds: ["SUM-7"], httpOk: false, status: 500 });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && r.ok === false), true);
    check("帶出 HTTP 狀態", !!(r && r.reason && r.reason.indexOf("500") >= 0), true);
  }

  group("[12] 🔴 全程唔可以 F5（使用者明確要求）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-8"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    await bg.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食", targetDate: "2026-09-26" });

    // ① 執行期唔可以 reload
    check("🔴 執行期間完全冇 reload 過頁面", bg.reloaded, 0);

    // ② 原始碼層面都唔可以有 reload / location.href = 呢類寫法
    //
    // 🔴 必須先剝走註解 —— 呢個檔案嘅檔頭註解**故意**提到「冇任何 location.reload()」
    //    （向後人解釋設計決定）。唔剝註解就會永遠紅燈，
    //    而下一個人只會學到「呢條斷言可以無視」—— 比冇斷言更差。
    const src = stripComments(fs.readFileSync(BRIDGE, "utf8"));
    check("🔴 原始碼冇 location.reload()", /location\s*\.\s*reload\s*\(/.test(src), false);
    check("🔴 原始碼冇 window.location.href 賦值", /location\s*\.\s*href\s*=[^=]/.test(src), false);
    check("原始碼冇 go(0) / replace(", /location\s*\.\s*(go\(0\)|replace\s*\()/.test(src), false);
  }

  group("[13] PROBE 診斷端點（唔會撳任何嘢，只量度）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-9"],
      response: { result: [], total: 0 },
    });
    const r = await bg.send({ type: "MFOODFIN_PROBE", targetDate: "2026-09-26" });
    check("PROBE 有回應", !!(r && r.ok), true);
    check("PROBE 認得呢個係財務頁", r && r.finance, true);
    check("PROBE 量到商家欄位", r && r.storeInput, true);
    check("PROBE 量到帳期列", !!(r && r.periodRow), true);
    // 🔴 PROBE 只量度 —— 用家排查時撳一下唔應該有副作用（改變頁面狀態）
    check("🔴 PROBE 冇撳過查詢", bg.page.queryBtn.clicked, 0);
    check("🔴 PROBE 冇打任何 API", bg.fetchCalls.length, 0);
  }

  group("[14] GRAB_PING 要標示 finance 旗標（background 靠佢分流）");
  {
    const bg = loadBridge({});
    const r = await bg.send({ type: "GRAB_PING" });
    check("回 ok", !!(r && r.ok), true);
    check("🔴 有 finance: true", r && r.finance, true);

    const bg2 = loadBridge({ hash: "#/trade/takeout" });
    const r2 = await bg2.send({ type: "GRAB_PING" });
    check("🔴 非財務頁 finance: false", r2 && r2.finance, false);
  }

  // ════════════════════════════════════════════════════════════════════
  //  商家選擇器：結構定位（2026-09-28 真機修正）
  //  ───────────────────────────────────────────────────────────────────
  //  真機 DOM dump 顯示：商家選擇器係**多選標籤型**（`el-select__tags`，
  //  寬 230px），input 嘅 placeholder 係「全部」而唔係「商家」。
  //  舊寫法靠 placeholder ⇒ 永遠搵唔到（就係「找不到商家下拉」嘅根因）。
  // ════════════════════════════════════════════════════════════════════

  group("[15] 🔴 商家下拉：真機係多選標籤型（placeholder「全部」都要搵到）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-T1"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    // 真機結構：el-select + el-select__tags，placeholder「全部」（唔含「商家」）
    const r = await bg.send({ type: "MFOODFIN_PROBE", targetDate: "2026-09-26" });
    check("🔴 PROBE 搵到商家下拉（唔靠 placeholder）", r && r.storeInput, true);
    check("🔴 認得係多選標籤型", r && r.hasTags, true);
  }

  group("[16] 🔴 選商家：撳 tag 型下拉 → 揀啱目標店 → 落 tag");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-T2"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });
    check("回 ok:true", !!(r && r.ok), true);
    // 有撳過下拉選項（其中一個）
    const anyClicked = bg.page.optionEls.some((o) => o.clicked >= 1);
    check("🔴 有撳過商家選項", anyClicked, true);
    const storeStep = r && r.trace && r.trace.find((t) => t.step === "store");
    check("store 步驟成功", !!(storeStep && storeStep.ok), true);
  }

  group("[17] 🔴 商家已選（tag 含目標名）→ 唔重複撳（already）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-T3"],
      storeValue: "表嫂美食",
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 完全冇撳過任何選項（已選好）", bg.page.optionEls.every((o) => o.clicked === 0), true);
  }

  group("[18] 🔴 商家名係 tag 文字嘅子串都要認（後台名帶分店括號）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-T4"],
      // 真機：tag 文字係「表嫂美食(海贼龍蝦飯)」，目標係「表嫂美食」
      storeValue: "表嫂美食(海贼龍蝦飯)",
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 認得已選（子串比對）→ 唔重複撳", bg.page.optionEls.every((o) => o.clicked === 0), true);
  }

  group("[18b] 🔴🔴 3 間相似分店 + 括號寬度／空格唔同 → 都要揀啱嗰間（2026-09-30 修復）");
  {
    // 真機場景：3 間都叫「表嫂美食(分店X)」，使用者喺 popup 揀咗「分店A」
    const stores3 = ["表嫂美食(分店A)", "表嫂美食(分店B)", "表嫂美食(總店)"];

    // ① 完全相等（半角括號）→ 撳中分店A，唔撳其餘兩間
    const bgA = loadBridge({
      summaryIds: ["SUM-S1"],
      storeOptions: stores3,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const rA = await bgA.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食(分店A)", targetDate: "2026-09-26" });
    check("🔴 回 ok:true", !!(rA && rA.ok), true);
    check("🔴 只撳咗分店A（第 0 個）", bgA.page.optionEls[0].clicked, 1);
    check("🔴 冇撳分店B（第 1 個）", bgA.page.optionEls[1].clicked, 0);
    check("🔴 冇撳總店（第 2 個）", bgA.page.optionEls[2].clicked, 0);

    // ② 🔴🔴 全角括號 mismatch：popup 存咗「表嫂美食（分店A）」（全角（）），
    //    但 DOM 顯示係半角()。舊寫法完全相等＝false、包含＝false ⇒ 揀唔中。
    //    新寫法 normStoreName 歸一 ⇒ 照樣揀中分店A。
    const bgB = loadBridge({
      summaryIds: ["SUM-S2"],
      storeOptions: stores3,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const rB = await bgB.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食（分店A）", targetDate: "2026-09-26" });
    check("🔴 全角括號都揀到 ok:true", !!(rB && rB.ok), true);
    check("🔴 全角括號→照樣撳中分店A", bgB.page.optionEls[0].clicked, 1);
    check("🔴 全角括號→冇撳錯分店", bgB.page.optionEls[1].clicked + bgB.page.optionEls[2].clicked, 0);

    // ③ 尾隨空格 mismatch：popup 存嘅 data-store 帶咗空格
    const bgC = loadBridge({
      summaryIds: ["SUM-S3"],
      storeOptions: stores3,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const rC = await bgC.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食(分店A) ", targetDate: "2026-09-26" });
    check("🔴 尾隨空格都揀到 ok:true", !!(rC && rC.ok), true);
    check("🔴 尾隨空格→撳中分店A", bgC.page.optionEls[0].clicked, 1);
  }

  group("[18c] 🔴🔴 真機單選 DOM（readonly input + 嵌套 span + 全角/空格店名）→ 照樣揀啱（2026-09-30 修復）");
  {
    // 用家貼出嘅真機 3 間分店（注意：① 單選、冇 tags；② 選項文字喺 <li><span> 入面；
    // ③ 店名帶空格 + 半角括號；④ 用家輸入名可能係全角括號）
    const realStores = [
      "表嫂美食 燒烤館 (秘制燒五花, 蒜蓉茄皇, 無敵烤魚)",
      "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)",
      "表嫂美食(海贼龍蝦飯)",
    ];

    // ① 完全相等（半角括號，第 1 個）→ 撳中 index 1
    const bg1 = loadBridge({
      summaryIds: ["SUM-R1"],
      singleSelect: true,
      storeOptions: realStores,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r1 = await bg1.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)", targetDate: "2026-09-26" });
    check("🔴 單選：回 ok:true", !!(r1 && r1.ok), true);
    check("🔴 單選：只撳中 index 1", bg1.page.optionEls[1].clicked, 1);
    check("🔴 單選：冇撳錯 index 0 / 2", bg1.page.optionEls[0].clicked + bg1.page.optionEls[2].clicked, 0);
    check("🔴 單選：input.value 已更新", bg1.page.storeInput.value, "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)");

    // ② 全角括號 mismatch（用家輸入用全角（））→ 歸一後照樣中 index 1
    const bg2 = loadBridge({
      summaryIds: ["SUM-R2"],
      singleSelect: true,
      storeOptions: realStores,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r2 = await bg2.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食（蒸煎手打肉餅,酸菜魚,沙薑雞飯）", targetDate: "2026-09-26" });
    check("🔴 單選+全角括號：回 ok:true", !!(r2 && r2.ok), true);
    check("🔴 單選+全角括號：照樣撳中 index 1", bg2.page.optionEls[1].clicked, 1);

    // ③ 帶空格嗰間（index 0）完全相等 → 撳中 index 0
    const bg3 = loadBridge({
      summaryIds: ["SUM-R3"],
      singleSelect: true,
      storeOptions: realStores,
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r3 = await bg3.send({ type: "MFOODFIN_SYNC", storeName: "表嫂美食 燒烤館 (秘制燒五花, 蒜蓉茄皇, 無敵烤魚)", targetDate: "2026-09-26" });
    check("🔴 單選+空格店名：回 ok:true", !!(r3 && r3.ok), true);
    check("🔴 單選+空格店名：撳中 index 0", bg3.page.optionEls[0].clicked, 1);
  }

  group("[18d] 🔴🔴 頁面上有「帶 tags 嘅誘餌下拉」時，都一定要揀中**真正**嘅商家欄（2026-09-30 真機 bug）");
  {
    // 真機：財務頁有幾個 `.el-select`（月份／狀態／商家／分頁）。
    // 商家欄其實係**單選**（冇 `.el-select__tags`），誘餌係**多選帶 tags 而且更闊**
    // ⇒ 舊 `findStoreSelectControl()` 嘅 `hasTags +100` 一定壓過真商家欄
    // ⇒ 撳開錯嘅下拉 ⇒ 商家選項永遠唔會出現（「零個可見選項」）
    // ⇒ 對帳卡死喺 `store` 步（用家見到「撳咗商家下拉但 1620ms 內一個可見選項都冇」）。
    const bg = loadBridge({
      summaryIds: ["SUM-DECOY"],
      singleSelect: true,
      decoySelect: true,
      storeOptions: ["表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)", "另一家分店"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)",
      targetDate: "2026-09-26",
    });

    check("🔴 有誘餌都回 ok:true（舊 code 呢個會 ok:false）", !!(r && r.ok), true);
    check("🔴 撳中真商家選項（index 0）", bg.page.optionEls[0].clicked, 1);
    check("🔴 冇撳錯第間分店", bg.page.optionEls[1].clicked, 0);
    check("🔴🔴 冇撳中任何誘餌選項", bg.page.decoy.picked, 0);
    check(
      "🔴 商家欄 input.value 已更新",
      bg.page.storeInput.value,
      "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)",
    );
  }

  group("[18e] 🔴🔴 商家下拉靠真實 pointer 序列 ＋ 主動催選項（2026-09-30 真機）");
  {
    // ── 真機現場（用家截圖 + DOM dump）────────────────────────────────
    //   用家：「我只要幫這個步驟按了一下，打開了那個 drop down 就完成了整個對帳流程」
    //   DOM 對比：撳之前 vs 撳之後**只有兩處分別**
    //     · 外層 `.el-input` 多咗 `is-focus`
    //     · 箭頭 `.el-select__caret` 多咗 `is-reverse`
    //   ⇒ 下拉確實開咗，但 `.el-select-dropdown__item` **一個都冇**
    //   ⇒ 用 `.click()` 造嘅合成事件（唔夠像真 pointer）開唔到，或者選項要平台
    //      handler 行完／遠端返咗先 render。
    //   呢兩條回歸就係鎖住呢兩件事。
    const STORE = "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)";

    // ① `.click()` 完全開唔到 ⇒ bridge 必須用 pointer 序列（mousedown 等）
    const bg1 = loadBridge({
      summaryIds: ["SUM-PTR"],
      singleSelect: true,
      storeNeedsPointer: true,
      storeOptions: [STORE, "另一家分店"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r1 = await bg1.send({ type: "MFOODFIN_SYNC", storeName: STORE, targetDate: "2026-09-26" });
    check("🔴 A: `.click()` 開唔到但都要成功（舊 code 呢個會 ok:false）", !!(r1 && r1.ok), true);
    check("🔴 A: 撳中商家選項", bg1.page.optionEls[0].clicked, 1);
    check("🔴 A: 真係派過 mouse 事件（唔可以淨係 .click()）", bg1.page.selectWrap._dispatchCount > 0, true);

    // ② 開咗但選項懶載入 ⇒ 要派 ArrowDown 先 render 得出
    const bg2 = loadBridge({
      summaryIds: ["SUM-LAZY"],
      singleSelect: true,
      storeNeedsPointer: true,
      storeLazyOptions: true,
      storeOptions: [STORE, "另一家分店"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r2 = await bg2.send({ type: "MFOODFIN_SYNC", storeName: STORE, targetDate: "2026-09-26" });
    check("🔴 B: 選項懶載入都要成功（死等一定失敗）", !!(r2 && r2.ok), true);
    check("🔴 B: 撳中商家選項", bg2.page.optionEls[0].clicked, 1);
    check("🔴 B: 商家欄已顯示目標店名", bg2.page.storeInput.value, STORE);

    // ③ 選項延遲先出現（模擬遠端搜尋）⇒ 要有耐心重試，唔可以一開就判死
    const bg3 = loadBridge({
      summaryIds: ["SUM-LAZY2"],
      singleSelect: true,
      storeNeedsPointer: true,
      storeLazyOptions: true,
      storeLazyDelayMs: 400,
      storeOptions: [STORE, "另一家分店"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r3 = await bg3.send({ type: "MFOODFIN_SYNC", storeName: STORE, targetDate: "2026-09-26" });
    check("🔴 C: 選項遲 400ms 返都要成功", !!(r3 && r3.ok), true);
    check("🔴 C: 撳中商家選項", bg3.page.optionEls[0].clicked, 1);
  }

  group("[19] 🔴 帳期 id 來源一定要經網絡攔截（唔可以回歸 DOM）");
  {
    const bg = loadBridge({
      summaryIds: ["SUM-NET"],
      response: { result: [{ tradeNo: "A", storeReceiveAmtn: 1 }], total: 1 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    const step = r && r.trace && r.trace.find((t) => t.step === "summaryId");
    check("🔴 via 標明係網絡來源", !!(step && /network/.test(step.via)), true);
    check("🔴 用嘅係攔截到嘅 id", fetchUsedId(bg.fetchCalls, "SUM-NET"), true);
  }

  group("[20] 🔴 詳情彈窗唔再發請求 → 用帳期列表回應配對 id");
  {
    // 模擬：撳「查看詳情」冇產生新請求（彈窗已存在／快取）
    //      但平台查帳期時嘅 `summary/_list` 回應已被攔截
    const bg = loadBridge({
      periods: ["2026-09-01 ~ 2026-09-15", "2026-09-16 ~ 2026-09-30"],
      // 刻意唔畀 summaryIds → onDetail 唔會 post 任何嘢
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });

    // 喺 SYNNC 之前，模擬平台已載入帳期列表（inject 已 post finance_periods）
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_periods",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
        periods: [
          { id: "PID-OLD", raw: { period: "2026-09-01 ~ 2026-09-15" } },
          { id: "PID-NEW", raw: { period: "2026-09-16 ~ 2026-09-30" } },
        ],
      },
      meta: { transport: "capture" },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    const step = r && r.trace && r.trace.find((t) => t.step === "summaryId");
    check("🔴 via 標明係帳期配對", step && step.via, "periods-map");
    check("🔴 用嘅係第二個帳期嘅 id（按日期配對）", fetchUsedId(bg.fetchCalls, "PID-NEW"), true);
    check("冇誤用第一個帳期", fetchUsedId(bg.fetchCalls, "PID-OLD"), false);
  }

  group("[21] 🔴 撳一次發多個請求 → 要掃全部，唔可以只睇最後一個");
  {
    // 真機實況：撳「查看詳情」會連發多個財務請求，
    // 帶 id 嗰個可能係中間嗰個（如下面嘅 `_get-order-summary-data`），
    // 而**最後**發嘅 `_get-order-summary-list` 反而唔帶 id。
    // 🔴 一定要用 onDetail 回調（撳掣當刻先發）—— 因為 step3 會先
    //    `clearFinanceEvents()` 清走上一輪殘留，預先發嘅會被清掉（正確行為）。
    const bg = loadBridge({
      summaryIds: [], // 唔用 simulateDetailRequest，改用 onDetail 自己發三個
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
      onDetail: () => {
        const emit = (url, summaryId, kind, body) =>
          bg.emitInjectEvent({
            __mfoodFinance: true,
            kind: "finance_request",
            payload: {
              url: "https://management-api.mfoodapp.com/merchants/summarys/summary/" + url,
              method: "POST",
              summaryId: summaryId,
              kind: kind,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json;charset=UTF-8",
                "x-ca-key": "K",
                "x-ca-signature": "S",
              },
              body: body || JSON.stringify({ weekId: summaryId || "", pageNo: 1, pageSize: 20 }),
              at: Date.now(),
            },
            meta: {},
          });
        // 真機次序：先 `_list`（帳期列表），再 `-list`（明細，**帶 id** ← 重放要用），
        // 最後 `-data`（匯總，**唔帶 id**）。
        // 🔴 重點：撳一次發多個請求，帶 id 嗰個喺**中間**，最後一個唔帶 id
        //    ⇒ bridge 一定要掃全部，唔可以只睇最後一個。
        emit("_list", null, "summary_list");
        emit("_get-order-summary-list", "SUM-FROM-DATA", "detail");
        emit("_get-order-summary-data", null, "detail");
      },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check(
      "🔴 用咗中間嗰個請求帶嘅 id",
      fetchUsedId(bg.fetchCalls, "SUM-FROM-DATA"),
      true,
    );
    const step = r && r.trace && r.trace.find((t) => t.step === "summaryId");
    check("via 標明係網絡事件", step && step.via, "network-event");
  }

  group("[22] 🔴 `clearFinanceEvents` 要清走本輪累積嘅請求（防配錯帳期）");
  {
    // 先殘留一個「上一輪」帶 id 嘅請求，再撳今次詳情（今次冇 id）
    // ⇒ 若冇清乾淨，就會攞到舊 id（配錯帳期 = 實收有值但錯，最難察覺）
    const bg = loadBridge({
      summaryIds: [],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_request",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-data",
        method: "POST",
        summaryId: "STALE-ID-SHOULD-NOT-BE-USED",
        kind: "detail",
        at: Date.now(),
      },
      meta: {},
    });

    // 平台載入帳期列表（唯一 fallback）
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_periods",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
        periods: [{ id: "PID-NEW", raw: { period: "2026-09-16 ~ 2026-09-30" } }],
      },
      meta: { transport: "capture" },
    });

    console.log("[22-DBG] send 前");
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    console.log("[22-DBG] send 後 ok=", !!(r && r.ok), "step=", r && r.step, "reason=", r && r.reason);
    check(
      "🔴 唔可以攞到殘留嘅舊 id",
      fetchUsedId(bg.fetchCalls, "STALE-ID-SHOULD-NOT-BE-USED"),
      false,
    );
  }

  group("[23] 🔴 真機 2026-09-28：帳期列表用 `startDateStr/endDateStr` 都要配對到");
  {
    // 真機 `_list` 回應每一列係：
    //   { id, startDateStr:"2026-09-16", endDateStr:"2026-09-30", status, ... }
    // 舊 `periodTextOfRaw` 只試 period/summaryDate/startTime(epoch)
    // ⇒ `periods-map` 永遠配對失敗（periods.count=20 但一個都對唔上）。
    const bg = loadBridge({
      summaryIds: [], // 唔靠網絡事件，迫佢走 periods-map
      // 🔴 頁面上嘅帳期列（DOM）—— 要同下面 finance_periods 嘅區間一致，
      //    否則文字全等配對失敗（會跌落 periods-date 兜底，測唔到本項）。
      periods: ["2026-09-01 ~ 2026-09-15", "2026-09-16 ~ 2026-09-30"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });

    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_periods",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
        periods: [
          { id: "WEEK-OLD", raw: { startDateStr: "2026-09-01", endDateStr: "2026-09-15" } },
          { id: "WEEK-NEW", raw: { startDateStr: "2026-09-16", endDateStr: "2026-09-30" } },
        ],
      },
      meta: { transport: "capture" },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    const step = r && r.trace && r.trace.find((t) => t.step === "summaryId");
    check("🔴 via 標明係帳期配對", step && step.via, "periods-map");
    check(
      "🔴 用第二個帳期（09-16~09-30）嘅 id",
      fetchUsedId(bg.fetchCalls, "WEEK-NEW"),
      true,
    );
    check("冇誤用第一個帳期", fetchUsedId(bg.fetchCalls, "WEEK-OLD"), false);
  }

  group("[24] 🔴 文字配對失敗 → 用日期區間命中兜底（periods-date）");
  {
    // 平台改咗帳期文字格式（例如回 `startDate`/`endDate` 但帶時間戳），
    // 令 normalizePeriod 全等比較失敗 ⇒ 要可以用「目標日期落喺區間」兜底。
    const bg = loadBridge({
      summaryIds: [],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });

    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_periods",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
        periods: [
          // raw 冇 period 欄位、只有 startDate/endDate ⇒ periodTextOfRaw 用 ② 路
          { id: "RANGE-OLD", raw: { startDate: "2026-08-01", endDate: "2026-08-31" } },
          { id: "RANGE-NEW", raw: { startDate: "2026-09-16", endDate: "2026-09-30" } },
        ],
      },
      meta: { transport: "capture" },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check(
      "🔴 用命中區間嘅 id",
      fetchUsedId(bg.fetchCalls, "RANGE-NEW"),
      true,
    );
  }

  group("[25] 🔴 今次查詢嘅列表請求 `weekId` → 兜底用（list-week-id）");
  {
    // 最壞情況：帳期列表回應解析唔出（count=0），
    // 但今次按「查詢」時列表請求 body 帶 `weekId` ⇒ 佢就係帳期 id。
    // ⚠️ 呢條路要喺 DOM 之前、而且只認「非 detail」嘅請求（防上一輪殘留）。
    const bg = loadBridge({
      summaryIds: [],
      // 只用 onDetail 發一個 summary_list 請求（帶 weekId）
      onDetail: () => {
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
            method: "POST",
            summaryId: "202609170106005576278",
            kind: "summary_list",
            at: Date.now(),
          },
          meta: {},
        });
      },
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check(
      "🔴 用咗列表請求嘅 weekId",
      fetchUsedId(bg.fetchCalls, "202609170106005576278"),
      true,
    );
  }

  group("[26] 🔴 上一輪嘅 detail id 唔可以經 list-week-id 漏出（配錯帳期）");
  {
    // 先殘留一個 detail 請求帶 id，今次列表請求冇 id
    // ⇒ 唔可以用殘留 id（list-week-id 只收非 detail 請求）
    const bg = loadBridge({
      summaryIds: [],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_request",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-data",
        method: "POST",
        summaryId: "STALE-DETAIL-ID",
        kind: "detail",
        at: Date.now(),
      },
      meta: {},
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check(
      "🔴 唔可以用殘留 detail id",
      fetchUsedId(bg.fetchCalls, "STALE-DETAIL-ID"),
      false,
    );
  }

  group("[27] 🔴 重放要照抄「今次查詢」嘅 body 範本（storeId/orderType 等）");
  {
    // 真機 `_get-order-summary-list` body 有一堆必填欄位（storeId/storeName/
    // startDate/endDate/orderType/fromMerchant）。重放一定要照抄，唔好自己硬編。
    const bg = loadBridge({
      summaryIds: ["WEEK-777"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
      onDetail: () => {
        // 模擬「今次撳詳情」嘅真實請求 body（帶齊所有欄位）
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
            method: "POST",
            summaryId: "WEEK-777",
            kind: "detail",
            body: JSON.stringify({
              startDate: 1789488000000,
              endDate: 1790784000000,
              storeId: "STORE-9",
              storeName: "表嫂美食",
              weekId: "WEEK-777",
              fromMerchant: true,
              orderType: 1,
              pageNo: 1,
              pageSize: 20,
            }),
            at: Date.now(),
          },
          meta: {},
        });
      },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    let body = null;
    try {
      body = api && api.init.body ? JSON.parse(api.init.body) : null;
    } catch (e) {
      body = null;
    }
    check("🔴 POST", api && api.init.method, "POST");
    check("🔴 照抄 storeId", body && body.storeId, "STORE-9");
    check("🔴 照抄 orderType", body && body.orderType, 1);
    check("🔴 照抄 fromMerchant", body && body.fromMerchant, true);
    check("🔴 換成目標 weekId", body && body.weekId, "WEEK-777");
    check("🔴 Content-Type 係 JSON", !!(api && /application\/json/.test(api.init.headers["Content-Type"])), true);
  }

  group("[28] 🔴 用 GET 打 `_get-order-summary-list` 會 404（替身要模仿真機）");
  {
    // 呢個係 2026-09-28 HTTP 404 嘅真兇：舊寫法 GET + ?summaryId=。
    // 替身 fetch 已改為「GET 打呢條 endpoint 就 404」⇒ 若重放用錯 method 就即刻紅。
    const bg = loadBridge({
      summaryIds: ["WEEK-404"],
      // 強制用一個 mock 攔截：重放時如果係 GET 就會 404 ⇒ r.ok=false
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });
    console.log("[28-DBG] before send");
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    console.log("[28-DBG] after send ok=", !!(r && r.ok));
    // 若重放正確（POST）→ ok:true；若仍然用 GET → ok:false（404）
    check("🔴 重放冇 404（即係用咗 POST）", !!(r && r.ok), true);
  }

  group("[29] 🔴 404 失敗時必需帶「實際 URL / HTTP 碼 / body」證據（唔可以靜默）");
  {
    // 2026-09-28 第五次真機教訓：背景 log 只有 "HTTP 404"，
    // 完全睇唔到係邊條 URL、body 係咩 ⇒ 白白多查三輪。
    // 呢個測試鎖住：重放失敗時，回報必須含 url / status / requestBody。
    const bg = loadBridge({
      summaryIds: ["WEEK-EVIDENCE"],
      // httpOk:false 令替身回非 2xx（模擬 404），但保留真實錯誤細節
      httpOk: false,
      status: 404,
      response: { message: "Not Found" },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && !r.ok), true);
    check("🔴 帶實際請求 URL", !!(r && r.requestUrl && /_get-order-summary-list/.test(r.requestUrl)), true);
    check("🔴 帶 HTTP 碼", r && r.requestStatus, 404);
    check("🔴 帶實際 body（含 weekId）", !!(r && r.requestBody && /WEEK-EVIDENCE/.test(r.requestBody)), true);
    check("🔴 reason 內含 URL（popup 一眼睇到）", !!(r && r.reason && /_get-order-summary-list/.test(r.reason)), true);
  }

  group("[30] 🔴🔴 MAIN world 冇可重放範本時要講明（避免靜默失敗）");
  {
    // 2026-09-28 第六次真機：重放已搬去 MAIN world。
    //   若 MAIN world 完全冇攔截到財務請求（理論上唔會，因為一定撳過「查詢」
    //   同「查看詳情」），重放一定失敗 —— 失敗回報必須講清楚，
    //   唔可以只回一個含糊嘅 `Failed to fetch`（使用者最介意靜默失敗）。
    const bg = loadBridge({
      summaryIds: [],
      // 用 onDetail 覆寫：連 fallback 範本都唔設（模擬 MAIN world 完全冇範本）
      onDetail: () => {
        bg.clearMainWorldTemplate();
      },
      response: { message: "Not Found" },
      httpOk: false,
      status: 404,
    });
    // 帳期 id 由「帳期列表回應」提供（呢條路唔需要 detail 請求）
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_periods",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_list",
        periods: [{ id: "PID-NOTPL", raw: { period: "2026-09-16 ~ 2026-09-30" } }],
      },
      meta: { transport: "capture" },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && !r.ok), true);
    check("🔴 明示 MAIN world 冇範本", r && r.mainWorldTemplate, false);
    check(
      "🔴 reason 講明冇範本（唔可以只回 Failed to fetch）",
      !!(r && r.reason && /範本/.test(r.reason)),
      true,
    );
  }

  group("[31] 🔴🔴 重放要用**攔截到嘅真實 host**（唔可以用 location.origin）");
  {
    // 2026-09-28 第五次真機 404 真兇：
    //   真機請求 host ＝ management-api.mfoodapp.com
    //   頁面 origin    ＝ merchant.mfoodapp.com
    //   ⇒ 用 location.origin 重放會打錯 host ⇒ 404。
    // 呢個測試鎖住：重放 URL 必須係 **management-api** host。
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
      onDetail: () => {
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
            origin: "https://management-api.mfoodapp.com",
            path: "/merchants/summarys/summary/_get-order-summary-list",
            method: "POST",
            summaryId: "202609170106005576278",
            kind: "detail",
            body: JSON.stringify({
              startDate: 1789488000000,
              endDate: 1790784000000,
              storeId: "S1",
              weekId: "202609170106005576278",
              fromMerchant: true,
              orderType: 1,
              pageNo: 1,
              pageSize: 20,
            }),
            at: Date.now(),
          },
          meta: {},
        });
      },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    check(
      "🔴🔴 用 management-api host（唔可以係 location.origin）",
      !!(api && api.url.indexOf("https://management-api.mfoodapp.com/") === 0),
      true,
    );
    check(
      "🔴 冇用頁面 origin（merchant）",
      !!(api && api.url.indexOf("merchant.mfoodapp.com") === -1),
      true,
    );
  }

  group("[32] 🔴 範本只可以收 `_get-order-summary-list`（唔可以係 `-data`）");
  {
    // 真機同一輪有兩個 kind:"detail"：
    //   `_get-order-summary-data`（冇 pageNo/pageSize）
    //   `_get-order-summary-list`（有 pageNo/pageSize）← 重放要用呢個
    // 舊寫法「任何 detail 都覆寫」⇒ 若 `-data` 後到，範本就會缺 pageNo/pageSize。
    // 呢個測試把 `-data` **故意放最後**，斷言範本仍然係 `-list` 嘅。
    const bg = loadBridge({
      summaryIds: ["WEEK-LIST-TPL"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
      onDetail: () => {
        const base = {
          startDate: 1789488000000,
          endDate: 1790784000000,
          storeId: "STORE-Z",
          weekId: "WEEK-LIST-TPL",
          fromMerchant: true,
          orderType: 1,
        };
        // 先 `-list`（有 pageNo/pageSize）
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
            origin: "https://management-api.mfoodapp.com",
            path: "/merchants/summarys/summary/_get-order-summary-list",
            method: "POST",
            summaryId: "WEEK-LIST-TPL",
            kind: "detail",
            body: JSON.stringify(Object.assign({ pageNo: 1, pageSize: 20 }, base)),
            at: Date.now(),
          },
          meta: {},
        });
        // 再 `-data`（冇 pageNo/pageSize）—— 舊寫法會覆蓋成呢個
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-data",
            origin: "https://management-api.mfoodapp.com",
            path: "/merchants/summarys/summary/_get-order-summary-data",
            method: "POST",
            summaryId: "WEEK-LIST-TPL",
            kind: "detail",
            body: JSON.stringify(base),
            at: Date.now(),
          },
          meta: {},
        });
      },
    });

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    let body = null;
    try {
      body = api && api.init.body ? JSON.parse(api.init.body) : null;
    } catch (e) {
      body = null;
    }
    check("🔴 照抄到 storeId（來自 -list 範本）", body && body.storeId, "STORE-Z");
    // 🔴 2026-09-28 第八次真機：`pageSize` 一律拉到最大（`MAX_PAGE_SIZE`），
    //    唔再係「照抄範本」⇒ 範本係 20 都要變 200。
    //    （舊斷言寫死 20，係 pageSize 禁止改大嘅年代嘅產物。）
    //    真正要驗嘅係「`-data` 唔可以覆蓋範本」——用 pageNo 驗（範本 -list 有、-data 冇）。
    check("🔴 範本頁碼保留（唔可以被 -data 覆蓋掉）", body && body.pageNo, 1);
    check("🔴🔴 pageSize 一律拉到最大（唔理範本寫 20）", body && body.pageSize, 200);
    check("🔴 換成目標 weekId", body && body.weekId, "WEEK-LIST-TPL");
  }

  group("[33] 🔴🔴 重放必須由 MAIN world 執行，並且**帶簽章標頭**（Failed to fetch 真兇）");
  {
    // 2026-09-28 第六次真機：404 修好之後變成 `Failed to fetch`。
    //   真兇 ＝ mfood 用 Alibaba 閘道簽章（x-ca-key/nonce/signature/timestamp）。
    //   isolated world（bridge）自己組標頭 ⇒ 冇簽章 ⇒ 閘道拒收 ⇒ Failed to fetch。
    //   ⇒ 修法：重放搬去 MAIN world，標頭由攔截到嘅真實請求照抄。
    // 呢個測試鎖住三件事：
    //   ① bridge 一定要用 `postMessage({__mfoodCmd, cmd:"finance_replay_list"})` 叫 MAIN world
    //   ② 重放請求一定要帶 `x-ca-*` 簽章標頭
    //   ③ 唔可以有 isolated world 直接打 mfood 嘅 fallback（會靜默失敗）
    const bg = loadBridge({
      summaryIds: ["WEEK-SIG"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 bridge 有叫 MAIN world 重放", bg.postMessageCount.replayCmds >= 1, true);
    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    const hk = api && api.init && api.init.headers ? Object.keys(api.init.headers) : [];
    check(
      "🔴🔴 重放請求帶 x-ca 簽章標頭",
      hk.some((k) => /^x-ca-/i.test(k)),
      true,
    );
    const step = r && r.trace && r.trace.find((t) => t.step === "transactions");
    check("🔴 trace 記低有簽章", step && step.hasSignature, true);
  }

  group("[34] 🔴🔴 冇簽章標頭時，失敗訊息要**明確指出**（唔可以靜默 Failed to fetch）");
  {
    // 若範本冇簽章（理論上唔會，但真機若攔截唔到 headers 就會），
    // 必須大聲失敗，並講明「冇簽章標頭」。使用者最介意靜默失敗。
    const bg = loadBridge({
      summaryIds: ["WEEK-NOSIG"],
      response: { result: [{ tradeNo: "M1", storeReceiveAmtn: 2 }], total: 1 },
      onDetail: () => {
        // 刻意發一個**冇 headers** 嘅範本 ⇒ 模擬攔截唔到標頭
        bg.emitInjectEvent({
          __mfoodFinance: true,
          kind: "finance_request",
          payload: {
            url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
            method: "POST",
            summaryId: "WEEK-NOSIG",
            kind: "detail",
            headers: {}, // 🔴 冇簽章
            body: JSON.stringify({ weekId: "WEEK-NOSIG", pageNo: 1, pageSize: 20 }),
            at: Date.now(),
          },
          meta: {},
        });
      },
    });
    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-26" });
    check("回 ok:false", !!(r && !r.ok), true);
    const step = r && r.trace && r.trace.find((t) => t.step === "transactions");
    check("🔴 回報明示冇簽章", step && step.hasSignature === false, true);
  }

  group("[35] 🔴🔴🔴 直接由「帳期列表回應」抽實收（金額零重放；明細另外抓）");
  {
    // 2026-09-28 第七次真機 —— 使用者原話：
    //   「我打開頁面後, 就看到所有的訂單, 然後每一條 record 在介面上都已經有多少金額.
    //     為什麼你就能不到?」
    //
    // 佢係完全正確嘅：平台開財務頁時**自己就發** `summary/_list`，
    // 回應 result[] 每項已經有齊真機欄位（DOMDUMP 實證）：
    //   id / startDateStr / endDateStr / subsidyStoreReceiveAmtn（🔴 實收）/
    //   storeReceiveAmtn / platformServiceFee / details[]
    // ⇒ 按完「查詢」就應該直接讀得到，**唔需要靠重放**去攞金額。
    //
    // 🔴🔴 2026-09-28 第十次真機（使用者點醒）：
    //   「他好像只拿到了那條總額, 但是沒有拿到每一條的明細.」
    //   舊寫法讀到金額就 return ⇒ 明細永遠係空。
    //   ✅ 新行為：**金額直讀**（快、唔靠重放），但**明細照抓**（POS 配對要逐筆 tradeNo）。
    //   ⇒ 呢個測試鎖住「金額來自平台欄位（唔係公式）＋ 完成方式標明兩段」。
    const bg = loadBridge({
      // 撳詳情攞唔到 id（模擬詳情彈窗已開、平台唔再發請求）
      response: { result: [], total: 0 },
    });

    // 平台載入頁面時發出嘅帳期列表回應（照真機 DOMDUMP 抄）
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 1212.37,
        storeReceiveAmtn: 1353.17,
        storeBusinessAmtn: 1803.34,
        platformServiceFee: 490.83,
        deliverySubsidyAmtn: 23.2,
        redpackSubsidyAmtn: 164,
        details: [
          { startDateStr: "2026-09-16", subsidyStoreReceiveAmtn: 114.82 },
          { startDateStr: "2026-09-17", subsidyStoreReceiveAmtn: 96.5 },
        ],
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 實收 = 平台欄位（唔可以自行拼公式）", r && r.receive, 1212.37);
    check("應收（營業額）", r && r.should, 1803.34);
    check("平台服務費", r && r.fee, 490.83);
    check("🔴 金額來源標示為平台欄位", r && r.amountsVia, "list-field");
    check("🔴 實收欄位名如實回報", r && r.receiveKey, "subsidyStoreReceiveAmtn");
    // 🔴 帳期文字一定要用「列表帳期」（09-16~09-30），唔可以用明細頁文字（09-19~09-26）
    check("🔴 回報帳期文字（以列表為準）", r && r.period, "2026-09-16 ~ 2026-09-30");
    check("回報帳期 id", r && r.summaryId, "202609170106005576278");
    // 🔴 第十次真機：金額係直讀（冇靠重放），但明細照抓 ⇒ 完成方式 = 兩段
    check("🔴 完成方式標明「直讀金額＋重放明細」", r && r.source, "list-inline+replay");
  }

  group("[35b] 🔴🔴🔴 直讀到帳期金額之後，**仍然要抓到逐筆明細**（第十次真機）");
  {
    // 2026-09-28 第十次真機，使用者原話：
    //   「他好像只拿到了那條總額, 但是沒有拿到每一條的明細.」
    //
    // 舊寫法：零重放讀到帳期金額就 `return { transactions: [] }`
    //   ⇒ POS 收唔到任何逐筆 tradeNo ⇒ 訂單配對全 empty。
    // 新行為：金額直讀（快、穩）**＋** 照樣撳詳情 + 重放攞明細（逐筆 tradeNo）。
    //
    // 真機佐證（DOMDUMP）：
    //   `_list`（帳期列表）→ subsidyStoreReceiveAmtn 1212.37、total 32
    //   `_get-order-summary-list`（明細）→ result[].tradeNo = "CRD2026…"
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      // 明細回兩筆（帶真機欄位名）
      response: {
        result: [
          { tradeNo: "CRD202609161003178839221", subsidyStoreReceiveAmtn: 31.91 },
          { tradeNo: "CRD202609161003178839222", subsidyStoreReceiveAmtn: 28.5 },
        ],
        total: 2,
      },
    });
    // 帳期列表（平台載頁時自己發）—— 金額同明細係兩個來源
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 1212.37,
        storeBusinessAmtn: 1803.34,
        platformServiceFee: 490.83,
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true", !!(r && r.ok), true);
    // ① 帳期金額（直讀，平台欄位）
    check("🔴 帳期實收 = 1212.37（直讀）", r && r.receive, 1212.37);
    // ② 🔴🔴 逐筆明細 —— 呢個就係使用者話「拿唔到」嘅嘢
    check("🔴🔴🔴 有逐筆明細（唔可以係空）", (r && r.transactions && r.transactions.length) || 0, 2);
    check(
      "🔴 明細帶 tradeNo（POS 靠佢配對 external_order_id）",
      !!(r && r.transactions && r.transactions[0] && r.transactions[0].tradeNo),
      true,
    );
    check(
      "🔴 明細 tradeNo 值正確",
      r && r.transactions && r.transactions[0] && r.transactions[0].tradeNo,
      "CRD202609161003178839221",
    );
    // ③ 完成方式標明「兩段都做咗」
    check("🔴 完成方式 = 直讀金額＋重放明細", r && r.source, "list-inline+replay");
    // ④ 帳期文字以列表為準
    check("🔴 帳期文字以列表為準", r && r.period, "2026-09-16 ~ 2026-09-30");
  }

  group("[40] 🔴🔴🔴 MFOODFIN_RAW：把所有訂單原樣交返出嚟（唔配對）");
  {
    // 2026-09-28 第十一次真機，使用者原話：
    //   「不是, 不如你先不要做配對, 先把所有的訂單都先拿在手上,
    //     然後我再幫你分析好不好?」
    //
    // ⇒ 呢條路**唔可以**做任何配對／篩選／改名。它只把已攔到嘅原始資料帶返出嚟。
    //    呢個測試鎖死「原樣」：連平台多餘欄位都要在，一經篩選就會紅。
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      response: {
        result: [
          {
            tradeNo: "CRD202609161003178839221",
            subsidyStoreReceiveAmtn: 31.91,
            storeReceiveAmtn: 35,
            storeBusinessAmtn: 45,
            weekId: "202609170106005576278",
            // 一個「冇用」嘅欄位 —— 但原樣就係要留
            someUnusedField: "keep-me",
          },
        ],
        total: 1,
      },
    });

    // ① 帳期列（含 details，原樣）
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 1212.37,
        storeBusinessAmtn: 1803.34,
        platformServiceFee: 490.83,
        details: [{ day: "2026-09-16", subsidyStoreReceiveAmtn: 100.5 }],
      },
    ]);

    // ② 明細事件（模擬 inject 已攔到）
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_detail_captured",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
        summaryId: "202609170106005576278",
        result: [
          {
            tradeNo: "CRD202609161003178839221",
            subsidyStoreReceiveAmtn: 31.91,
            storeReceiveAmtn: 35,
            storeBusinessAmtn: 45,
            weekId: "202609170106005576278",
            someUnusedField: "keep-me",
          },
        ],
        total: 1,
        rawResult: [
          {
            tradeNo: "CRD202609161003178839221",
            subsidyStoreReceiveAmtn: 31.91,
            storeReceiveAmtn: 35,
            storeBusinessAmtn: 45,
            weekId: "202609170106005576278",
            someUnusedField: "keep-me",
          },
        ],
        firstRowKeys: [
          "tradeNo",
          "subsidyStoreReceiveAmtn",
          "storeReceiveAmtn",
          "storeBusinessAmtn",
          "weekId",
          "someUnusedField",
        ],
      },
      meta: { transport: "capture" },
    });

    const r = await bg.ask({ type: "MFOODFIN_RAW" }, 3000);

    check("回 ok:true", !!(r && r.ok), true);
    // 帳期列
    check("🔴 帳期列數 = 1", r && r.periodRowCount, 1);
    check(
      "🔴 帳期列原樣（details 都要在）",
      r && r.periodRows && r.periodRows[0] && Array.isArray(r.periodRows[0].details) && r.periodRows[0].details.length,
      1,
    );
    // 明細列
    check("🔴 明細列數 = 1", r && r.detailRowCount, 1);
    check(
      "🔴 明細保留平台全部欄位（連冇用嘅）",
      r && r.detailRows && r.detailRows[0] && r.detailRows[0].someUnusedField,
      "keep-me",
    );
    check(
      "🔴 明細 tradeNo 原樣",
      r && r.detailRows && r.detailRows[0] && r.detailRows[0].tradeNo,
      "CRD202609161003178839221",
    );
    check(
      "🔴 firstRowKeys 有列欄位名",
      r && Array.isArray(r.firstRowKeys) && r.firstRowKeys.includes("someUnusedField"),
      true,
    );
    // ⚠️ 關鍵：呢條路唔可以有配對結果（唔應該有 updated / notFound 之類）
    check("🔴 唔應該有 updated（唔做配對）", r && "updated" in r, false);
    check("🔴 唔應該有 notFound（唔做配對）", r && "notFound" in r, false);
  }

  group("[41] 🔴🔴 MFOODFIN_RAW 唔可以「收到訊息但冇回」（2026-09-28 第十三次真機）");
  {
    // 真機症狀：popup 報「收到訊息但冇回」——即係 `sendResponse` 根本冇被叫到。
    // 本 handler 本來同步直回、看似最安全，但建構回應物件時一拋錯就靜默死。
    //
    // ⇒ 修法：整個 handler 包 try/catch ＋ 大小上限 ＋ 結構化複製預檢。
    //    呢組測試鎖死三個行為：
    //      ① 含不可結構化複製嘅值 → 仍然要回一個 ok 回應（清洗過）
    //      ② 超大 payload → 截斷而唔係死
    //      ③ 萬一建構真係拋錯 → 要回 `ok:false` + `reason`（唔可以靜默）
    const bg = loadBridge({ response: { result: [], total: 0 } });

    // ① 正常無資料時，仍然要回一個 ok:true 嘅回應（唔可以「冇回」）
    const empty = await bg.ask({ type: "MFOODFIN_RAW" }, 3000);
    check("🔴 冇資料都要回 ok:true（唔可以冇回）", !!(empty && empty.ok), true);
    check("🔴 冇資料時明細列數 = 0", empty && empty.detailRowCount, 0);
    check("🔴 有 capturedAt 欄位（可分辨『冇抓到』vs『壞了』）", empty && "capturedAt" in empty, true);

    // ② 大量明細（模擬超過 4MB 上限）→ 要截斷，唔可以靜默死
    const big = [];
    const pad = "x".repeat(2000); // 每列約 2KB
    for (let i = 0; i < 2600; i++) {
      big.push({ tradeNo: "CRD" + i, subsidyStoreReceiveAmtn: 1, pad: pad });
    }
    bg.emitInjectEvent({
      __mfoodFinance: true,
      kind: "finance_detail_captured",
      payload: {
        url: "https://management-api.mfoodapp.com/merchants/summarys/summary/_get-order-summary-list",
        summaryId: "SUM-BIG",
        result: big,
        total: big.length,
        rawResult: big,
        firstRowKeys: ["tradeNo", "subsidyStoreReceiveAmtn", "pad"],
      },
      meta: { transport: "capture" },
    });

    const bigResp = await bg.ask({ type: "MFOODFIN_RAW" }, 5000);
    check("🔴🔴 超大 payload 都要回得到（唔可以冇回）", !!(bigResp && bigResp.ok), true);
    check("🔴 標明已截斷", bigResp && bigResp.truncated === true, true);
    check(
      "🔴 截斷原因講明係避免訊息通道超時",
      !!(bigResp && /超時|MB/.test(String(bigResp.truncatedReason || ""))),
      true,
    );
    check(
      "🔴 截斷後仍然有資料（各 200 列）",
      bigResp && bigResp.detailRows && bigResp.detailRows.length <= 200 && bigResp.detailRows.length > 0,
      true,
    );
  }

  group("[42] 🔴🔴 bridge 唔可以喺非 extension context 做嘢（防 MAIN world 污染）");
  {
    // 2026-09-28 第十四次真機，真機紅字實證：
    //   「Uncaught ReferenceError: onFinancePage is not defined」
    //
    // 成因：bridge 嘅 IIFE 開頭用 `window.__MFOOD_FINANCE_BRIDGE_INSTALLED__`
    //   做 guard —— 但 **`window` 喺 isolated / MAIN world 之間係同一個物件**。
    //   一旦 bridge 被意外注入 MAIN world：
    //     MAIN 先跑 → 設記號，但 `onFinancePage` 等從未定義
    //     真正 isolated 跑 → 見記號即 `return` ⇒ **乜都冇註冊**
    //     但舊 onMessage listener 仍在 ⇒ 收到訊息就叫 `onFinancePage()`
    //     ⇒ Uncaught ReferenceError
    //
    // ⇒ 修法：guard 改成「`chrome.runtime.id` 存在（＝真 extension context）
    //   才設記號」；唔係就**直接不做任何事**。
    //
    // 呢組測試鎖死：唔喺 extension context ⇒ 唔可以註冊 listener、
    // 唔可以設 `window` 記號（否則會毒死真 isolated world 嘅一次）。
    const src = fs.readFileSync(
      path.join(__dirname, "..", "mfood-finance-bridge.js"),
      "utf8",
    );

    // ① 靜態：guard 一定要存在，而且要喺設記號**之前**
    const idxExtCtx = src.indexOf('typeof chrome !== "undefined"');
    const idxFlagSet = src.indexOf("window.__MFOOD_FINANCE_BRIDGE_INSTALLED__ = true");
    check("🔴 有檢查係唔係 extension context", idxExtCtx > 0, true);
    check(
      "🔴 context 檢查一定要喺「設記號」之前",
      idxExtCtx > 0 && idxFlagSet > 0 && idxExtCtx < idxFlagSet,
      true,
    );

    // ② 動態：喺一個「冇 chrome」嘅 sandbox 跑 bridge ⇒ 唔可以拋錯、唔可以註冊
    let threw = null;
    const mainWorld = {
      __MFOOD_FINANCE_BRIDGE_INSTALLED__: undefined,
    };
    try {
      const ctx = vm.createContext({
        window: mainWorld,
        location: {
          href: "https://merchant.mfoodapp.com/#/finance/tackout-check",
          hash: "#/finance/tackout-check",
        },
        document: {
          readyState: "complete",
          querySelector: () => null,
          querySelectorAll: () => [],
          body: null,
          addEventListener() {},
        },
        // 🔴 刻意**唔提供** `chrome` —— 模擬 MAIN world（頁面 context）
        console: { log() {}, warn() {}, error() {} },
        fetch: () => Promise.reject(new TypeError("Failed to fetch")),
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
        RegExp,
        Set,
        Map,
        WeakMap,
        isFinite,
        parseInt,
        parseFloat,
        Promise,
        URLSearchParams,
        TypeError,
        Error,
        encodeURIComponent,
        decodeURIComponent,
      });
      vm.runInContext(src, ctx, { filename: "mfood-finance-bridge.js" });
    } catch (e) {
      threw = e;
    }
    check("🔴🔴 冇 chrome 嘅世界（MAIN）跑 bridge 唔可以拋錯", threw ? String(threw.message) : null, null);
    check(
      "🔴🔴 冇 chrome 時唔可以設 window 記號（否則毒死真 isolated 嗰次）",
      mainWorld.__MFOOD_FINANCE_BRIDGE_INSTALLED__ === true,
      false,
    );
    check(
      "🔴 guard 一定要係 early-return（靜態確認）",
      /if\s*\(\s*!IN_EXTENSION_CONTEXT\s*\)\s*return/.test(src),
      true,
    );
  }

  group("[36] 🔴 金額欄位改名時，公式 fallback 要標示 via=formula（唔可以扮係平台值）");
  {
    // 平台日後若改欄位名（冇 subsidyStoreReceiveAmtn），我哋用已驗算嘅公式拼。
    // 但**一定要**明確標示係我哋自己計 —— 否則以後查唔出「呢個數邊度嚟」。
    // 呢個測試**唔行慢路**：直接用一個有金額嘅帳期，確認公式口徑正確。
    const bg = loadBridge({ response: { result: [], total: 0 } });
    bg.emitPeriods([
      {
        id: "P-FORMULA",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        // 刻意唔畀 subsidyStoreReceiveAmtn / storeReceiveAmtn
        storeBusinessAmtn: 62,
        platformServiceFee: 14.89,
        disMerchantDeliveryFee: 12,
        deliverySubsidyAmtn: 0.8,
        activitySubsidyAmtn: 4,
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });
    check("回 ok:true", !!(r && r.ok), true);
    // 62 − 14.89 − 12 = 35.11；35.11 + 0.8 − 4 = 31.91（真機驗算命中）
    check("🔴 公式計出 31.91", r && r.receive, 31.91);
    check("🔴 明確標示來源係公式", r && r.amountsVia, "formula");
    check("🔴 冇實收欄位名", r && r.receiveKey, null);
    // 🔴 第十次真機：金額係公式（直讀），但明細照抓 ⇒ 唔再 assert「零請求」。
    //    真正要鎖嘅係「金額來源 = formula」（上面已鎖），唔係「有冇發過請求」。
    check("🔴 金額來源唔可以係 replay（公式自足）", r && r.source !== "replay", true);
  }

  group("[37] 🔴 目標帳期唔喺列表回應 → 唔可以亂用其他帳期嘅金額");
  {
    // 列表回應只有一個**唔涵蓋目標日期**嘅帳期 ⇒ 唔可以搭便車用佢嘅金額。
    // 呢個係「實收有值但錯」嘅高風險位。
    //
    // ⚠️ 刻意用 `MFOODFIN_AMOUNTS`（純讀，唔跑四步流程）：
    //    「唔可以亂用金額」係**純配對邏輯**，用一個唯讀入口驗最乾淨，
    //    亦唔會牽動 setStore/clickQuery/重放等慢路（歷史上嗰啲慢路易令
    //    測試互相污染，造成「掛死、零輸出」嘅假象，查好久）。
    const bg = loadBridge({ response: { result: [], total: 0 } });
    bg.emitPeriods([
      {
        id: "P-OTHER",
        startDateStr: "2026-08-01",
        endDateStr: "2026-08-15",
        subsidyStoreReceiveAmtn: 500,
      },
    ]);

    // ① 目標日期唔喺任何帳期區間 ⇒ 唔可以命中
    const miss = await bg.ask({ type: "MFOODFIN_AMOUNTS", targetDate: "2026-09-26" });
    check("🔴 日期唔對 → ok:false（唔可以亂攞）", !!(miss && miss.ok === false), true);
    check("🔴🔴 回報值唔可以係 500（其他帳期嘅金額）", miss && miss.receive, null);
    // ② 但帳期清單本身仍然要如實列出（供診斷睇真相）
    check("🔴 帳期清單仍然要照出（診斷用）", (miss && miss.periods && miss.periods.length) || 0, 1);
    check("🔴 清單內嗰個帳期嘅實收係 500", miss && miss.periods[0].receive, 500);
  }

  group("[38] 🔴🔴 pageSize 一定要拉到最大（使用者 2026-09-28 明確要求）");
  {
    // 使用者原話：「request payload 里面, 有一個叫 page size 的,
    //   這個必須要拿到最大的, 因為一個月里面, 會有很多數據。」
    //
    // 舊寫法「照抄平台範本嘅 pageSize」（範本係 20）⇒ 一個帳期過百筆就要打 5+ 次，
    // 多打幾倍請求 = 更多 429 風險 + 更長嘅失敗窗口。
    const bg = loadBridge({
      period: "2026-09-01 ~ 2026-09-30",
      summaryIds: ["SUM-BIG"],
      // 範本刻意用平台 UI 嘅 20，驗證我哋**唔會**照抄
      listBody: JSON.stringify({ storeId: "STORE", weekId: "__WEEKID__", pageNo: 1, pageSize: 20 }),
      response: { result: [{ tradeNo: "T1", storeReceiveAmtn: 1 }], total: 1 },
    });

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });

    const api = bg.fetchCalls.find((c) => c.url.indexOf("_get-order-summary-list") >= 0);
    let sent = null;
    try {
      sent = api && api.init.body ? JSON.parse(api.init.body) : null;
    } catch (e) {
      sent = null;
    }
    check("🔴 有打 API", !!api, true);
    check(
      "🔴🔴 pageSize 一定要拉到最大（唔可以照抄範本嘅 20）",
      sent && sent.pageSize,
      200,
    );
    check("🔴 仍然由 pageNo=1 開始", sent && sent.pageNo, 1);
    check("🔴 保留範本其他欄位（storeId）", sent && sent.storeId, "STORE");
    check("回 ok:true", !!(r && r.ok), true);
  }

  group("[39] 🔴 pageSize 被平台拒收 → 要自動降級，唔可以當整次失敗");
  {
    // 平台可能有真正上限（例如 100）。設太大回 4xx 時，
    // **寧願多打幾次都要拿到數** —— 直接失敗就係「靜默少一大截」。
    const bg = loadBridge({
      period: "2026-09-01 ~ 2026-09-30",
      summaryIds: ["SUM-LIMIT"],
      listBody: JSON.stringify({ storeId: "STORE", weekId: "__WEEKID__", pageNo: 1, pageSize: 20 }),
      // 200 被拒（400），100 成功
      rejectPageSizeAbove: 100,
      response: { result: [{ tradeNo: "T1", storeReceiveAmtn: 9 }], total: 1 },
    });

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      storeName: "表嫂美食",
      targetDate: "2026-09-26",
    });

    const sizes = bg.fetchCalls
      .filter((c) => c.url.indexOf("_get-order-summary-list") >= 0)
      .map((c) => {
        try {
          return JSON.parse(c.init.body).pageSize;
        } catch (e) {
          return null;
        }
      });
    check("🔴 有試過最大 200", sizes.indexOf(200) >= 0, true);
    check("🔴 被拒後有降級到 100", sizes.indexOf(100) >= 0, true);
    check("🔴 最終仍然成功取到數", !!(r && r.ok), true);
    check("🔴 拿到 1 筆", (r && r.transactions && r.transactions.length) || 0, 1);
  }

  group("[43] 🔴🔴🔴 立即對帳要**自己**撳「每頁筆數」到 50（第十六次真機）");
  {
    // 使用者原話（2026-09-28 第十六次）：
    //   「拿不到 32 條是因為, paging 我沒選到 50一頁,
    //     但是當我用立即對帳, 應該是你也要幫忙按到才行.」
    //
    // ⇒ 呢個就係「立即對帳」嘅**核心驗收**：
    //     ① 唔可以要求使用者自己先揀好 50項/頁
    //     ② 唔可以靠重放（重放係 CORS 死路，第十五次真機實證）
    //     ③ 撳完每頁筆數，平台會自己再發請求 ⇒ 我哋被動抄低（零 CORS）
    //
    // 真機事實：平台預設 20項/頁，一個月 32 筆 ⇒ 只會回 20（靜默少 12 筆）。
    const rows = [];
    for (let i = 1; i <= 32; i++) {
      rows.push({
        tradeNo: "CRD20260900" + String(i).padStart(3, "0"),
        subsidyStoreReceiveAmtn: Number((10 + i * 0.11).toFixed(2)),
      });
    }
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      // 明細彈窗嘅分頁器：預設 20項/頁，選項去到 50
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: rows,
    });
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 1212.37,
        storeBusinessAmtn: 1803.34,
        platformServiceFee: 490.83,
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true", !!(r && r.ok), true);
    // ① 🔴🔴 使用者最關心嘅：**要撳到 50**
    check(
      "🔴🔴🔴 立即對帳有自己撳「每頁筆數」",
      bg.pgClicks.sizeChanges.length > 0,
      true,
    );
    check(
      "🔴🔴🔴 撳到嘅係最大嗰個（50項/頁）",
      bg.pgClicks.sizeChanges[bg.pgClicks.sizeChanges.length - 1],
      50,
    );
    // ② 🔴🔴 32 筆要全部到手（唔可以剩 20）
    check(
      "🔴🔴🔴 32 筆全部拎到（唔可以剩 20）",
      (r && r.transactions && r.transactions.length) || 0,
      32,
    );
    check("🔴 平台 total = 32 要外露", r && r.transactionsTotal, 32);
    check("🔴 要標明「已抄齊」", !!(r && r.transactionsComplete), true);
    // ③ 🔴 來源一定要係「搭便車」，唔係重放
    check("🔴🔴 來源 = page-capture（唔係重放）", r && r.source, "page-capture");
    check(
      "🔴🔴🔴 完全冇發起重放（重放係 CORS 死路）",
      bg.postMessageCount.replayCmds,
      0,
    );
    // ④ trace 要寫低「撳咗每頁筆數」呢一步（日後排查用）
    const psStep = (r && r.trace || []).find((t) => t && t.step === "page-size");
    check("🔴 trace 要有 page-size 呢一步", !!psStep, true);
    check("🔴 page-size 步驟係 ok", !!(psStep && psStep.ok), true);
    check("🔴 page-size 步驟標明 changed", !!(psStep && psStep.changed), true);
    check("🔴 page-size 步驟記低實際值 = 50", psStep && psStep.sizes && psStep.sizes[0] && psStep.sizes[0].value, 50);
    // ⑤ 明細內容本身要啱
    check(
      "🔴 明細第一筆 tradeNo 正確",
      r && r.transactions && r.transactions[0] && r.transactions[0].tradeNo,
      "CRD20260900001",
    );
    check(
      "🔴 明細最後一筆 tradeNo 正確（證明係全批，唔係第一頁）",
      r && r.transactions && r.transactions[31] && r.transactions[31].tradeNo,
      "CRD20260900032",
    );
  }

  group("[44] 🔴🔴 每頁 50 都裝唔晒（120 筆）⇒ 要逐頁撳「下一頁」累積");
  {
    // 第十六次真機嘅延伸：平台上限係 50項/頁，
    // 但一個月跨幾個帳期／大店可以過百筆 ⇒ 一定要翻頁，
    // 而且**每頁要累積**（唔可以覆寫 —— 覆寫就只剩最後一頁）。
    const rows = [];
    for (let i = 1; i <= 120; i++) {
      rows.push({ tradeNo: "CRD" + String(i).padStart(6, "0"), subsidyStoreReceiveAmtn: 1.5 });
    }
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRows: rows,
    });
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 3000,
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 有撳每頁筆數到 50", bg.pgClicks.sizeChanges.length > 0, true);
    // 120 筆 / 50 每頁 ⇒ 至少撳 2 次「下一頁」
    check("🔴🔴 有逐頁撳「下一頁」", bg.pgClicks.nextPages >= 2, true);
    check(
      "🔴🔴🔴 120 筆全部累積到（唔可以剩最後一頁）",
      (r && r.transactions && r.transactions.length) || 0,
      120,
    );
    check("🔴 標明已抄齊", !!(r && r.transactionsComplete), true);
    check("🔴 仍然係零重放", bg.postMessageCount.replayCmds, 0);
  }

  group("[45] 🔴 已經係 50項/頁 → 唔好再撳（避免多餘請求同延遲）");
  {
    const rows = [];
    for (let i = 1; i <= 32; i++) {
      rows.push({ tradeNo: "CRD20260900" + String(i).padStart(3, "0"), subsidyStoreReceiveAmtn: 1 });
    }
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      pageSizeSelect: { current: 50, options: [10, 20, 30, 40, 50] },
      captureRows: rows,
    });
    bg.emitPeriods([
      {
        id: "202609170106005576278",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 1212.37,
      },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 已經夠大 → 唔撳（sizeChanges 空）", bg.pgClicks.sizeChanges.length, 0);
    check("🔴 一樣拎到 32 筆", (r && r.transactions && r.transactions.length) || 0, 32);
    check("🔴 標明已抄齊", !!(r && r.transactionsComplete), true);
  }

  group("[46] 🔴 「每頁筆數」下拉搵唔到 → 要如實講（唔可以扮成功）");
  {
    // 冇分頁器（例如平台改版、彈窗未開）⇒ trace 要寫低 `ok:false` 同原因，
    // 而且**要 fallback 去重放**，唔可以靜默交一個空嘅 transactions。
    const bg = loadBridge({
      summaryIds: ["202609170106005576278"],
      response: { result: [{ tradeNo: "CRD-1", subsidyStoreReceiveAmtn: 9.9 }], total: 1 },
    });
    bg.emitPeriods([
      { id: "202609170106005576278", startDateStr: "2026-09-16", endDateStr: "2026-09-30" },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-20" });

    check("回 ok:true（fallback 去重放仍然成功）", !!(r && r.ok), true);
    const psStep = (r && r.trace || []).find((t) => t && t.step === "page-size");
    check("🔴 有 page-size 呢一步", !!psStep, true);
    check("🔴 page-size 係 ok:false（搵唔到）", !!(psStep && psStep.ok === false), true);
    check("🔴 要有原因（唔可以靜默）", !!(psStep && psStep.reason), true);
    check("🔴 走咗重放後備路", bg.postMessageCount.replayCmds >= 1, true);
    // 🔴🔴 一定要**只行一次**：`step3b` 有「搵唔到下拉就重試一次」嘅保險，
    //    若寫成 `.then(A).then(B)`，A 嘅 `return` 唔會跳過 B ⇒ `step4` 行兩次
    //    （實測：replayCmds 變 2、trace 出現兩段 paging）。呢條鎖死佢。
    check("🔴🔴 重放只可以發一次（重試唔可以令 step4 行兩次）", bg.postMessageCount.replayCmds, 1);
    const pagingSteps = (r && r.trace || []).filter((t) => t && t.step === "paging");
    check("🔴 trace 只可以有一段 paging", pagingSteps.length, 1);
    check("🔴 仍然拎到明細", (r && r.transactions && r.transactions.length) || 0, 1);
  }

  group("[47] 🔴🔴🔴 多帳期走訪：由「開始日期」一路行到最新（第十七次真機）");
  {
    // 使用者原話（2026-09-29 第十七次）：
    //   「這個介面內, 是有超過一個的對帳日期時段, 你要知道要找到不同的時段
    //     去拿到對應的帳, 就比如, 我set 的時間是, 8月30日開始, 你就需要在
    //     頁面上找到 8月30日那個月的部份, 然後查看里面的數據,
    //     然後一直拿, 拿到最新的一天.」
    //
    // ⇒ 呢組鎖死三件事：
    //   ① 唔可以淨係抓「今日」嗰個帳期（要行晒開始日期之後全部）
    //   ② 每個帳期都要**自己撳一次「查看詳情」**（3 個帳期 = 3 次）
    //   ③ 行完一個要**閂彈窗**先好撳下一列（唔閂就撳唔到）
    const mk = (n, tag) =>
      Array.from({ length: n }, (_, i) => ({
        tradeNo: tag + "-" + String(i + 1).padStart(3, "0"),
        subsidyStoreReceiveAmtn: 10 + i,
      }));

    const bg = loadBridge({
      // 頁面係「新 → 舊」：9月尾 → 9月頭 → 8月尾
      periods: [
        "2026-09-16 ~ 2026-09-30",
        "2026-09-01 ~ 2026-09-15",
        "2026-08-16 ~ 2026-08-31",
      ],
      summaryIds: ["SID-SEP2", "SID-SEP1", "SID-AUG"],
      pageSizeSelect: { current: 20, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [mk(5, "SEP2"), mk(7, "SEP1"), mk(4, "AUG")],
      timeout: 30000,
      hardTimeout: 45000,
    });
    bg.emitPeriods([
      {
        id: "SID-SEP2",
        startDateStr: "2026-09-16",
        endDateStr: "2026-09-30",
        subsidyStoreReceiveAmtn: 900,
      },
      {
        id: "SID-SEP1",
        startDateStr: "2026-09-01",
        endDateStr: "2026-09-15",
        subsidyStoreReceiveAmtn: 700,
      },
      {
        id: "SID-AUG",
        startDateStr: "2026-08-16",
        endDateStr: "2026-08-31",
        subsidyStoreReceiveAmtn: 500,
      },
    ]);

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-08-30", // 使用者 set 嘅開始日 ⇒ 8月尾嗰個帳期都要
    });

    check("回 ok:true", !!(r && r.ok), true);
    // ① 🔴🔴 三個帳期全部都要行（唔可以淨係今日嗰個）
    check("🔴🔴🔴 三個帳期全部行晒", (r && r.periods && r.periods.length) || 0, 3);
    check(
      "🔴🔴 帳期順序由新到舊（含 8 月尾嗰個）",
      (r && r.periods || []).map((p) => p.period),
      ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
    );
    // ② 🔴🔴 每一個帳期都要自己撳「查看詳情」
    check(
      "🔴 三個帳期各撳一次「查看詳情」",
      bg.page.rowEls.map((row) => row.querySelectorAll("button")[0].clicked),
      [1, 1, 1],
    );
    // ③ 🔴🔴 行完要閂彈窗（3 個帳期 ⇒ 至少閂 2 次，最後一個閂唔閂都算完成）
    check("🔴🔴 有閂彈窗（否則撳唔到下一列）", bg.pgClicks.dialogCloses >= 2, true);
    // ③b 🔴🔴 每個帳期都要**自己**撳一次「每頁筆數」
    //     （彈窗重開會還原 20 ⇒ 唔可以淨係第一個帳期撳）
    check(
      "🔴🔴 每個帳期都各自撳到 50項/頁",
      bg.pgClicks.sizeChanges,
      [50, 50, 50],
    );
    // ④ 🔴🔴 明細要**逐帳期**唔同，加埋 16 筆（5+7+4）
    check(
      "🔴🔴🔴 全部帳期嘅明細合埋 = 16 筆",
      (r && r.transactions && r.transactions.length) || 0,
      16,
    );
    check(
      "🔴 每個帳期各自嘅明細數啱",
      (r && r.periods || []).map((p) => (p.transactions || []).length),
      [5, 7, 4],
    );
    check(
      "🔴 唔同帳期嘅 tradeNo 冇撈埋（8月嗰個仲喺度）",
      !!(r && r.transactions.some((x) => String(x.tradeNo).indexOf("AUG-") === 0)),
      true,
    );
    // ⑤ 🔴 每個帳期要有自己嘅帳期級金額（POS 逐帳期寫報表用）
    check(
      "🔴🔴 每個帳期有自己嘅實收金額",
      (r && r.periods || []).map((p) => p.receive),
      [900, 700, 500],
    );
    check(
      "🔴 每個帳期有自己嘅 summaryId",
      (r && r.periods || []).map((p) => p.summaryId),
      ["SID-SEP2", "SID-SEP1", "SID-AUG"],
    );
    // ⑥ 主帳期（最新）仍然要喺頂層，等舊有 popup／log 邏輯唔會壞
    check("🔴 頂層 period = 最新嗰個帳期", r && r.period, "2026-09-16 ~ 2026-09-30");
    check("🔴 頂層 receive = 最新帳期嘅實收", r && r.receive, 900);
    check("🔴 走訪統計要外露", r && r.periodWalk && r.periodWalk.ok, 3);
    check("🔴 仍然係零重放", bg.postMessageCount.replayCmds, 0);
  }

  group("[48] 🔴 開始日期之後嘅帳期先好行（唔好掃晒成個頁面）");
  {
    // 使用者 set 9月10日開始 ⇒ 「2026-08-16 ~ 2026-08-31」唔應該行
    //   （佢嘅結束日 08-31 < 09-10）。
    // 冇呢條界線，定時對帳會每次掃晒全部歷史帳期（慢到追唔上）。
    const mk = (n, tag) =>
      Array.from({ length: n }, (_, i) => ({
        tradeNo: tag + "-" + (i + 1),
        subsidyStoreReceiveAmtn: 1,
      }));
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
      summaryIds: ["SID-B", "SID-A", "SID-OLD"],
      pageSizeSelect: { current: 50, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [mk(2, "B"), mk(3, "A"), mk(9, "OLD")],
      timeout: 30000,
      hardTimeout: 45000,
    });
    bg.emitPeriods([
      { id: "SID-B", startDateStr: "2026-09-16", endDateStr: "2026-09-30", subsidyStoreReceiveAmtn: 10 },
      { id: "SID-A", startDateStr: "2026-09-01", endDateStr: "2026-09-15", subsidyStoreReceiveAmtn: 20 },
      { id: "SID-OLD", startDateStr: "2026-08-16", endDateStr: "2026-08-31", subsidyStoreReceiveAmtn: 30 },
    ]);

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-09-10",
    });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴🔴 只行開始日期之後嗰兩個", (r && r.periods && r.periods.length) || 0, 2);
    check(
      "🔴 8月尾嗰個帳期冇行（結束日早過開始日）",
      !!(r && r.transactions.every((x) => String(x.tradeNo).indexOf("OLD-") !== 0)),
      true,
    );
    check("🔴 8月嗰列完全冇撳過", bg.page.rowEls[2].querySelectorAll("button")[0].clicked, 0);
    check("🔴 明細 = 2 + 3 = 5 筆", (r && r.transactions.length) || 0, 5);
  }

  group("[49] 🔴 冇開始日期 ⇒ 只行「今日」嗰個帳期（保持低頻，唔好自己掃全頁）");
  {
    // 定時對帳係 60 秒一輪；每行一個帳期要 8~15 秒。
    // 若冇日期都掃晒成個頁面 ⇒ 永遠追唔上新帳期（反而連最新嗰個都冇）。
    const mk = (n, tag) =>
      Array.from({ length: n }, (_, i) => ({ tradeNo: tag + "-" + (i + 1), subsidyStoreReceiveAmtn: 1 }));
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15", "2026-08-16 ~ 2026-08-31"],
      summaryIds: ["SID-B", "SID-A", "SID-OLD"],
      pageSizeSelect: { current: 50, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [mk(2, "B"), mk(3, "A"), mk(9, "OLD")],
      timeout: 30000,
      hardTimeout: 45000,
    });
    bg.emitPeriods([
      { id: "SID-B", startDateStr: "2026-09-16", endDateStr: "2026-09-30", subsidyStoreReceiveAmtn: 10 },
      { id: "SID-A", startDateStr: "2026-09-01", endDateStr: "2026-09-15", subsidyStoreReceiveAmtn: 20 },
      { id: "SID-OLD", startDateStr: "2026-08-16", endDateStr: "2026-08-31", subsidyStoreReceiveAmtn: 30 },
    ]);

    const r = await bg.send({ type: "MFOODFIN_SYNC", targetDate: "2026-09-29" });

    check("回 ok:true", !!(r && r.ok), true);
    check("🔴 只行一個（命中今日嗰個）", (r && r.periods && r.periods.length) || 0, 1);
    check("🔴 行嘅係最新嗰個", r && r.period, "2026-09-16 ~ 2026-09-30");
    check("🔴 其他帳期完全冇撳過", [
      bg.page.rowEls[1].querySelectorAll("button")[0].clicked,
      bg.page.rowEls[2].querySelectorAll("button")[0].clicked,
    ], [0, 0]);
  }

  group("[50] 🔴 其中一個帳期失敗 ⇒ 其餘照交（唔可以一個失敗變全冇）");
  {
    // 真機常見：某個舊帳期嘅詳情彈窗撈唔到 id（平台唔再俾）。
    // 若因為佢一個搞到成次失敗 ⇒ 最新嗰個帳期嘅數都冇（靜默少一截）。
    const mk = (n, tag) =>
      Array.from({ length: n }, (_, i) => ({ tradeNo: tag + "-" + (i + 1), subsidyStoreReceiveAmtn: 1 }));
    const bg = loadBridge({
      periods: ["2026-09-16 ~ 2026-09-30", "2026-09-01 ~ 2026-09-15"],
      // 第二個帳期**冇** id ⇒ 撈唔到帳期 id（模擬平台唔再俾）
      summaryIds: ["SID-OK", null],
      pageSizeSelect: { current: 50, options: [10, 20, 30, 40, 50] },
      captureRowsByIndex: [mk(3, "OK"), mk(4, "BAD")],
      timeout: 30000,
      hardTimeout: 45000,
    });
    // 🔴🔴 第二個帳期**冇 id**（模擬平台唔再俾舊帳期）⇒ 任何途徑都搵唔到 id。
    //    但要**照樣畀一個 raw 列**，否則 `periods.length === 1` 會跌去
    //    `periods-only`（直接用唯一嗰個 id）⇒ 又係永遠唔會失敗嘅假測試。
    bg.emitPeriods([
      { id: "SID-OK", startDateStr: "2026-09-16", endDateStr: "2026-09-30", subsidyStoreReceiveAmtn: 10 },
      { startDateStr: "2026-09-01", endDateStr: "2026-09-15", subsidyStoreReceiveAmtn: 20 },
    ]);

    const r = await bg.send({
      type: "MFOODFIN_SYNC",
      targetDate: "2026-09-29",
      startDate: "2026-09-01",
    });

    check("🔴🔴 仍然 ok:true（唔可以一個失敗變全冇）", !!(r && r.ok), true);
    check("🔴 成功嘅帳期照交", (r && r.periods && r.periods.length) || 0, 1);
    check("🔴 失敗嗰個要如實列出", (r && r.failedPeriods && r.failedPeriods.length) || 0, 1);
    check(
      "🔴 失敗原因講明係撈唔到 id",
      !!(r && r.failedPeriods[0] && /帳期 id/.test(String(r.failedPeriods[0].reason))),
      true,
    );
    // 🔴🔴🔴 第十七次真機嘅**核心**：撈唔到 id 就唔可以「借用」上一個帳期嘅 id。
    //    舊寫法 `resolveSummaryId` 會問 MAIN world「上一次請求係邊個」
    //    ⇒ 上一個帳期嘅 id ⇒ 兩個帳期共用一個 id ⇒ 明細抄錯帳期
    //    （金額**有值但錯**，最難察覺嗰種）。一定要有一步 `summaryId` 係失敗嘅。
    const badSid = ((r && r.trace) || []).filter((t) => t.step === "summaryId" && t.ok === false);
    check("🔴🔴 撈唔到 id 時唔可以借用上一個帳期嘅 id", badSid.length >= 1, true);
    check("🔴 成功嗰個嘅明細仍然喺度", (r && r.transactions.length) || 0, 3);
  }

  group("[51] 🔴🔴 商家下拉失敗時，訊息要**如實報告**（唔可以斷言未驗證嘅事）");
  {
    // 使用者日誌（2026-09-30）：80/80 全敗，訊息都係
    //   「下拉打開咗但搵唔到「表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)」呢個商家」
    // 🔴 但呢句係**寫死**嘅 —— 冇驗證過下拉到底開唔開、亦冇講有冇任何選項。
    //
    // 兩種失敗係**唔同嘅事**，一定要分得開：
    //   ① 下拉有選項但冇一個啱  ⇒ 真係「名稱唔一致」（使用者要改設定）
    //   ② 一個可見選項都冇      ⇒ 下拉冇開／遠端搜尋未返（**唔關名稱事**）
    // 舊訊息把 ② 都講成 ① ，會誤導使用者去改一個根本冇錯嘅商家名。

    // ── 情境 A：目標名唔喺選項入面（＝真嘅名稱不符）──
    const bgA = loadBridge({});
    const rA = await bgA.send({
      type: "MFOODFIN_SYNC",
      targetDate: null,
      storeName: "唔存在嘅店名",
    });
    const tA = ((rA && rA.trace) || []).find((x) => x.step === "store");
    const msgA = String((tA && tA.reason) || "");
    check("情境A：仍然如實失敗", !!(tA && tA.ok === false), true);
    check("🔴 講明「有 N 個可見選項」", /有 \d+ 個可見選項/.test(msgA), true);
    check("🔴 唔可以再講「打開咗但搵唔到」呢句未驗證嘅話", /下拉打開咗/.test(msgA), false);
    check("情境A 要指出係名稱問題", /請確認名稱同後台一致/.test(msgA), true);

    // ── 情境 B：下拉一個可見選項都冇（＝唔關名稱事）──
    const bgB = loadBridge({ storeOptions: [], dropdownOpen: false });
    const rB = await bgB.send({
      type: "MFOODFIN_SYNC",
      targetDate: null,
      storeName: "表嫂美食",
    });
    const tB = ((rB && rB.trace) || []).find((x) => x.step === "store");
    const msgB = String((tB && tB.reason) || "");
    check("情境B：冇選項時仍然如實失敗", !!(tB && tB.ok === false), true);
    check(
      "🔴🔴 冇選項時**唔可以**叫使用者去核對名稱（咁會改錯嘢）",
      /請確認名稱同後台一致/.test(msgB),
      false,
    );
    check(
      "🔴 要講明「一個可見選項都冇」並提出遠端搜尋嘅可能",
      /一個可見選項都冇/.test(msgB) && /遠端搜尋/.test(msgB),
      true,
    );
  }

  /**
   * 🔴🔴 2026-09-30：`MFOODFIN_STORE_OPTIONS` —— 「讀出商家下拉可揀嘅店家」。
   *
   * 使用者原話：「你需要給商家在extension 上, 選擇用那家店, 去做mfood 對帳」
   * ⇒ 商家唔再手打商家名（真機 80/80 打錯），改為由後台真實清單揀。
   *
   * ⚠️ 三種情況一定要**分得開**（同 group[51] 同一紀律）：
   *   ① 搵唔到下拉容器       → ok:false（要報清楚係「唔喺對帳頁」）
   *   ② 開到但 0 個可見選項  → ok:true + options:[] + emptyReason（**唔係失敗**）
   *   ③ 有 N 個可見選項      → ok:true + options:[…]
   * 把 ② 當 ① 就會無故報「失敗」；把 ① 當 ② 就會話「0 個」而真正原因係去錯頁。
   */
  group("[52] 🔴🔴 讀出商家下拉清單（畀商家揀，唔使手打）");
  {
    // ── 情境③：正常有選項 ──
    const bgA = loadBridge({
      storeOptions: [
        "表嫂美食 燒烤館 (秘制燒五花, 蒜蓉茄皇, 無敵烤魚)",
        "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)",
        "表嫂美食(海贼龍蝦飯)",
      ],
    });
    const rA = await bgA.ask({ type: "MFOODFIN_STORE_OPTIONS" }, 4000);
    check("情境③：讀取成功", !!(rA && rA.ok), true);
    check("🔴 原樣交返全部選項（唔可以改名／截斷）", (rA && rA.options || []).length, 3);
    check(
      "🔴 商家名連招牌菜括號都要原樣保留（商家要認得出係邊間）",
      (rA && (rA.options || []).indexOf("表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)") >= 0),
      true,
    );
    check("情境③ 唔應該有 emptyReason", !(rA && rA.emptyReason), true);

    // ── 情境②：開到但 0 個可見選項（遠端搜尋未返）──
    const bgB = loadBridge({ storeOptions: [], dropdownOpen: false });
    const rB = await bgB.ask({ type: "MFOODFIN_STORE_OPTIONS" }, 4000);
    check("🔴🔴 情境②：仍然 ok:true（0 個選項**唔係**失敗）", !!(rB && rB.ok), true);
    check("🔴🔴 情境②：options 係空陣列（唔可以 undefined）", Array.isArray(rB && rB.options), true);
    check("🔴 情境②：要講明係「一個可見選項都冇」＋遠端搜尋", /一個可見選項都冇/.test(String((rB && rB.emptyReason) || "")) && /遠端搜尋/.test(String((rB && rB.emptyReason) || "")), true);

    // ── 情境①：去錯頁／冇下拉容器 → 硬失敗 ──
    // `storeOptions` 非空但 `dropdownOpen:false` 會令下拉無容器？唔係 ——
    // 要用「冇任何 .el-select」嘅頁。loadBridge 一定要 build 頁，
    // 所以用 `noStoreSelect:true` 令 buildPage 唔起商家下拉。
    const bgC = loadBridge({ noStoreSelect: true });
    const rC = await bgC.ask({ type: "MFOODFIN_STORE_OPTIONS" }, 4000);
    check("🔴 情境①：搵唔到下拉要如實失敗", !!(rC && rC.ok === false), true);
    check(
      "🔴 情境①：要指出係「唔喺對帳頁」而唔係「0 個選項」",
      /搵唔到商家下拉/.test(String((rC && rC.reason) || "")) &&
        !/一個可見選項都冇/.test(String((rC && rC.reason) || "")),
      true,
    );
  }

  process.on("unhandledRejection", (e) => {
    console.log("UNHANDLED REJECTION:", (e && e.stack) || e);
    process.exit(9);
  });
  process.on("uncaughtException", (e) => {
    console.log("UNCAUGHT:", (e && e.stack) || e);
    process.exit(9);
  });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`通過 ${passed} 項，失敗 ${failed} 項`);

  process.exit(failed > 0 ? 1 : 0);
})();
