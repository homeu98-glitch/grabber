/**
 * aomi-inject.js — MAIN world content script (澳覓)
 *
 * 執行在頁面自己的 JS 環境（world: "MAIN"），在 document_start 時包裝
 * window.fetch 與 XMLHttpRequest，搭便車複製澳覓後台自己發出的訂單回應。
 *
 * 為什麼不自己打 API：
 *   澳覓 API 需要 HmacSHA256 簽章（X-Ca-Signature 等）+ session token +
 *   cookie。簽章綁定 method / 完整 path / body / timestamp / nonce，無法
 *   跨請求重用；而簽章金鑰只存在頁面 JS 記憶體或已編譯進 bundle，
 *   service worker 取不到。所以改為「讀頁面已經取回的資料」——
 *   零簽章邏輯、零密鑰、零額外請求。
 *
 * 本檔只做抓取與過濾，不發送任何網路請求（推送在 background.js）。
 */

(function () {
  "use strict";

  if (window.__AOMI_GRABBER_INSTALLED__) return;
  window.__AOMI_GRABBER_INSTALLED__ = true;

  var TAG = "[aomi/inject]";

  // 澳覓商家後台訂單 API 的 URL 特徵
  var ORDER_LIST_PATTERN = /takeoutOrderRecord\/list/i;
  var ORDER_DETAIL_PATTERN = /takeoutOrderRecord\/(detail|info|view|get)/i;

  // ── 財務對帳 API（2026-09-29 新增）────────────────────────────────────
  //
  // 🔴🔴 三支財務 API 嘅**回應形狀完全一樣**（`detailMsg.list` 陣列），
  //      所以**唔可以**靠 body 形狀分類，一定要靠 URL：
  //        ① hadSettlement   已打款帳期列表
  //        ② unSettlement    未出帳帳期列表
  //        ③ order/list      某帳期嘅逐筆明細（帶 accountId）
  //
  //      呢個係澳覓同 mfood 最大嘅分別（mfood 三支形狀唔同，可以靠形狀分）。
  var FINANCE_PERIOD_PATTERN = /settleService\/(hadSettlement|unSettlement)/i;
  var FINANCE_DETAIL_PATTERN = /settleService\/order\/list/i;

  // 財務頁專用命名空間（同訂單流程完全隔離，唔會撞）
  function postFinance(kind, payload, meta) {
    try {
      window.postMessage(
        { __aomiFinance: true, kind: kind, payload: payload, meta: meta },
        window.location.origin,
      );
    } catch (err) {
      console.warn(TAG, "postMessage(finance) failed", err);
    }
  }

  /** 由 URL 抽出 accountId（明細請求帶住佢，用嚟對帳期）。 */
  function accountIdOf(url) {
    var m = /[?&]accountId=([^&]+)/i.exec(String(url));
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  /** 財務回應是否成功 —— 澳覓用 `resultCode: "200"`（同訂單一致）。 */
  function financeOk(body) {
    if (!body || typeof body !== "object") return false;
    if (String(body.resultCode) === "200") return true;
    // 有些財務端點回 `code`
    return String(body.code) === "200";
  }

  /** 財務列表／明細回應是否似「有 list」。 */
  function looksLikeFinanceList(body) {
    return !!(
      body &&
      typeof body === "object" &&
      body.detailMsg &&
      typeof body.detailMsg === "object" &&
      (Array.isArray(body.detailMsg.list) || Array.isArray(body.detailMsg.records))
    );
  }

  /** 帳期／明細列抽出（相容 list / records；亦相容直接放陣列）。 */
  function financeRowsOf(dm) {
    if (!dm || typeof dm !== "object") return [];
    if (Array.isArray(dm.list)) return dm.list;
    if (Array.isArray(dm.records)) return dm.records;
    if (Array.isArray(dm.data)) return dm.data;
    return [];
  }

  /** 處理財務回應（由 fetch／XHR 包裝共用）。 */
  function handleFinance(kind, url, body, extraMeta) {
    if (!financeOk(body) || !looksLikeFinanceList(body)) return;
    var dm = body.detailMsg;
    var rows = financeRowsOf(dm);
    var meta = Object.assign(
      { url: url, capturedAt: new Date().toISOString(), pageUrl: window.location.href },
      extraMeta || {},
    );

    if (kind === "finance_periods") {
      postFinance(
        "finance_periods",
        {
          periods: rows.map(function (r) {
            return { raw: r };
          }),
          source: /hadSettlement/i.test(url)
            ? "hadSettlement"
            : /unSettlement/i.test(url)
              ? "unSettlement"
              : "unknown",
          total: dm.total != null ? dm.total : null,
        },
        meta,
      );
      return;
    }

    if (kind === "finance_detail") {
      var accountId = accountIdOf(url);
      postFinance(
        "finance_detail_captured",
        {
          accountId: accountId,
          rawResult: rows,
          result: rows,
          total: dm.total != null ? dm.total : null,
          pageNum: dm.pageNum != null ? dm.pageNum : null,
          pageSize: dm.pageSize != null ? dm.pageSize : null,
        },
        meta,
      );
      return;
    }
  }

  /** 把一次財務請求記入「最近一次請求」（診斷用，唔重放）。 */
  function noteFinanceRequest(url, method) {
    // 🔴 一定要**同時**記落模組變數 —— 舊寫法只 `postFinance` 咗一次事件，
    //    但 `lastFinanceReq` 由頭到尾**冇被賦值**（永遠係 null）
    //    ⇒ 反向命令 `finance_last_request` 一定回 null
    //    ⇒ `AOMIFIN_PROBE` 嘅 `lastRequestUrl` 永遠係 null
    //      （＝一條死咗嘅診斷，查錯方向時完全幫唔到手）。
    //    ⚠️ 呢種「宣告咗、讀過、但從未寫入」嘅變數，靜態檢查唔會出聲 ——
    //       只有測試會捉到（見 test/aomi-inject.test.cjs [10]）。
    lastFinanceReq = {
      url: String(url),
      method: String(method || "GET").toUpperCase(),
      accountId: accountIdOf(url),
      at: Date.now(),
    };
    postFinance(
      "finance_last_request",
      {
        url: lastFinanceReq.url,
        method: lastFinanceReq.method,
        accountId: lastFinanceReq.accountId,
        at: lastFinanceReq.at,
      },
      {},
    );
  }

  // ---- 回讀用：記錄「頁面真正送出的列表請求」 --------------------------------
  //
  // 澳覓的列表請求帶著 beginDate / endDate / type（狀態）三個篩選參數。
  // 我們不能自己改日期重放（簽章涵蓋完整 query string），只能操作頁面；
  // 但操作頁面有可能「按了但沒生效」。
  //
  // 所以我們把頁面每次送出的列表請求記下來，讓 bridge 事後回讀查證：
  // 「頁面剛剛真的用了我要的日期嗎？」——這是把猜測換成證據的關鍵一步。

  var lastListReq = null;

  /** 最近一次財務請求（診斷用）。 */
  var lastFinanceReq = null;

  function noteListRequest(url, method) {
    lastListReq = {
      url: String(url),
      method: String(method || "GET").toUpperCase(),
      at: Date.now(),
    };
  }

  // 來自 bridge 的反向命令（與 mfood 同一套模式）
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__aomiCmd !== true) return;

    if (d.cmd === "probe_list") {
      post("list_probe", { reqId: d.reqId, req: lastListReq, pageUrl: window.location.href }, {});
      return;
    }

    // 🔴 財務：叫 MAIN world 回報最近一次財務請求（診斷用，唔會重放）。
    if (d.cmd === "finance_last_request") {
      postFinance("finance_last_request", lastFinanceReq || null, {});
    }
  });


  function isSuccess(body) {
    return body && String(body.resultCode) === "200";
  }

  function looksLikeOrderList(body) {
    return !!(
      body &&
      typeof body === "object" &&
      body.detailMsg &&
      typeof body.detailMsg === "object" &&
      Array.isArray(body.detailMsg.list)
    );
  }

  function looksLikeOrderDetail(body) {
    return !!(
      body &&
      typeof body === "object" &&
      body.detailMsg &&
      typeof body.detailMsg === "object" &&
      typeof body.detailMsg.orderId === "string"
    );
  }

  function post(kind, payload, meta) {
    try {
      window.postMessage(
        { __aomiGrabber: true, kind: kind, payload: payload, meta: meta },
        window.location.origin,
      );
    } catch (err) {
      console.warn(TAG, "postMessage failed", err);
    }
  }

  function handle(kind, url, body, extraMeta) {
    if (!isSuccess(body)) return;

    var meta = Object.assign(
      { url: url, capturedAt: new Date().toISOString(), pageUrl: window.location.href },
      extraMeta || {},
    );

    if (kind === "order_list" && looksLikeOrderList(body)) {
      console.log(TAG, "captured order list,", body.detailMsg.size, "rows");
      post("order_list", body, meta);
      return;
    }

    if (kind === "order_detail" && looksLikeOrderDetail(body)) {
      console.log(TAG, "captured order detail", body.detailMsg.orderId);
      post("order_detail", body, meta);
      return;
    }
  }

  function classify(url) {
    // 🔴🔴 財務要**先**判（財務 URL 唔會撞訂單 URL，順序只係防禦性）。
    //    三支財務 API 回應形狀一樣 ⇒ 一定要靠 URL 分，唔可以靠 body。
    if (FINANCE_DETAIL_PATTERN.test(url)) return "finance_detail";
    if (FINANCE_PERIOD_PATTERN.test(url)) return "finance_periods";
    if (ORDER_DETAIL_PATTERN.test(url)) return "order_detail";
    if (ORDER_LIST_PATTERN.test(url)) return "order_list";
    return null;
  }

  /** 呢個 kind 係唔係財務。 */
  function isFinanceKind(kind) {
    return kind === "finance_detail" || kind === "finance_periods";
  }

  /**
   * 統一嘅「交貨」入口：訂單走舊通道，財務走新通道。
   */
  function dispatch(kind, url, body, extraMeta) {
    if (isFinanceKind(kind)) {
      if (kind === "finance_detail") noteFinanceRequest(url, (extraMeta && extraMeta.method) || "GET");
      handleFinance(kind, url, body, extraMeta);
      return;
    }
    handle(kind, url, body, extraMeta);
  }

  // ----------------------------------------------------------------- fetch
  var originalFetch = window.fetch;

  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      var url = "";
      try {
        url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      } catch (_) {
        url = "";
      }

      var kind = classify(url);
      if (kind === "order_list") {
        noteListRequest(url, (init && init.method) || (input && input.method) || "GET");
      }
      var promise = originalFetch.apply(this, arguments);
      if (!kind) return promise;

      return promise.then(
        function (response) {
          // clone() 讓我們能讀 body，不影響頁面自己的消費
          try {
            response
              .clone()
              .json()
              .then(function (body) {
                dispatch(kind, url, body, {
                  transport: "fetch",
                  method: (init && init.method) || (input && input.method) || "GET",
                });
              })
              .catch(function () {
                /* 不是 JSON，忽略 */
              });
          } catch (err) {
            console.warn(TAG, "response clone failed", err);
          }
          return response;
        },
        function (error) {
          throw error;
        },
      );
    };
  }

  // ------------------------------------------------------------------- XHR
  var OriginalXHR = window.XMLHttpRequest;

  if (OriginalXHR && OriginalXHR.prototype) {
    var originalOpen = OriginalXHR.prototype.open;
    var originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__aomiGrabber = { method: method, url: url, kind: classify(String(url)) };
        if (this.__aomiGrabber.kind === "order_list") noteListRequest(url, method);
      } catch (_) {
        this.__aomiGrabber = null;
      }
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function () {
      var info = this.__aomiGrabber;

      if (info && info.kind) {
        var self = this;
        this.addEventListener("load", function () {
          try {
            var body = null;
            if (self.responseType === "json") {
              body = self.response;
            } else if (self.responseType === "" || self.responseType === "text") {
              var text = self.responseText;
              if (text && text.length < 5 * 1024 * 1024) body = JSON.parse(text);
            }
            if (body) {
              dispatch(info.kind, info.url, body, {
                transport: "xhr",
                method: info.method,
                status: self.status,
              });
            }
          } catch (_) {
            /* 非 JSON，忽略 */
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }

  console.log(TAG, "installed on", window.location.href);
  post("ready", { href: window.location.href }, {});
})();
