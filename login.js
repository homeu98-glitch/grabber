/* ==========================================================================
   login.js —— 自動登入 content script（2026-09-29 登入前移）
   --------------------------------------------------------------------------
   注入範圍：merchant.aomiapp.com + *.mfoodapp.com（isolated world）

   職責只有一件事：**代商家完成登入**。
   資料擷取完全唔關呢個檔事 —— 澳覓簽章算不出，擷取仍然靠
   aomi-inject.js / mfood-inject.js 搭便車攔頁面自己嘅請求。

   訊息流（背景 ↔ 本檔）：
     本檔 → 背景  <PREFIX>_LOGIN_NEEDED   「我見到登入頁」→ 背景決定是否自動填
     背景 → 本檔  <PREFIX>_LOGIN_FILL     {username,password,orderPageUrl}
     本檔 → 背景  <PREFIX>_LOGIN_STATUS   {status:'ok'|'fail', stage, error}

   實測平台事實（2026-09-29，兩平台一致）：
     input[name="username"] / input[name="password"] / button.el-button--primary
     Element UI 受控元件 —— 填值必須 dispatchEvent，否則 Vue model 唔會更新。
     無圖形驗證碼；登入同頁完成（SPA hash 變化）。
   ========================================================================== */

(function () {
  'use strict';

  // 已處理過呢次 page load 嘅 LOGIN_NEEDED（防重複發）
  var loginNeededSent = false;
  // 正在跑登入流程（防同一頁面重入）
  var loginRunning = false;

  function platformPrefix() {
    var host = String(location.hostname || '');
    if (host.indexOf('mfoodapp.com') >= 0) return 'MFOOD';
    if (host.indexOf('aomiapp.com') >= 0) return 'AOMI';
    return null;
  }

  function isLoginRoute() {
    return /#\/login/.test(String(location.hash || ''));
  }

  function findUsername() {
    return document.querySelector('input[name="username"]');
  }

  function findPassword() {
    return document.querySelector('input[name="password"]');
  }

  /**
   * Element UI 受控元件填值。
   * 🔴 必須用 native setter + dispatchEvent('input')：直接賦值 .value
   *    只會改 DOM，Vue 內部 model 唔會更新，提交時仍是空值。
   */
  function fillInput(el, value) {
    if (!el) return false;
    var proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** 等 predicate 成立；每 400ms 一次，最多 timeoutMs。resolve(true)=等到 */
  function waitFor(pred, timeoutMs) {
    var limit = timeoutMs || 20000;
    return new Promise(function (resolve) {
      var started = Date.now();
      var timer = setInterval(function () {
        var v = false;
        try {
          v = pred();
        } catch (e) {
          v = false;
        }
        if (v) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started > limit) {
          clearInterval(timer);
          resolve(false);
        }
      }, 400);
    });
  }

  /**
   * 導向目標頁 —— **只改 hash，唔重新載入整頁**。
   *
   * 🔴 為什麼唔可以直接 `location.href = 目標URL`（2026-09-30 修正）：
   *    兩個平台都係 Vue + **hash 路由**嘅 SPA：由登入頁去訂單頁，本質上只係
   *    hash 由 `#/login…` 變成 `#/trade/tackout`。雖然對「只有 fragment 唔同」
   *    嘅 URL 賦值 `location.href` 通常仍屬同一份文件內導航，但只要有任何
   *    差異（實測登入頁係 `#/login?redirect=%2F`、平台亦可能隨時加參數或
   *    改路徑大小寫），就會變成**整頁重新載入**。
   *    整頁重載 ＝ SPA 由頭再啟動一次 ＝ 再問一次 session
   *    ⇒ 喺自動化循環入面就表現為「不停跳返登入頁」。
   *    `location.hash` 賦值 **100% 係同一份文件內導航**，永遠唔會重載。
   *
   * ⚠️ 只喺「同源 + 同路徑 + 同查詢」時才用 hash 導航；其餘情況老實用
   *    `location.href`（跨路徑冇得純 hash 導航）。
   *
   * 回 true ＝ **目的地已達成**（可能係啱啱導過去，亦可能本來就已經喺度）；
   * 回 false ＝ 導唔到（呼叫方要 fallback，例如背景用 chrome.tabs.update）。
   *
   * ⚠️ 「本來就已經喺目標 route」一定要回 true 而**唔可以**再導一次：
   *    多餘導航會重置平台頁面上啱啱設好嘅篩選（「訂單狀態＝全部」），
   *    令自動化每次登入都白做一次設定。
   */
  function gotoPage(targetUrl) {
    if (!targetUrl) return false;
    var cur = String(location.href || '');
    if (cur === targetUrl) return true; // 已經喺度
    var t;
    try {
      t = new URL(targetUrl, cur);
    } catch (e) {
      return false;
    }
    var sameDoc =
      t.origin === location.origin &&
      t.pathname === location.pathname &&
      t.search === location.search;
    if (!sameDoc) {
      try {
        location.href = targetUrl;
        return true;
      } catch (e2) {
        return false;
      }
    }
    var want = t.hash || '';
    if (!want) return true; // 同路徑又冇 hash ⇒ 已經等同喺目標
    var have = String(location.hash || '');
    // 已經喺目標 route（可能帶住平台自己加嘅子參數）⇒ 唔好再改
    if (have === want || have.indexOf(want + '?') === 0 || have.indexOf(want + '/') === 0) {
      return true;
    }
    try {
      location.hash = want;
      return true;
    } catch (e3) {
      return false;
    }
  }

  /**
   * 🔴🔴 2026-09-29 實測捉到嘅坑：`chrome.runtime.sendMessage(message, options, cb)`
   *     第二個參數係 **options**，唔係第二份 message。
   *     如果寫 `sendMessage({type:'..._LOGIN_STATUS', href}, {status, stage, error}, cb)`，
   *     成個 status payload 會被 Chrome 當 options 吞掉 ⇒ 背景收到嘅得 `{type, href}`，
   *     `request.status` 係 undefined ⇒ 主面板永遠顯示「自動登入失敗：未知原因」
   *     （呢個正正係最難查嗰種「明明登入咗但話失敗」）。
   *     ⇒ status / stage / error 一定要**合併入同一份 message**。
   */
  function reportStatus(prefix, payload) {
    try {
      var message = Object.assign(
        { type: prefix + '_LOGIN_STATUS', href: String(location.href || '') },
        payload || {},
      );
      chrome.runtime.sendMessage(message, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 背景 SW 休眠中 —— 無法回報就算了 */
    }
  }

  /**
   * 執行登入：等表單 → 填 → 提交 → 等離開 #/login → 導向訂單頁。
   * resolve 一個結果物件（永遠 resolve，唔會 reject）。
   */
  function runLogin(payload) {
    var prefix = platformPrefix();
    if (!prefix) return Promise.resolve({ ok: false, error: '未知平台 host' });
    if (loginRunning) return Promise.resolve({ ok: false, error: '登入進行中' });
    loginRunning = true;

    var username = String((payload && payload.username) || '');
    var password = String((payload && payload.password) || '');
    var orderPageUrl = String((payload && payload.orderPageUrl) || '');

    // ① 本來就不是登入頁（或已自動跳走）＝ 已登入
    if (!isLoginRoute() && !findUsername()) {
      loginRunning = false;
      if (orderPageUrl && payload && payload.navigateOnAlready) {
        // 背景新建嘅分頁落在首頁 → 導去訂單頁（回 navigated 等背景跳過二次導航）
        // 🔴 用 gotoPage()（純 hash 導航）：整頁重載會令 SPA 重啟、再問一次 session。
        var went1 = gotoPage(orderPageUrl);
        reportStatus(prefix, { status: 'ok', stage: 'already', navigated: went1 });
        return Promise.resolve({ ok: true, stage: 'already', navigated: went1 });
      }
      reportStatus(prefix, { status: 'ok', stage: 'already' });
      return Promise.resolve({ ok: true, stage: 'already' });
    }

    // ② 等表單出現。期間若 SPA 自己跳走（cookie 仍有效）＝ 已登入
    return waitFor(function () {
      if (!isLoginRoute()) return true; // 跳走了
      return !!(findUsername() && findPassword());
    }, 20000).then(function (settled) {
      if (!settled) {
        loginRunning = false;
        var err = '登入頁 20 秒內未出現帳密欄（頁面可能改版）';
        reportStatus(prefix, { status: 'fail', stage: 'wait-form', error: err });
        return { ok: false, error: err };
      }
      if (!isLoginRoute()) {
        // cookie 仍有效，SPA 自己跳走了
        loginRunning = false;
        // 🔴 gotoPage()：純 hash 導航，唔會整頁重載
        var went2 = orderPageUrl ? gotoPage(orderPageUrl) : false;
        reportStatus(prefix, { status: 'ok', stage: 'already', navigated: went2 });
        return { ok: true, stage: 'already' };
      }

      // ③ 填表 + 提交
      fillInput(findUsername(), username);
      fillInput(findPassword(), password);

      var btn =
        document.querySelector('button.el-button--primary') ||
        document.querySelector('button[type="submit"]');
      if (!btn) {
        loginRunning = false;
        var errBtn = '找不到登入按鈕（el-button--primary）';
        reportStatus(prefix, { status: 'fail', stage: 'no-button', error: errBtn });
        return { ok: false, error: errBtn };
      }
      btn.click();

      // ④ 等 hash 離開 #/login（最多 25 秒）
      return waitFor(function () {
        return !isLoginRoute();
      }, 25000).then(function (left) {
        loginRunning = false;
        if (!left) {
          var err2 = '提交後 25 秒仍在登入頁（帳密錯誤或頁面改版）';
          reportStatus(prefix, { status: 'fail', stage: 'submit', error: err2 });
          return { ok: false, error: err2 };
        }
        // ⑤ 成功 → 導向訂單頁（每天都要開嗰頁）
        // 🔴 gotoPage()：只改 hash，唔會令 SPA 由頭重啟（重啟就好易再跳返登入頁）
        var went3 = orderPageUrl ? gotoPage(orderPageUrl) : false;
        reportStatus(prefix, { status: 'ok', stage: 'submitted', navigated: went3 });
        return { ok: true, stage: 'submitted' };
      });
    });
  }

  // ---- 訊息接線 -------------------------------------------------------------
  // 背景送嚟 <PREFIX>_LOGIN_FILL；由 prefix 認返係咪自己平台。
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== 'string') return false;
      var prefix = platformPrefix();
      if (!prefix || msg.type !== prefix + '_LOGIN_FILL') return false;

      runLogin(msg).then(function (r) {
        try {
          sendResponse(r);
        } catch (e) {
          /* send channel 已關 */
        }
      });
      return true; // async sendResponse
    });
  }

  // ---- 開場回報 -------------------------------------------------------------
  // 頁面載入後停在登入頁 → 告訴背景（背景有憑證就會自動填，60 秒冷卻）。
  // 只在「見到登入 route 或表單」時先報；唔係每頁都嘈。
  function announceIfNeeded() {
    if (loginNeededSent) return;
    var prefix = platformPrefix();
    if (!prefix) return;
    if (!isLoginRoute() && !findUsername()) return;
    loginNeededSent = true;
    try {
      chrome.runtime.sendMessage(
        { type: prefix + '_LOGIN_NEEDED', href: String(location.href || '') },
        function () {
          void chrome.runtime.lastError;
        },
      );
    } catch (e) {
      /* 忽略 */
    }
  }

  // SPA hash 路由：載入後 + hash 變化都要看一眼
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(announceIfNeeded, 800);
      });
    } else {
      setTimeout(announceIfNeeded, 800);
    }
    window.addEventListener('hashchange', function () {
      setTimeout(announceIfNeeded, 500);
    });
  }
})();
