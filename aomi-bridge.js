/**
 * aomi-bridge.js — isolated world content script (澳覓)
 *
 * 接收 aomi-inject.js（MAIN world）透過 window.postMessage 傳來的原始回應，
 * 正規化為 POS 認得的形狀 + 去重，再交給 background.js。
 *
 * 為什麼要分兩個 world：
 *   MAIN world 才能包裝頁面的 fetch/XHR，但頁面可以讀寫 MAIN world 的變數。
 *   所以 inject 只做「抓」，bridge 做「處理」，兩者以 postMessage 溝通並驗證標記。
 */

(function () {
  "use strict";

  if (window.__AOMI_BRIDGE_INSTALLED__) return;
  window.__AOMI_BRIDGE_INSTALLED__ = true;

  var TAG = "[aomi/bridge]";

  // 澳覓金額單位一律是「分」。POS 內部用 MOP 元。
  //
  // 回傳規則（重要，不要改成一律回 0）：
  //   欄位不存在 / null / ""  →  回 null（代表「澳覓沒給這個欄位」）
  //   欄位是數字（含 0）      →  回換算後的 MOP 元
  // 區分兩者的原因：0 是「明確的零」（例如 refundAmt: 0 表示沒退款），
  // null 是「這個 API 沒回這個欄位」。混為一談會讓 POS 端誤以為有資料。
  function centsToMop(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n) / 100;
  }

  function trimmed(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/^\s+|\s+$/g, "");
  }

  var RECENT_MAX = 500;
  var recentKeys = new Set();

  function alreadyHandled(key) {
    if (!key) return false;
    if (recentKeys.has(key)) return true;
    recentKeys.add(key);
    if (recentKeys.size > RECENT_MAX) {
      recentKeys.delete(recentKeys.values().next().value);
    }
    return false;
  }

  /**
   * 抽出規格／附加選項。
   *
   * 平台把規格放在哪裡並不固定，澳覓畫面顯示成
   * 「馬蹄 + 米飯 + 例湯 + 蒸」，但 API 欄位名可能是 params / specNames /
   * propertiesNames… 所以這裡做防禦性掃描：只要是字串或字串陣列就收，
   * 再依 + ＋ 、 等分隔符拆成細項。
   */
  var SPEC_FIELDS = [
    "params",
    "specNames",
    "propertiesNames",
    "ingredientNames",
    "extendNames",
    "attributeNames",
    "attrs",
    "specifications",
    "options",
    "additions",
  ];

  function extractSpecs(g) {
    var flat = [];

    SPEC_FIELDS.forEach(function (k) {
      var v = g[k];
      if (Array.isArray(v)) {
        v.forEach(function (x) {
          var t = trimmed(x);
          if (t) flat.push(t);
        });
      } else {
        var t = trimmed(v);
        if (t) flat.push(t);
      }
    });

    // 依分隔符拆開（"馬蹄 + 米飯 + 例湯 + 蒸" → 4 項）
    var out = [];
    flat.forEach(function (s) {
      s.split(/\s*[+＋、,，]\s*/).forEach(function (x) {
        var t = trimmed(x);
        if (t && out.indexOf(t) < 0) out.push(t);
      });
    });
    return out;
  }

  /**
   * 把 orderGoods[] 轉成 POS 的 OrderItem 形狀。
   * 菜名常帶編號前綴（例："A16.洋蔥炒雞"），拆出來讓 POS 比對菜單更準。
   */
  function normalizeItems(goods) {
    if (!Array.isArray(goods)) return [];

    var out = [];
    for (var i = 0; i < goods.length; i++) {
      var g = goods[i];
      if (!g || typeof g !== "object") continue;

      var rawName = trimmed(g.menuName);
      if (!rawName) continue;

      var m = rawName.match(/^([A-Za-z]{0,3}\d{1,4})[.\u3002\uff0e\s]\s*(.+)$/);
      var itemCode = m ? m[1] : null;
      var displayName = m ? trimmed(m[2]) : rawName;

      var copies = Number(g.copies);
      if (!isFinite(copies) || copies <= 0) copies = 1;

      out.push({
        name: rawName,
        displayName: displayName,
        itemCode: itemCode,
        quantity: copies,
        unitPrice: centsToMop(g.actPrice),
        originalUnitPrice: centsToMop(g.oriPrice),
        totalPrice: centsToMop(g.totalActPrice),
        // 規格／附加選項。澳覓畫面顯示成「馬蹄 + 米飯 + 例湯 + 蒸」，
        // 來源欄位名可能隨版本不同 → 一併掃描常見命名，並把含分隔符的字串拆開。
        specs: extractSpecs(g),

        // 原始物件：僅供診斷用（若規格還是抓不到，可從這裡看出真正的欄位名）
        raw: g,
      });
    }
    return out;
  }

  /** 訂單列表的一列 → POS 形狀 */
  function normalizeListRow(row) {
    if (!row || typeof row !== "object" || !row.orderId) return null;

    var seq = trimmed(row.storeSeqNo);

    return {
      source: "aomi",
      externalOrderId: String(row.orderId),

      storeId: row.storeId ? String(row.storeId) : "",
      storeName: trimmed(row.storeName),

      // 澳覓列表給的是 "#2"（含 #），保留原樣；同時給一個不帶 # 的版本
      storeSeqNo: seq || null,
      localOrderNo: seq ? seq.replace(/^#/, "") : String(row.orderId).slice(-6),

      orderDateTime: trimmed(row.orderDateTime),
      finishTime: trimmed(row.finishTime) || null,

      // 注意：同一個狀態在 list / detail 有多種寫法
      // （"訂單已送達" / ORDER_ARRIVED / "客戶已確認收餐"），兩個都留
      stateRaw: trimmed(row.stateVal) || null,

      sendType: trimmed(row.sendType) || null,
      memberPhoneMasked: trimmed(row.memberPhone) || null,

      amount: {
        goodsAmount: centsToMop(row.goodsAmount),
        merchantActAmount: centsToMop(row.merchantActAmount),
        turnoverAmount: centsToMop(row.turnoverAmount),
        refundAmt: centsToMop(row.refundAmt),
        settleAmount: centsToMop(row.settleAmount),
        sendFeeAmt: centsToMop(row.sendFeeAmt),
        boxOrPackageAmt: centsToMop(row.boxOrPackageAmt),
        plasticBagAmt: centsToMop(row.plasticBagAmt),
        holidayServiceFeeAmt: centsToMop(row.holidayServiceFeeAmt),
        storeRedpacket: centsToMop(row.storeRedpacket),
        tipFeeByUser: centsToMop(row.tipFeeByUser),
        tipFeeByMerchant: centsToMop(row.tipFeeByMerchant),
      },

      // 列表 API 通常不回明細，要靠 detail API
      items: [],
    };
  }

  /** 訂單詳情 → POS 形狀 */
  function normalizeDetail(d) {
    if (!d || typeof d !== "object" || !d.orderId) return null;

    var seq = trimmed(d.storeSeq);

    return {
      source: "aomi",
      externalOrderId: String(d.orderId),

      stateEnum: trimmed(d.orderState) || null,
      stateRaw: trimmed(d.orderStateStr) || null,

      storeSeq: seq || null,
      localOrderNo: seq ? "#" + seq : null,

      memberShip: trimmed(d.memberShip) || null,
      sendType: trimmed(d.sendType) || null,
      sendTypeEnum: trimmed(d.sendTypeEnum) || null,

      customer: {
        // 澳覓只給遮罩電話（853-****9190），不是可用聯絡方式
        phoneMasked: trimmed(d.userRegistPhone) || trimmed(d.userReveivePhone) || null,
        name: trimmed(d.userNickName) || trimmed(d.userName) || null,
        address: trimmed(d.userAddress) || null,
        remark: trimmed(d.remark) || null,
        tableware: trimmed(d.tableware) || null,
      },

      items: normalizeItems(d.orderGoods),

      amount: {
        // 客人實付 = 菜品原價 + 餐盒 + 膠袋 + 配送費 - 商家活動 - 其他優惠
        payAmount: centsToMop(d.payAmt),
        // 營業額（商家口徑，已扣商家活動支出）—— 不等於客人實付
        turnoverAmount: centsToMop(d.turnoverAmt),
        // 預計收入（扣平台服務費後）
        settleAmount: centsToMop(d.settleAmount),
        totalAmount: centsToMop(d.totalAmt),
        goodsAllAmount: centsToMop(d.goodsAllAmount),
        boxAmt: centsToMop(d.boxAmt),
        plasticAmt: centsToMop(d.plasticAmt),
        sendAmt: centsToMop(d.sendAmt),
        merchantActAmt: centsToMop(d.merchantActAmt),
        // 🔴 節假日服務費：屬營業額公式其中一項，之前完全冇抓
        //    → POS 永遠搵唔到，要靠殘差行兜底（對數睇唔到呢一項）。
        holidayServiceAmt: centsToMop(d.holidayServiceAmt),
        platServiceAmt: centsToMop(d.platServiceAmt),

        breakdown: {
          merchantActDetails: Array.isArray(d.merchantActDetails)
            ? d.merchantActDetails.map(function (x) {
                return { content: trimmed(x.actContent), amount: centsToMop(x.actPrice) };
              })
            : [],
          platActDetails: Array.isArray(d.platActDetails)
            ? d.platActDetails.map(function (x) {
                return {
                  content: trimmed(x.actContent),
                  amount: centsToMop(x.actPrice),
                  merchantBorne: centsToMop(x.merchantActPrice),
                };
              })
            : [],
          platServiceDetails: Array.isArray(d.platServiceDetails)
            ? d.platServiceDetails.map(function (x) {
                return { name: trimmed(x.feeName), amount: centsToMop(x.feeAmount) };
              })
            : [],
        },
      },

      // cut-off 過濾用：最早的一筆狀態時間（通常為「付款成功」）。
      // 澳覓詳情本身沒有下單時間欄位，只能從狀態時間軸推導。
      occurredAt:
        Array.isArray(d.states) && d.states.length > 0
          ? trimmed(d.states[0].stateDate) || null
          : null,

      timeline: Array.isArray(d.states)
        ? d.states.map(function (s) {
            return { name: trimmed(s.stateName), at: trimmed(s.stateDate) };
          })
        : [],

      arrivedPic: trimmed(d.arrivedPic) || null,
    };
  }

  function forward(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      console.warn(TAG, "sendMessage failed", err);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.__aomiGrabber !== true) return;

    var kind = event.data.kind;
    var payload = event.data.payload;
    var meta = event.data.meta || {};

    if (kind === "ready") {
      forward({
        type: "AOMI_PAGE_READY",
        href: meta.href || window.location.href,
        at: new Date().toISOString(),
      });
      return;
    }

    if (kind === "list_probe") {
      var pw = probeWaiters[payload && payload.reqId];
      if (pw) {
        delete probeWaiters[payload.reqId];
        pw(payload.req || null);
      }
      return;
    }

    if (kind === "order_list") {
      // 展開前先驗結構 —— normalizeListRow 讀的是 payload.detailMsg.list，
      // 若 detailMsg 不存在會直接拋錯，整支 bridge 就掛了
      var dm = payload && payload.detailMsg;
      if (!dm || !Array.isArray(dm.list)) return;

      lastListSeenAt = Date.now();

      var rows = dm.list.map(normalizeListRow).filter(Boolean);

      // 🔴 2026-09-25：呢度之前用「0 行就唔轉發」做防護 —— 但佢撈亂咗兩件事：
      //    · **失敗回應**（HTTP 級錯誤碼）→ 頁面其實唔正常，唔可以更新 lastListCaptureAt
      //    · **合法空結果**（店真係冇新單）→ 一定要更新，否則誤報「冇收到資料」
      //    所以先擋失敗回應（>= 400 先算失敗；非數字碼無法判斷，一律放行）。
      var codeNum = payload.resultCode == null ? null : Number(payload.resultCode);
      if (codeNum !== null && isFinite(codeNum) && codeNum >= 400) return;

      // 有 N 行但一行都解析唔到 ＝ 我哋嘅解析壞咗（平台改版？）
      // ⇒ 唔可以靜默當「冇單」（會掩蓋真問題）⇒ 轉發但標記，由 background 出 error。
      var parseFailures = dm.list.length - rows.length;

      // 🔴 2026-09-25：**0 張單都要通知 background**。
      //
      // 舊寫法係 `if (rows.length === 0) return;`（「唔好驚動 background」）。
      // 但「店冇新單」係最常見嘅正常狀態 ⇒ 完全冇回報 ⇒ background 嘅
      // `lastListCaptureAt` 唔更新 ⇒ 過 10 分鐘就誤報「冇收到資料，
      // 請確認分頁仍開著且未被登出」（使用者 2026-09-25 實案）。
      //
      // 判斷「頁面係咪正常」唔可以用「有冇新訂單」—— 上面一行
      // `lastListSeenAt = Date.now()` 其實已經證明頁面有回應，之前只係冇講出來。
      //
      // 0 行係安全嘅：background 收到 rows: [] 只會更新 lastListCaptureAt、
      // fresh 會係空 ⇒ 唔會推送、唔會建單。
      forward({
        type: "AOMI_ORDER_LIST_CAPTURED",
        rows: rows,
        observedOnly: rangeObserveOnly === true,
        meta: {
          pageNum: dm.pageNum,
          pageSize: dm.pageSize,
          total: dm.total,
          traceId: (payload.businessMsg && payload.businessMsg.traceId) || null,
          capturedAt: meta.capturedAt,
          // 方便診斷：「呢一輪係空結果」同「解析壞掉」要分得清
          empty: rows.length === 0,
          parseFailures: parseFailures,
        },
      });
      return;
    }

    if (kind === "order_detail") {
      var detail = normalizeDetail(payload.detailMsg);
      if (!detail) return;
      detail.traceId = (payload.businessMsg && payload.businessMsg.traceId) || null;

      // 先放行等待者 —— 批次迴圈靠這個推進
      releaseDetailWaiter(detail.externalOrderId, detail);

      // 詳情也用同樣的 key 形式做一次本地去重，減少訊息量
      var key = "d|" + detail.externalOrderId + "|" + (detail.stateEnum || detail.stateRaw || "");
      if (alreadyHandled(key)) return;

      forward({
        type: "AOMI_ORDER_DETAIL_CAPTURED",
        detail: detail,
        meta: { url: meta.url, capturedAt: meta.capturedAt, traceId: detail.traceId },
      });
      return;
    }
  });

  // ---- 重新掃描：請頁面自己去查詢 ------------------------------------------
  //
  // 不替頁面發請求（X-Ca-Signature 綁定 method/path/body/timestamp/nonce，
  // 重放舊請求一定被拒），只代替使用者按一下頁面上的「查詢」按鈕。
  // ==========================================================================
  // 自動節拍：由內容腳本自己計時
  // --------------------------------------------------------------------------
  // chrome.alarms 的週期下限是 30 秒（瀏覽器硬限制），無法更短。
  // 所以改成頁面自己用 setInterval 計時 —— 分頁在前景時可精確到秒。
  // 背景的 30 秒 alarm 仍然保留當備援；它會比對「上次實際擷取時間」，
  // 若內容腳本已經跑過就不會重複觸發。
  // ==========================================================================

  var QUERY_RE = /查詢|查询|搜尋|搜索|刷新|重新整理|重新載入|重新加载/;
  var autoTimer = null;
  // 🔴🔴 2026-09-30：對帳期間要暫停訂單頁自動查詢，結束後要復原。
  var lastAutoSecs = null;

  function setAutoInterval(secs) {
    lastAutoSecs = secs;
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (!secs || Number(secs) <= 0) {
      automationOn = false;
      return { ok: true, running: false };
    }
    automationOn = true;

    var ms = Math.max(5, Number(secs)) * 1000;
    autoTimer = setInterval(function () {
      var btn = findClickable(QUERY_RE);
      if (btn) {
        try {
          btn.click();
        } catch (e) {
          /* 忽略 */
        }
      }
    }, ms);

    return { ok: true, running: true, secs: ms / 1000 };
  }

  // ---- 套用日期區間 + 逐頁抓完 --------------------------------------------------

  /**
   * 設定 input 的值。
   *
   * 🔴 只做「原生 setter + 派發事件」，**刻意不做 focus / select / execCommand**。
   *
   *    實測踩過（v1.25）：日期區間選擇器把兩個 input 當成同一個元件管理，
   *    對其中一個 focus 會讓另一個先提交成「只有一半的區間」，
   *    接著元件重新渲染就把我們填的第二個值蓋掉 ——
   *    結果變成「只填了開始日期、結束日期空白」，
   *    頁面反而**查不到任何單**（訂單總數全部變成 —）。
   *
   *    受控元件只要收到 input/change 事件就會更新內部值，
   *    不需要真的打字；真的打字反而會破壞 range 的成對狀態。
   */
  function setInputValue(el, value) {
    try {
      var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      try {
        el.value = value;
      } catch (e2) {
        /* 忽略 */
      }
    }
    dispatchInput(el, value);
  }

  /** 派發 input / change（能用 InputEvent 就用，帶 inputType 更接近真實輸入） */
  function dispatchInput(el, value) {
    try {
      var ev;
      try {
        ev = new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        });
      } catch (e) {
        ev = new Event("input", { bubbles: true });
      }
      el.dispatchEvent(ev);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      /* 忽略 */
    }
  }

  function todayStr() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /**
   * 這個 input 看起來是不是日期欄位？
   *
   * 除了看 input 自己（type / placeholder / class），**也看祖先容器** ——
   * 很多日期選擇器的 input 本身只有 class="el-range-input"，
   * 線索其實在包住它的 .el-date-editor / .el-range-editor 上。
   * 只看 input 自己會漏掉第二個框，變成「只填一半」的區間。
   *
   * 回傳「為什麼認為它是」（字串）或 null。
   */
  function dateInputHint(el) {
    var hint = (el.type || "") + " " + (el.placeholder || "") + " " + (el.className || "");
    if (el.type === "date" || /date|日期|開始|开始|start|end/i.test(hint)) return "self";

    var node = el.parentElement;
    for (var d = 0; d < 4 && node && node.nodeType === 1; d++) {
      var cls = String(node.className || "");
      if (/date|picker|calendar|range|time/i.test(cls)) return "container:" + cls.slice(0, 40);
      node = node.parentElement;
    }
    return null;
  }

  /** 依輸入框「現在的值」判斷它吃哪一種日期格式 —— 看現場，不猜設定 */
  function detectDateMode(el) {
    var v = String((el && el.value) || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) return "datetime";
    return null;
  }

  /** 依模式組出要填的值（開始取當日零點、結束取當日最後一刻） */
  function buildDateValue(dateStr, mode, edge) {
    if (mode === "datetime") {
      return dateStr + (edge === "start" ? " 00:00:00" : " 23:59:59");
    }
    return dateStr;
  }

  /**
   * 把日期區間填進頁面的篩選器。
   *
   * ⚠️ 澳覓做不到「直接呼叫 API」—— 它的簽章涵蓋完整 query string，
   *    改了 beginDate / endDate 簽章就失效。所以這裡只能操作頁面。
   *
   * 🔴 兩個一定要回報的東西（否則失敗時無從下手）：
   *    · afterStart / afterEnd —— 填完之後輸入框「實際剩下什麼值」。
   *      若元件把我們的值還原、或只留一半，這裡就會看到。
   *    · onlyOneInput —— 只找到一個日期框。區間選擇器少一個框，
   *      填出來的區間一定是壞的（這正是「頁面查不到單」的成因）。
   */
  function applyDateRange(startDate, endDate, forceMode) {
    var to = endDate || todayStr();
    var all = document.querySelectorAll("input");
    var dateInputs = [];
    var fields = [];

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var why = dateInputHint(el);

      if (fields.length < 15) {
        fields.push({
          type: el.type || "",
          placeholder: el.placeholder || "",
          cls: String(el.className || "").slice(0, 60),
          readonly: !!el.readOnly,
          value: String(el.value || "").slice(0, 24),
          match: why || "",
        });
      }

      if (why) dateInputs.push(el);
    }

    if (dateInputs.length === 0) {
      return { ok: false, reason: "在頁面上找不到日期輸入框", fields: fields };
    }

    var startEl = dateInputs[0];
    var endEl = dateInputs.length > 1 ? dateInputs[1] : null;

    // 先記下「填之前」的格式與值 —— 這才是判斷它吃哪種格式的依據
    var detected = detectDateMode(startEl) || detectDateMode(endEl) || null;
    var before = String(startEl.value || "").slice(0, 24);

    var mode = forceMode || detected || "date";
    var from = buildDateValue(startDate, mode, "start");
    var toValue = buildDateValue(to, mode, "end");

    setInputValue(startEl, from);
    if (endEl) setInputValue(endEl, toValue);

    // 很多選擇器是在 blur 時才提交值
    try {
      startEl.blur();
    } catch (e) {
      /* 忽略 */
    }
    if (endEl) {
      try {
        endEl.blur();
      } catch (e) {
        /* 忽略 */
      }
    }

    return {
      ok: true,
      mode: mode,
      detected: detected,
      before: before,
      from: from,
      to: toValue,
      // 填完之後實際剩下什麼 —— 元件若還原或只留一半，這裡看得出來
      afterStart: String(startEl.value || "").slice(0, 24),
      afterEnd: endEl ? String(endEl.value || "").slice(0, 24) : null,
      // 🔴 只找到一個日期框 = 區間一定是壞的
      onlyOneInput: dateInputs.length === 1,
      count: dateInputs.length,
      readonly: !!startEl.readOnly,
      fields: fields,
    };
  }

  /** 找「下一頁」按鈕（先比對文字、命中才量測，避免版面鎖死） */
  function findNextPage() {
    var nodes = document.querySelectorAll('button, a, li, span, [role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var txt = (el.textContent || "").replace(/\s+/g, "");
      if (!txt || txt.length > 4) continue;
      if (!/^(>|›|»|下一頁|下一页|Next)$/i.test(txt)) continue;

      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  function paginateAll(steps) {
    var pages = 0;
    var MAX_PAGES = 12;

    function next() {
      if (pages >= MAX_PAGES) {
        steps.push({ step: "paginate", stopped: "達上限 " + MAX_PAGES });
        return Promise.resolve({ pages: pages });
      }
      var btn = findNextPage();
      if (!btn) {
        steps.push({ step: "paginate", stopped: "沒有下一頁" });
        return Promise.resolve({ pages: pages });
      }
      try {
        btn.click();
      } catch (e) {
        steps.push({ step: "paginate", stopped: "點擊失敗" });
        return Promise.resolve({ pages: pages });
      }
      pages++;
      steps.push({ step: "page", n: pages });
      return sleep(2200).then(next);
    }

    return next();
  }

  // ---- 回讀「頁面實際送出的列表請求」 --------------------------------------
  //
  // 澳覓的簽章涵蓋完整 query string，所以我們無法自己改日期重放。
  // 唯一的路是操作頁面 —— 但操作頁面就有可能「按了但沒生效」。
  //
  // 所以我們反過來查證：查詢之後，回讀頁面剛才真正送出的列表請求 URL，
  // 檢查裡面的 beginDate / endDate / type 到底是不是我們要的。
  // 這一步是把「相信它成功」換成「證明它成功」。

  // 這一輪抓到的列表要不要「只記錄、不推送」。
  // 由 runOneType 依頁籤設定；列表回應是非同步到達的，所以用模組層級變數傳遞。
  var rangeObserveOnly = false;

  // 我們自己正在驅動頁面（同步作業中）→ 補償邏輯不要介入
  var autoDriving = false;
  // 開始／停止 總開關（由 GRAB_SET_INTERVAL 控制，secs=0 即停）
  var automationOn = false;
  // 最近一次「收到列表回應」的時間 —— 用來判斷頁面自己有沒有查
  var lastListSeenAt = 0;
  // 最近一次「代按查詢」的時間 —— 避免重複補償
  var lastCompensateAt = 0;

  var probeWaiters = {};
  var probeSeq = 0;

  function probeLastList() {
    return new Promise(function (resolve) {
      probeSeq++;
      var reqId = "p" + probeSeq;
      var done = false;

      var timer = setTimeout(function () {
        finish(null);
      }, 2500);

      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete probeWaiters[reqId];
        resolve(v);
      }

      probeWaiters[reqId] = finish;

      try {
        window.postMessage(
          { __aomiCmd: true, cmd: "probe_list", reqId: reqId },
          window.location.origin,
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  /** 把 URL 的 query string 拆成物件 */
  function parseQuery(url) {
    try {
      var q = String(url).split("?")[1] || "";
      var out = {};
      if (!q) return out;

      var parts = q.split("&");
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var idx = parts[i].indexOf("=");
        var k = idx < 0 ? parts[i] : parts[i].slice(0, idx);
        var v = idx < 0 ? "" : parts[i].slice(idx + 1);
        try {
          v = decodeURIComponent(v);
        } catch (e) {
          /* 保持原樣 */
        }
        out[k] = v;
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  // ---- 狀態頁籤（進行中 / 已完成）------------------------------------------
  //
  // 澳覓的「狀態」是單選 —— 沒有「全部」這個選項。
  // 所以要抓完整，必須切兩次：進行中（GOING）、已完成（FINISH）。
  // 只抓其中一種，另一種狀態的訂單就會永遠漏掉。

  // ⚠️ 頁籤文字實測是「進行中訂單」「已完成訂單」…（帶「訂單」後綴），
  //    而且可能帶數量括號。所以後綴一律容許 ——
  //    原本的 /^(進行中|…)$/ 全字錨定在真實頁面上一個都不會命中。
  var TAB_SUFFIX = "(?:訂單|订单)?[（(]?\\d*[）)]?";
  function tabRe(core) {
    return new RegExp("^(?:" + core + ")" + TAB_SUFFIX + "$", "i");
  }

  var TYPE_TABS = [
    { key: "GOING", label: "進行中", re: tabRe("進行中|进行中|處理中|处理中|待處理|待处理|GOING") },
    { key: "FINISH", label: "已完成", re: tabRe("已完成|完成|已結束|已结束|FINISH") },

    // 已取消／待退款：**只記錄，不推送**。
    // 理由：這兩種狀態的單不該變成 POS 訂單 ——
    // 廚房會為一張已經取消的單出單，那是實際的金錢與時間損失。
    { key: "CANCEL", label: "已取消", observeOnly: true, re: tabRe("已取消|取消|CANCEL|CANCELLED") },
    { key: "REFUND", label: "待退款", observeOnly: true, re: tabRe("待退款|退款中|退款|REFUND") },
  ];

  /**
   * 找狀態頁籤 —— 取「最內層」符合文字的元素。
   * 若取到外層容器，點擊可能落在空白處而無效，所以要比 DOM 深度。
   */
  function findTab(re) {
    var sel = '[role="tab"], .el-tabs__item, .ant-tabs-tab, li, button, a, span';
    var nodes = document.querySelectorAll(sel);
    var best = null;
    var bestDepth = -1;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;

      var txt = (el.textContent || "").replace(/\s+/g, "");
      if (!txt || txt.length > 12) continue;
      if (!re.test(txt)) continue;

      var d = 0;
      var p = el.parentElement;
      while (p) {
        d++;
        p = p.parentElement;
      }
      if (d > bestDepth) {
        bestDepth = d;
        best = el;
      }
    }
    return best;
  }

  // ---- 補償：切換狀態頁籤之後，替使用者按一次「查詢」 --------------------
  //
  // 澳覓的狀態頁籤有個毛病：點下去之後不一定會重新查詢，
  // 畫面就停在上一個狀態的資料 —— 使用者得自己再按一次查詢，或按 F5，
  // 才會看到該狀態的訂單。
  //
  // 我們不去猜它為什麼不查（那是人家的程式），只做一件確定有效的事：
  //   偵測到使用者點了狀態頁籤 → 稍等 → 若頁面自己沒有送出列表請求，
  //   就用頁面自己的「查詢」按鈕替它送一次。
  //
  // 🔴 用頁面的按鈕、而不是自己組請求，所以：不需要知道它的內部狀態怎麼存
  //    （hash？sessionStorage？），平台改版也不會失效。
  //
  // 同步作業進行中（autoDriving）時不介入 —— 那條路自己會按查詢。

  var TAB_CLICK_WAIT_MS = 900;
  var COMPENSATE_COOLDOWN_MS = 1500;

  /** 頁籤容器的選擇器 —— 只認這些，避免誤判 */
  var TAB_CONTAINER_SEL = '[role="tab"], .el-tabs__item, .ant-tabs-tab, li';

  /** 從被點到的元素往上找，看它是不是某個狀態頁籤 */
  function tabSpecOf(el) {
    var node = el;
    for (var depth = 0; depth < 4 && node && node.nodeType === 1; depth++) {
      var txt = (node.textContent || "").replace(/\s+/g, "");
      if (txt && txt.length <= 12) {
        // 🔴 必須真的是頁籤容器。
        //    否則訂單列表「訂單狀態」欄裡的「已完成」「訂單已取消」
        //    也會命中，使用者點一下儲存格就多送一次查詢。
        var isTab = !!(node.matches && node.matches(TAB_CONTAINER_SEL));
        if (isTab) {
          for (var i = 0; i < TYPE_TABS.length; i++) {
            if (TYPE_TABS[i].re.test(txt)) return TYPE_TABS[i];
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 用頁面自己的「查詢」按鈕送一次查詢 */
  function pressQuery(reason) {
    var btn = findClickable(QUERY_RE);
    if (!btn) return false;
    try {
      btn.click();
    } catch (e) {
      return false;
    }
    lastCompensateAt = Date.now();
    forward({
      type: "AOMI_AUTO_QUERY",
      ok: true,
      reason: reason,
      at: new Date().toISOString(),
    });
    return true;
  }

  // 🔴 用 typeof 檢查而不是直接寫 document：這個模組必須能在沒有 DOM 的環境
  //    載入（測試用的 vm 就是），否則會在載入階段就 ReferenceError，
  //    整個 bridge 掛掉、連擷取都做不到。
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener(
      "click",
      function (ev) {
        // 🔴 停止之後就唔准再干預頁面（補償器係「自動化」嘅一部分）
        if (autoDriving || !automationOn) return;
        var spec = tabSpecOf(ev.target);
        if (!spec) return;

        var clickedAt = Date.now();
        setTimeout(function () {
          if (autoDriving || !automationOn) return;
          // 頁面自己已經查了 → 不必多按一次（避免多一筆無謂的請求）。
          // 🔴 用 >= 而不是 >：回應很快時，「收到列表」與「使用者點擊」可能
          //    落在同一個毫秒。用 > 會判成「頁面沒查」而多按一次。
          if (lastListSeenAt >= clickedAt) return;
          // 剛剛才補償過 → 不重複
          if (Date.now() - lastCompensateAt < COMPENSATE_COOLDOWN_MS) return;
          pressQuery("切換到「" + spec.label + "」後頁面沒有自動查詢，已代為查詢");
        }, TAB_CLICK_WAIT_MS);
      },
      true,
    );
  }

  /** 按一下頁面的「查詢」按鈕（找不到回 false） */
  function clickQuery() {
    var btn = findClickable(QUERY_RE);
    if (!btn) return false;
    try {
      btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 從嘗試紀錄歸納出「為什麼日期沒套用」的一句話。
   * 使用者看到的是「日期未能套用」—— 但真正有用的是後面那句原因。
   */
  function dateFailReason(attempts) {
    var last = null;
    var verify = null;

    for (var i = attempts.length - 1; i >= 0; i--) {
      if (attempts[i].step === "date_verify" && !verify) verify = attempts[i];
      if (attempts[i].step === "date" && attempts[i].ok && !last) last = attempts[i];
    }

    if (!last) return "找不到日期輸入框";
    if (last.onlyOneInput) return "只找到一個日期框（區間只填了一半）";
    if (!verify || !verify.seen) return "頁面沒有送出查詢請求";
    return (
      "頁面送出的區間仍是 " +
      verify.seen.beginDate +
      " ~ " +
      verify.seen.endDate +
      "（" +
      last.mode +
      " 格式，填完後框內是 " +
      last.afterStart +
      " / " +
      last.afterEnd +
      "）"
    );
  }
  /**
   * 套用日期區間，並**確認它真的生效**。
   *
   * 🔴 為什麼一定要驗：
   *    澳覓的日期選擇器是受控元件。直接改 input.value 往往只改到
   *    「畫面上顯示的字」，元件內部的值沒變 —— 送出的請求仍是舊區間。
   *    這種失敗**沒有任何錯誤訊息**，只能靠回讀請求發現。
   *
   * 流程：套用 → 查詢 → 回讀請求的 beginDate/endDate → 不符就換另一種
   *      格式（純日期 ↔ 帶時間）再試一次。
   */
  function ensureDateRange(startDate, endDate, steps) {
    var attempts = [];

    function attempt(mode) {
      var applied = applyDateRange(startDate, endDate, mode);
      attempts.push(Object.assign({ step: "date", usedMode: mode || "auto" }, applied));

      if (!applied.ok) return Promise.resolve({ ok: false, mode: mode || null });

      return sleep(250)
        .then(function () {
          attempts.push({
            step: "date_query",
            mode: applied.mode,
            clicked: clickQuery(),
          });
          return sleep(2400);
        })
        .then(function () {
          return probeLastList();
        })
        .then(function (req) {
          var params = req && req.url ? parseQuery(req.url) : null;
          var seen = params
            ? { beginDate: params.beginDate || null, endDate: params.endDate || null }
            : null;

          var ok = !!(
            params &&
            String(params.beginDate) === String(startDate) &&
            String(params.endDate) === String(endDate)
          );

          attempts.push({ step: "date_verify", mode: applied.mode, verified: ok, seen: seen });
          return { ok: ok, mode: applied.mode };
        });
    }

    return attempt(null).then(function (r) {
      if (r.ok) {
        steps.push.apply(steps, attempts);
        return { ok: true, mode: r.mode, attempts: attempts };
      }

      // 換另一種格式再試 —— 日期選擇器吃純日期還是帶時間，未必判斷得出來
      var other = r.mode === "datetime" ? "date" : "datetime";
      return attempt(other).then(function (r2) {
        steps.push.apply(steps, attempts);
        return {
          ok: r2.ok,
          mode: r2.mode,
          reason: r2.ok ? null : dateFailReason(attempts),
          attempts: attempts,
        };
      });
    });
  }

  /**
   * 「套用日期並抓全部」。
   *
   * 澳覓只能操作頁面（簽章綁 query，無法自行改日期重放），流程是：
   *   ① 套用日期區間，並**回讀確認真的生效**（不生效就換格式再試）
   *   ② 逐一走訪 4 個狀態頁籤，各自「按查詢 + 翻頁 + 回讀驗證」
   *
   * ①② 都要回讀驗證 —— 過去正是少了這個，才會「看起來做了、實際沒生效」。
   * 若日期最終沒能套用，仍然照抓（背景的 cut-off 會擋掉範圍外的單），
   * 但結果會明確標示 dateOk: false，不假裝成功。
   */
  function runSyncRange(msg) {
    var startDate = msg.startDate;
    var endDate = msg.endDate || todayStr();
    var steps = [];

    // 同步作業期間由我們自己驅動頁面 —— 補償邏輯不要插手，免得雙重查詢
    autoDriving = true;

    return ensureDateRange(startDate, endDate, steps).then(function (dateResult) {
      var plan = [];
      for (var i = 0; i < TYPE_TABS.length; i++) {
        var el = findTab(TYPE_TABS[i].re);
        if (!el) continue;
        plan.push({
          key: TYPE_TABS[i].key,
          label: TYPE_TABS[i].label,
          el: el,
          observeOnly: !!TYPE_TABS[i].observeOnly,
        });
      }

      // 找不到狀態頁籤 → 只跑一輪，用頁面當前的狀態
      if (plan.length === 0) {
        plan.push({ key: "AS_IS", label: "目前狀態", el: null, observeOnly: false });
      }
      steps.push({
        step: "plan",
        types: plan.map(function (p) {
          return p.label;
        }),
      });

      var results = [];

      return plan
        .reduce(function (chain, item) {
          return chain.then(function () {
            return runOneType(item, startDate, endDate, steps).then(function (r) {
              results.push(r);
            });
          });
        }, Promise.resolve())
        .then(function () {
          autoDriving = false;
          return {
            ok: true,
            via: "dom",
            dateOk: dateResult.ok,
            dateMode: dateResult.mode,
            dateReason: dateResult.reason || null,
            types: results,
            verifiedTypes: results.filter(function (r) {
              return r.verified;
            }).length,
            pages: results.reduce(function (n, r) {
              return n + (r.pages || 0);
            }, 0),
            steps: steps,
          };
        });
    });
  }

  /**
   * 驅動一次：切頁籤 → 按查詢 → 翻頁 → 回讀頁面實際送出的請求。
   * 回傳 { pages, req } —— req 是回讀到的列表請求（沒觀察到就是 null）。
   */
  function driveType(item, steps, pass) {
    if (item.el) {
      try {
        item.el.click();
      } catch (e) {
        /* 忽略 */
      }
      steps.push({ step: "tab", ok: true, label: item.label, pass: pass });
    }

    return sleep(item.el ? 800 : 0)
      .then(function () {
        var btn = findClickable(QUERY_RE);
        if (!btn) {
          steps.push({
            step: "query",
            ok: false,
            label: item.label,
            pass: pass,
            reason: "找不到「查詢」按鈕",
          });
          return null;
        }
        try {
          btn.click();
        } catch (e) {
          /* 忽略 */
        }
        steps.push({ step: "query", ok: true, label: item.label, pass: pass });
        return sleep(2500);
      })
      .then(function () {
        return paginateAll(steps);
      })
      .then(function (r) {
        return probeLastList().then(function (req) {
          return { pages: (r && r.pages) || 0, req: req };
        });
      });
  }

  /**
   * 走完一種狀態。
   *
   * 🔴 為什麼要「驗證 + 重試」而不是驅動一次就相信它：
   *    澳覓切了狀態頁籤之後不一定會重新查詢，畫面會停在上一個狀態。
   *    如果我們只驅動一次就當成功，就會把上一個狀態的資料當成這一輪的結果 ——
   *    而且是靜默的（清單看起來有單、筆數也對，但其實是同一批）。
   *    所以一律回讀頁面實際送出的請求，type 不對就再驅動一次，最多兩趟。
   */
  function runOneType(item, startDate, endDate, steps) {
    var out = {
      type: item.key,
      label: item.label,
      verified: false,
      pages: 0,
      request: null,
      observeOnly: !!item.observeOnly,
      attempts: 0,
    };

    // 這一輪抓回來的列表要不要只記錄、不推送
    rangeObserveOnly = !!item.observeOnly;

    function judge(req) {
      var params = req && req.url ? parseQuery(req.url) : null;

      out.request = params
        ? {
            beginDate: params.beginDate || null,
            endDate: params.endDate || null,
            type: params.type || null,
            at: req.at || null,
          }
        : null;

      var ok = !!(
        params &&
        String(params.beginDate) === String(startDate) &&
        String(params.endDate) === String(endDate)
      );

      // 若頁面有帶 type，也一併核對（沒帶就不當作失敗）
      if (ok && params.type && item.key !== "AS_IS") {
        ok = String(params.type).toUpperCase() === item.key;
      }

      out.verified = ok;
      return ok;
    }

    function pass(n) {
      out.attempts = n;

      return driveType(item, steps, n).then(function (r) {
        out.pages = r.pages || 0;
        var ok = judge(r.req);

        steps.push({
          step: "verify",
          label: item.label,
          pass: n,
          verified: ok,
          seen: out.request || "（沒有觀察到列表請求）",
        });

        // 沒載到該狀態就再來一趟 —— 澳覓切完頁籤常常不會自己查
        if (!ok && n < 2) {
          steps.push({
            step: "retry",
            label: item.label,
            reason: "切換後沒有載入該狀態的訂單，重試一次",
          });
          return sleep(600).then(function () {
            return pass(n + 1);
          });
        }

        return out;
      });
    }

    return pass(1).then(function () {
      // 這一輪結束才恢復預設（可推送）
      rangeObserveOnly = false;
      return out;
    });
  }

  /**
   * 搵「查詢」掣。
   *
   * 🔴 優先用**主色（`el-button--primary`）而且文字剛好係「查詢」**嗰粒（2026-09-25）。
   * 使用者提供嘅真實 DOM：
   *   <button class="el-button el-button--primary el-button--medium"><span> 查詢 </span></button>
   *   <button class="el-button el-button--default el-button--medium"><span> 重置 </span></button>
   * 同一個容器就有「重置」；頁面其他地方亦可能有「重新整理 / 刷新」等字眼嘅掣。
   * 原本嘅模糊搜尋（任何 button 文字含 查詢/搜尋/刷新…、長度 ≤ 6）**可能先撳到第二粒**
   * ⇒ 撳錯掣 = 頁面根本冇查詢 ⇒ 之後所有「冇收到資料」都係假象（最難查嘅一種）。
   */
  function findQueryButton() {
    var RE = /查詢|查询|搜尋|搜索|刷新|重新整理|重新載入|重新加载/;
    var nodes = document.querySelectorAll('button, a, [role="button"]');
    var exact = null; // 文字剛好「查詢」但唔係主色
    var fuzzy = null; // 其他符合字眼嘅（最後選擇）
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      var txt = (el.textContent || "").replace(/\s+/g, "");
      if (!txt || txt.length > 6 || !RE.test(txt)) continue;
      if (txt === "查詢" && String(el.className || "").indexOf("el-button--primary") >= 0) {
        return el;
      }
      if (!exact && txt === "查詢") exact = el;
      if (!fuzzy) fuzzy = el;
    }
    return exact || fuzzy;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // 自動節拍（秒數由使用者設定，可低於 30 秒）
    if (msg.type === "GRAB_SET_INTERVAL") {
      sendResponse(setAutoInterval(msg.secs));
      return true;
    }

    // 🔴🔴 2026-09-30：對帳期間暫停／恢復訂單頁自動查詢。
    if (msg.type === "GRAB_PAUSE_ORDERS") {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
      sendResponse({ ok: true, paused: true });
      return true;
    }
    if (msg.type === "GRAB_RESUME_ORDERS") {
      if (lastAutoSecs) setAutoInterval(lastAutoSecs);
      sendResponse({ ok: true, paused: false, running: !!autoTimer });
      return true;
    }

    // 套用日期區間並逐頁抓完
    if (msg.type === "GRAB_SYNC_RANGE") {
      runSyncRange(msg).then(sendResponse);
      return true;
    }

    // 🔴 存活探測（2026-09-25）
    //
    // 用途：background 唔可以用「有冇新訂單」判斷頁面死活 —— 店冇新單時頁面照樣健康。
    // 呢個 ping 由 background 每次 tick 發一次，回得到就代表
    // **內容腳本仲活住**（收得到訊息＝擴充功能重載後冇失效）⇒ 寫入 `lastAliveAt`。
    // 回唔到（content script 已死）→ `chrome.runtime.lastError` → 現有嘅自動重載救援接手。
    if (msg.type === "GRAB_PING") {
      sendResponse({
        ok: true,
        href: String(location.href || ""),
        ready: String(document.readyState || ""),
      });
      return true;
    }

    // 自動抓詳情（澳覓只能模擬點擊）
    if (msg.type === "GRAB_FETCH_DETAILS") {
      runDetailBatch(msg).then(sendResponse);
      return true; // 非同步回應
    }

    if (msg.type !== "GRAB_RESCAN") return;

    var found = findQueryButton();
    if (!found) {
      sendResponse({ ok: false, reason: "找不到頁面上的「查詢」按鈕，請手動按一次。" });
      return;
    }

    var clickedAt = Date.now();
    try {
      found.click();
    } catch (e) {
      sendResponse({ ok: false, reason: String((e && e.message) || e) });
      return;
    }

    // 🔴 等 1.5 秒再回報「攔截器有冇見到請求」（2026-09-25 使用者要求：
    //    澳覓「你按查詢就可以」）。呢個回報可以一次分清兩種完全唔同嘅故障：
    //      · listSeen = true  → inject 有交列表上嚟（問題喺解析／過濾，會有 parseFailures）
    //      · listSeen = false → MAIN world 攔截器**乜都冇交** ⇒ 佢死咗，要 F5
    //    `lastListSeenAt` 係「inject 交咗列表上嚟」嗰一刻寫嘅（見上面 order_list 分支）。
    setTimeout(function () {
      sendResponse({
        ok: true,
        label: (found.textContent || "").trim(),
        listSeen: lastListSeenAt > clickedAt,
      });
    }, 1500);
    return true; // 非同步回應
  });

  // ==========================================================================
  // 詳情批次：自動逐筆開詳情把品項抓回來
  // --------------------------------------------------------------------------
  // 澳覓的詳情請求帶 Alibaba 閘道簽章（X-Ca-Signature 涵蓋 method / path /
  // query / nonce），換一個 orderId 簽章就對不上，**無法重放**。
  // 所以只能模擬點擊：點「訂單詳情」→ 等攔截到回應 → 關閉 → 下一筆。
  //
  // ⚠️ 分頁切到背景超過 5 分鐘後，串接的 timer 會被 Chrome 節流。
  //    但澳覓一天只有 2～3 筆，就算慢到每分鐘一筆也只需 3 分鐘。
  // ==========================================================================

  var detailWaiters = {};

  function releaseDetailWaiter(orderId, detail) {
    var w = detailWaiters[orderId];
    if (!w) return;
    delete detailWaiters[orderId];
    w(detail);
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function waitDetail(orderId, timeoutMs) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () {
        delete detailWaiters[orderId];
        resolve(null);
      }, timeoutMs);
      detailWaiters[orderId] = function (d) {
        clearTimeout(t);
        resolve(d);
      };
    });
  }

  function report(type, payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload), function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  var DETAIL_TEXT_RE = /訂單詳情|查看詳情|訂單明細|詳情|明細/;
  var CLOSE_TEXT_RE = /^(×|✕|✖|關閉|关闭|返回|取消|close)$/i;

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findClickable(re, root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('button, a, [role="button"], span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var txt = (el.textContent || "").replace(/\s+/g, "");
      if (txt.length > 0 && txt.length <= 8 && re.test(txt) && isVisible(el)) return el;
    }
    return null;
  }

  /**
   * 用單號在列表中找到那一列（取「含單號且內容最短」的容器）。
   *
   * 🔴 絕對不要對每個元素呼叫 getBoundingClientRect()。
   *    它會強制同步 reflow；在元素上萬的 SPA 上逐元素量測會把頁面鎖死 ——
   *    實測症狀就是「按下抓取品項後整個網頁卡住、點什麼都沒反應」。
   *
   *    改成：先做純文字比對（便宜、完全不觸發排版）→ 只在命中者中挑最短的。
   *    querySelectorAll 也收窄到 td / tr / li，不再掃所有 div。
   */
  /**
   * 用單號在列表中找到那一「列」。
   *
   * 🔴 一定要回傳整列（tr），不能回傳含單號的那個格子（td）。
   *    詳情按鈕在「操作」欄，跟單號不在同一個 td 裡；
   *    若回傳那個 td，findClickable 在裡面找不到按鈕，就會退回
   *    「全頁搜尋」→ 永遠點到第一張單的按鈕 → 每輪都在重抓同一張。
   *
   * 🔴 全程不呼叫 getBoundingClientRect（會強制同步 reflow，鎖死頁面）。
   */
  function findRow(order) {
    var needles = [order.tradeNo, order.id].filter(Boolean).map(String);
    if (needles.length === 0) return null;

    var all = document.querySelectorAll("td, tr, li");
    var best = null;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var txt = el.textContent || "";
      if (txt.length === 0) continue;

      var hit = false;
      for (var n = 0; n < needles.length; n++) {
        if (txt.indexOf(needles[n]) >= 0) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      if (!best || txt.length < best.len) best = { el: el, len: txt.length };
    }

    if (!best) return null;

    // 往上取列容器
    try {
      if (best.el.closest) {
        var tr = best.el.closest("tr");
        if (tr) return tr;
      }
    } catch (e) {
      /* 忽略 */
    }
    return best.el;
  }

  /** 關閉詳情：× → 返回/關閉 → ESC */
  function closeDetail() {
    var btn = findClickable(CLOSE_TEXT_RE);
    if (btn) {
      try {
        btn.click();
        return true;
      } catch (e) {
        /* 換下一招 */
      }
    }
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  function domOne(order) {
    var row = findRow(order);
    if (!row) return Promise.resolve({ ok: false, reason: "在列表中找不到這一列" });

    var btn = findClickable(DETAIL_TEXT_RE, row) || findClickable(DETAIL_TEXT_RE);
    if (!btn) return Promise.resolve({ ok: false, reason: "找不到「訂單詳情」按鈕" });

    var p = waitDetail(order.id, 15000);
    try {
      btn.click();
    } catch (e) {
      return Promise.resolve({ ok: false, reason: "點擊失敗：" + ((e && e.message) || e) });
    }

    return p.then(function (d) {
      closeDetail();
      return { ok: !!d, reason: d ? null : "等待詳情回應逾時" };
    });
  }

  function runDetailBatch(msg) {
    var orders = Array.isArray(msg.orders) ? msg.orders : [];
    var delayMs = msg.delayMs || 1200;
    var okCount = 0;
    var failCount = 0;
    var failures = [];

    function step(i) {
      if (i >= orders.length) {
        var result = {
          total: orders.length,
          ok: okCount,
          failed: failCount,
          failures: failures.slice(0, 8),
          strategy: "dom",
        };
        report("AOMI_DETAIL_BATCH_DONE", result);
        // 🔴 2026-09-30：同 mfood-bridge 同一坑 —— `result.ok` 係「成功筆數」，
        //    會覆蓋 `ok:true` ⇒ 一筆都抓唔到時 background 誤判成「派工失敗」
        //    ⇒ 唔計重試次數 ⇒ 每 30 秒無限重派。成功筆數改用 `batchOk`。
        return Promise.resolve(
          Object.assign({}, result, {
            ok: true,
            dispatched: orders.length,
            batchOk: okCount,
          }),
        );
      }

      var o = orders[i];
      return domOne(o).then(function (r) {
        if (r && r.ok) okCount++;
        else {
          failCount++;
          failures.push({ id: o.id, reason: (r && r.reason) || "未知" });
        }
        return sleep(delayMs).then(function () {
          return step(i + 1);
        });
      });
    }

    return step(0);
  }

  console.log(TAG, "installed on", window.location.href);
})();
