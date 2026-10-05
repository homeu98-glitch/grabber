/**
 * mfood-bridge.js — isolated world content script (mFood)
 *
 * 接收 mfood-inject.js（MAIN world）透過 window.postMessage 傳來的原始回應，
 * 正規化為 POS 認得的形狀 + 去重，再交給 background.js。
 *
 * ============================================================================
 * 🔴 最關鍵的一件事：mfood 的金額單位是「元」，澳覓是「分」
 * ============================================================================
 *   mfood : businessAmtn 62      → MOP 62.00    （已經是元，不要再除 100）
 *   澳覓  : turnoverAmount 12600 → MOP 126.00   （是分，必須除 100）
 *
 * 所以本檔「不做任何金額換算」，只做數值驗證。
 * 若誤把 mfood 當成分再除 100，MOP 62 會變成 MOP 0.62，對帳直接崩掉。
 * 這個行為已用 test/mfood.test.cjs 鎖住。
 * ============================================================================
 *
 * 另一個陷阱：列表與詳情的 amtn 不一樣
 *   列表 amtn 75.9  = 含全額配送費，未扣商家配送補貼、未扣贈品
 *   詳情 amtn 53.9  = 客人實際支付（已扣商家配送補貼 12 + 贈品 10）
 *   詳情 totalAmtn 63.9 = 折扣後應付（扣贈品前）
 *   → POS 顯示「客人付多少」請用詳情的 amtn；只有列表時要標示為「未定」。
 */

(function () {
  "use strict";

  if (window.__MFOOD_BRIDGE_INSTALLED__) return;
  window.__MFOOD_BRIDGE_INSTALLED__ = true;

  var TAG = "[mfood/bridge]";

  function trimmed(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/^\s+|\s+$/g, "");
  }

  /**
   * 數值驗證。
   *
   * ⚠️ 刻意「不」除以 100 —— mfood 的金額已經是元。
   * 這個函式只負責把字串轉數字、擋掉 NaN。
   */
  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    // mfood 金額最多兩位小數，四捨五入避免浮點誤差（75.90000000000001）
    return Math.round(n * 100) / 100;
  }

  /** epoch 毫秒 → ISO 8601。mfood 全部用毫秒時間戳，不像澳覓用字串。 */
  function msToIso(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    // 有些系統混用秒與毫秒，用大小判斷（1e12 以上視為毫秒）
    var ms = n > 1e11 ? n : n * 1000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function msOrNull(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    return n > 1e11 ? n : n * 1000;
  }

  // ---- 枚舉解碼 ------------------------------------------------------------
  //
  // 這些是「已從實際資料觀察到」的值。沒觀察到的值一律回 null，
  // 讓 POS 端看到 null 就知道要回頭查，而不是被錯誤翻譯誤導。

  var DELIVERY_TYPE = {
    1: "delivery", // 外送（有配送費 13.90）
    3: "pickup", // 自取（配送費 0.00）
  };

  var ORDER_STATUS = {
    4: "completed", // 已完成（畫面篩選「已完成」對應的即為此值）
  };

  var TRANSACTION_STATUS = {
    2: "paid", // 已付款（實際資料全部為 2）
  };

  function decodeDeliveryType(v) {
    var n = Number(v);
    return Object.prototype.hasOwnProperty.call(DELIVERY_TYPE, n) ? DELIVERY_TYPE[n] : null;
  }

  function decodeOrderStatus(v) {
    var n = Number(v);
    return Object.prototype.hasOwnProperty.call(ORDER_STATUS, n) ? ORDER_STATUS[n] : null;
  }

  function decodeTransactionStatus(v) {
    var n = Number(v);
    return Object.prototype.hasOwnProperty.call(TRANSACTION_STATUS, n) ? TRANSACTION_STATUS[n] : null;
  }

  // ---- 明細 ----------------------------------------------------------------

  /**
   * prdtList[] → POS OrderItem[]
   *
   * 品項規格在 mfood 分成三個陣列，要合併：
   *   propertiesNames : ["馬蹄","米飯","奶茶","蒸"]   ← 規格選項
   *   ingredientNames : ["加蒸蛋"]                    ← 加料
   *   extendNames     : []                            ← 額外
   */
  function normalizeItems(prdtList) {
    if (!Array.isArray(prdtList)) return [];

    var out = [];
    for (var i = 0; i < prdtList.length; i++) {
      var p = prdtList[i];
      if (!p || typeof p !== "object") continue;

      var name = trimmed(p.productName);
      if (!name) continue;

      var specs = []
        .concat(Array.isArray(p.propertiesNames) ? p.propertiesNames : [])
        .concat(Array.isArray(p.ingredientNames) ? p.ingredientNames : [])
        .concat(Array.isArray(p.extendNames) ? p.extendNames : [])
        .map(trimmed)
        .filter(Boolean);

      var qty = Number(p.buyCount);
      if (!isFinite(qty) || qty <= 0) qty = 1;

      var refundQty = Number(p.refundQty);
      if (!isFinite(refundQty) || refundQty < 0) refundQty = 0;

      out.push({
        // mfood 菜名不含編號（不像澳覓的 "A16.洋蔥炒雞"），name 與 displayName 相同，
        // 保留兩個欄位是為了與澳覓的輸出形狀一致，POS 端可以共用比對邏輯。
        name: name,
        displayName: name,
        itemCode: null,

        productId: p.productId ? String(p.productId) : null,
        skuId: p.skuId ? String(p.skuId) : null,
        skuName: trimmed(p.skuName) || null,

        quantity: qty,
        refundQuantity: refundQty,

        // ⚠️ 已是「元」
        // 🔴 用「實收單價」而唔係 skuPrice。
        //    實例（2026-09-24 真實 payload）：表嫂手打肉餅 skuPrice 58，
        //    但 productAmtn 67（含加購：轉五谷飯、加蒸蛋）。
        //    用 skuPrice 會令 POS 收據「原價合計」少 9 蚊 → 同營業額對唔上。
        unitPrice: num(p.productAmtn) > 0 ? num(p.productAmtn) / qty : num(p.skuPrice),
        lineTotal: num(p.productAmtn),
        boxPrice: num(p.boxPrice),
        boxNum: num(p.boxNum),

        specs: specs,

        // 原始物件：僅供診斷用
        raw: p,

        imageUrl: trimmed(p.imgUrl) || null,
      });
    }
    return out;
  }

  // ---- 訂單號（列表／詳情共用） --------------------------------------------

  /**
   * 🔴 2026-09-25 修正：mfood 嘅「訂單號」係**字串**（`"#1"`、`"#2"`，每日流水），
   * 舊寫法 `Number(row.orderNumber)` → `Number("#1")` = **NaN**
   * ⇒ 被當成「冇訂單號」⇒ 跌落 fallback `String(row.id).slice(-6)`
   * ⇒ POS 顯示 `MFOOD#269108`（= 平台內部 id `CRD202609251303412269108` 嘅尾 6 位）
   *   而唔係店員實際用嘅 `#1`（實案：商家問「為什麼 mfood 訂單是這個編號???」）。
   *
   * ⇒ 一律用「去空白後嘅原字串」，只把開頭嘅 `#` 剝走做數字檢查；
   *   同時要兼容「平台真係俾數字」嘅情況（故不能直接用 `trimmed()`）。
   *
   * 🔴 2026-09-29：由「淨列表用」抽出做共用 helper —— **詳情路徑以前完全冇單號欄位**，
   *    所以凡係「補 items 嗰輪由詳情路徑送出」嘅單，POS 五個候選全空、
   *    必然跌到「外部單號尾 6 位」（實案 `MFOOD#883658`）。
   *    兩條路徑**必須**行同一套正規化，否則又會再漂移一次。
   */
  function normalizeOrderNo(v) {
    if (v === null || v === undefined) return { has: false, num: null, raw: "" };
    var raw = String(v).trim();
    if (raw === "") return { has: false, num: null, raw: "" };
    var n = Number(raw.replace(/^#/, ""));
    if (!isFinite(n) || n <= 0) return { has: false, num: null, raw: raw };
    return { has: true, num: n, raw: raw };
  }

  // ---- 列表 ----------------------------------------------------------------

  /** 列表的一列（result[] 元素） → POS 形狀 */
  function normalizeListRow(row) {
    if (!row || typeof row !== "object" || !row.id) return null;

    var orderNo = normalizeOrderNo(row.orderNumber);

    // 扣掉已退數量後的品項數（mfood 列表不給明細，只能給總數）
    return {
      source: "mfood",
      externalOrderId: String(row.id),
      tradeNo: trimmed(row.tradeNo) || null,

      storeId: row.storeId ? String(row.storeId) : "",
      storeName: trimmed(row.storeName),

      // mfood 的「訂單號」是每日流水號（1,2,3…），與 tradeNo（CRD…）不同
      orderNumber: orderNo.has ? orderNo.num : null,
      // 保留平台原字串（`"#1"`）—— POS 會自己補平台前綴：`MFOOD#1`。
      // 🔴 列表係唯一有「平台原始列」嘅時刻 ⇒ 呢度可以安全地用尾 6 位做 fallback。
      localOrderNo: orderNo.has ? orderNo.raw : String(row.id).slice(-6),

      // 時間：一律轉 ISO 8601，同時保留原始毫秒方便比對
      createdAt: msToIso(row.createTime),
      createdAtMs: msOrNull(row.createTime),
      finishedAt: msToIso(row.finishTime),
      finishedAtMs: msOrNull(row.finishTime),

      // 狀態：同時給解碼值與原始碼，未觀察到的碼回 null
      orderStatus: decodeOrderStatus(row.orderStatus),
      orderStatusRaw: isFinite(Number(row.orderStatus)) ? Number(row.orderStatus) : null,
      transactionStatus: decodeTransactionStatus(row.transactionStatus),
      transactionStatusRaw: isFinite(Number(row.transactionStatus)) ? Number(row.transactionStatus) : null,

      fulfillmentType: decodeDeliveryType(row.deliveryType),
      deliveryTypeRaw: isFinite(Number(row.deliveryType)) ? Number(row.deliveryType) : null,

      // 僅供當次顯示 —— 不應落庫（見 docs 的個資提醒）
      receiverPhone: trimmed(row.receiverMobile) || null,
      receiverPhoneMasked: trimmed(row.receiverMaskPhone) || null,

      amount: {
        // ⚠️ 全部已是「元」。客人實付（未扣商家配送補貼與贈品）
        payAmount: num(row.amtn),
        // 商家營業額 = 商品 + 餐盒 + 膠袋 − 商家折扣
        businessAmount: num(row.businessAmtn),

        productAmount: num(row.productAmtn),
        boxFee: num(row.boxFee),
        plasticBagFee: num(row.plasticBagFee),
        serviceFee: num(row.serviceFee),
        deliveryFee: num(row.deliveryFee),
        discountDeliveryAmount: num(row.discountDeliveryAmtn),
        merchantDeliveryAmount: num(row.merchantDeliveryAmtn),
        farawayDeliveryFee: num(row.farawayDeliveryFee),

        discountFee: num(row.discountFee),
        fullReductionAmount: num(row.fullReductionAmtn),
        voucherAmount: num(row.discountVoucherAmtn),
        refundAmount: num(row.refundAmtn),
        pointAmount: num(row.disPointAmt),

        plasticBagQty: num(row.plasticBagQty),
        plasticBagPrice: num(row.plasticBagPrice),
      },

      refund: {
        viewable: row.isViewRefund === true,
        handler: row.isHandlerRefund === true,
        amount: num(row.refundAmtn),
        type: row.refundType ?? null,
      },

      isReserve: row.isReserve === true,

      // 列表 API 不含明細，要靠詳情 API
      items: [],
    };
  }

  // ---- 詳情 ----------------------------------------------------------------

  /** 詳情 → POS 形狀 */
  function normalizeDetail(d) {
    if (!d || typeof d !== "object" || !d.id) return null;

    /**
     * 🔴🔴 2026-09-29 修：詳情路徑**以前完全冇單號欄位**。
     *
     * 後果：凡係「補 items 嗰輪由詳情路徑送出」嘅單，POS `grabberLocalOrderNo()`
     * 嘅五個候選（`storeSeqNo` / `storeSeq` / `localOrderNo` / `orderNumber` / …）全空
     * ⇒ 必然跌落 `MFOOD#${externalOrderId.slice(-6)}`（實案 `MFOOD#883658`），
     *    同 popup 由**列表**記低嘅 `#75` 唔同 ⇒ 商家當係「寄錯單」。
     *
     * 點解以前冇人發現：POS 端 `grabber-order.ts` 有條**錯註釋**寫住
     * 「mfood normalizeDetail → orderNumber（數字）」⇒ 假安心。已同步修正。
     *
     * 🔴 有就用，**冇就出 null，絕對唔可以喺度 fallback 做「id 尾 6 位」**：
     *    呢度一寫死，POS 就冇機會再食到 `background.js` 由註冊表回填嘅真單號
     *    （`grabEnrichOrdersWithItems`），而且兩條路徑會永遠對唔上。
     */
    var orderNo = normalizeOrderNo(d.orderNumber);

    return {
      source: "mfood",
      externalOrderId: String(d.id),
      tradeNo: trimmed(d.tradeNo) || null,
      tradeSeq: trimmed(d.tradeSeq) || null, // 支付平台流水號（BOCAPPPAY…）

      orderNumber: orderNo.has ? orderNo.num : null,
      localOrderNo: orderNo.has ? orderNo.raw : null,

      orderStatus: decodeOrderStatus(d.orderStatus),
      transactionStatus: decodeTransactionStatus(d.transactionStatus),
      fulfillmentType: decodeDeliveryType(d.deliveryType),
      deliveryTypeRaw: isFinite(Number(d.deliveryType)) ? Number(d.deliveryType) : null,

      customer: {
        // ⚠️ mfood 給的是「完整」電話，不像澳覓有遮罩。
        // 這是個資，只應供當次畫面顯示，不要落庫（見 docs 的個資提醒）。
        phone: trimmed(d.receiverMobile) || trimmed(d.mobile) || null,
        name: trimmed(d.receiverName) || null,
        nickname: trimmed(d.buyerNick) || null,
        gender: isFinite(Number(d.receiverGender)) ? Number(d.receiverGender) : null,
        address: trimmed(d.address) || null,
        remark: trimmed(d.remark) || null,
        tableware: trimmed(d.tablewareQty) || null,
      },

      // 騎手資訊（mfood 特有，澳覓沒有）
      rider: {
        name: trimmed(d.riderName) || null,
        phone: trimmed(d.riderPhone) || null,
      },

      items: normalizeItems(d.prdtList),

      amount: {
        // ⚠️ 全部已是「元」
        // amtn = 客人實際支付（已扣商家配送補貼與贈品）—— 這才是「客人付多少」
        payAmount: num(d.amtn),
        // totalAmtn = 折扣後應付（扣贈品前）
        totalAmount: num(d.totalAmtn),
        // 商家營業額
        businessAmount: num(d.businessAmtn),

        boxFee: num(d.boxFee),
        plasticBagFee: num(d.plasticBagFee),
        serviceFee: num(d.serviceFee),

        // 注意：詳情的 deliveryFee 是「客人實付的配送費」（1.90），
        // 而列表的 deliveryFee 是「原始配送費」（13.90）。別搞混。
        deliveryFee: num(d.deliveryFee),
        basicDeliveryFee: num(d.basicDeliveryFee),
        merchantDeliveryAmount: num(d.merchantDisDeliveryAmtn),
        deliverySubsidyAmount: num(d.deliverySubsidyAmtn),
        incrementDeliveryFee: num(d.incrementDeliveryFee),

        fullReductionAmount: num(d.fullReductionAmtn),
        voucherAmount: num(d.voucherAmtn),
        giftAmount: num(d.giftAmtn),
        thirdPartyAmount: num(d.thirdPartyAmtn),
        pointAmount: num(d.disPointAmt),
        consumptionAmount: num(d.disConsumptionAmtn),
        mallCouponAmount: num(d.disMallCouponAmtn),
        memberUpAmount: num(d.memberUpMoneyAmt),
        refundAmount: num(d.refundAmtn),

        // 優惠名稱（POS 顯示「用了什麼券」用）
        discountNames: {
          fullReduction: trimmed(d.disFullName) || null,
          voucher: trimmed(d.disVoucherName) || null,
          gift: trimmed(d.disGiftName) || null,
          delivery: trimmed(d.disDeliveryName) || null,
          placeOrderVoucher: trimmed(d.placeOrderVoucherName) || null,
        },
      },

      member: {
        level: isFinite(Number(d.memberLevel)) ? Number(d.memberLevel) : null,
      },

      // 時間軸（全部 epoch 毫秒）
      timeline: {
        created: msToIso(d.createDate),
        paid: msToIso(d.payTime),
        accepted: msToIso(d.acceptDate),
      },

      // 原始碼，供 POS 端除錯
      raw: {
        orderStatus: d.orderStatus ?? null,
        transactionStatus: d.transactionStatus ?? null,
        deliveryType: d.deliveryType ?? null,
        isReserve: d.isReserve ?? null,
      },
    };
  }

  // ---- 頁面統計（用於驗證） -------------------------------------------------

  /**
   * list_store_for_takeout_merchant 回的是「當前查詢條件的統計」。
   * 我們不拿它來下單，但拿來驗證很有用：
   *   擷取到的訂單 businessAmount 加總 應該 ≈ storeBusinessAmount
   * 對不上就代表有漏抓。
   */
  function normalizeStats(s) {
    if (!s || typeof s !== "object") return null;
    if (!isFinite(Number(s.orderCount))) return null;

    return {
      orderCount: Number(s.orderCount),
      totalOrderAmount: num(s.totalOrderAmt),
      storeBusinessAmount: num(s.storeBusinessAmt),
      avgAmount: num(s.avgAmt),
      orderDiscountFee: num(s.orderDiscountFee),
      orderDeliveryFee: num(s.orderDeliveryFee),
      merchantDeliveryFee: num(s.merchantDeliveryFee),
      merchantSpecialDeliveryFee: num(s.merchantSpecialDeliveryFee),
      merchantFarawayDeliveryFee: num(s.merchantFarawayDeliveryFee),
      merchantSelfDeliveryFee: num(s.merchantSelfDeliveryFee),
    };
  }

  // ---- 送出 ----------------------------------------------------------------

  function forward(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      console.warn(TAG, "sendMessage failed", err);
    }
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

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.__mfoodGrabber !== true) return;

    var kind = event.data.kind;
    var payload = event.data.payload;
    var meta = event.data.meta || {};

    if (kind === "ready") {
      forward({
        type: "MFOOD_PAGE_READY",
        href: meta.href || window.location.href,
        at: new Date().toISOString(),
      });
      return;
    }

    if (kind === "order_list") {
      var list = payload.result;
      if (!Array.isArray(list)) return;

      var rows = [];
      for (var i = 0; i < list.length; i++) {
        var r = normalizeListRow(list[i]);
        if (r) rows.push(r);
      }
      // 🔴 2026-09-25：「0 行就唔轉發」撈亂咗兩件事（同 aomi-bridge 一樣）：
      //    · 失敗回應 → 頁面唔正常，唔可以更新 lastListCaptureAt
      //    · 合法空結果（店冇新單）→ 一定要更新，否則誤報「冇收到資料」
      var codeNum = payload.code == null ? null : Number(payload.code);
      if (codeNum !== null && isFinite(codeNum) && codeNum >= 400) return;

      // 有行但全部解析唔到 ＝ 我哋解析壞咗 ⇒ 轉發但標記（唔可以靜默當「冇單」）
      var parseFailures = list.length - rows.length;

      forward({
        type: "MFOOD_ORDER_LIST_CAPTURED",
        rows: rows,
        meta: {
          total: isFinite(Number(payload.total)) ? Number(payload.total) : null,
          url: meta.url,
          capturedAt: meta.capturedAt,
          empty: rows.length === 0,
          parseFailures: parseFailures,
        },
      });
      return;
    }

    if (kind === "order_detail") {
      var detail = normalizeDetail(payload);
      if (!detail) return;

      // 先放行等待者 —— 批次迴圈要靠這個推進，即使這一筆稍後被去重擋掉
      releaseDetailWaiter(detail.externalOrderId, detail);

      var key = "d|" + detail.externalOrderId + "|" + (detail.orderStatus || detail.raw.orderStatus || "");
      if (alreadyHandled(key)) return;

      forward({
        type: "MFOOD_ORDER_DETAIL_CAPTURED",
        detail: detail,
        meta: { url: meta.url, capturedAt: meta.capturedAt },
      });
      return;
    }

    if (kind === "replay_result") {
      releaseReplayWaiter(payload && payload.reqId, payload);
      return;
    }

    if (kind === "list_range_result") {
      releaseListRangeWaiter(payload && payload.reqId, payload);
      return;
    }

    if (kind === "template") {
      forward({ type: "MFOOD_TEMPLATE_CAPTURED", template: payload });
      return;
    }

    if (kind === "stats") {
      var stats = normalizeStats(payload);
      if (!stats) return;
      forward({
        type: "MFOOD_STATS_CAPTURED",
        stats: stats,
        meta: { url: meta.url, capturedAt: meta.capturedAt },
      });
      return;
    }
  });

  // ---- 重新掃描：請頁面自己去查詢 ------------------------------------------
  //
  // 不替頁面發請求（session／簽章綁在頁面手上，重放舊請求會失敗），
  // 只代替使用者按一下頁面上的「查詢」按鈕 —— 等同人工操作一次。
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
  //    pause / resume 靠記低上一次嘅 interval 秒數嚟復原 timer。
  var lastAutoSecs = null;

  function setAutoInterval(secs) {
    lastAutoSecs = secs;
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (!secs || Number(secs) <= 0) return { ok: true, running: false };

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

  /** 設定 input 的值（React/Vue 會攔截 setter，要用原生 setter 再派發事件） */
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
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function todayStr() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /** 把日期區間填進頁面的篩選器 */
  function applyDateRange(startDate) {
    var all = document.querySelectorAll("input");
    var dateInputs = [];

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var hint = (el.type || "") + " " + (el.placeholder || "") + " " + (el.className || "");
      if (el.type === "date" || /date|日期|開始|开始|start|end/i.test(hint)) {
        dateInputs.push(el);
      }
    }

    if (dateInputs.length === 0) {
      return { ok: false, reason: "在頁面上找不到日期輸入框" };
    }

    setInputValue(dateInputs[0], startDate);
    if (dateInputs.length > 1) setInputValue(dateInputs[1], todayStr());

    return { ok: true, count: dateInputs.length, from: startDate, to: todayStr() };
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

  // ---- 路線 B：列表請求重放（在指定日期區間抓全部） --------------------------
  //
  // 為什麼需要這條路：
  //   「只同步此日後」如果只靠 DOM 去點頁面上的日期選擇器，失敗率很高
  //   （React 受控元件、自製 picker…），而且失敗時我們完全無從得知。
  //   改成直接重放列表請求，時間範圍由我們自己決定，結果必然正確。
  //
  // ⚠️ 失敗時（閘道擋重放／還沒擷取到範本）自動退回 DOM 操作，
  //    並把「為什麼改用 DOM」一併回報 —— 不再有靜默失敗。

  var listRangeWaiters = {};
  var listRangeSeq = 0;

  function releaseListRangeWaiter(reqId, result) {
    if (!reqId) return;
    var w = listRangeWaiters[reqId];
    if (!w) return;
    delete listRangeWaiters[reqId];
    w(result);
  }

  function waitListRange(reqId, timeoutMs) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () {
        delete listRangeWaiters[reqId];
        resolve(null);
      }, timeoutMs);
      listRangeWaiters[reqId] = function (r) {
        clearTimeout(t);
        resolve(r);
      };
    });
  }

  /** 請 MAIN world 直接在指定日期區間重放列表請求 */
  function syncRangeViaApi(startDate, endDate) {
    listRangeSeq++;
    var reqId = "L" + listRangeSeq;
    var p = waitListRange(reqId, 20000);

    window.postMessage(
      { __mfoodCmd: true, cmd: "sync_range", startDate: startDate, endDate: endDate, reqId: reqId },
      window.location.origin,
    );

    return p.then(function (r) {
      return r || { ok: false, reason: "重放沒有回應（20 秒逾時）" };
    });
  }

  /**
   * 「套用日期並抓全部」。
   *
   * 兩條路線，按可靠度排序：
   *   ① API 重放 —— 我們自己決定 startTime / endTime（首選）
   *   ② DOM 操作 —— 填日期欄位 + 按查詢 + 翻頁（保底）
   *
   * 回傳會明確標示走了哪一條、以及 API 那條實際套用了什麼區間，
   * 讓使用者一眼看出「這次到底有沒有套用到我要的日期」。
   */
  function runSyncRange(msg) {
    var startDate = msg.startDate;
    var endDate = msg.endDate || todayStr();
    var steps = [];

    return syncRangeViaApi(startDate, endDate).then(function (api) {
      steps.push({
        step: "api",
        ok: !!(api && api.ok),
        reason: (api && api.reason) || null,
        applied: (api && api.applied) || null,
        rows: (api && api.rows) || 0,
      });

      if (api && api.ok) {
        return {
          ok: true,
          via: "api",
          applied: api.applied,
          rows: api.rows || 0,
          total: api.total == null ? null : Number(api.total),
          pages: 0,
          steps: steps,
        };
      }

      // 退回 DOM 操作
      return runSyncRangeDom(startDate, endDate, steps).then(function (r) {
        return Object.assign(
          { via: "dom", fallbackReason: (api && api.reason) || "API 重放失敗" },
          r,
        );
      });
    });
  }

  /**
   * 保底路線：先設「訂單狀態＝全部」→ 操作頁面的日期欄位 → 查詢 → 逐頁抓完
   *
   * 🔴🔴 2026-09-30 使用者真機：**呢條路一直冇設過「全部」**。
   *    使用者原話：「mfood 個邊, 我見到無選個訂單狀態為全部. …
   *              你沒選這個, mfood 訂單不會出來.」
   *
   *    路徑（①）API 重放會強制 `body.status = ""`（安全）；
   *    但一旦重放失敗跌落嚟呢條 DOM 保底，舊寫法**只做日期＋查詢** ——
   *    頁面仍係「已完成」⇒ ①拿唔到新單 ②`paginateAll()` 翻足 12 頁
   *    全部係同一批已完成單（白翻，而且會拖慢成條流程）。
   *
   *    ⇒ 一定要**先設篩選、再查**，而且設定失敗要老實寫入 `steps`
   *      （唔可以靜靜當成功 —— 呢個正正就係使用者今次撞到嘅情況）。
   */
  function runSyncRangeDom(startDate, endDate, steps) {
    var applied = applyDateRange(startDate, endDate);
    steps.push(Object.assign({ step: "date" }, applied));

    var btn = findClickable(QUERY_RE);
    if (!btn) {
      return Promise.resolve({ ok: false, reason: "找不到「查詢」按鈕", steps: steps });
    }

    // 🔴 設「訂單狀態＝全部」→ 才按查詢。
    //    刻意**放在日期之後**：兩個都係篩選，次序唔影響結果，
    //    但先填日期可以先暴露「日期欄位搵唔到」呢類硬故障，唔使白等一次 setOrderStatusAll。
    return setOrderStatusAll().then(function (st) {
      steps.push({
        step: "status",
        ok: !!(st && st.ok),
        already: !!(st && st.already),
        skipped: !!(st && st.skipped),
        value: (st && st.value) || null,
        reason: (st && st.reason) || null,
      });

      // 🔴 設唔到就唔好查 —— 否則會拿到一批「已完成」單當成全部，
      //    並即時寫入訂單記錄（比失敗更差：錯誤資料已經入庫）。
      if (!st || !st.ok) {
        return {
          ok: false,
          reason:
            "未能把「訂單狀態」設成「全部」：" +
            ((st && st.reason) || "未知原因") +
            " —— 唔可以用「已完成」嘅畫面去抓（會攞唔到新單）",
          steps: steps,
        };
      }

      try {
        btn.click();
        steps.push({ step: "query", ok: true, label: (btn.textContent || "").trim() });
      } catch (e) {
        return {
          ok: false,
          reason: "點擊查詢失敗：" + ((e && e.message) || e),
          steps: steps,
        };
      }

      // 等第一頁回來再開始翻頁
      return sleep(2500)
        .then(function () {
          return paginateAll(steps);
        })
        .then(function (r) {
          return { ok: true, pages: r.pages, steps: steps };
        });
    });
  }

  // ==========================================================================
  // 「訂單狀態」篩選 → 全部（2026-09-25 使用者要求）
  // --------------------------------------------------------------------------
  // ## UI 實況（使用者提供截圖）
  //   · 一個 **readonly** 嘅 `input.el-input__inner`，placeholder「請選擇」
  //     （Element-UI `el-select`）⇒ **打字一定失敗**，必須開面板揀。
  //   · 選項面板 `.el-select-dropdown__item`，其中一個文字係「全部」。
  //   · 旁邊有 label「訂單狀態」。
  //
  // ## 為何一定要做（唔係美觀問題）
  // 後台預設係「已完成」。而列表重放係「照抄請求範本、只改時間區間」⇒
  // 範本帶住 status=已完成 嘅話，**每次重放都只拎到已完成單
  //（新單係進行中／待取餐）⇒ 永遠漏新單**。
  //
  // ## 鐵律：唔可以「撳咗就當成功」
  // 最後一定要**回讀 `input.value`** 確認真係變咗「全部」，否則回原因。
  // ==========================================================================

  /** 由 input 往上搵有「訂單狀態」字樣嘅容器（label 通常係兄弟節點）。 */
  function nearOrderStatusLabel(el) {
    var node = el;
    for (var i = 0; i < 6 && node; i++) {
      var t = (node.textContent || "").replace(/\s+/g, "");
      // 加長度上限：祖先嘅 textContent 可能係成張表，唔可以當成「label 喺隔籬」
      if (t.length > 0 && t.length <= 60 && t.indexOf("訂單狀態") >= 0) return true;
      node = node.parentElement;
    }
    return false;
  }

  /** 由 el 往上搵第一個 class 含 cls 嘅祖先（含自己）。 */
  function closestByClass(el, cls) {
    var node = el;
    while (node) {
      if (node.classList && node.classList.contains && node.classList.contains(cls)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 搵「訂單狀態」嗰個 el-select 嘅 input。
   *
   * 🔴 🔴 **只准靠 label 定位，唔准靠「value === 全部」猜**（2026-09-25 實案）。
   *
   * 舊寫法係「見到 value === '全部' 就即刻回傳」—— 但 mfood 後台有**幾個**
   * `el-select`（訂單類型／配送類型／訂單狀態…），而「訂單類型」本身就係「全部」
   * ⇒ 會攞錯欄位，跟住讀到「全部」就以為「已經設好」⇒ **假報成功、完全冇撳過**，
   * 而商家見到嘅係「根本冇幫我選 filter」。
   *
   * 呢種「認錯對象 + 假成功」比直接失敗更貴（冇症狀、要查一輪）。
   * ⇒ 搵唔到就老實回 null，由呼叫端出錯誤原因 + 寫日誌。
   */
  function findOrderStatusSelect() {
    var all = document.querySelectorAll("input.el-input__inner");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue; // 唔可見唔算
      if (nearOrderStatusLabel(el)) return el; // label 係唯一權威
    }
    return null;
  }

  /**
   * 喺已展開嘅面板搵文字完全等於 label 嘅可見選項。
   *
   * 🔴🔴 2026-09-30 修復：舊寫法 `document.querySelectorAll(...)` 掃**成個頁**，
   * 而 mfood 後台有幾個 `el-select`（訂單類型／配送類型／訂單狀態…）都各有自己嘅
   * 「全部」選項。若另一個下拉都開住（上一次失敗留低／用家手開），就會撳錯
   * 另一個 select 嘅「全部」⇒ `box.value` 讀返唔到「全部」⇒ 第八次重試後報失敗，
   * 訂單狀態永遠設唔到「全部」（正正係用家投訴「無選個訂單狀態為全部」嘅一種成因）。
   * ⇒ 收 scopeEl（訂單狀態嗰個 `.el-select`）做邊界，只喺佢子樹入面搵。
   *    ⚠️ Element-UI `el-select` 嘅 `popper-append-to-body` **預設係 `true`**，
   *    dropdown 會被 teleport 到 `<body>`，**唔喺** `.el-select` 子樹入面。
   *    ⇒ scoped 喺預設情況下會搵唔到嘢（呢個就係 2026-09-30 修復後真機仲係「已完成」嘅根因）。
   *    ⇒ 呼叫端 `pick()` 會先用 scope 試、搵唔到再退返 `document` 全頁掃（保底）。
   */
  function findVisibleOption(label, scopeEl) {
    var base = scopeEl || document;
    var items = base.querySelectorAll(
      ".el-select-dropdown__item, .el-select-dropdown li, [role='option']",
    );
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if ((el.textContent || "").replace(/\s+/g, "") === label) return el;
    }
    return null;
  }

  /**
   * 把「訂單狀態」切去「全部」。**非同步**（面板有開合動畫，要重試）。
   *
   * 🔴 2026-09-25 實案（第二個 bug）：click 開面板之後**即刻**搵選項 ——
   *    但 Element-UI 嘅下拉係 `transform: scaleY(0) → scaleY(1)` 動畫，
   *    嗰一刻 `getBoundingClientRect()` 回 **0×0**，被「必須可見」嘅過濾剔走
   *    ⇒ 回「搵唔到『全部』」而**面板就留喺度開住**（使用者截圖正正係咁：卡住）。
   *    ⇒ 要「重試」等到動畫完；而且**唔可以**再 click（click 會閂咗個開住嘅面板）。
   */
  function setOrderStatusAll() {
    // 🔴 2026-09-28 真機：mfood 分頁可能開喺**財務對帳頁**
    //    （`#/finance/tackout-check`）—— 嗰度**冇**「訂單狀態」篩選欄位。
    //    舊寫法會回 `ok:false` 並寫 error 日誌，令 popup 一直顯示失敗警示，
    //    但其實**根本唔需要設**（財務頁同訂單重放無關）⇒ 假警報。
    //    ⇒ 認得係財務頁就回 `skipped`（唔算失敗，唔寫 error）。
    var hash = "";
    try {
      hash = String((window.location && window.location.hash) || "");
    } catch (e) {
      hash = "";
    }
    if (/finance|tackout-check|settle/i.test(hash)) {
      return Promise.resolve({
        ok: true,
        skipped: true,
        reason: "呢個分頁係財務對帳頁，冇「訂單狀態」篩選，唔需要設定",
      });
    }

    var box = findOrderStatusSelect();
    if (!box) {
      return Promise.resolve({
        ok: false,
        reason:
          "搵唔到「訂單狀態」篩選欄位（靠 label「訂單狀態」定位；頁面可能仲未載入完，或者版面已改）",
      });
    }

    var current = String(box.value || "").trim();
    if (current === "全部") {
      return Promise.resolve({ ok: true, already: true, value: current });
    }

    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };

    /** 試搵可見嘅「全部」並點落去。搵唔到回 null（未布局好）。 */
    function pick() {
      // 🔴🔴 2026-09-30 修復 + 當晚修正：
      //    先喺「訂單狀態」嗰個 .el-select 子樹入面搵（避免撳錯 訂單類型／配送類型 等其他 select 嘅「全部」），
      //    但 Element-UI 預設 popper-append-to-body=true，dropdown 會被 teleport 去 <body> 而不在 .el-select 子樹，
      //    所以 scoped 搵唔到時要退返 document 全頁掃（保底），否則真機永遠搵唔到「全部」⇒ 停留「已完成」。
      var scope = closestByClass(box, "el-select");
      var opt = findVisibleOption("全部", scope) || findVisibleOption("全部", null);
      if (!opt) return null;
      try {
        opt.click();
      } catch (e) {}
      var after = String(box.value || "").trim();
      if (after === "全部") return { ok: true, value: after };
      return { ok: false, reason: "已點「全部」但欄位仲係「" + (after || "(空)") + "」" };
    }

    // ① 面板可能**已經開住**（上一次失敗留低，或者商家自己開咗）
    //    ⇒ 直接揀；千祈唔好再 click（click 會閂咗佢 ⇒ 又搵唔到）。
    var direct = pick();
    if (direct) return Promise.resolve(direct);

    // ② 未開 → click 開面板
    try {
      box.click();
    } catch (e) {}

    // ③ 等動畫完：每 120ms 重試，最多 8 次（≈1 秒）
    var tries = 0;
    function retry() {
      var r = pick();
      if (r) return Promise.resolve(r);
      tries++;
      if (tries >= 8) {
        return Promise.resolve({
          ok: false,
          reason:
            "開唔到選項面板／搵唔到「全部」選項（欄位而家係「" +
            (current || "(空)") +
            "」）—— 面板可能未展開完，或者選項文字唔係「全部」",
        });
      }
      return sleep(120).then(retry);
    }
    return retry();
  }

  /**
   * 叫 MAIN world 回報「最近見過嘅財務請求」—— **包括完整 URL**。
   *
   * 🔴 2026-09-28 第五次真機（HTTP 404 追查嘅關鍵缺失）：
   *    我一直以為財務 API 喺 `merchant.mfoodapp.com`（頁面 origin），
   *    但真機 detail 請求嘅 body 係 `{"startDate":…,"storeId":…,"weekId":…}` ——
   *    呢個 body **唔含任何 host 資訊**，所以我從來冇驗證過 host！
   *    而 `location.origin + "/merchants/summarys/summary/_get-order-summary-list"`
   *    一旦 host 唔對，就會回 **404**（Vercel/nginx 對唔存在嘅路徑回 404），
   *    完全對得上使用者三次見到嘅症狀：
   *      · 請求 body 完全正確（有 weekId）
   *      · POS 端點正常（回 400）
   *      · 但重放永遠 404
   *    ⇒ 診斷**必須**回報攔截到嘅**絕對 URL**（含 host），
   *      先用 `location.origin` 做兜底（同源 SPA 最常見）。
   */
  function askForensicUrls(timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        try {
          window.removeEventListener("message", onMsg);
        } catch (e) {
          /* 忽略 */
        }
        resolve(v);
      }
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.__mfoodFinance !== true) return;
        if (d.kind !== "finance_seen_urls") return;
        finish(d.payload || null);
      }
      window.addEventListener("message", onMsg);
      try {
        window.postMessage(
          { __mfoodCmd: true, cmd: "finance_seen_urls" },
          window.location.origin,
        );
      } catch (e) {
        /* 忽略 */
      }
      setTimeout(function () {
        finish(null);
      }, timeoutMs || 1500);
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    // 🔴 財務頁「論證式診斷」：回報攔截到嘅財務請求**絕對 URL**（含 host）
    //    同頁面自己嘅 origin —— 呢兩者一比就知重放 host 對唔對。
    //    獨立成一個 listener 分支（財務頁唔會經下面嘅訂單分支）。
    if (msg.type === "GRAB_FINANCE_FORENSIC") {
      if (!onFinancePage()) {
        sendResponse({ ok: false, reason: "呢個分頁唔係 mfood 財務對帳頁" });
        return true;
      }
      askForensicUrls(2000).then(function (r) {
        sendResponse({
          ok: true,
          // 頁面自身 origin（重放時用嘅 host）——同請求 host 一比就知對唔對
          pageOrigin: String(window.location.origin || ""),
          pageHref: String(window.location.href || ""),
          seenUrls: r || [],
        });
      });
      return true;
    }

    // 自動節拍（秒數由使用者設定，可低於 30 秒）
    if (msg.type === "GRAB_SET_INTERVAL") {
      sendResponse(setAutoInterval(msg.secs));
      return true;
    }

    // 🔴🔴 2026-09-30：對帳期間暫停／恢復訂單頁自動查詢。
    //    background 喺進入對帳前 send GRAB_PAUSE_ORDERS（清走頁面 timer），
    //    對帳成功返回訂單頁後 send GRAB_RESUME_ORDERS（用 lastAutoSecs 復原）。
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

    // 🔴 存活探測（2026-09-25）：同 aomi-bridge 一樣 ——
    // background 唔可以用「有冇新訂單」判斷頁面死活。
    if (msg.type === "GRAB_PING") {
      sendResponse({
        ok: true,
        href: String(location.href || ""),
        ready: String(document.readyState || ""),
      });
      return true;
    }

    // 🔴 訂單狀態 → 「全部」（2026-09-25 使用者要求）
    //
    // ## 為什麼一定要做
    // 後台嘅「訂單狀態」預設係**已完成**。而擴充功能嘅列表重放係
    // 「照抄請求範本、只改時間區間」⇒ 範本一旦帶住 status=已完成，
    // **每次重放都只會拎到已完成單 ⇒ 新單（進行中／待取餐）永遠唔會出現**。
    // ⇒ 開始同步之前一定要確保呢個篩選係「全部」。
    if (msg.type === "GRAB_SET_ORDER_STATUS_ALL") {
      // 非同步：面板有開合動畫，setOrderStatusAll() 內部會重試（見該函式註釋）。
      setOrderStatusAll().then(sendResponse);
      return true; // 非同步回應
    }

    // 自動抓詳情
    if (msg.type === "GRAB_FETCH_DETAILS") {
      runDetailBatch(msg).then(sendResponse);
      return true; // 非同步回應
    }

    if (msg.type !== "GRAB_RESCAN") return;

    var RE = /查詢|查询|搜尋|搜索|刷新|重新整理|重新載入|重新加载/;
    var nodes = document.querySelectorAll('button, a, [role="button"]');
    var found = null;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var txt = (el.textContent || "").replace(/\s+/g, "");
      if (txt.length > 0 && txt.length <= 6 && RE.test(txt)) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          found = el;
          break;
        }
      }
    }

    if (!found) {
      sendResponse({ ok: false, reason: "找不到頁面上的「查詢」按鈕，請手動按一次。" });
      return;
    }

    try {
      found.click();
      sendResponse({ ok: true, label: (found.textContent || "").trim() });
    } catch (e) {
      sendResponse({ ok: false, reason: String((e && e.message) || e) });
    }
  });

  // ==========================================================================
  // 詳情批次：自動逐筆把品項抓回來
  // --------------------------------------------------------------------------
  // 路線 B（重放）：mfood 詳情請求無簽章，可直接重發 —— 快，不碰畫面。
  // 路線 A（DOM）：真的去點頁面上的「訂單詳情」—— 慢，但重放失敗時還能用。
  //
  // 第一次重放如果失敗，會自動切換到路線 A 並回報原因（自我測試）。
  // ==========================================================================

  var detailWaiters = {};
  var replayWaiters = {};
  var replayAvailable = null; // null = 還沒測過
  var replaySeq = 0;

  function releaseDetailWaiter(orderId, detail) {
    var w = detailWaiters[orderId];
    if (!w) return;
    delete detailWaiters[orderId];
    w(detail);
  }

  function releaseReplayWaiter(reqId, result) {
    if (!reqId) return;
    var w = replayWaiters[reqId];
    if (!w) return;
    delete replayWaiters[reqId];
    w(result);
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

  function waitReplay(reqId, timeoutMs) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () {
        delete replayWaiters[reqId];
        resolve(null);
      }, timeoutMs);
      replayWaiters[reqId] = function (r) {
        clearTimeout(t);
        resolve(r);
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

  // ---- 路線 B：請求重放 ----

  function replayOne(order) {
    replaySeq++;
    var reqId = "r" + replaySeq;
    var p = waitReplay(reqId, 12000);

    window.postMessage(
      { __mfoodCmd: true, cmd: "fetch_detail", orderId: order.id, reqId: reqId },
      window.location.origin,
    );

    return p.then(function (res) {
      if (res && res.ok) {
        replayAvailable = true;
        return { ok: true };
      }
      if (replayAvailable === null) {
        replayAvailable = false;
        report("MFOOD_REPLAY_TEST", {
          ok: false,
          orderId: order.id,
          reason: (res && res.reason) || "重放沒有回應",
          status: res && res.status,
        });
      }
      return { ok: false, reason: (res && res.reason) || "重放失敗" };
    });
  }

  // ---- 路線 A：模擬點擊 ----

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

    var p = waitDetail(order.id, 12000);
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

  // ---- 批次主迴圈 ----

  function runDetailBatch(msg) {
    var orders = Array.isArray(msg.orders) ? msg.orders : [];
    var delayMs = msg.delayMs || 1200;
    var strategy = msg.strategy || "replay";
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
          strategy: strategy,
          usedFallback: replayAvailable === false,
        };
        report("MFOOD_DETAIL_BATCH_DONE", result);
        /**
         * 🔴🔴 2026-09-30 真機確診：舊寫法 `Object.assign({ ok: true }, result)`
         *     —— `result.ok` 係「**成功筆數**」，會反過來覆蓋 `ok: true`。
         *     一筆都抓唔到時回 `ok: 0` ⇒ background 當成「派工失敗」
         *     ⇒ 唔計重試次數、唔標 `detailState` ⇒ **每 30 秒無限重派**
         *     （實測日誌 541 條），而摘要寫成「派工失敗（未計入重試）：undefined」。
         * ⇒ `ok` 只代表「批次有跑完」；成功筆數一律睇 `batchOk`。
         */
        return Promise.resolve(
          Object.assign({}, result, {
            ok: true,
            dispatched: orders.length,
            batchOk: okCount,
          }),
        );
      }

      var o = orders[i];
      var p;

      if (strategy === "replay" && replayAvailable !== false) {
        p = replayOne(o).then(function (r) {
          if (r.ok) return r;
          // 重放失敗且已判定不可用 → 立刻改用模擬點擊再試
          if (replayAvailable === false) return domOne(o);
          return r;
        });
      } else {
        p = domOne(o);
      }

      return p.then(function (r) {
        if (r && r.ok) okCount++;
        else {
          failCount++;
          failures.push({ id: o.id, reason: (r && r.reason) || "未知" });
        }

        // 重放很快，短暫停頓即可；模擬點擊要慢，避免像機器人
        var wait =
          strategy === "replay" && replayAvailable !== false ? Math.min(delayMs, 250) : delayMs;
        return sleep(wait).then(function () {
          return step(i + 1);
        });
      });
    }

    return step(0);
  }

  console.log(TAG, "installed on", window.location.href);
})();
