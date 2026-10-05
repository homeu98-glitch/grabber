const TARGET_URL = "https://msp.macaupay.com.mo/msp/a/stpprdinf/mpopBasicStpprdinf/listData";
const DASHBOARD_URL = "https://msp.macaupay.com.mo/msp/a/stpprdinf/mpopBasicStpprdinf/list";

const SUPABASE_BASE_URL = "https://xuhgvlkxivztzrhfvwkb.supabase.co/rest/v1/transactions_from_mpaybackoffice";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1aGd2bGt4aXZ6dHpyaGZ2d2tiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjMwNzUzNSwiZXhwIjoyMDk3ODgzNTM1fQ.XYyTko7hscRG_SvBs9B-0CDdgXw6TOl5cuQVq01FjKw";

function formatDateTime(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/* ==========================================================================
   通用擷取框架（澳覓 aomi / mfood 共用）
   --------------------------------------------------------------------------
   每個來源都是「搭便車」讀頁面自己發出的請求回應：
     *-inject.js 在 MAIN world 攔截 fetch + XHR
     *-bridge.js 在 isolated world 正規化
     本檔負責：跨 session 去重、觀察日誌、推送（預設關閉）

   ⚠️ 全程不接觸任何簽章金鑰。澳覓的 X-Ca-Signature 綁定 method/path/body/
      timestamp/nonce 無法重用，金鑰也只存在頁面 JS 記憶體，所以我們不自己
      發請求，只複製頁面已經取回的資料。

   🔴 金額單位陷阱：澳覓是「分」，mfood 是「元」。
      換算在各自的 *-bridge.js 完成，本檔收到的一律已是 MOP 元。
   ========================================================================== */

const GRAB_LOG_MAX = 300;
const GRAB_SEEN_MAX = 2000;
const GRAB_STALE_MS = 10 * 60 * 1000; // 超過 10 分鐘沒擷取就告警

// 通知用的最小 icon（16x16 琥珀色圓點，內嵌避免依賴外部檔案）
const GRAB_NOTIFY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFwwYAAAcKAAF8YQ0zAAAAAElFTkSuQmCC';

/**
 * 各來源的差異全部集中在這裡。新增平台只要加一個條目，
 * 不用動下面的任何邏輯。
 */
const GRAB_SOURCES = {
  aomi: {
    key: 'aomi',
    prefix: 'AOMI',
    label: '澳覓',
    site: 'merchant.aomiapp.com',
    secretHeader: 'X-Aomi-Grabber-Secret',
    supportsStats: false,
    // 澳覓詳情請求帶 Alibaba 閘道簽章（涵蓋 method/path/query/nonce），
    // 換 orderId 即失效 → 無法重放，只能模擬點擊
    detailStrategy: 'dom',

    // 去重 key 含狀態 —— 狀態變化是有意義的更新，不該被當重複丟掉
    listKey: (r) => `${r.externalOrderId}|${r.stateRaw || ''}`,
    detailKey: (d) => `${d.externalOrderId}|detail|${d.stateEnum || d.stateRaw || ''}`,

    summarizeRow: (r) => ({
      orderId: r.externalOrderId,
      seq: r.storeSeqNo,
      state: r.stateRaw,
      amount: r.amount && r.amount.turnoverAmount,
      at: r.orderDateTime,
    }),

    summarizeDetail: (d) => ({
      orderId: d.externalOrderId,
      seq: d.storeSeq,
      state: d.stateEnum || d.stateRaw,
      payAmount: d.amount && d.amount.payAmount,
      items: (d.items || []).map((i) => {
        const n = i.itemCode ? `${i.itemCode} ${i.displayName}` : i.displayName;
        const sp = (i.specs || []).length > 0 ? `（${i.specs.join('/')}）` : '';
        return n + sp;
      }),
    }),
  },

  mfood: {
    key: 'mfood',
    prefix: 'MFOOD',
    label: 'mfood',
    site: 'mfood 商戶後台',
    secretHeader: 'X-Mfood-Grabber-Secret',
    supportsStats: true,
    // mfood 詳情請求沒有任何簽章標頭（只靠 cookie）→ 可直接重放
    detailStrategy: 'replay',
    /**
     * 🔴 開始同步之前，要把後台嘅「訂單狀態」篩選切去「全部」（2026-09-25 使用者要求）。
     *
     * 後台預設係「已完成」，而列表重放係「照抄請求範本、只改時間區間」——
     * 範本一旦帶住 status=已完成，每次重放都只拎到已完成單
     * （**新單係「進行中」**）⇒ 永遠漏新單。
     * 澳覓冇呢個篩選（佢走 4 個狀態頁籤）⇒ 只有 mfood 要。
     */
    needsOrderStatusAll: true,

    listKey: (r) => `${r.externalOrderId}|${r.orderStatus || r.orderStatusRaw || ''}`,
    detailKey: (d) =>
      `${d.externalOrderId}|detail|${d.orderStatus || (d.raw && d.raw.orderStatus) || ''}`,

    summarizeRow: (r) => ({
      orderId: r.externalOrderId,
      seq: r.orderNumber,
      state: r.orderStatus || `raw:${r.orderStatusRaw}`,
      amount: r.amount && r.amount.businessAmount,
      at: r.createdAt,
    }),

    summarizeDetail: (d) => ({
      orderId: d.externalOrderId,
      payAmount: d.amount && d.amount.payAmount,
      items: (d.items || []).map((i) => {
        const sp = (i.specs || []).length > 0 ? `（${i.specs.join('/')}）` : '';
        return i.displayName + sp;
      }),
      specs: (d.items || []).map((i) => (i.specs && i.specs.length ? i.specs.join('/') : null)),
    }),
  },
};

// POS 接收端點與共享密鑰 —— 由系統內建，不開放使用者設定。
// 使用者只需要填 Store ID，連線細節由系統決定。
//
// ⚠️ 這兩個是打包進擴充功能的常數。本擴充功能目前只在本機以
//    「載入未封裝項目」使用，所以可接受；若日後要公開發佈，必須改成
//    由 POS 端以 Store ID 換取短期憑證，不可把長期密鑰留在用戶端。
const POS_ENDPOINT = 'https://macau-pos-system.vercel.app/api/integration/grabber/orders';

/**
 * 平台結算（實收）端點（2026-09-26）。
 *
 * ⚠️ 同 `POS_ENDPOINT` 係**兩條 route**：orders 係 `DO NOTHING`（保護店員已推進嘅狀態），
 *    settlement 係 `UPDATE`（補寫實收金額落已存在嘅列）。語意相反，唔可以共用。
 */
const POS_SETTLEMENT_ENDPOINT =
  'https://macau-pos-system.vercel.app/api/integration/grabber/settlement';
// 查店名（同一個 integration/grabber 命名空間，共用 X-Grabber-Secret）。
// 由 POS_ENDPOINT 推導 —— 唔可以另外寫死一條 URL，否則換網域時兩條會漂移。
const POS_STORE_ENDPOINT = POS_ENDPOINT.replace(/\/orders$/, '/store');
const POS_SHARED_SECRET = '575a4f3bb5ab58d979974af1c3345a730ec68bb81a99f450d90f75d5bde1e9cc';

const GRAB_DEFAULT_SETTINGS = {
  // 觀察模式：預設關閉推送，只記錄，不對外發任何請求
  pushEnabled: false,

  // ---- 自動化（預設全關，要使用者確認過才開）----
  // 定時請後台分頁自己去按「查詢」
  autoRefresh: false,
  // 自動逐筆抓訂單詳情（品項）
  autoFetchDetails: false,
  // 路線 A（模擬點擊）每筆之間的間隔
  detailDelayMs: 1200,
  // 每輪最多抓幾筆詳情，避免一次打太多
  maxDetailsPerRun: 30,
  // 頁面太久沒回報時自動重新載入（自我修復）
  autoReload: true,
  // 🔴🔴 2026-09-29 第十七次真機：定時**自動對帳**（實收）。
  //    使用者原話：「我們要把"立即對帳" 這個也自動化, 放到上面的timer 的功能里面,
  //                 就比如: 我set 了 60秒, 就60秒做一次立即對帳的功能。」
  //    ⇒ 開咗就**跟同步間隔**跑（唔係舊嘅 6 小時節流）。
  //    預設關：每跑一次都要開彈窗逐頁抄，60 秒一輪對平台有壓力，
  //    要使用者自己決定。
  autoSettle: false,
};

/**
 * 全域設定（三個平台共用）。
 *
 * 沿用 MacauPay 既有的 storage key，避免兩套設定值分岐：
 *   machineId           → Store ID（這家店在 POS 的識別）
 *   startDate           → cut-off date（只同步此日期之後的單）
 *   currentIntervalSecs → 同步間隔
 */
function grabGlobalSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['machineId', 'startDate', 'currentIntervalSecs'], (res) => {
      resolve({
        storeId: res.machineId || '',
        cutoffDate: res.startDate || '',
        // 🔴 2026-09-29：預設間隔 60 → 30 秒（使用者拍板「timer 全部 default 30 秒」）。
        //    只影響「從未設定過」的裝置；已儲存的值不變。
        intervalSecs: Number(res.currentIntervalSecs) || 30,
      });
    });
  });
}

/**
 * cut-off 日期 → 毫秒。回 null 表示不設限。
 *
 * 用本地時區的當日 00:00 作為界線：使用者填 2026-09-23，
 * 代表「9/23 之前的單都不要」。若用 UTC 會有一天偏差。
 */
function grabCutoffMs(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  const t = d.getTime();
  return isFinite(t) ? t : null;
}

/**
 * 從訂單列取出可比對的時間。
 *
 * 兩個平台的形狀不同：
 *   澳覓  列表 orderDateTime "2026-09-17 19:07:11"（本地時間字串）
 *         詳情 occurredAt（由 bridge 從 states 推導）
 *   mfood 列表 createdAt / 詳情 timeline.created（均為 ISO）
 */
function grabRowDateMs(row) {
  if (!row || typeof row !== 'object') return null;
  // 注意最後的 row.at：註冊表項目用的欄位名是 at（不是 createdAt），
  // 少了它，清除超出 cut-off 的舊記錄時永遠取不到時間。
  const raw = row.createdAt || row.occurredAt || row.orderDateTime || row.at || null;
  if (!raw) return null;
  // "2026-09-17 19:07:11" → "2026-09-17T19:07:11" 才會被穩定解析為本地時間
  const s = String(raw).replace(' ', 'T');
  const t = Date.parse(s);
  return isFinite(t) ? t : null;
}

function grabSourceList() {
  return Object.keys(GRAB_SOURCES).map((k) => GRAB_SOURCES[k]);
}

function grabCfgByPrefix(prefix) {
  const keys = Object.keys(GRAB_SOURCES);
  for (let i = 0; i < keys.length; i++) {
    if (GRAB_SOURCES[keys[i]].prefix === prefix) return GRAB_SOURCES[keys[i]];
  }
  return null;
}

// ---- 儲存層（每個來源獨立的 settings / state / log）------------------------

function grabSettingsKey(k) {
  return `${k}Settings`;
}
function grabStateKey(k) {
  return `${k}State`;
}
function grabLogKey(k) {
  return `${k}Log`;
}

/**
 * 自動重載冷卻時間戳**專用** storage key（2026-09-25）。
 *
 * 🔴 為什麼唔可以只放喺 `state.lastAutoReloadAt`：`state` 會被其他
 *   「讀 state → 改 → 寫返成個 state」嘅路徑覆蓋掉。實案：
 *   自動重載之後 ~55ms 就有詳情派工嘅 state 寫入（見同日診斷日誌），
 *   佢攞住 reload **之前**嘅快照寫返 ⇒ `lastAutoReloadAt` 被抹走
 *   ⇒ 3 分鐘冷卻期永遠唔生效 ⇒ **每 30 秒 reload 商戶後台一次**，
 *   頁面永遠載唔完，反而令分頁永久卡住
 *   （澳覓 `lastListCaptureAt` 一枝不動 47 分鐘就係咁嚟）。
 *
 * 獨立 key 冇其他寫入者 ⇒ 冷卻期唔會被 race 抵銷。
 * `state.lastAutoReloadAt` 照樣寫（診斷輸出／UI 要睇）。
 */
function grabReloadKey(k) {
  return `${k}ReloadAt`;
}

function grabGetLastReloadAt(sourceKey) {
  return new Promise((resolve) => {
    const key = grabReloadKey(sourceKey);
    chrome.storage.local.get([key], (res) => {
      const v = res[key];
      resolve(typeof v === 'string' ? v : null);
    });
  });
}

function grabSetLastReloadAt(sourceKey, iso) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [grabReloadKey(sourceKey)]: iso }, () => resolve(iso));
  });
}

// 設定的合法欄位。只回傳這些 —— 舊版遺留的欄位（posEndpoint / posSecret /
// pushTerminalStates 等）會自然被丟掉，不會一直留在 storage 與診斷輸出裡。
const GRAB_SETTING_KEYS = [
  'pushEnabled',
  'autoRefresh',
  'autoFetchDetails',
  'detailDelayMs',
  'maxDetailsPerRun',
  'autoReload',
  // 🔴 第十七次真機：定時自動對帳（mfood 專用，但有齊設定管道先唔會寫死）
  'autoSettle',
];

function grabGetSettings(sourceKey) {
  const key = grabSettingsKey(sourceKey);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      const stored = res[key] || {};
      const out = { ...GRAB_DEFAULT_SETTINGS };
      GRAB_SETTING_KEYS.forEach((k) => {
        if (stored[k] !== undefined) out[k] = stored[k];
      });
      resolve(out);
    });
  });
}

function grabSaveSettings(sourceKey, patch) {
  return grabGetSettings(sourceKey).then((cur) => {
    const next = { ...cur, ...patch };
    return new Promise((resolve) => {
      chrome.storage.local.set({ [grabSettingsKey(sourceKey)]: next }, () => resolve(next));
    });
  });
}

function grabEmptyCounters() {
  return {
    listCaptures: 0,
    detailCaptures: 0,
    statsCaptures: 0,
    rowsSeen: 0,
    freshRows: 0,
    pushes: 0,
    pushFailures: 0,
    duplicatesSkipped: 0,
    skippedByCutoff: 0,
    autoRefreshes: 0,
    autoReloads: 0,
    prunedByCutoff: 0,
    detailBatches: 0,
    detailsFetched: 0,
    detailsFailed: 0,
  };
}

function grabGetState(sourceKey) {
  const key = grabStateKey(sourceKey);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      const stored = res[key] || {};
      resolve({
        seen: {},
        lastListCaptureAt: null,
        lastDetailCaptureAt: null,
        lastPushOkAt: null,
        lastError: null,
        stats: null,
        orders: {},
        tabId: null,
        ...stored,
        // counters 單獨合併，避免舊資料缺欄位時把新欄位蓋掉
        counters: { ...grabEmptyCounters(), ...(stored.counters || {}) },
      });
    });
  });
}

function grabSaveState(sourceKey, state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [grabStateKey(sourceKey)]: state }, () => resolve(state));
  });
}

function grabAppendLog(cfg, entry) {
  const key = grabLogKey(cfg.key);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      let log = Array.isArray(res[key]) ? res[key] : [];
      log.unshift({ at: new Date().toISOString(), source: cfg.key, ...entry });
      if (log.length > GRAB_LOG_MAX) log = log.slice(0, GRAB_LOG_MAX);
      chrome.storage.local.set({ [key]: log }, () => resolve(log));
    });
  });
}

/**
 * 跨 session 去重。
 *
 * 為什麼一定要落地 storage：MV3 service worker 閒置約 30 秒就被回收，
 * 記憶體中的 Set 會消失，會導致重複推送。
 */
// ---- 逐單發送狀態註冊表 ------------------------------------------------------
//
// 商家關心的不是「系統跑了幾次」，而是「我的單怎麼了」。所以除了聚合計數，
// 另外維護一份逐單狀態，讓 popup 直接呈現：
//   ① 擷取到哪些訂單  ② 有沒有成功送到 macau-pos  ③ 有沒有被判定重複
//
// state.orders[externalOrderId] = {
//   id, seq, amount, at,   -- 顯示用
//   state,                 -- observed | pending | sending | sent | failed
//   attempts,              -- 實際送出次數
//   duplicates,            -- 被判定重複而攔下的次數
//   lastAt, error
// }

const GRAB_ORDERS_MAX = 120;

function grabRegisterOrder(state, id, fields) {
  if (!id) return null;
  if (!state.orders) state.orders = {};
  if (state.orders[id]) {
    // 名冊說「抓過品項」但狀態掉了 → 補回來（否則會被重複抓取）
    grabSyncDetailDone(state, state.orders[id]);
    return state.orders[id];
  }

  state.orders[id] = {
    id: id,
    // 平台顯示用的單號（mfood 的 CRD… / 澳覓的 TK…）。
    // DOM 模擬點擊要靠它在列表中定位那一列。
    tradeNo: fields.tradeNo != null && fields.tradeNo !== '' ? fields.tradeNo : null,
    seq: fields.seq != null && fields.seq !== '' ? fields.seq : null,
    amount: fields.amount != null ? fields.amount : null,
    at: fields.at || null,
    state: fields.state || 'pending',
    attempts: 0,
    duplicates: 0,
    lastAt: null,
    error: null,

    // ---- 詳情（品項）----
    items: [],
    itemCount: 0,
    detailState: 'none', // none | fetching | done | failed
    detailMethod: null, // replay | dom —— 哪條路線抓到的，供排查
    detailAttempts: 0,
    detailError: null,
    detailAt: null,
  };

  // 裁掉最舊的，避免 storage 無限成長
  const keys = Object.keys(state.orders);
  if (keys.length > GRAB_ORDERS_MAX) {
    keys.sort(
      (a, b) =>
        (Date.parse(state.orders[a].at || '') || 0) - (Date.parse(state.orders[b].at || '') || 0),
    );
    keys.slice(0, keys.length - GRAB_ORDERS_MAX).forEach((k) => delete state.orders[k]);
  }
  // 🔴 新建的項目也要對一次名冊：註冊表被重建（容量裁剪、清除、舊版殘留）後，
  //    這一筆會是全新的 detailState:'none'；若不補回來，UI 會顯示「尚未抓取品項」，
  //    而且會讓人以為還沒抓過。
  grabSyncDetailDone(state, state.orders[id]);

  return state.orders[id];
}

function grabSetOrderState(state, id, patch) {
  if (!state.orders || !state.orders[id]) return;
  Object.assign(state.orders[id], patch, { lastAt: new Date().toISOString() });
}

/** 被判定重複而攔下一次 —— 只在該單已登記時累加 */
function grabCountDuplicate(state, id) {
  if (!state.orders || !state.orders[id]) return;
  state.orders[id].duplicates++;
}

/**
 * 把詳情帶來的品項合併進註冊表。
 * 這是「清單顯示品項數」與「推送帶完整菜名」的唯一來源。
 */
function grabMergeDetail(state, orderId, detail, method) {
  const entry = state.orders && state.orders[orderId];
  if (!entry) return false;

  const items = Array.isArray(detail.items) ? detail.items : [];
  entry.items = items;
  entry.itemCount = items.length;
  entry.detailAt = new Date().toISOString();
  if (method) entry.detailMethod = method;

  entry.detailQueuedAt = null;

  if (items.length > 0) {
    entry.detailState = 'done';
    entry.detailError = null;
    // 🔴 寫進「已經拿過品項」名冊 —— 「不再重複拿取」的最終保證，
    //    即使日後註冊表被重建也不會重抓。
    grabMarkDetailDone(state, grabDetailKey(entry));
  } else {
    entry.detailState = 'failed';
    entry.detailError = '詳情回應沒有品項';
  }
  return true;
}

// ---- 「已經拿過品項」名冊 ----------------------------------------------------
//
// 使用者的要求：**每個品項只要成功拿取過一次，之後就不應再重複拿取。**
//
// 為什麼不能只靠註冊表上的 detailState：
//   註冊表會因為 cut-off 清理、容量裁剪、清除訂單而被重建；
//   一旦那一筆的狀態掉了，同一張單就會被重新派工 ——
//   在 DOM 路線下就是使用者看到的「不斷瘋狂點開每一個頁面」。
//
// 所以另外維護一份獨立的「訂單號 → 抓過的時刻」名冊：
//   · 只在「確實拿到品項」時寫入（成功才算，失敗不寫）
//   · **不受 cut-off 清理影響** —— 歷史單抓過就是抓過
//   · 只有「清除所有訂單」才會清掉它
//   · 查詢一律用訂單號（tradeNo），沒有才退回平台單號
//
// 這份名冊是「不再重複拿取」的最終保證：即使註冊表被重建，
// 只要名冊說抓過，就不會再派工。

const GRAB_DETAIL_DONE_MAX = 2000; // 名冊上限，避免 storage 無限成長
const GRAB_DETAIL_MAX_ATTEMPTS = 3; // 請求重放：不碰畫面，可以多試
const GRAB_DETAIL_MAX_ATTEMPTS_DOM = 2; // 模擬點擊：會真的開關彈窗，少試為妙

/**
 * 平台結算（實收）抓取 —— 2026-09-26 使用者需求。
 *
 * ── 為什麼要低頻 ─────────────────────────────────────────────────────
 * 平台帳期通常 T+1 至帳期結束才生成，**唔係即時**。
 * 跟訂單同步一個節拍（每 60 秒）去問只係白撞，仲會被平台當異常流量。
 * ⇒ 每 `GRAB_SETTLE_MIN_INTERVAL_MS` 才跑一次（預設 6 小時）。
 *   使用者亦可以喺 popup 按「立即對帳」手動觸發（`GRAB_SETTLE_NOW`）。
 */
const GRAB_SETTLE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小時

/**
 * 🔴🔴 各來源嘅「財務頁」設定 —— 2026-09-29 澳覓對帳新增。
 *
 * 舊寫法 `GRAB_SETTLE_STORE_KEY = 'mfoodFinanceStoreName'` 係**寫死一個常數**，
 * 澳覓一定要另一條 key（`aomiFinanceStoreName`）。
 * ⇒ 改為**函式**，由 `sourceKey` 推導，兩邊唔會再撞。
 *
 * @param {string} sourceKey 'mfood' | 'aomi'
 * @returns {string}
 */
function grabSettleStoreKey(sourceKey) {
  return sourceKey === 'aomi' ? 'aomiFinanceStoreName' : 'mfoodFinanceStoreName';
}

/**
 * 平台結算（實收）流程嘅**來源差異表** —— 全部集中喺呢度。
 *
 * 新增第三個平台只要加一個條目，下面嘅流程邏輯完全唔使改
 * （同 `GRAB_SOURCES` 同一個設計原則）。
 */
const GRAB_SETTLE_SOURCES = {
  mfood: {
    key: 'mfood',
    label: 'mfood',
    // 財務頁分頁 URL 特徵
    tabUrlPattern: 'https://*.mfoodapp.com/*',
    tabUrlMatch: (url) => url.indexOf('finance/tackout-check') >= 0,
    // 發去財務頁嘅訊息型別
    syncType: 'MFOODFIN_SYNC',
    // 帳期 id 來源（僅顯示用）
    pageHint: 'merchant.mfoodapp.com/#/finance/tackout-check',
    // 帳期級金額由平台列表回應直接提供（mfood 有 `subsidyStoreReceiveAmtn`）
    hasPeriodAmounts: true,
  },
  aomi: {
    key: 'aomi',
    label: '澳覓',
    tabUrlPattern: 'https://merchant.aomiapp.com/*',
    /**
     * 澳覓財務對帳頁 —— 🔴 2026-09-29 真機修正。
     *
     * 舊寫法 `/settle/i.test(url)` **永遠唔中**：`settle` 只出現喺 API 路徑
     * （`…/settleService/hadSettlement`），**唔喺前端 SPA 路由**。
     * 實際路由係：
     *   · 帳期列表 `#/qrAccountmanage/takeoutAccountManage/takeoutAccount`
     *   · 明細    `#/qrAccountmanage/takeoutAccountManage/takeoutDetail?accountId=…`
     * 兩者共同前綴 = `takeoutAccountManage` ⇒ 用佢做特徵，
     * 走訪時換 route（列表 ↔ 明細）亦唔會掉線。
     */
    tabUrlMatch: (url) => /takeoutAccountManage/i.test(String(url)),
    syncType: 'AOMIFIN_SYNC',
    pageHint: 'merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount',
    /**
     * 🔴 澳覓列表層**冇金額**（要撳「查看」入明細先有 `costAmount`）⇒
     *    帳期級金額由 bridge 用明細逐筆加總得出（見 aomi-finance-bridge `finishPeriod`）。
     *    呢個旗標只係記錄語意差異，流程本身唔使分岔。
     */
    hasPeriodAmounts: true,
  },
};

/** 由 sourceKey 攞結算來源設定（預設 mfood，兼容舊呼叫）。 */
function grabSettleCfg(sourceKey) {
  return GRAB_SETTLE_SOURCES[sourceKey] || GRAB_SETTLE_SOURCES.mfood;
}

/**
 * 實收對照表（`tradeNo → 實收金額`）最多記幾多筆。
 *
 * 為什麼要設上限：`chrome.storage.local` 冇自動回收，
 * 而對帳係**長期累積**嘅（每 60 秒一輪 × 每輪幾十筆）。
 * 唔設上限會慢慢食爆 storage ⇒ 最後連 state 都寫唔入（連鎖故障）。
 * 3,000 筆 ≈ 兩個月嘅量，對「顯示實收價格」呢個用途綽綽有餘。
 */
const GRAB_SETTLE_MAP_MAX = 3000;

/**
 * 合併實收對照表（新嘅蓋舊嘅，超出上限就掉最舊）。
 *
 * @param {object} oldMap 現有對照表
 * @param {object} newMap 今輪抄到嘅
 * @returns {object}
 */
function grabMergeSettleMap(oldMap, newMap) {
  const out = Object.assign({}, oldMap || {});
  const fresh = newMap || {};
  Object.keys(fresh).forEach((k) => {
    out[k] = fresh[k];
  });
  const keys = Object.keys(out);
  if (keys.length <= GRAB_SETTLE_MAP_MAX) return out;
  keys.sort((a, b) => {
    const ta = Date.parse((out[a] && out[a].at) || '') || 0;
    const tb = Date.parse((out[b] && out[b].at) || '') || 0;
    return ta - tb; // 最舊排前
  });
  keys.slice(0, keys.length - GRAB_SETTLE_MAP_MAX).forEach((k) => delete out[k]);
  return out;
}

// 2026-09-26 結算欄位定義結束


/** 品項名冊用的鍵 —— 優先訂單號，沒有才用平台單號 */
function grabDetailKey(o) {
  if (!o) return '';
  const k = o.tradeNo || o.id;
  return k == null ? '' : String(k);
}

/** 這張單的品項是否已經拿到過（拿到過就永遠算拿到） */
function grabIsDetailSettled(state, o) {
  if (!o) return false;
  if (o.detailState === 'done') return true;
  if (Array.isArray(o.items) && o.items.length > 0) return true;
  const k = grabDetailKey(o);
  return !!(k && state.detailDone && state.detailDone[k]);
}

/** 記進名冊（只有真的拿到品項才呼叫） */
function grabMarkDetailDone(state, key) {
  const k = key == null ? '' : String(key);
  if (!k) return;
  if (!state.detailDone) state.detailDone = {};
  state.detailDone[k] = new Date().toISOString();

  const keys = Object.keys(state.detailDone);
  if (keys.length <= GRAB_DETAIL_DONE_MAX) return;
  keys
    .sort(
      (a, b) => (Date.parse(state.detailDone[a]) || 0) - (Date.parse(state.detailDone[b]) || 0),
    )
    .slice(0, keys.length - GRAB_DETAIL_DONE_MAX)
    .forEach((old) => {
      delete state.detailDone[old];
    });
}

/**
 * 名冊說抓過、但這一筆的狀態掉了（例如註冊表被重建）
 * → 把狀態補回來，讓清單與派工都看到真相，不會再被重抓。
 */
function grabSyncDetailDone(state, entry) {
  if (!entry || entry.detailState === 'done') return;
  const k = grabDetailKey(entry);
  if (!k || !state.detailDone || !state.detailDone[k]) return;
  entry.detailState = 'done';
  entry.detailError = null;
  entry.detailQueuedAt = null;
}

// 卡在 fetching 超過這個時間就視為「可重試」。// 卡在 fetching 超過這個時間就視為「可重試」。
// 派工成功但批次沒跑完（例如中途換頁、分頁被關）時，狀態會一直停在
// fetching，沒有人會復原它 —— 這會讓那張單永遠不再被派工。
const GRAB_FETCHING_STALE_MS = 2 * 60 * 1000;

/**
 * 找出「還沒抓到品項」的單。
 *
 * 🔴 第一道條件就是名冊：**已經拿過品項的單，永不派工** ——
 *    連 force（手動按鈕）都不例外。這是使用者的明確要求：
 *    「每個品項只要成功拿取過一次，之後就不應再重複拿取」。
 *
 * @param ignoreAttempts true = 手動觸發，忽略重試上限
 * @param maxAttempts    重試上限（依策略不同：模擬點擊要更低）
 */
function grabOrdersNeedingDetail(state, limit, ignoreAttempts, maxAttempts) {
  if (!state.orders) return [];
  const now = Date.now();
  const cap = Number(maxAttempts) > 0 ? Number(maxAttempts) : GRAB_DETAIL_MAX_ATTEMPTS;

  return Object.keys(state.orders)
    .map((k) => state.orders[k])
    .filter((o) => {
      // ① 已經拿到品項 → 永遠不再碰（不受 force 影響）
      if (grabIsDetailSettled(state, o)) return false;

      // ② 正在抓、且還沒過期 → 別重複派工
      if (o.detailState === 'fetching') {
        const t = o.detailQueuedAt ? Date.parse(o.detailQueuedAt) : 0;
        if (t && now - t < GRAB_FETCHING_STALE_MS) return false;
      }

      // ③ 重試上限
      if (!ignoreAttempts && (o.detailAttempts || 0) >= cap) return false;

      // ④ 🔴 假單（`FAKE-` 前綴）永遠唔會出現喺真後台列表
      //    ⇒ 派工一定失敗（2026-09-25 實案：每 30 秒重試「在列表中找不到這一列」，
      //      `detailsFailed` 一路漲到 60）。假單係測試用，唔需要抓品項。
      if (String(o.id || '').indexOf('FAKE-') === 0) return false;
      return true;
    })
    .sort(
      (a, b) =>
        (Date.parse(String(b.at || '').replace(' ', 'T')) || 0) -
        (Date.parse(String(a.at || '').replace(' ', 'T')) || 0),
    )
    .slice(0, limit);
}

/** 送出抓取前先標記，避免同一批被重複派工 */
function grabMarkDetailQueued(state, ids) {
  const now = new Date().toISOString();
  ids.forEach((id) => {
    const e = state.orders && state.orders[id];
    if (!e) return;
    e.detailState = 'fetching';
    e.detailAttempts = (e.detailAttempts || 0) + 1;
    e.detailQueuedAt = now; // 給後面的「卡住過期」判斷用
  });
}

function grabMarkSeen(state, key) {
  if (!key) return false;
  if (state.seen[key]) {
    state.counters.duplicatesSkipped++;
    return false;
  }
  state.seen[key] = Date.now();

  const keys = Object.keys(state.seen);
  if (keys.length > GRAB_SEEN_MAX) {
    keys.sort((a, b) => state.seen[a] - state.seen[b]);
    keys.slice(0, keys.length - GRAB_SEEN_MAX).forEach((k) => delete state.seen[k]);
  }
  return true;
}

// ---- 推送 -----------------------------------------------------------------

function grabPush(cfg, orders, storeId) {
  if (POS_SHARED_SECRET === 'FILL_ME_WHEN_POS_API_IS_READY') {
    return Promise.resolve({ ok: false, error: '系統尚未設定 POS 密鑰（請見 background.js 的 POS_SHARED_SECRET）' });
  }

  // 🔴 冇 storeId 就唔好發 —— POS 端一定回 400「缺少 storeId」。
  //    喺本地先講清楚，慳一次白撞，亦避免使用者要由 HTTP 錯誤碼反推原因。
  if (!storeId) {
    return Promise.resolve({
      ok: false,
      error: '未設定 Store ID：請喺 popup「店家設定」填入並按一下旁邊空白處（要失焦才會儲存）',
    });
  }

  // 🔴 orders 一定要係**非空陣列**。
  //    實測踩過：呼叫端傳單一物件 → POS 端 Array.isArray 唔過 → 當 0 張單
  //    → **回 ok:true**，使用者見到「已推送」但其實一張都沒入（靜默假成功）。
  //    與其靠 POS 端發現，不如喺本地就大聲報錯。
  if (!Array.isArray(orders) || orders.length === 0) {
    return Promise.resolve({
      ok: false,
      error: 'grabPush 需要非空陣列嘅 orders（呼叫端 bug）',
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  headers['X-Grabber-Secret'] = POS_SHARED_SECRET;

  return fetch(POS_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: cfg.key,
      clientVersion: chrome.runtime.getManifest().version,
      capturedAt: new Date().toISOString(),
      orders,
      storeId: storeId,
    }),
  })
    .then((r) =>
      r.text().then((text) => {
        const brief = text.slice(0, 500);
        if (!r.ok) {
          return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}`, response: brief };
        }
        // 🔴 HTTP 200 唔等於入咗 POS（2026-09-25 實案）：
        //    POS 對「冇可用品項」嘅單會回 `ok: true` 但 `created: 0` ＋ `rejected[]`
        //    ⇒ 舊寫法一律當成功 → popup 顯示「已送出」而 POS 一張都冇（靜默假成功，
        //      商家要等到發覺收銀機冇單才知）。
        //    ⇒ 只有 `rejected[]` 非空才當失敗。**重複單**（POS 已存在）都係
        //      `created: 0` 但 `rejected` 空 ⇒ 嗰個係「已經入咗」＝唔係失敗。
        let body = null;
        try {
          body = JSON.parse(text);
        } catch (e) {
          body = null;
        }
        const rejected = Array.isArray(body && body.rejected) ? body.rejected : [];
        if (rejected.length > 0) {
          const why = rejected
            .map((x) => `${(x && x.externalOrderId) || '?'}：${(x && x.reason) || '未提供原因'}`)
            .join('；');
          return {
            ok: false,
            error: `POS 拒收 ${rejected.length}/${orders.length} 張 —— ${why}`,
            response: brief,
          };
        }
        return { ok: true, response: brief };
      }),
    )
    .catch((err) => {
      const msg = String((err && err.message) || err);
      // 🔴 「Failed to fetch」係網絡層失敗，唔會帶 HTTP 碼。最常見三個成因：
      //    ① manifest host_permissions 未包 POS 網域（MV3 會直接攔）
      //    ② POS 端部署未生效（route 唔存在）
      //    ③ 部機／網絡唔通
      const hint =
        msg.indexOf('Failed to fetch') >= 0
          ? '（檢查：① manifest host_permissions 有冇包 POS 網域 ② POS 部署生效未 ③ 網絡）'
          : '';
      return { ok: false, error: msg + hint };
    });
}

/**
 * 把「未啟用同步期間只登記、未送出」嘅單由去重名冊釋放（2026-09-25）。
 *
 * ## 為什麼唔可以直接由註冊表推送
 * `grabPush(cfg, orders, storeId)` 要嘅係平台**原始列**（POS 端靠佢砌訂單）。
 * 原始列只在「列表擷取」嗰一刻存在，註冊表只得正規化咗嘅欄位 ⇒ 推唔到。
 * ⇒ 唯一乾淨做法：把嗰幾張單由去重名冊（`seen`）剔走，再叫頁面重新查一次
 *   （`grabRescan`），令下一次擷取當佢哋係新單，行返**正常**推送路徑。
 *
 * ## 只剔 `held`，其他一律唔郁
 * `seen` 嘅 key 格式係 `${externalOrderId}|${平台狀態}`，所以用 id 前綴比對：
 *   · 歷史單（`observed`）**唔郁** —— 唔可以因為開同步而一次過倒晒去 POS；
 *   · 平台已取消／待退款（`observed`）**唔郁** —— 佢哋係刻意唔推
 *     （廚房為一張已取消嘅單出紙係實際損失）。
 *
 * @returns {Promise<number>} 放行咗幾多張
 */
function grabReleaseHeldOrders(cfg) {
  return grabGetState(cfg.key).then((state) => {
    const heldIds = Object.keys(state.orders || {}).filter(
      (id) => state.orders[id] && state.orders[id].state === 'held',
    );
    if (heldIds.length === 0) return 0;

    const heldSet = new Set(heldIds);
    let released = 0;
    Object.keys(state.seen || {}).forEach((k) => {
      if (heldSet.has(String(k).split('|')[0])) {
        delete state.seen[k];
        released++;
      }
    });

    return grabSaveState(cfg.key, state).then(() =>
      grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_release_held`,
        summary: `已啟用同步：${heldIds.length} 筆待送出嘅單已放行，將會補送`,
        detail: { orderIds: heldIds, releasedSeenKeys: released },
      }).then(() => heldIds.length),
    );
  });
}

/**
 * 推送失敗重試（2026-09-25）。
 *
 * ## 為什麼要「放行去重名冊」而唔係直接由註冊表重推
 * `grabPush` 要平台**原始列**（POS 靠佢砌金額拆解同狀態）。註冊表只有正規化
 * 咗嘅欄位（單一 amount 數字），自己砌一個 row 會令 POS 嘅費用明細／營業額口徑
 * 全部走樣 ⇒ 唔可以咁做。
 * 正確做法：剔走嗰張單嘅 `seen` key，令下一次列表擷取用**真 row**
 * （＋ `grabEnrichOrdersWithItems()` 併入嘅品項）再推一次。
 *
 * ## 為什麼重推係安全嘅
 * POS 入站 route 對 `(store_id, source, external_order_id)` 有唯一鍵 ＋
 * `ON CONFLICT DO NOTHING` ⇒ 同一張單推幾多次都唔會變兩張（頂多 `created: 0`）。
 * 而且只處理 `state === 'failed'` 且 `attempts < GRAB_PUSH_MAX_ATTEMPTS` 嘅單
 * —— 成功過嘅永遠唔會再推；試够上限就停手（**狀態留住 failed，大聲示人**）。
 */
/**
 * 推送失敗重試上限。
 *
 * 2026-09-25 由 3 提高到 10：**10 秒嘅查詢間隔之下，3 次配額 30 秒就燒光**
 * （實案：POS 端 500 嘅幾分鐘內就試完 3 次 → 之後永遠唔再試，商家要手動撳
 * 「清除去重記錄」才有得補送）。而家配合下面嘅冷卻期，總共可以撐約 20 分鐘。
 */
const GRAB_PUSH_MAX_ATTEMPTS = 10;

/**
 * 兩次重試之間最少間隔（2026-09-25）。
 *
 * 冇冷卻期嘅話，配額會被查詢節拍（可低到 10 秒）瞬間燒光；
 * POS 短暫故障（部署中／500）就永遠冇得補送。
 * 冷卻期用 `lastAt`（最後一次狀態變更＝上次失敗嘅時間）計算。
 */
const GRAB_PUSH_RETRY_COOLDOWN_MS = 2 * 60 * 1000;

function grabRetryFailedPushes(cfg) {
  return grabGetState(cfg.key).then((state) => {
    const retryIds = Object.keys(state.orders || {}).filter((id) => {
      const e = state.orders[id];
      if (!e || e.state !== 'failed') return false;
      if ((e.attempts || 0) >= GRAB_PUSH_MAX_ATTEMPTS) return false;
      // 冷卻期：唔可以每個查詢節拍都重試（見 GRAB_PUSH_RETRY_COOLDOWN_MS）
      const lastAt = e.lastAt ? Date.parse(e.lastAt) : 0;
      if (lastAt && Date.now() - lastAt < GRAB_PUSH_RETRY_COOLDOWN_MS) return false;
      return true;
    });
    if (retryIds.length === 0) return 0;

    const retrySet = new Set(retryIds);
    let released = 0;
    Object.keys(state.seen || {}).forEach((k) => {
      if (retrySet.has(String(k).split('|')[0])) {
        delete state.seen[k];
        released++;
      }
    });
    if (released === 0) return 0;

    // 狀態由 failed 改回 pending：下次擷取會入 fresh，再推一次
    retryIds.forEach((id) => grabSetOrderState(state, id, { state: 'pending' }));

    return grabSaveState(cfg.key, state).then(() =>
      grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_push_retry`,
        summary: `推送失敗重試：${retryIds.length} 筆會喺下一次擷取再送一次`,
        detail: { orderIds: retryIds, releasedSeenKeys: released },
      }).then(() => retryIds.length),
    );
  });
}

/**
 * 「立即重試推送」—— popup 卡片撳「重試」時真正要做嘅事。
 *
 * 🔴🔴 2026-09-30 真機確診：舊寫法 popup 只送 `<PREFIX>_RESCAN`
 *     （叫後台按一次「查詢」）—— **唔會**重置 `attempts`、
 *     **唔會**放行去重名冊 `seen`，亦**唔會**清除「最後失敗時間」。
 *     配額（10 次）用完之後，撳個掣完全冇用，卡片永遠停喺「推送失敗」。
 *
 * 三件事一定要一齊做：
 *   ① 重置 `attempts` ⇒ 否則自動重試唔會再跑；
 *   ② 放行 `seen` ⇒ `grabPush` 要平台**原始列**（POS 靠佢砌費用拆解），
 *      唔可以自己砌一個 row（會令金額口徑走樣）⇒ 一定要令下次擷取重新入 fresh；
 *   ③ 即刻 rescan ⇒ 唔等下一次 tick。
 *
 * ⚠️ 只處理 `failed` / `held`；成功過嘅永遠唔會再推。
 */
function grabRetryPushNow(cfg) {
  return grabGetState(cfg.key).then((state) => {
    const retryIds = Object.keys(state.orders || {}).filter((id) => {
      const e = state.orders[id];
      return !!e && (e.state === 'failed' || e.state === 'held');
    });

    if (retryIds.length === 0) {
      return grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_push_retry_manual`,
        summary: '手動重試：目前冇需要重試嘅單',
      }).then(() => ({ ok: true, retried: 0 }));
    }

    const retrySet = new Set(retryIds);
    let released = 0;
    Object.keys(state.seen || {}).forEach((k) => {
      if (retrySet.has(String(k).split('|')[0])) {
        delete state.seen[k];
        released++;
      }
    });

    retryIds.forEach((id) => {
      const e = state.orders[id];
      e.attempts = 0; // 重置配額
      e.error = null;
      // 🔴 `lastAt: null` ⇒ 自動重試嘅 2 分鐘冷卻視為「未試過」，即刻可再推
      e.lastAt = null;
      e.state = 'pending';
    });

    return grabSaveState(cfg.key, state)
      .then(() =>
        grabAppendLog(cfg, {
          level: 'info',
          kind: `${cfg.key}_push_retry_manual`,
          summary: `手動重試：${retryIds.length} 筆已重新排隊（放行 ${released} 條去重記錄），即刻重新查詢`,
          detail: { orderIds: retryIds, releasedSeenKeys: released },
        }),
      )
      .then(() => grabRescan(cfg, 'manual'))
      .then((r) => ({ ok: true, retried: retryIds.length, released: released, rescan: r }));
  });
}

/**
 * 推送前把「已抓到嘅品項」併入 payload（2026-09-25 修）。
 *
 * ## 為什麼一定要做
 * POS 入站 route 對「冇任何可用品項」嘅單**直接拒收**
 * （回應 `rejected: [{ reason: 'payload 內冇可用品項' }]`）。
 * 而平台嘅**列表** API 唔含明細 —— 明細係後續另一個請求（詳情）才有，
 * 佢會寫入註冊表 `state.orders[id].items`。
 * ⇒ 第一次由列表推送嘅 row 一定冇 items ⇒ 一定被拒。
 *
 * 實案（2026-09-25）：`pushes: 2`、POS 回 HTTP 200，但 `created: 0`
 * ＋`rejected: payload 內冇可用品項` ⇒ 商家喺 POS 完全見唔到張單。
 *
 * 規則：
 *   · row 已經有 items（詳情路徑送嘅）→ **原樣保留**，唔覆蓋；
 *   · 註冊表有 items → 併入；
 *   · 兩邊都冇 → 照送（由 POS 回報拒收原因，唔喺本地靜默丟單）。
 */
/**
 * 呢張 row 有冇任何「單號」欄位？
 *
 * POS `grabberLocalOrderNo()` 會依序試 `storeSeqNo` / `storeSeq` / `localOrderNo`
 * / `orderNumber`，全部冇就跌去「外部單號尾 6 位」。所以只要**任何一個**有值，
 * 就唔需要（亦唔應該）回填 —— 否則會用舊資料蓋過新資料。
 */
function grabHasAnyOrderNo(row) {
  if (!row || typeof row !== 'object') return true;
  const names = ['storeSeqNo', 'storeSeq', 'localOrderNo', 'orderNumber'];
  for (const k of names) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    if (String(v).trim() === '') continue;
    return true;
  }
  return false;
}

/**
 * 🔴 2026-09-29：詳情路徑（mfood `normalizeDetail()`）**唔帶單號**，
 * 但**列表擷取**時已經把平台單號記咗落註冊表（`entry.seq`）。
 * ⇒ 推送前喺呢度補返，POS 就唔會跌去「外部單號尾 6 位」。
 *
 * 點解揀喺呢度補而唔係淨改 bridge：
 *   · 一改就覆蓋晒**所有來源、兩條路徑**，唔使逐個 bridge 對位；
 *   · 連「當日已經擷取過、但詳情係之後補」嘅舊單都補得返。
 *
 * 🔴 只補「完全冇單號」嘅 row —— 有就原樣放行（上面 `grabHasAnyOrderNo`）。
 */
function grabFillMissingOrderNo(row, entry) {
  if (!row || typeof row !== 'object') return row;
  if (grabHasAnyOrderNo(row)) return row;
  if (!entry) return row;

  const raw = entry.seq === null || entry.seq === undefined ? '' : String(entry.seq).trim();
  if (raw === '') return row;

  const n = Number(raw.replace(/^#/, ''));
  if (!isFinite(n) || n <= 0) return row;

  // 同 `mfood-bridge.js::normalizeOrderNo()` 同一口徑：數字 ＋ 平台原字串都俾
  return Object.assign({}, row, { orderNumber: n, localOrderNo: raw });
}

function grabEnrichOrdersWithItems(state, orders) {
  const registry = (state && state.orders) || {};
  return (orders || []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const entry = registry[row.externalOrderId];

    // ① 單號：冇就由註冊表補（詳情路徑嘅洞）
    let out = grabFillMissingOrderNo(row, entry);

    // ② 品項：原本就有嘅邏輯（清單顯示品項數 ＋ POS 要有菜名先肯收）
    if (Array.isArray(out.items) && out.items.length > 0) return out;
    const items = entry && Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0) return out;
    return Object.assign({}, out, { items: items });
  });
}

/**
 * 查某個 Store ID 對應嘅**店名**（2026-09-25）。
 *
 * 用途：popup 輸入完 Store ID 即刻顯示係邊間店 —— 打錯 ID 嘅話，
 * 訂單會靜靜咁推去另一間店（實案同日發生，排查咗三輪）。呢個係最低成本嘅防錯。
 *
 * 由 background 發請求（唔喺 popup 直接發）：popup 係 extension page，
 * 跨來源 fetch 嘅行為同 service worker 唔一定一致；`grabPush` 已經證明呢條路行得通。
 *
 * 一律回 `{ok:false, reason}` 而**唔 throw**（popup 只係顯示一行提示）。
 */
function grabLookupStore(storeId) {
  const id = typeof storeId === 'string' ? storeId.trim() : '';
  if (!id) return Promise.resolve({ ok: false, reason: '未填 Store ID' });
  if (POS_SHARED_SECRET === 'FILL_ME_WHEN_POS_API_IS_READY') {
    return Promise.resolve({ ok: false, reason: '系統尚未設定 POS 密鑰' });
  }

  const headers = { 'Content-Type': 'application/json' };
  headers['X-Grabber-Secret'] = POS_SHARED_SECRET;

  return fetch(POS_STORE_ENDPOINT, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ storeId: id }),
  })
    .then((r) => r.text().then((text) => ({ status: r.status, text: text })))
    .then((res) => {
      let body = null;
      try {
        body = JSON.parse(res.text);
      } catch (e) {
        body = null;
      }
      if (body && body.ok && body.storeName) return { ok: true, storeName: String(body.storeName) };
      return { ok: false, reason: (body && body.error) || ('HTTP ' + res.status) };
    })
    .catch((err) => ({ ok: false, reason: String((err && err.message) || err) }));
}

/** 推送守門員：pushEnabled 為 false 時絕不對外發請求 */
function grabMaybePush(cfg, orders, origin) {
  if (!orders || orders.length === 0) return Promise.resolve();

  const ids = orders.map((o) => o.externalOrderId);

  return Promise.all([grabGetSettings(cfg.key), grabGlobalSettings()]).then(([settings, global]) => {
    if (!settings.pushEnabled) {
      // 未啟用同步 → 標 `held`（popup 顯示「待同步」），商家一眼睇得出仲未送出。
      //
      // 🔴 2026-09-25 由 `observed` 改成 `held`：`observed` 同時代表
      //    「平台已取消／待退款（**永遠唔應該推**）」同「已見過嘅歷史單」，
      //    三者混埋同一個值 ⇒ 無法分辨「開啟同步時應該補送邊幾張」。
      //    分出獨立嘅 `held` 之後，SAVE_SETTINGS 就可以精準補送
      //    （見 grabReleaseHeldOrders 註釋）。
      return grabGetState(cfg.key).then((state) => {
        ids.forEach((id) => grabSetOrderState(state, id, { state: 'held' }));
        return grabSaveState(cfg.key, state).then(() =>
          grabAppendLog(cfg, {
            level: 'info',
            kind: 'push_skipped',
            summary: `未啟用同步：${orders.length} 筆待送出（開啟同步會自動補送）`,
            detail: { origin, orderIds: ids },
          }),
        );
      });
    }

    return grabGetState(cfg.key).then((state) => {
      state.counters.pushes++;
      ids.forEach((id) => grabSetOrderState(state, id, { state: 'sending' }));
      return grabSaveState(cfg.key, state).then(() =>
        grabPush(cfg, grabEnrichOrdersWithItems(state, orders), global.storeId).then((result) =>
          // 送出後重新讀取，避免與其他並行更新互相覆蓋
          grabGetState(cfg.key).then((s2) => {
            if (result.ok) {
              s2.lastPushOkAt = new Date().toISOString();
              s2.lastError = null;
            } else {
              s2.counters.pushFailures++;
              s2.lastError = result.error;
            }
            ids.forEach((id) => {
              const cur = s2.orders && s2.orders[id];
              grabSetOrderState(s2, id, {
                state: result.ok ? 'sent' : 'failed',
                attempts: ((cur && cur.attempts) || 0) + 1,
                error: result.ok ? null : result.error,
              });
            });
            return grabSaveState(cfg.key, s2).then(() =>
              grabAppendLog(cfg, {
                level: result.ok ? 'push_ok' : 'error',
                kind: 'push',
                summary: result.ok
                  ? `已送出 ${orders.length} 筆到 macau-pos`
                  : `送出失敗：${result.error}`,
                detail: {
                  origin,
                  orderIds: ids,
                  response: result.response,
                  error: result.error,
                },
              }),
            );
          }),
        ),
      );
    });
  });
}

// ---- 擷取處理 -------------------------------------------------------------

function grabHandleList(cfg, message) {
  return Promise.all([grabGetState(cfg.key), grabGlobalSettings()]).then(([state, global]) => {
    const rows = Array.isArray(message.rows) ? message.rows : [];
    const cutoff = grabCutoffMs(global.cutoffDate);

    // 這一輪要不要「只記錄、不推送」（例如澳覓的「已取消」「待退款」）。
    const observedOnly = message.observedOnly === true;
    let observedOnlyRows = 0;

    // 先過濾 cut-off，再進去重。順序很重要：早於 cut-off 的單不該
    // 佔用去重記錄，否則使用者之後放寬日期時會被誤判為「已見過」。
    const candidates = [];
    let skippedByCutoff = 0;
    rows.forEach((row) => {
      const t = grabRowDateMs(row);
      if (cutoff !== null && t !== null && t < cutoff) {
        skippedByCutoff++;
        return;
      }
      candidates.push(row);
    });

    state.counters.listCaptures++;
    state.counters.rowsSeen += rows.length;
    state.lastListCaptureAt = new Date().toISOString();
    // 🔴 2026-09-25：有列表回報就代表管道通（內容腳本 + 攔截器都活住）
    //    ⇒ 之前因為「rescan 失敗」掛住嘅橫幅警示要清走，
    //      否則頁面自己查得到單、橫幅卻一直顯示「有問題」（假警報）。
    state.lastAutoRefreshError = null;
    if (skippedByCutoff > 0) {
      state.counters.skippedByCutoff = (state.counters.skippedByCutoff || 0) + skippedByCutoff;
    }

    const fresh = [];
    const summaries = [];

    candidates.forEach((row) => {
      const sum = cfg.summarizeRow(row);
      const alreadySeen = !!state.seen[cfg.listKey(row)];

      // 只記錄不推送的輪次（已取消／待退款）：
      //   · 一樣登記，讓商家在清單看得到
      //   · 標成 observed —— 不會被當成待送出
      //   · 🔴 刻意「不」寫 seen：否則這張單日後變成正常狀態時，
      //     會被當成已見過而永遠不推送。
      if (observedOnly) {
        grabRegisterOrder(state, row.externalOrderId, {
          tradeNo: row.tradeNo || null,
          seq: sum.seq,
          amount: sum.amount,
          at: row.createdAt || row.orderDateTime || null,
          state: 'observed',
        });
        observedOnlyRows++;
        return;
      }

      // 🔴 登記「所有通過 cut-off 的單」，不只是新的那幾筆。
      //
      // 原因：使用者在舊版時期已經抓過的單全都躺在 seen 裡，
      // 之後每次刷新 fresh 都是空的 → 清單永遠一片空白。
      // 清單要回答的是「擷取到哪些訂單」，不是「這一輪新增哪些」。
      //
      // 已見過的單視為歷史資料：標 observed（只記錄、本次不送出），
      // 避免把它們當成待送出而誤送。已存在於註冊表的項目不會被覆寫。
      grabRegisterOrder(state, row.externalOrderId, {
        tradeNo: row.tradeNo || null,
        seq: sum.seq,
        amount: sum.amount,
        at: row.createdAt || row.orderDateTime || null,
        state: alreadySeen ? 'observed' : 'pending',
      });

      if (grabMarkSeen(state, cfg.listKey(row))) {
        fresh.push(row);
        summaries.push(sum);
      } else {
        // 已被判定重複 —— 累加在該單上，讓商家看得見去重有在運作
        grabCountDuplicate(state, row.externalOrderId);
      }
    });
    state.counters.freshRows += fresh.length;

    const parts = [`擷取訂單列表 ${rows.length} 筆`];
    // 🔴 有行但一行都解析唔到 ＝ 我哋嘅解析壞咗（平台改版？）——
    //    會令「空結果」同「解析壞掉」睇落一樣，所以一定要出聲（2026-09-25）。
    const parseFailures = Number(message.meta && message.meta.parseFailures) || 0;
    if (parseFailures > 0) parts.push(`⚠ ${parseFailures} 行解析失敗（平台可能改版，請回報）`);
    if (fresh.length > 0) parts.push(`${fresh.length} 筆為新的`);
    if (observedOnlyRows > 0) parts.push(`${observedOnlyRows} 筆只記錄不推送`);
    if (skippedByCutoff > 0) parts.push(`${skippedByCutoff} 筆早於 cut-off 已略過`);

    // 🔴 依 cut-off 清掉「先前已登記、但現在超出範圍」的單。
    //
    //    過去只在「進來的列」上過濾，已登記的舊單永遠留著 ——
    //    所以使用者把日期往後調（例如 08-13 → 09-22）之後，
    //    清單裡還是看得到更早的單，設定等於沒生效。
    if (cutoff !== null && state.orders) {
      let pruned = 0;
      Object.keys(state.orders).forEach((k) => {
        const t = grabRowDateMs(state.orders[k]);
        if (t !== null && t < cutoff) {
          delete state.orders[k];
          pruned++;
        }
      });
      if (pruned > 0) {
        state.counters.prunedByCutoff = (state.counters.prunedByCutoff || 0) + pruned;
        parts.push(`另清除 ${pruned} 筆已超出範圍的舊記錄`);
      }
    }

    return grabSaveState(cfg.key, state)
      .then(() =>
        grabAppendLog(cfg, {
          level: parseFailures > 0 ? 'error' : fresh.length > 0 ? 'new' : 'info',
          kind: `${cfg.key}_order_list`,
          summary: parts.join('，'),
          detail: {
            page: message.meta,
            cutoff: global.cutoffDate || null,
            skippedByCutoff,
            fresh: fresh.map(cfg.summarizeRow),
          },
        }),
      )
      .then(() => grabMaybePush(cfg, fresh, 'list'))
      // 新單進來後，若開啟了自動抓詳情就立刻派工
      .then(() => grabMaybeFetchDetails(cfg));
  });
}

function grabHandleDetail(cfg, message) {
  return Promise.all([grabGetState(cfg.key), grabGlobalSettings()]).then(([state, global]) => {
    state.counters.detailCaptures++;
    state.lastDetailCaptureAt = new Date().toISOString();

    const detail = message.detail;

    // 詳情也要擋 cut-off，否則從書籤直接開舊單詳情仍會被推送
    const cutoff = grabCutoffMs(global.cutoffDate);
    const detailTime = grabRowDateMs(detail.timeline ? detail.timeline.created : null) ??
      grabRowDateMs(detail);
    if (cutoff !== null && detailTime !== null && detailTime < cutoff) {
      return grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_order_detail`,
        summary: `略過訂單詳情 ${detail.externalOrderId}（早於 cut-off）`,
        detail: { cutoff: global.cutoffDate, orderId: detail.externalOrderId },
      });
    }

    const isNew = grabMarkSeen(state, cfg.detailKey(detail));

    const sum = cfg.summarizeDetail(detail);
    grabRegisterOrder(state, detail.externalOrderId, {
      tradeNo: detail.tradeNo || null,
      seq: sum.seq,
      amount: sum.payAmount,
      at: (detail.timeline && detail.timeline.created) || detail.occurredAt || null,
      state: isNew ? 'pending' : 'observed',
    });
    if (!isNew) grabCountDuplicate(state, detail.externalOrderId);

    // 有品項就寫進註冊表 —— 清單與推送都靠這份
    if (Array.isArray(detail.items) && detail.items.length > 0) {
      const merged = grabMergeDetail(
        state,
        detail.externalOrderId,
        detail,
        message.meta && message.meta.transport,
      );
      // 🔴 就算註冊表裡沒有這一筆（被 cut-off 清掉或容量裁剪），也要把
      //    「抓過品項」記下來 —— 否則它下次被重新登記時又會被再抓一次。
      if (!merged) grabMarkDetailDone(state, detail.tradeNo || detail.externalOrderId);
    } else {
      const e = state.orders && state.orders[detail.externalOrderId];
      if (e && e.detailState !== 'done') {
        e.detailState = 'failed';
        e.detailError = '詳情回應沒有品項';
        e.detailAttempts = (e.detailAttempts || 0) + 0;
      }
    }

    return grabSaveState(cfg.key, state)
      .then(() =>
        grabAppendLog(cfg, {
          level: isNew ? 'new' : 'info',
          kind: `${cfg.key}_order_detail`,
          summary:
            `擷取訂單詳情 ${detail.externalOrderId}` +
            (isNew ? '' : '（已見過）') +
            `，${(detail.items || []).length} 個品項`,
          detail: cfg.summarizeDetail(detail),
        }),
      )
      .then(() => (isNew ? grabMaybePush(cfg, [detail], 'detail') : undefined));
  });
}

/**
 * 頁面統計（目前只有 mfood 有）。
 * 不拿來下單，但拿來人工核對「畫面上的總額」與「我們抓到的單」是否一致。
 */
function grabHandleStats(cfg, message) {
  return grabGetState(cfg.key).then((state) => {
    state.counters.statsCaptures++;
    state.stats = { ...message.stats, capturedAt: new Date().toISOString() };

    return grabSaveState(cfg.key, state).then(() =>
      grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_stats`,
        summary:
          `頁面統計：${message.stats.orderCount} 單 / ` +
          `營業總額 MOP ${message.stats.storeBusinessAmount}`,
        detail: message.stats,
      }),
    );
  });
}

/** popup 用的一次性查詢 */
function grabDashboard(cfg) {
  return Promise.all([
    grabGetState(cfg.key),
    grabGetSettings(cfg.key),
    grabGlobalSettings(),
    // 🔴 登入前移（2026-09-29）：主面板要顯示「憑證設咗未／登入狀態」
    grabGetCreds(cfg.key),
    // 🔴 2026-09-30：數呢個平台開咗幾個分頁，**而且要分類**。
    //    舊版只數總數 ⇒「1 訂單頁 + 1 對帳頁」呢個**正常狀態**都會被當成「開多咗」，
    //    警示永遠唔走（使用者真機：「不明白為什麼會長時間顯示出來」）。
    grabClassifyTabs(cfg.key),
  ]).then(
    ([state, settings, global, creds, tabInfo]) =>
      new Promise((resolve) => {
        chrome.storage.local.get([grabLogKey(cfg.key)], (res) => {
          resolve({
            source: cfg.key,
            // 🔴🔴 2026-09-29 澳覓：popup 用 sourceKey 判斷「本頁係邊個平台」，
            //    再揀正確嘅 storage key（`aomiSettings` vs `mfoodSettings`）。
            //    `source` 係歷史欄位（mfood 時就係佢），兩者同值，唔可以淨係回一個。
            sourceKey: cfg.key,
            label: cfg.label,
            site: cfg.site,
            supportsStats: cfg.supportsStats,
            // `openTabCount` = 該平台分頁**總數**（向後兼容），`null` = 環境查唔到。
            openTabCount: tabInfo && !tabInfo.unknown ? tabInfo.total : null,
            /** 分類明細：popup 靠佢講清楚「邊個係多出嚟嗰個」 */
            tabInfo: tabInfo || null,
            // 🔴 真正嘅「重複」＝ 訂單頁或對帳頁多過一張。
            //    舊寫法 `openTabCount > 1` 會誤報（見 grabClassifyTabs 註釋）。
            duplicateTabs: !!(
              tabInfo &&
              !tabInfo.unknown &&
              (tabInfo.order > 1 || tabInfo.finance > 1)
            ),
            storeId: global.storeId,
            cutoffDate: global.cutoffDate,
            intervalSecs: global.intervalSecs,
            // 🔴 登入前移：憑證只回「有冇」，永遠唔回密碼本身
            hasCreds: !!(creds && creds.username && creds.password),
            credsUsername: (creds && creds.username) || '',
            login: state.login || null,
            orders: state.orders || {},
            detailDoneCount: Object.keys(state.detailDone || {}).length,
            // 🔴🔴 第十七次真機：實收對照表（`tradeNo → 實收金額`）。
            //    popup 喺每張訂單嘅價格下面加一行「實收價格」就係讀呢度。
            //    一定要由 state 帶出（popup 唔會自己去掘 storage）。
            settleMap: state.settleMap || {},
            state,
            settings,
            log: Array.isArray(res[grabLogKey(cfg.key)])
              ? res[grabLogKey(cfg.key)].slice(0, 60)
              : [],
            version: chrome.runtime.getManifest().version,
          });
        });
      }),
  );
}

/**
 * 🔴🔴 2026-10-02：MacauPay 主面板卡片嘅 dashboard。
 *
 * MacauPay 係「舊後台直抓鏈」（`fetchData()` 直接打 msp.macaupay.com.mo → Supabase），
 * 冇遷入 GRAB_SOURCES 框架，所以呢度**唔用** grabGetState/grabGetSettings，
 * 改讀佢自己嘅 storage keys：
 *   · isTimerActive / nextRefreshTime / currentIntervalSecs —— 舊 timer 狀態
 *   · lastGrabbedData / lastGrabTime / fetchStatus / error —— 抓取結果
 *   · mpayPushEnabled —— 「同步到 macau-pos」開關（預設開）
 *
 * 回嘅形狀刻意同 grabDashboard() 相容，令 popup 嘅 cardHtml / renderRunCtl 可以
 * 唔分平台咁用：
 *   · settings.autoRefresh = isTimerActive（呢個決定總控列「運行中」）
 *   · state.login = null（MacauPay 冇獨立登入流程，靠後台 cookie 自動帶）
 */
function grabMpayDashboard() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['isTimerActive', 'lastGrabTime', 'fetchStatus', 'error', 'lastGrabbedData', 'mpayPushEnabled'],
      (res) => {
        const active = res.isTimerActive === true;
        const list = (res.lastGrabbedData && res.lastGrabbedData.list) || [];
        resolve({
          source: 'mpay',
          sourceKey: 'mpay',
          label: 'MacauPay',
          site: 'msp.macaupay.com.mo',
          supportsStats: false,
          openTabCount: null,
          duplicateTabs: false,
          storeId: null,
          intervalSecs: null,
          // 🔴 後台自動帶 cookie 登入，冇需手輸帳密 ⇒ 當「已設定」，
          //    咁總控列先會計埋 mpay 嘅運行狀態。
          hasCreds: true,
          credsUsername: '',
          login: null,
          orders: {},
          detailDoneCount: 0,
          settleMap: {},
          state: { login: null, lastListCaptureAt: null, orders: {} },
          settings: {
            pushEnabled: res.mpayPushEnabled !== false, // 預設開
            autoRefresh: active,
          },
          listLength: list.length,
          sentCount: list.length,
          mpay: {
            isTimerActive: active,
            lastGrabTime: res.lastGrabTime || null,
            fetchStatus: res.fetchStatus || null,
            error: res.error || null,
          },
          log: [],
          version: chrome.runtime.getManifest().version,
        });
      },
    );
  });
}

/**
 * 數「呢個平台開咗幾個分頁」—— 畀 popup 提示使用者（2026-09-30 使用者真機）。
 *
 * ## 為什麼要數
 * 使用者原話：
 *   「我需要同時讓多個頁面各自獨立運行才能正常操作，目前的做法是在 Google Chrome
 *     裡同時打開 4 個分頁，想讓它們各自自動執行，但似乎無法正常運作。」
 *
 * 根因（已喺 background.js 查清）：
 *   ① `state.tabId` 只喺 `PAGE_READY` 記低，即係「最後重新載入嗰個同平台分頁贏」
 *      ⇒ 開咗兩個 mfood 分頁，就會出現「有時得有時唔得」。
 *   ② `grabFindFinanceTab()` / `grabFindSiteTab()` 都係 `tabs[0]`
 *      ⇒ 邊個分頁被揀中，取決於 Chrome 嘅排序（唔穩定）。
 *
 * ⇒ 正解係「每個平台**只留一個**功能分頁」（訂單頁一個、對帳頁一個；
 *   兩平台共 4 個）。但呢個係使用者側嘅規矩，擴充功能阻止唔到 ——
 *   **唯一可以做嘅係講清楚**，唔可以靜靜地唔出聲。
 *
 * ## ⚠️ 唔需要 "tabs" 權限
 * `chrome.tabs.query({url})` 喺有對應 `host_permissions` 時就查到，
 * 唔需要 `"tabs"`（嗰個會令 Chrome 彈「讀取你的瀏覽紀錄」）。
 * 只數數量、唔讀標題／URL 內容 ⇒ 私隱上無增量。
 */
function grabCountSiteTabs(sourceKey) {
  const lc = GRAB_LOGIN_SOURCES[sourceKey];
  const pattern = (lc && lc.sitePattern) || ((GRAB_SOURCES[sourceKey] || {}).tabUrlPattern);
  if (!pattern) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(null);
      return;
    }
    chrome.tabs.query({ url: pattern }, (tabs) => {
      void chrome.runtime.lastError;
      resolve(Array.isArray(tabs) ? tabs.length : 0);
    });
  });
}

/**
 * 由完整 URL 抽出「路徑特徵」—— hash 路由（`#/finance/tackout-check`）。
 * SPA 嘅 `chrome.tabs.query({url})` match pattern **唔支援 hash 比對**，
 * 所以一律攞晒該站分頁自己逐個 `indexOf` 比對。
 */
function grabUrlMarker(targetUrl) {
  const i = String(targetUrl || '').indexOf('#');
  return i >= 0 ? String(targetUrl).slice(i) : '';
}

/** 記日誌用嘅分頁摘要 —— 一律**去掉 query**（可能有一次性 token）。 */
function grabTabInfoForLog(info) {
  if (!info || info.unknown) return { unknown: true };
  return {
    total: info.total,
    order: info.order,
    finance: info.finance,
    login: info.login,
    other: info.other,
    urls: (info.tabs || []).map((t) => ({
      id: t.id,
      kind: t.kind,
      url: String(t.url || '').split('?')[0],
    })),
  };
}

/**
 * 把「同平台開咗嘅分頁」**按用途分類**（2026-09-30 真機確診後新增）。
 *
 * ## 為什麼唔可以只數總數
 * 舊寫法 `grabCountSiteTabs()` 只回總數 ⇒ **正常狀態（訂單頁 1 ＋ 對帳頁 1 = 2）**
 * 都會判定為「開多咗」而長期出警示 ⇒ 使用者見到「⚠ 2 個分頁同時開住」永遠唔走，
 * 以為擴充功能壞咗（真機原話：「不明白為什麼會長時間顯示出來」）。
 * ⇒ 一定要**分類**：真正嘅重複 = `order > 1` 或 `finance > 1`。
 *
 * @returns {Promise<{total,order,finance,login,other,tabs,unknown}>}
 *   `unknown:true` ＝ 環境查唔到（唔可以當 0，會變成假安心）。
 */
function grabClassifyTabs(sourceKey) {
  const lc = GRAB_LOGIN_SOURCES[sourceKey];
  const pattern = (lc && lc.sitePattern) || (GRAB_SOURCES[sourceKey] || {}).tabUrlPattern;
  const unknown = {
    total: null,
    order: null,
    finance: null,
    login: null,
    other: null,
    tabs: [],
    unknown: true,
  };
  if (!pattern) return Promise.resolve(unknown);
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return Promise.resolve(unknown);

  const oMark = grabUrlMarker(lc.orderPageUrl);
  const fMark = grabUrlMarker(lc.financePageUrl);

  return new Promise((resolve) => {
    chrome.tabs.query({ url: pattern }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(unknown);
        return;
      }
      const list = (Array.isArray(tabs) ? tabs : []).map((t) => {
        const url = String((t && t.url) || '');
        let kind = 'other';
        if (/#\/login/.test(url)) kind = 'login';
        else if (oMark && url.indexOf(oMark) >= 0) kind = 'order';
        else if (fMark && url.indexOf(fMark) >= 0) kind = 'finance';
        return { id: (t && t.id) != null ? t.id : null, url: url, kind: kind };
      });
      const count = (k) => list.filter((x) => x.kind === k).length;
      resolve({
        total: list.length,
        order: count('order'),
        finance: count('finance'),
        login: count('login'),
        other: count('other'),
        tabs: list,
        unknown: false,
      });
    });
  });
}

/**
 * 解析「應該收命令嘅分頁」—— **一定要用 URL 認，唔可以靠 `state.tabId`**。
 *
 * ## 🔴🔴 2026-09-30 真機確診（三件事其實同一個成因）
 * `state.tabId` 只喺 `PAGE_READY` 記低 ＝ **最後載入嗰個同平台分頁贏**。
 * 同平台開咗第二個分頁（登入頁／對帳頁／另一個 portal）之後，命令會送去錯嘅分頁：
 *   · 代按查詢 → 「找不到頁面上的『查詢』按鈕」
 *   · 抓詳情   → 「在列表中找不到這一列」
 *   · 設篩選   → 「搵唔到『訂單狀態』篩選欄位」
 * 三者睇落好似三個唔同 bug，其實都係「**命令落喺一個唔係訂單頁嘅分頁**」。
 * ⇒ 一律按 URL 揀（訂單頁 hash 命中）；揀唔到才退返 `state.tabId`（保持舊行為）。
 *
 * @returns {Promise<number|null>} 分頁 id；`null` = 完全冇可用分頁
 */
function grabOrderTabId(cfg) {
  const lc = GRAB_LOGIN_SOURCES[cfg.key];
  const pattern = (lc && lc.sitePattern) || (GRAB_SOURCES[cfg.key] || {}).tabUrlPattern;
  const marker = grabUrlMarker(lc && lc.orderPageUrl);
  const fallback = () =>
    grabGetState(cfg.key).then((st) => (typeof st.tabId === 'number' ? st.tabId : null));

  if (!marker || !pattern) return fallback();
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return fallback();

  return new Promise((resolve) => {
    chrome.tabs.query({ url: pattern }, (tabs) => {
      if (chrome.runtime.lastError) {
        // 查唔到唔等於冇 ⇒ 退返舊行為，唔好靜靜地當「冇分頁」
        fallback().then(resolve);
        return;
      }
      const hits = (Array.isArray(tabs) ? tabs : []).filter(
        (t) => String((t && t.url) || '').indexOf(marker) >= 0,
      );
      if (hits.length > 0 && typeof hits[0].id === 'number') {
        // ⚠️ 多過一個訂單頁時，仍然係「揀第一個」—— 但呢個情況 popup 會出警示
        resolve(hits[0].id);
        return;
      }
      fallback().then(resolve);
    });
  });
}

/**
 * 記住「這個來源最近一次是由哪個分頁回報的」。
 *
 * 用途：popup 的「重新掃描」要把訊息送回那個分頁。
 * 為什麼不用 tabs.query 依網域找：那需要 "tabs" 權限，
 * Chrome 會對使用者顯示「讀取你的瀏覽紀錄」。用 sender.tab.id 完全不需要。
 *
 * 🔴🔴 2026-09-30（使用者真機）：呢個函式**只喺 `PAGE_READY` 被呼叫**，
 *    所以同平台開兩個分頁時，「最後重新載入嗰個」會蓋掉前一個
 *    ⇒ 之後所有 `sendMessage(state.tabId)`（設篩選、代按查詢、抓詳情）
 *      都可能送去**錯嘅分頁**。
 *    呢個就係使用者見到「mfood 訂單狀態冇被設成全部」嘅其中一條路：
 *    設篩選送去 A 分頁，而真正被重放／被觀察嘅係 B 分頁。
 *    ⚠️ 我哋**唔會**喺呢度自己禁掉多分頁（會誤殺正常用法），
 *       而係交由 `grabCountSiteTabs()` 出提示，等使用者自己收乾淨。
 */
function grabRememberTab(cfg, sender) {
  const id = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  if (id === null) return Promise.resolve();
  return grabGetState(cfg.key).then((state) => {
    if (state.tabId === id) return undefined;
    state.tabId = id;
    return grabSaveState(cfg.key, state);
  });
}

/**
 * 請該來源的分頁「自己去」重新查詢。
 *
 * ⚠️ 我們不會替它發請求 —— 澳覓的簽章綁定 method/path/body/timestamp/nonce，
 * 重放舊請求一定會被拒。所以這裡只請內容腳本去按頁面上的「查詢」按鈕，
 * 等同人工操作一次。
 */
function grabRescanRaw(cfg) {
  // 🔴 2026-09-30：改用 `grabOrderTabId()` —— 唔可以靠 `state.tabId`
  //    （同平台開多過一個分頁時，佢可能指住登入頁／對帳頁 ⇒ 永遠撳唔到「查詢」）。
  return grabOrderTabId(cfg).then(
    (tabId) =>
      new Promise((resolve) => {
        if (typeof tabId !== 'number') {
          resolve({
            ok: false,
            reason: '還沒偵測到該後台的分頁。請先開啟該後台，並在該分頁按 F5 重新整理一次。',
          });
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: 'GRAB_RESCAN' }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              reason: grabExplainLastError('重新掃描'),
            });
            return;
          }
          resolve(resp || { ok: false, reason: '分頁沒有回應' });
        });
      }),
  );
}

// ---- 自動化：定時查詢 --------------------------------------------------------

/**
 * 自動查詢的節拍器。
 *
 * 為什麼不每個來源各自一個 alarm：alarm 建立/清除成本高，而且設定變更時
 * 要同步重建。改成「一個每分鐘的 tick，各來源自己判斷是否該動作」。
 */
function grabAutoTick() {
  return grabGlobalSettings().then((global) => {
    const intervalMs = Math.max(30, Number(global.intervalSecs) || 60) * 1000;

    return Promise.all(
      grabSourceList().map((cfg) =>
        Promise.all([grabGetSettings(cfg.key), grabGetState(cfg.key)]).then(([s, st]) => {
          // 🔴🔴 2026-09-30：對帳期間完全停止訂單循環（唔可以同時跑，避免互相干擾）
          if (st.busySettling) return Promise.resolve();
          // 🔴🔴 2026-09-30：30 分鐘累加器（不可設）；到點先觸發單一分頁對帳。
          //    只有 autoSettle 開咗先累加（關咗就唔計）。
          // 🔴🔴 2026-10-02：再加 autoRefresh 閘 —— 按「停止」後 autoRefresh=false，
          //    就算 autoSettle 殘留都唔可以繼續累加／觸發對帳。
          const _run = s.autoRefresh && s.autoSettle;
          const _accum = _run ? (st.settleAccumMs || 0) + intervalMs : 0;
          const _due = _run && _accum >= 30 * 60 * 1000;
          st.settleAccumMs = _due ? 0 : _accum;
          if (_due) {
            st.busySettling = true;
            return grabSaveState(cfg.key, st).then(() => grabSettleSingleTab(cfg));
          }
          return grabSaveState(cfg.key, st).then(() => {
            const tasks = [];

          // ① 定時查詢 —— 依使用者設定的間隔節流，不必重建 alarm
          if (s.autoRefresh) {
            // 內容腳本自己也在計時（分頁在前景時可精準到秒）。
            // 這裡比對「上次自動觸發」與「上次實際擷取」，取較新者 ——
            // 若內容腳本剛跑過，這裡就不必重複觸發。
            const lastAuto = st.lastAutoRefreshAt ? Date.parse(st.lastAutoRefreshAt) : 0;
            const lastCap = st.lastListCaptureAt ? Date.parse(st.lastListCaptureAt) : 0;
            const last = Math.max(lastAuto, lastCap);
            // 留 10% 容差：alarm 排程本身會有抖動，若用嚴格比較，
            // 當使用者間隔與 tick 同為 30 秒時會每兩拍才跑一次（實際變 60 秒）。
            if (!last || Date.now() - last >= intervalMs * 0.9) {
              tasks.push(
                grabRescan(cfg, 'auto').then((r) =>
                  grabGetState(cfg.key).then((s2) => {
                    s2.lastAutoRefreshAt = new Date().toISOString();
                    s2.counters.autoRefreshes = (s2.counters.autoRefreshes || 0) + 1;
                    // 🔴 2026-09-25：`r.ok` 只代表「成功撳到頁面嘅查詢掣」，
                    //    **唔代表頁面真係送咗請求、或者攔截器收得到**。
                    //    實案：澳覓 `lastListCaptureAt` 93 分鐘冇動過，
                    //    而 `lastAutoRefreshError` 一路係 null
                    //    ⇒ 橫幅一直綠色「自動中」，真正嘅卡住被綠燈藏住
                    //    （見 skill「自動化狀態一定要反映失敗」）。
                    //    ⇒ 撳掣成功但長時間冇任何列表回報 = 我哋係盲嘅，要大聲講。
                    //    （`capAt2 > 0` 係必要條件：全新安裝／未開過後台就唔應該嘈。）
                    const silentMs = Math.max(60 * 1000, intervalMs * 3);
                    const capAt2 = s2.lastListCaptureAt ? Date.parse(s2.lastListCaptureAt) : 0;
                    // 🔴 2026-09-25：`listSeen === false`（撳咗查詢但攔截器乜都冇交）
                    //    係**即時**證據 ⇒ 唔使等 3 個週期，橫幅即刻轉紅同叫 F5。
                    const blind =
                      r.ok &&
                      (r.listSeen === false || (capAt2 > 0 && Date.now() - capAt2 > silentMs));
                    s2.lastAutoRefreshError = r.ok
                      ? blind
                        ? r.listSeen === false
                          ? '已代按「查詢」但攔截器冇見到任何請求 —— 攔截器可能失效，請喺該分頁按 F5 重新整理'
                          : `已代按「查詢」但一直沒有回報訂單列表（上次擷取 ${Math.round(
                              (Date.now() - capAt2) / 60000,
                            )} 分鐘前）—— 請在該後台分頁按 F5 重新整理`
                        : null
                      : r.reason;
                    return grabSaveState(cfg.key, s2);
                  }),
                ),
              );
            }
          }

          // ③ 自動復原 —— 頁面太久沒回報就重新載入它
          tasks.push(grabMaybeRecover(cfg, global.intervalSecs));

          // ④ 推送失敗重試（2026-09-25）：POS 拒收過嘅單要再試，唔可以永遠卡住。
          tasks.push(grabRetryFailedPushes(cfg));

          // ⑤ 存活探測（2026-09-25）：分辨「頁面正常、只係冇新單」同「真係收唔到嘢」。
          //    唔可以只睇「有冇新訂單」—— 冇新單係正常狀態。
          tasks.push(grabProbeLiveness(cfg));

          // ② 自動抓詳情 —— 每個 tick 都嘗試，**不依賴新的列表擷取**。
          //    否則使用者只開「自動抓詳情」而沒開「定時查詢」時，
          //    永遠不會有新的列表事件 → 詳情永遠不會被派工。
          tasks.push(grabMaybeFetchDetails(cfg));

          // 🔴🔴 2026-09-30：對帳改由「30 分鐘累加器」驅動（見上面 `_due` 分支），
          //    喺嗰度用 grabSettleSingleTab 做單一分頁對帳，唔喺呢度並行跑。
          //    另外每次訂單循環前，冪等重設「訂單狀態＝全部」（單一分頁切去財務頁
          //    再返訂單頁會 reset SPA 篩選，必須每輪補返）。
          if (s.autoRefresh) tasks.push(grabApplyPagePrepare(cfg, 'tick'));

          return Promise.all(tasks);
          });
        }),
      ),
    );
  });
}

// ---- 自動化：逐筆抓訂單詳情 --------------------------------------------------

function grabDispatchDetails(cfg, orders, settings) {
  // 🔴 2026-09-30：一定要送去**訂單頁**分頁（詳情列只存在於訂單頁）。
  //    舊寫法用 `state.tabId` ⇒ 同平台有第二個分頁時，命令落到登入頁／對帳頁
  //    ⇒ 內容腳本搵唔到列 ⇒ 回「在列表中找不到這一列」⇒ 永遠抓唔到品項
  //    ⇒ POS 拒收「payload 內冇可用品項」。呢個就係推送失敗嘅根源。
  return grabOrderTabId(cfg).then(
    (tabId) =>
      new Promise((resolve) => {
        if (typeof tabId !== 'number') {
          resolve({ ok: false, reason: '沒有可用的後台分頁（請先開啟該後台並按 F5）' });
          return;
        }
        chrome.tabs.sendMessage(
          tabId,
          {
            type: 'GRAB_FETCH_DETAILS',
            strategy: cfg.detailStrategy,
            delayMs: settings.detailDelayMs || 1200,
            orders: orders.map((o) => ({ id: o.id, seq: o.seq, tradeNo: o.tradeNo || null })),
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve({
                ok: false,
                reason: grabExplainLastError('抓訂單詳情'),
              });
              return;
            }
            resolve(resp || { ok: false, reason: '分頁沒有回應' });
          },
        );
      }),
  );
}

/** 找出還沒抓到品項的單，派工給內容腳本 */
/**
 * 派工抓詳情。
 *
 * @param force true = 手動觸發，不受「自動抓訂單詳情」開關限制。
 *
 * 🔴 這裡「絕對不可以靜默 return」。
 *    先前每個失敗路徑都寫 return undefined，導致使用者按了按鈕卻
 *    完全沒有反應、也沒有任何訊息可查 —— 是這個功能最難排查的來源。
 *    現在一律回傳 { ok, dispatched } 或 { ok:false, reason }。
 */
function grabMaybeFetchDetails(cfg, force) {
  return grabGetSettings(cfg.key).then((settings) => {
    if (!settings.autoFetchDetails && !force) {
      return { ok: false, reason: '未開啟「自動抓訂單詳情」（可用手動按鈕）' };
    }

    return grabGetState(cfg.key).then((state) => {
      const total = Object.keys(state.orders || {}).length;

      if (total === 0) {
        return { ok: false, reason: '目前沒有任何訂單，請先讓列表擷取一次' };
      }

      // 模擬點擊會實際操作頁面（開關彈窗），一次抓太多會讓商家等太久、
      // 也更容易被平台判定異常，所以另外收緊上限。
      // 請求重放不碰畫面，維持使用者設定。
      const cap =
        cfg.detailStrategy === 'dom'
          ? Math.min(settings.maxDetailsPerRun || 30, 10)
          : settings.maxDetailsPerRun || 30;

      // 模擬點擊會真的開關彈窗（商家看得到），重試上限要比請求重放更低
      const maxAttempts =
        cfg.detailStrategy === 'dom' ? GRAB_DETAIL_MAX_ATTEMPTS_DOM : GRAB_DETAIL_MAX_ATTEMPTS;

      // force（手動）時忽略重試上限 —— 但「已經拿過品項」的單仍然不會被派工
      const need = grabOrdersNeedingDetail(state, cap, force, maxAttempts);
      if (need.length === 0) {
        const now = Date.now();
        const inFlight = Object.keys(state.orders || {}).filter((k) => {
          const o = state.orders[k];
          const q = o.detailQueuedAt ? Date.parse(o.detailQueuedAt) : 0;
          return o.detailState === 'fetching' && q && now - q < GRAB_FETCHING_STALE_MS;
        }).length;

        // 讓使用者看得到「名冊有在運作」——不然會以為它沒在做事
        const settled = Object.keys(state.orders || {}).filter((k) =>
          grabIsDetailSettled(state, state.orders[k]),
        ).length;

        return {
          ok: false,
          reason:
            inFlight > 0
              ? `有 ${inFlight} 筆正在抓取中，請稍候再試`
              : `沒有需要抓的單了：${settled} 筆已取得過品項（不再重複拿取）` +
                `，其餘 ${Math.max(0, total - settled)} 筆已達重試上限`,
          settled: settled,
        };
      }

      if (typeof state.tabId !== 'number') {
        return { ok: false, reason: '還沒偵測到該後台分頁，請先在該分頁按 F5' };
      }

      const ids = need.map((o) => o.id);
      const label = cfg.detailStrategy === 'replay' ? '請求重放' : '模擬點擊';

      // 🔴 先派工，成功才計一次重試。
      //
      //    先前是「先計次、再派工」，結果分頁還沒 F5 時連續三次派工失敗
      //    就把重試配額用光 → 之後永遠不再嘗試、畫面永久卡在「抓取品項中」。
      //    派工失敗（沒人收）不是「抓取失敗」，不該消耗配額。
      return grabDispatchDetails(cfg, need, settings).then((r) => {
        if (!r.ok) {
          return grabAppendLog(cfg, {
            level: 'error',
            kind: `${cfg.key}_detail_batch`,
            summary: `派工失敗（未計入重試）：${r.reason}`,
            detail: { count: need.length, strategy: cfg.detailStrategy, result: r },
          }).then(() => ({ ok: false, reason: r.reason }));
        }

        /**
         * 🔴🔴 2026-09-30 真機確診：**「派工」同「抓取」係兩件事，唔可以混為一談。**
         *
         * 舊寫法只睇 `r.ok`，而 bridge 回傳嘅 `ok` 係**成功筆數**（見 mfood-bridge.js
         * `runDetailBatch`）—— 一筆都失敗時 `ok: 0` ⇒ 被當成「派工失敗」
         * ⇒ **唔會叫 `grabMarkDetailQueued()`** ⇒ `detailAttempts` 永遠 0
         * ⇒ `grabOrdersNeedingDetail()` 每個 tick 都覺得「未試過」⇒ **每 30 秒重派**。
         * 實測日誌已有 541 條 `mfood_detail_done`，而摘要寫成
         * 「派工失敗（未計入重試）：undefined」（`r.reason` 根本唔存在）。
         *
         * ⇒ 而家：`batchOk === 0` 且有失敗 ⇒ 當「**抓取失敗**」，照計 attempts，
         *   並將 `detailState` 標成 `failed`（唔會再無限期重派；配額用完即停）。
         */
        const batchOk = Number(r.batchOk);
        const gotNone = Number.isFinite(batchOk) && batchOk === 0 && Number(r.failed) > 0;
        const failReason = (r.failures && r.failures[0] && r.failures[0].reason) || '原因不明';

        return grabGetState(cfg.key).then((s2) => {
          if (force) {
            // 手動強制重試：把先前卡住的狀態與配額復原
            ids.forEach((id) => {
              const e = s2.orders && s2.orders[id];
              if (!e) return;
              e.detailError = null;
              e.detailAttempts = 0;
            });
          }
          grabMarkDetailQueued(s2, ids);
          s2.counters.detailBatches = (s2.counters.detailBatches || 0) + 1;

          if (gotNone) {
            s2.counters.detailFailures = (s2.counters.detailFailures || 0) + 1;
            ids.forEach((id) => {
              const e = s2.orders && s2.orders[id];
              if (!e) return;
              e.detailState = 'failed';
              e.detailError = failReason;
              e.detailQueuedAt = null;
            });
          }

          return grabSaveState(cfg.key, s2).then(() =>
            grabAppendLog(cfg, {
              level: gotNone ? 'error' : 'info',
              kind: `${cfg.key}_detail_batch`,
              summary: gotNone
                ? `抓取品項失敗（已計 1 次重試）：${need.length} 筆全部失敗 —— ${failReason}`
                : `派工抓取 ${need.length} 筆詳情（${label}）`,
              detail: { count: need.length, strategy: cfg.detailStrategy, batch: r },
            }).then(() => ({ ok: true, dispatched: ids.length, strategy: cfg.detailStrategy })),
          );
        });
      });
    });
  });
}

// ---- 診斷匯出 ----------------------------------------------------------------
//
// 讓使用者按一個按鈕就能把「排查需要的東西」複製出來，
// 不必每次翻 DevTools。
//
// 🔴 敏感值一律遮蔽：cookie / token / sign / session / nonce / key …
//    只保留「標頭名稱」與「值有多長」，足以判斷有沒有帶憑證，
//    但不會把憑證本身外流。

const GRAB_SENSITIVE = /cookie|authorization|token|sign|session|secret|nonce|api[-_]?key|password/i;

function grabRedact(name, value) {
  const s = value == null ? '' : String(value);
  if (GRAB_SENSITIVE.test(String(name))) return `<已遮蔽 · ${s.length} 字元>`;
  if (s.length > 160) return `${s.slice(0, 80)}…<共 ${s.length} 字元>`;
  return s;
}

function grabRedactHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((k) => {
    out[k] = grabRedact(k, headers[k]);
  });
  return out;
}

function grabStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => resolve(res || {}));
  });
}

function grabBuildDiagnostics() {
  return Promise.all([
    grabGlobalSettings(),
    Promise.all(
      grabSourceList().map((cfg) =>
        Promise.all([
          grabGetSettings(cfg.key),
          grabGetState(cfg.key),
          grabStorageGet([grabLogKey(cfg.key)]),
        ]).then(([settings, state, store]) => {
          const orders = state.orders || {};
          const ids = Object.keys(orders);
          return {
            source: cfg.key,
            label: cfg.label,
            detailStrategy: cfg.detailStrategy,
            settings,
            state: {
              tabId: state.tabId,
              lastListCaptureAt: state.lastListCaptureAt,
              lastDetailCaptureAt: state.lastDetailCaptureAt,
              lastAutoRefreshAt: state.lastAutoRefreshAt || null,
              lastAutoReloadAt: state.lastAutoReloadAt || null,
              lastAutoRefreshError: state.lastAutoRefreshError || null,
              lastPushOkAt: state.lastPushOkAt,
              lastError: state.lastError,
              counters: state.counters,
              orderCount: ids.length,
              ordersWithItems: ids.filter((k) => (orders[k].items || []).length > 0).length,
              detailPending: grabOrdersNeedingDetail(state, 999).length,
              pageStats: state.stats || null,
            },
            // 只帶最近 20 筆，避免複製出巨量文字
            recentLog: (store[grabLogKey(cfg.key)] || []).slice(0, 20),
          };
        }),
      ),
    ),
  ]).then(([global, sources]) => ({
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    platform: (typeof navigator !== 'undefined' && navigator.userAgent) || '(unknown)',
    globalSettings: global,
    sources,
    note: '此檔案中的 cookie / token / sign / nonce 等敏感值已自動遮蔽，只保留長度。',
  }));
}

/**
 * 包一層日誌：手動一定記錄、自動只在失敗時記錄（避免每分鐘洗版）。
 * 沒有這層的話，「按了重新掃描卻不知道有沒有成功」只能靠猜。
 */
function grabRescan(cfg, trigger) {
  return grabRescanRaw(cfg).then((r) => {
    const isManual = trigger === 'manual';
    /**
     * 🔴 撳到掣、但**攔截器冇見到任何請求**（2026-09-25）—— 呢個係「靜默卡住」嘅主因，
     *    一定要出聲，唔可以當成功而跳過日誌。
     *    澳覓實案：`rescan` 一直回 `ok`，但頁面從來冇請求上到嚟 ⇒ 零症狀；
     *    而 `listSeen`（inject 有冇交列表上嚟）就一次分清兩種故障。
     */
    const blind = !!(r && r.ok && r.listSeen === false);
    if (!isManual && r.ok && !blind) return r;

    return grabAppendLog(cfg, {
      level: r.ok && !blind ? 'info' : 'error',
      kind: `${cfg.key}_rescan`,
      summary: r.ok
        ? blind
          ? `已代按「${r.label || '查詢'}」但攔截器冇見到任何請求 —— 攔截器可能失效，請喺該分頁按 F5`
          : `已請後台重新查詢（按下「${r.label || '查詢'}」）`
        : `重新查詢失敗：${r.reason}`,
      detail: { trigger: trigger || 'auto', result: r },
    }).then(() => r);
  });
}

/**
 * 一次開／關所有來源的自動化。
 *
 * 「開始」＝三個平台都進入自動模式（定時查詢 + 抓詳情）；
 * 「停止」＝全部停掉。個別平台的開關仍然保留，可單獨再關掉某一個。
 */
/**
 * 把後台篩選設成正確值（目前只有 mfood：訂單狀態＝全部）（2026-09-25 使用者要求）。
 *
 * ## 為何「重新載入之後」要再設一次
 * 使用者嘅要求係「重新整理前先設定好篩選」。但 F5 會令 SPA 嘅篩選**還原成預設**
 * ⇒ 單靠「先設再載」會用返「已完成」嘅範本重放，**正好就係抓唔到新單嘅原因**。
 * 所以兩邊都做：
 *   ① 先設（令頁面即刻用「全部」查一次 → 拿到「全部」範本）→ ② 重新載入 →
 *   ③ 載完（`PAGE_READY` 之後延遲）再設一次 ⇒ **最終狀態一定係「全部」**。
 *
 * 失敗一律寫日誌 —— 設定唔到篩選＝會漏新單，係要即刻知嘅事（唔可以靜默）。
 */
function grabApplyPagePrepare(cfg, trigger) {
  if (!cfg.needsOrderStatusAll) return Promise.resolve(undefined);

  /**
   * 🔴🔴 2026-09-30 真機：**唔喺訂單頁就唔應該做**，而且唔可以當失敗。
   *
   * 實案：分頁反覆落喺 `#/login`（或對帳頁）時，舊寫法把
   * `GRAB_SET_ORDER_STATUS_ALL` 送去嗰個分頁 ⇒ 必定回
   * 「搵唔到『訂單狀態』篩選欄位」⇒ **每 30 秒一條 error 日誌**
   * （實測 09:53~10:08 之間重複出現），令 popup 長期紅燈，真正問題被淹沒。
   * ⇒ 先分類分頁：冇訂單頁就**略過（info）**，唔好出 error。
   */
  return grabClassifyTabs(cfg.key)
    .then((info) => {
      // ⚠️ 只有「**確實查到有分頁、但冇一張係訂單頁**」才略過。
      //    `total === 0`（查唔到）唔可以當成「冇訂單頁」—— 咁會令
      //    PAGE_READY 剛到、Chrome 未更新 tab URL 嘅一刻被誤判，
      //    變成永遠唔設篩選（靜默失效，比出 error 更差）。
      if (info && !info.unknown && info.total > 0 && info.order === 0) {
        return grabAppendLog(cfg, {
          level: 'info',
          kind: `${cfg.key}_page_prepare`,
          summary:
            '略過篩選設定（目前冇訂單頁分頁' +
            (info.login > 0 ? '；分頁仍在登入頁' : '') +
            '）',
          detail: { trigger: trigger || 'start', tabInfo: grabTabInfoForLog(info) },
        }).then(() => ({ ok: true, skipped: true, reason: '沒有訂單頁分頁' }));
      }
      return null;
    })
    .then((early) => {
      if (early) return early;
      // 🔴 用 `grabOrderTabId()`（按 URL 認）而唔係 `state.tabId`。
      return grabOrderTabId(cfg).then(
        (tabId) =>
          new Promise((resolve) => {
            if (typeof tabId !== 'number') {
              resolve({ ok: false, reason: '尚未偵測到該後台嘅分頁' });
              return;
            }
            chrome.tabs.sendMessage(tabId, { type: 'GRAB_SET_ORDER_STATUS_ALL' }, (r) => {
              if (chrome.runtime.lastError) {
                resolve({
                  ok: false,
                  reason: grabExplainLastError('設定訂單狀態'),
                });
                return;
              }
              resolve(r || { ok: false, reason: '內容腳本冇回應' });
            });
          }),
      );
    })
    .then((r) => {
      // 🔴 2026-09-28：分頁可能開喺財務對帳頁（冇「訂單狀態」篩選）⇒
      //    內容腳本回 `skipped`。呢個**唔算失敗** —— 唔應該寫 error 日誌
      //    （否則 popup 一直顯示假警報，掩蓋真正嘅問題）。
      if (r && r.skipped) {
        return grabAppendLog(cfg, {
          level: 'info',
          kind: `${cfg.key}_page_prepare`,
          summary: `略過篩選設定（${r.reason || '唔需要設定'}）`,
          detail: { trigger: trigger || 'start', result: r },
        }).then(() => r);
      }

      const ok = !!(r && r.ok);

      /**
       * 🔴 設完篩選**一定要再撳一次「查詢」**（2026-09-25 使用者明確指出：
       *    「然後你再要按一下查詢 才會出訂單的」）。
       *
       * 為什麼：更改 Element-UI 嘅篩選**唔會**自動重新查詢 —— 唔撳嘅話
       * 頁面仍然係用舊參數，擴充功能拿到嘅請求範本亦係舊嘅（＝白做）。
       * 重用現有嘅 `grabRescanRaw()`（佢已經識搵頁面上嘅「查詢」掣）⇒ 零重複實作。
       *
       * 設定失敗就唔好查 —— 免得用「錯嘅篩選」拿到一個壞範本。
       */
      const afterSet = ok
        ? grabRescanRaw(cfg).then((q) => Object.assign({}, r, { query: q }))
        : Promise.resolve(r);

      return afterSet.then((final) =>
        grabAppendLog(cfg, {
          level: ok ? 'info' : 'error',
          kind: `${cfg.key}_page_prepare`,
          summary: ok
            ? (r.already ? '訂單狀態已經係「全部」' : '訂單狀態已切換為「全部」') +
              (final.query && final.query.ok
                ? `，已代按「${final.query.label || '查詢'}」重新查詢`
                : `，但代按查詢失敗：${(final.query && final.query.reason) || '未知原因'}`)
            : `⚠ 訂單狀態篩選設定失敗：${(r && r.reason) || '未知原因'}`,
          detail: { trigger: trigger || 'start', result: final },
        }).then(() => final),
      );
    });
}

/**
 * 開始同步：把後台篩選設成正確值（mfood：訂單狀態＝全部）＋**代按「查詢」**。
 *
 * 🔴 **唔可以 F5 整個頁面**（2026-09-25 使用者明確要求）：
 *    「他不需要 F5 整個頁面去每次更新內容 —— 選完訂單狀態之後，
 *      更新頁面只需要按查詢就夠了。」
 *
 * 而且 F5 本身有代價：會中斷頁面、令 SPA 篩選還原成預設、又要再設一次（繞圈）。
 * `grabApplyPagePrepare()` 已經包含「設完篩選 → 代按查詢」，足以拿到最新資料。
 */
function grabPreparePagesForStart() {
  // 🔴🔴 2026-09-30：單一分頁模型 —— 唔再預開「財務對帳分頁」。
  //    多 tab 會令 mfood 兩個頁面搶 session；對帳改為「單一分頁 SPA 切去財務頁、
  //    抓完切返」(見 grabSettleSingleTab)，所以開始時只需要整備訂單頁篩選。
  return Promise.resolve()
    .then(() =>
      Promise.all(
        grabSourceList()
          .filter((cfg) => cfg.needsOrderStatusAll)
          .map((cfg) => grabApplyPagePrepare(cfg, 'start')),
      ),
    )
    .then(() => undefined);
}

// ---- 平台結算（實收）抓取 ---------------------------------------------------
//
// 2026-09-26 使用者需求：
//   「在 mfood 和澳覓平台抓取更多數據，因為目前取得的營業額並非商家真實到手的金額。」
//
// ## 為什麼要另開一條路（唔可以併入訂單抓取）
// 訂單抓取係「列表 → 詳情」，靠攔截器記住 network 回應。
// 結算抓取係「財務頁 → 帳期 → transaction detail」，係**另一個頁面、另一支 API**，
// 而且係**低頻**（平台對帳滯後）。混埋一齊會令訂單節奏被拖慢。
//
// ## 🔴 商家名一定要設定
// 多店商戶唔選商家，`summary/_list` 會回全部店嘅帳期混埋一齊 ⇒ 配對撞錯單。
// 單店商戶可以留空（保留後台預設）。

/**
 * 搵財務頁嘅分頁。
 *
 * 🔴 2026-09-29：由「mfood 專用」泛化為**按來源**。
 *    舊寫法 query `*.mfoodapp.com` ＋ 寫死 `finance/tackout-check`
 *    ⇒ 澳覓（`merchant.aomiapp.com`，route 含 `settle`）永遠搵唔到。
 *
 * @param {string} [sourceKey] 'mfood' | 'aomi'；唔傳 = mfood（兼容舊呼叫）
 */
function grabFindFinanceTab(sourceKey) {
  const cfg = grabSettleCfg(sourceKey);
  return new Promise((resolve) => {
    // 🔴 守衛：`tabs.query` 喺真 Chrome 一定有，但測試 harness／精簡環境未必 stub。
    //    冇守衛嘅話一句 TypeError 會炸穿成個 autoTick（連訂單抓取都停）。
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(null);
      return;
    }
    chrome.tabs.query({ url: cfg.tabUrlPattern }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      for (const t of tabs || []) {
        const url = String(t.url || '');
        if (cfg.tabUrlMatch(url)) {
          resolve(t);
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * 🔴 2026-09-28 第十二次真機：把 `chrome.runtime.lastError.message` 翻譯成
 *    「使用者可以做咩」。
 *
 * 為什麼要：真機上使用者**已經按咗 F5**，但 popup 只出一句
 * 「內容腳本未載入（請按 F5）」⇒ 佢再按 F5 都冇用，只能卡死。
 * 真兇其實係另一個：`Could not establish connection. Receiving end does not exist.`
 * 呢句可以有幾個完全唔同嘅成因，處置方式亦唔同：
 *
 *   · **分頁係 chrome:// 或擴充功能頁** → 內容腳本永遠唔會注入（瀏覽器限制）
 *   · **分頁開喺 file:// 或非 mfoodapp.com** → manifest `matches` 唔中
 *   · **擴充功能新版未載入，但分頁係舊腳本** → 重新載入擴充功能（唔係 F5 分頁）
 *   · **分頁已 crash／被凍結（Chrome Memory Saver）** → 重新載入分頁
 *   · **分頁 id 對唔上（剛關咗／換咗 tab）** → 再撳一次
 *
 * ⇒ 回一句「最可能嘅下一步」，而唔係罐頭一句。
 *
 * ⚠️ 任何**認唔出**嘅訊息，仍然一定要包含「F5」——佢係最基本且有效嘅一步，
 *   唔可以因為認唔出就叫使用者「去搵開發者」。
 *
 * @param {string|null} msg `chrome.runtime.lastError.message`
 * @returns {string}
 */
function grabFinanceRawHint(msg) {
  const m = String(msg || '');
  if (/Receiving end does not exist/i.test(m)) {
    return (
      '財務分頁喺度但**接收端唔存在**。最常見兩個原因：' +
      '① 分頁啱啱被 Chrome 凍結／重載中（等 2 秒再撳）；' +
      '② 分頁係舊版腳本（要在 chrome://extensions 撳「重新載入」，' +
      '唔係淨係 F5 網頁）。若持續，請喺該分頁按 F5 再試，' +
      '或者喺 DevTools Console 睇有冇 extension 錯誤。'
    );
  }
  if (/Cannot access|The extensions gallery/i.test(m)) {
    return '呢個分頁唔准擴充功能注入（chrome:// 或擴充功能頁）。請去 merchant.mfoodapp.com 嘅財務對帳頁。';
  }
  if (/No tab with id/i.test(m)) {
    return '分頁已經關咗或換咗。請確認財務對帳頁仍然開住，再撳一次。';
  }
  if (/message port closed|disconnected/i.test(m)) {
    return (
      '財務頁嘅內容腳本收到訊息但冇回（可能係舊版腳本，或者流程拋錯就死咗）。' +
      '請重新載入擴充功能，再喺該分頁按 F5。'
    );
  }
  // ⚠️ 任何未知錯誤 → 都要畀到「F5」呢個最基本、最有效嘅下一步。
  return (
    '請喺財務分頁按 F5 重試；若仍然失敗，去 chrome://extensions 撳「重新載入」擴充功能。' +
    (m ? '（技術原因：' + m + '）' : '')
  );
}

/**
 * 把 `chrome.runtime.lastError` 統一轉成「講真話」嘅原因字串。
 *
 * 🔴 為什麼要有呢個（2026-09-28 第十二次真機）：
 *    本檔曾經有 **7 處** 同一句罐頭
 *    「內容腳本已失效（請按 F5）」—— 把所有 lastError 成因冚成一句。
 *    使用者按咗 F5 都仲見同一句 ⇒ 完全冇下一步。
 *    統一收喺呢度，任何新加嘅 sendMessage 都可以直接呼叫。
 *
 * @param {string} what 邊個動作（例如「重新掃描」「抓品項」）
 * @returns {string}
 */
function grabExplainLastError(what) {
  const raw = (chrome.runtime.lastError && chrome.runtime.lastError.message) || null;
  const m = what ? what + '失敗' : '通訊失敗';
  return m + '：' + (raw || '未知錯誤') + '｜' + grabFinanceRawHint(raw);
}

/**
 * 兼容舊呼叫端：財務相關 helper 沿用舊名。
 * @param {string|null} msg
 * @returns {string}
 */
function grabFinanceHint(msg) {
  return grabFinanceRawHint(msg);
}

/**
 * 🔴 2026-09-28 第十二次真機：呢個掣係「唔配對，先把所有訂單拿喺手」。
 *
 * 使用者原話：「不如你先不要做配對, 先把所有的訂單都先拿在手上,
 *              然後我再幫你分析好不好?」
 *
 * ⇒ route 只做一件事：把財務頁目前已攔截到嘅**全部原始資料**帶返 popup。
 * 唔配對、唔計算、唔改名、唔推 POS；亦唔會觸發任何新請求。
 *
 * 🔴 第十二次真機補強：**sendMessage 失敗時自動重新注入內容腳本再試一次**。
 *    真機實測使用者按咗 F5 都仲報「接收端唔存在」——因為：
 *      · 瀏覽器凍結／重載分頁時，舊的 content script 已死
 *      · 或者擴充功能剛更新，分頁掛住嘅係舊腳本
 *    只要**即刻重新注入**一次，就唔需要使用者理解「載入次序」呢件事。
 *    （呢個亦係「唔可以要使用者做技術判斷」原則嘅落實。）
 *
 * @param {string} type 'raw' | 'domdump' | 'forensic' | 'storeoptions' —— 決定轉發邊個訊息
 */
function grabAskFinanceTab(type, sourceKey) {
  const cfg = grabSettleCfg(sourceKey);
  // 🔴 2026-09-29：訊息型別按來源分（`MFOODFIN_` / `AOMIFIN_`），
  //    唔可以當成同一個 —— 兩支 bridge 用唔同命名空間，撞錯就靜默無回應。
  //
  // 🔴 2026-09-30：新增 `storeoptions`（讀商家下拉可揀清單）。
  //    ⚠️ 目前**只有 mfood 實作**（`MFOODFIN_STORE_OPTIONS`）——
  //    澳覓嘅商家選擇器未驗證過，所以**刻意**唔分流去 aomi，
  //    而係當成「未支援」如實回報（唔可以丟一個永遠冇人答嘅訊息過去）。
  const inner =
    type === 'raw'
      ? cfg.key === 'aomi'
        ? { type: 'AOMIFIN_RAW' }
        : { type: 'GRAB_FINANCE_RAW' }
      : type === 'domdump'
        ? { type: 'MFOODFIN_DOMDUMP' }
        : type === 'storeoptions'
          ? { type: 'MFOODFIN_STORE_OPTIONS' }
          : cfg.key === 'aomi'
            ? { type: 'AOMIFIN_PROBE' }
            : { type: 'GRAB_FINANCE_FORENSIC' };

  return grabFindFinanceTab(sourceKey).then((tab) => {
    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        reason:
          '未開啟 ' +
          cfg.label +
          ' 財務對帳頁。請開分頁去 ' +
          cfg.pageHint +
          '（登入後開住唔好閂）',
      };
    }

    const sendOnce = () =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, inner, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({
              __sendFailed: true,
              message: chrome.runtime.lastError.message || null,
            });
            return;
          }
          resolve(resp || { ok: false, reason: '財務頁沒有回應' });
        });
      });

    return sendOnce().then((first) => {
      if (!first || first.__sendFailed !== true) return first;

      // ── 第一次失敗 → 嘗試重新注入財務頁嘅兩支腳本，再試一次 ──
      return grabReinjectFinanceScripts(tab.id, sourceKey).then((inj) => {
        if (!inj.ok) return grabFinanceFailResult(tab, first.message, inj.reason);

        return sendOnce().then((second) => {
          if (second && second.__sendFailed === true) {
            return grabFinanceFailResult(tab, second.message, '重新注入後仍然無回應');
          }
          return second;
        });
      });
    });
  });
}

/**
 * 重新注入財務頁嘅內容腳本（isolated bridge ＋ MAIN world inject）。
 *
 * 🔴 2026-09-29：**按來源**揀注入邊幾支檔。
 *    mfood → `mfood-inject.js`（MAIN）＋ `mfood-finance-bridge.js`（isolated）
 *    aomi  → `aomi-inject.js`（MAIN）＋ `aomi-finance-bridge.js`（isolated）
 *
 * ⚠️ 呢個係「最後手段」：正常情況內容腳本會自己載入。
 *    佢只係為咗令使用者**唔需要理解「要重新載入擴充功能」**。
 *
 * @param {number} tabId
 * @param {string} [sourceKey] 'mfood' | 'aomi'
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function grabReinjectFinanceScripts(tabId, sourceKey) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return Promise.resolve({
      ok: false,
      reason: '擴充功能冇 scripting 權限（請重新載入擴充功能）',
    });
  }
  const isAomi = grabSettleCfg(sourceKey).key === 'aomi';
  const injectFile = isAomi ? 'aomi-inject.js' : 'mfood-inject.js';
  const bridgeFile = isAomi ? 'aomi-finance-bridge.js' : 'mfood-finance-bridge.js';
  // 🔴🔴 2026-09-28 第十四次真機：**bridge 絕對唔可以注入 MAIN world**。
  //
  //    舊寫法（第十三次）：
  //      executeScript({ files: ['mfood-finance-bridge.js', 'mfood-inject.js'],
  //                      world: 'MAIN' })
  //
  //    後果（真機紅字實證）：
  //      bridge 嘅 IIFE 第一句就係
  //        if (window.__MFOOD_FINANCE_BRIDGE_INSTALLED__) return;
  //        window.__MFOOD_FINANCE_BRIDGE_INSTALLED__ = true;
  //      而 **`window` 喺 isolated 同 MAIN world 之間係同一個物件**
  //      ⇒ MAIN world 先跑一次，把記號設為 `true`
  //      ⇒ 之後真正嘅 isolated world bridge 一跑就即刻 `return`
  //        **乜都冇註冊**（函式全部未定義）
  //      ⇒ 但舊 closure 嘅 `chrome.runtime.onMessage` listener 仍然在
  //      ⇒ 收到訊息時就叫 `onFinancePage()` ⇒
  //         「Uncaught ReferenceError: onFinancePage is not defined」
  //
  //    ⇒ 紀律：**MAIN world 只可以注入 `*-inject.js`（真正需要頁面 window 嘅那支）**；
  //      `*-bridge.js`（isolated）**永遠只可以注入成 isolated**。
  //      兩者一概分開呼叫，唔可以合成一次 `files` 陣列。
  return chrome.scripting
    .executeScript({
      target: { tabId: tabId, allFrames: false },
      // ✅ 只注入真正需要頁面 `window` 嘅那支，並且一定要 MAIN world
      files: [injectFile],
      world: 'MAIN',
      injectImmediately: true,
    })
    .then(() => {
      // ✅ bridge 係 isolated world —— 一定要獨立注入，唔可以混入上面
      return chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: false },
        files: [bridgeFile],
        // ⚠️ 刻意唔寫 `world` ⇒ 用預設（isolated）
        injectImmediately: true,
      });
    })
    .then(() => ({ ok: true }))
    .catch((e) => ({
      ok: false,
      reason: (e && e.message) || String(e),
    }));
}

/** 財務頁無回應時嘅統一錯誤物件（帶 actionable hint）。 */
function grabFinanceFailResult(tab, lastErrorMessage, extra) {
  const m = lastErrorMessage || null;
  const hint = grabFinanceRawHint(m);
  return {
    ok: false,
    // ⚠️ `reason` 本身要包含 actionable 文字 —— 唔可以只放技術原因，
    //    因為好多呼叫端（舊 popup 版本 / 日誌）只讀 `reason`。
    reason:
      '財務頁無回應：' +
      (m || extra || '未知錯誤') +
      '（分頁：' +
      String((tab && tab.url) || (tab && tab.id) || '?') +
      '）' +
      (hint ? '｜' + hint : ''),
    lastErrorMessage: m,
    reinjectReason: extra || null,
    tabId: tab ? tab.id : null,
    tabUrl: (tab && tab.url) || null,
    hint: hint,
  };
}

/**
 * 抓一次平台結算（實收），推到 POS。
 *
 * 🔴 2026-09-29：由「mfood 專用」泛化為**按來源**（支援 mfood 同澳覓）。
 *    流程完全一樣，差異全部收喺 `GRAB_SETTLE_SOURCES`：
 *      · 財務頁分頁 URL 特徵
 *      · 發去財務頁嘅訊息型別（`MFOODFIN_SYNC` / `AOMIFIN_SYNC`）
 *      · 「本店商家名」嘅 storage key
 *
 * @param {{manual?: boolean, sourceKey?: string, autoIntervalMs?: number}} opts
 *   `manual: true` ＝ 使用者按「立即對帳」，忽略低頻節流。
 *   `sourceKey` 預設 'mfood'（兼容舊呼叫）。
 */
// ==========================================================================
// 🔴🔴 2026-09-30：單一分頁對帳（唔開第二個 tab）
// --------------------------------------------------------------------------
// 用戶要求：mfood 多 tab 會搶 session，所以對帳必須喺「同一個分頁」做 ——
// 進入對帳嗰陣將單一分頁 SPA 切去財務頁、抓一次、成功先切返訂單頁。
// 期間完全停止訂單循環（busySettling 鎖 ＋ 頁面 timer pause）。
// ==========================================================================

/** 導航單一分頁去某個 URL（hash route；同一 host 唔會重開 session）。 */
function grabNavigateTab(tabId, url) {
  return new Promise(function (resolve) {
    if (!chrome.tabs || typeof chrome.tabs.update !== 'function') {
      resolve(false);
      return;
    }
    chrome.tabs.update(tabId, { url: url }, function () {
      void chrome.runtime.lastError;
      resolve(true);
    });
  });
}

/** 等分頁真正載入好（內容腳本能收訊息）。靠 GRAB_PING 探測，超時返 false。 */
function grabWaitTabReady(tabId, timeoutMs) {
  var start = Date.now();
  function probe() {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId, { type: 'GRAB_PING' }, function (r) {
        if (chrome.runtime.lastError) {
          // 🔴 收唔到回應（內容腳本未注入／分頁唔係目標頁）⇒ 唔係「等一阵就有」，
          //    重試都冇用，直接当未 ready，交返 grabSettleRetry 去 reinject 解決。
          resolve({ ok: false, definite: true });
          return;
        }
        resolve({ ok: !!(r && r.ok), definite: false });
      });
    }).then(function (res) {
      if (res.ok) return true;
      if (res.definite) return false; // 🔴 確定性失敗，唔重試（否則 tabDead 會卡 12 秒）
      if (Date.now() - start > timeoutMs) return false;
      return new Promise(function (res) {
        setTimeout(res, 500);
      }).then(probe);
    });
  }
  return probe();
}

/**
 * 單一分頁對帳：暫停訂單 → 切去財務頁 → 抓一次（最多重試 5 次）→ 切返訂單頁 → 恢復。
 * 必須成功拿到數據先切返；若 5 次都失敗，log error 後一樣切返（唔死鎖訂單）。
 */
function grabSettleSingleTab(cfg) {
  var sourceKey = cfg.key;
  var lc = GRAB_LOGIN_SOURCES[sourceKey];
  if (!lc) return Promise.resolve({ ok: false, reason: '未知來源' });

  var clearLock = function () {
    return grabGetState(sourceKey).then(function (st) {
      st.busySettling = false;
      return grabSaveState(sourceKey, st);
    });
  };

  // 🔴 單一分頁：對帳用嘅 tab 就係 orders tab 本身 —— 可以喺 order URL
  //    或者 finance URL 搵到（SPA 切換前後都係同一個 tab）。
  //    正常路徑 `grabOrderTabId` 一定搵到（訂單頁開住）；
  //    若搵唔到 orders 分頁但搵到 finance 分頁（舊測試 / 邊緣情況），
  //    退而用 finance 分頁做對帳（同一個 tab，唔可以完全唔對帳）。
  return grabOrderTabId(cfg)
    .then(function (orderTabId) {
      if (typeof orderTabId === 'number') return orderTabId;
      return grabFindFinanceTab(sourceKey).then(function (ft) {
        return ft && typeof ft.id === 'number' ? ft.id : null;
      });
    })
    .then(function (tabId) {
      if (typeof tabId !== 'number') {
        // 🔴 冇任何分頁 ⇒ 交返 grabSettlePlatform 處理：佢會寫 lastSettleError
        //    ＋ 寫錯誤日誌 ＋ 回一個含 finance pageHint 嘅 reason（講清楚開邊頁）。
        //    唔可以喺呢度自己起一個 reason —— 舊寫法就係咁漏咗錯誤日誌。
        return grabSettlePlatform({ sourceKey: sourceKey, manual: true });
      }
      // ① 暫停訂單頁自動查詢
      try {
        chrome.tabs.sendMessage(tabId, { type: 'GRAB_PAUSE_ORDERS' });
      } catch (e) {
        /* 忽略 */
      }
      // ② 單一分頁切去財務對帳頁
      return grabNavigateTab(tabId, lc.financePageUrl)
        .then(function () {
          return grabWaitTabReady(tabId, 12000);
        })
        .then(function () {
          // ③ 抓一次對帳，最多重試 5 次（每次失敗 reinject 財務腳本再試）
          return grabSettleRetry(sourceKey, tabId, 5);
        })
        .then(function (r) {
          // ④ 切返訂單頁（中途失敗都要做），並恢復訂單頁 timer
          return grabNavigateTab(tabId, lc.orderPageUrl)
            .then(function () {
              return grabWaitTabReady(tabId, 12000);
            })
            .then(function () {
              try {
                chrome.tabs.sendMessage(tabId, { type: 'GRAB_RESUME_ORDERS' });
              } catch (e) {
                /* 忽略 */
              }
              return r;
            });
        })
        .catch(function (e) {
          // 任何異常都要切返訂單頁 + 恢復，唔可以卡喺財務頁
          grabNavigateTab(tabId, lc.orderPageUrl);
          try {
            chrome.tabs.sendMessage(tabId, { type: 'GRAB_RESUME_ORDERS' });
          } catch (err) {
            /* 忽略 */
          }
          return { ok: false, reason: (e && e.reason) || (e && e.message) || '對帳失敗' };
        });
    })
    .then(
      function (r) {
        return clearLock().then(function () {
          return r;
        });
      },
      function (e) {
        return clearLock().then(function () {
          return { ok: false, reason: (e && e.reason) || (e && e.message) || '對帳失敗' };
        });
      },
    );
}

/** 對帳重試：最多 `attempts` 次，每次 grabSettlePlatform（manual 跳過節流）；失敗 reinject 財務腳本再試。 */
function grabSettleRetry(sourceKey, tabId, attempts) {
  var last = null;
  function attempt(i) {
    if (i >= attempts) {
      return Promise.resolve(last || { ok: false, reason: '對帳失敗（重試用盡）' });
    }
    return grabSettlePlatform({ sourceKey: sourceKey, manual: true }).then(function (r) {
      if (r && (r.ok || r.skipped)) return r;
      // 🔴 永久錯誤（設定問題：例如未設 Store ID、搵唔到財務頁）唔重試 ——
      //    重試都係同一個結果，只會浪費 5 次 MFOODFIN_SYNC ＋ 令錯誤回報遲 5 輪。
      //    只有「暫時性」失敗（內容腳本未就緒／網絡抖動）先值得 reinject 再試。
      if (r && r.permanent) return r;
      last = r;
      // 失敗：重新注入財務頁腳本再試
      return grabReinjectFinanceScripts(tabId, sourceKey)
        .then(function () {
          return grabWaitTabReady(tabId, 5000);
        })
        .then(function () {
          return attempt(i + 1);
        });
    });
  }
  return attempt(0);
}

function grabSettlePlatform(opts) {
  const sourceKey = (opts && opts.sourceKey) || 'mfood';
  const scfg = grabSettleCfg(sourceKey);
  const storeKey = grabSettleStoreKey(sourceKey);
  const manual = !!(opts && opts.manual);
  // 🔴🔴 第十七次真機：自動對帳（放落 timer）要用**同步間隔**做節流，
  //    唔係舊嘅 6 小時 —— 使用者原話「我 set 咗 60 秒，就 60 秒做一次立即對帳」。
  //    `manual` ＝ 撳「立即對帳」⇒ 完全唔節流。
  const autoIntervalMs =
    opts && typeof opts.autoIntervalMs === 'number' && opts.autoIntervalMs > 0
      ? opts.autoIntervalMs
      : null;

  return grabGetState(sourceKey)
    .then((state) => {
      if (!manual) {
        const last = state.lastSettleAt ? Date.parse(state.lastSettleAt) : 0;
        // 留 10% 容差（同定時查詢一致）：alarm 排程有抖動，
        // 嚴格比較會令「間隔 30 秒」實際變 60 秒。
        const minGap = autoIntervalMs
          ? Math.round(autoIntervalMs * 0.9)
          : GRAB_SETTLE_MIN_INTERVAL_MS;
        if (last && Date.now() - last < minGap) {
          return {
            ok: true,
            skipped: true,
            reason: autoIntervalMs
              ? '未到自動對帳時間（每 ' + Math.round(autoIntervalMs / 1000) + ' 秒一次）'
              : '未到對帳時間（每 6 小時一次）',
          };
        }
      }

      // 🔴🔴 2026-09-28 第九次真機（使用者截圖為證）：Store ID 明明填了，
      //    但仍報「未設定 Store ID」。真兇 ＝ **讀錯 storage key**：
      //      · popup 顯示「Store ID」嘅輸入框係 `#machineId`，
      //        佢 `change` 時寫入嘅 key 係 **`machineId`**（唔係 `storeId`）。
      //      · 但呢度舊寫法讀 **`'storeId'`** ⇒ 呢個 key **全專案冇人寫過**
      //        ⇒ 永遠讀到空 ⇒ 就算畫面填咗都照樣報「未設定」。
      //    ⇒ 正確來源係 `machineId`（同 `grabGlobalSettings()` 一致，
      //      佢就係 `storeId: res.machineId || ''`）。
      return chrome.storage.local
        .get([storeKey, 'machineId', 'startDate'])
        .then(
          (cfgStore) =>
            new Promise((resolve) => {
            grabFindFinanceTab(sourceKey).then((tab) => {
              if (!tab || typeof tab.id !== 'number') {
                resolve({
                  ok: false,
                  permanent: true,
                  reason:
                    '未開啟 ' +
                    scfg.label +
                    ' 財務對帳頁。請開一個分頁去 ' +
                    scfg.pageHint +
                    '（登入後開住唔好閂）。',
                });
                return;
              }

              // 🔴 帳期用「今日」做目標日：平台帳期係區間，命中今日嗰個就係相關帳期。
              const today = new Date();
              const pad = (n) => String(n).padStart(2, '0');
              const targetDate =
                today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

              chrome.tabs.sendMessage(
                tab.id,
                {
                  type: scfg.syncType,
                  storeName: cfgStore[storeKey] || '',
                  targetDate: targetDate,
                  // 🔴🔴 第十七次真機：一定要帶「只同步此日後」（popup `#startDate`）。
                  //    使用者原話：「我set 的時間是, 8月30日開始, 你就需要在頁面上
                  //    找到 8月30日那個月的部份…然後一直拿, 拿到最新的一天。」
                  //    ⇒ 冇呢個值，content script 只會行「命中今日」嗰一個帳期，
                  //      8 月尾嘅帳期**永遠冇人抓**（報表靜默少一大截）。
                  startDate: cfgStore.startDate || '',
                },
                (resp) => {
                  if (chrome.runtime.lastError) {
                    // 🔴 2026-09-28 第十二次真機：同樣**唔可以**一句罐頭句冚晒。
                    //    顯示真實 `lastError.message` ＋ actionable hint。
                    const m = chrome.runtime.lastError.message || null;
                    const h = grabFinanceRawHint(m);
                    resolve({
                      ok: false,
                      reason:
                        '財務頁無回應：' +
                        (m || '未知錯誤') +
                        '（分頁：' +
                        String(tab.url || tab.id) +
                        '）' +
                        (h ? '｜' + h : ''),
                      lastErrorMessage: m,
                      hint: h,
                    });
                    return;
                  }
                  if (!resp || !resp.ok) {
                    // 🔴 2026-09-28 第五次真機：404 一直查唔到係邊一步、邊條 URL。
                    //    呢度把 content script 回報嘅「實際請求 URL / body / HTTP 碼」
                    //    拼入 reason ⇒ 背景 log 一眼睇到，唔使再猜。
                    var why = (resp && resp.reason) || '財務頁沒有回應';
                    var extra = [];
                    if (resp && resp.requestUrl) extra.push('URL ' + resp.requestUrl);
                    if (resp && resp.requestStatus) extra.push('碼 ' + resp.requestStatus);
                    if (resp && resp.step) extra.push('步驟 ' + resp.step);
                    // 🔴 2026-09-28 第六次真機：`Failed to fetch` 真兇係「冇簽章標頭」。
                    //    一定要喺 log 講明，否則又係一輪盲查。
                    if (resp && typeof resp.hasSignature === 'boolean') {
                      extra.push(resp.hasSignature ? '有簽章' : '⚠️冇簽章標頭');
                    }
                    if (resp && (resp.mainWorldTemplate === false || resp.hadBodyTemplate === false)) {
                      extra.push('⚠️MAIN world 冇請求範本');
                    }
                    if (extra.length) why += ' 〔' + extra.join('、') + '〕';
                    resolve({
                      ok: false,
                      reason: why,
                      requestUrl: (resp && resp.requestUrl) || null,
                      requestStatus: (resp && resp.requestStatus) || null,
                      requestBody: (resp && resp.requestBody) || null,
                      hasSignature:
                        resp && typeof resp.hasSignature === 'boolean' ? resp.hasSignature : null,
                      mainWorldTemplate:
                        resp && typeof resp.mainWorldTemplate === 'boolean'
                          ? resp.mainWorldTemplate
                          : null,
                      hadBodyTemplate:
                        resp && typeof resp.hadBodyTemplate === 'boolean'
                          ? resp.hadBodyTemplate
                          : null,
                      step: (resp && resp.step) || null,
                    });
                    return;
                  }
                  const txns = Array.isArray(resp.transactions) ? resp.transactions : [];
                  // 🔴 2026-09-28 第七次真機：帳期級金額（平台 `summary/_list` 回應本身就有）。
                  //    呢三個數 = POS 報表要嘅「應收／實收／差額率」。
                  const periodAmounts =
                    typeof resp.receive === 'number' || typeof resp.should === 'number'
                      ? {
                          period: resp.period || null,
                          should: typeof resp.should === 'number' ? resp.should : null,
                          receive: typeof resp.receive === 'number' ? resp.receive : null,
                          // 🔴🔴 2026-09-28 第十次真機：一定要帶 `subsidy`！
                          //    POS 端「實際到帳」口徑係**補貼後優先**
                          //    （`periodPayout()`：有 subsidy 用 subsidy，否則落返 receive）。
                          //    舊寫法漏咗呢欄 ⇒ 永遠送 null ⇒ POS 用「補貼前」⇒
                          //    報表金額**偏多**（商家以為平台食少咗）。
                          //    bridge 一直有產生 `subsidy`，只係呢度冇轉發。
                          subsidy: typeof resp.subsidy === 'number' ? resp.subsidy : null,
                          fee: typeof resp.fee === 'number' ? resp.fee : null,
                          receiveKey: resp.receiveKey || null,
                          via: resp.amountsVia || null,
                          details: Array.isArray(resp.details) ? resp.details : [],
                        }
                      : null;

                  // ══════════════════════════════════════════════════════
                  //  🔴🔴🔴 第十七次真機：**逐帳期**推送（唔可以撈埋一份）
                  // ══════════════════════════════════════════════════════
                  //
                  //  舊寫法：所有帳期嘅 transactions 撈埋一個 array ＋
                  //          只帶「第一個帳期」嘅 `periodAmounts` 送一次。
                  //
                  //  死穴：POS 嘅 `pos_platform_settlements` 係以
                  //        `(store_id, source, period)` 做 upsert key ⇒
                  //        **一次請求只會寫一個帳期**。
                  //        8 月、9 月兩個帳期撈埋一齊送，結果得返最新嗰個有數，
                  //        歷史帳期**靜默消失**（睇落有數，其實少咗一大截 ——
                  //        同第十六次「每頁 20 筆」係同一類病）。
                  //
                  //  ⇒ 有 `resp.periods[]` 就逐個 push；冇（舊版 content script）
                  //    先跌返「一次過送」。
                  const periodList = Array.isArray(resp.periods) ? resp.periods : [];
                  const pushes = [];

                  function amountsOf(p) {
                    if (!p) return null;
                    const has =
                      typeof p.receive === 'number' ||
                      typeof p.should === 'number' ||
                      typeof p.subsidy === 'number';
                    if (!has) return null;
                    return {
                      period: p.period || null,
                      should: typeof p.should === 'number' ? p.should : null,
                      receive: typeof p.receive === 'number' ? p.receive : null,
                      subsidy: typeof p.subsidy === 'number' ? p.subsidy : null,
                      fee: typeof p.fee === 'number' ? p.fee : null,
                      receiveKey: p.receiveKey || null,
                      via: p.amountsVia || null,
                      details: Array.isArray(p.details) ? p.details : [],
                    };
                  }

                  if (periodList.length) {
                    periodList.forEach((p) => {
                      const pTxns = Array.isArray(p && p.transactions) ? p.transactions : [];
                      const pAmounts = amountsOf(p);
                      // 完全冇嘢嘅帳期唔好浪費一次請求（多數係「未結算」）
                      if (!pTxns.length && !pAmounts) return;
                      pushes.push({
                        transactions: pTxns,
                        amounts: pAmounts,
                        period: (p && p.period) || null,
                      });
                    });
                  }
                  if (!pushes.length && (txns.length || periodAmounts)) {
                    // 舊版 content script（冇 `periods[]`）⇒ 一次過送，保持相容
                    pushes.push({
                      transactions: txns,
                      amounts: periodAmounts,
                      period: resp.period || null,
                    });
                  }

                  if (!pushes.length) {
                    // 帳期存在但冇單、又冇帳期級金額 ⇒ 正常（可能今日未有已結算單），唔算失敗。
                    resolve({ ok: true, pushed: 0, reason: '帳期內冇 transaction', tabId: tab.id });
                    return;
                  }

                  // 🔴🔴 第十七次真機：實收對照表（`tradeNo → 實收金額`）。
                  //    popup「擷取到的訂單」要喺價格下面加一行「實收價格」，
                  //    資料來源就係呢度（逐筆 `tradeNo` 配對，唔使再問平台）。
                  const map = {};
                  const allTxns = [];
                  pushes.forEach((it) => {
                    (it.transactions || []).forEach((t) => {
                      allTxns.push(t);
                      const no = String((t && t.tradeNo) || '').trim();
                      if (!no) return;
                      map[no] = {
                        // 🔴 口徑同 POS 一致：**補貼後優先**
                        //    （有 `subsidyStoreReceiveAmtn` 用佢，否則落返 `storeReceiveAmtn`）
                        //
                        // 🔴🔴 2026-09-29 澳覓：澳覓**冇** `subsidy*` 兩段口徑，
                        //    佢嘅 bridge 已經把 `costAmount`（分）÷100 成 `netAmount`。
                        //    舊寫法只認 mfood 嘅欄位名 ⇒ 澳覓每一筆都係 `receive: null`
                        //    ⇒ popup「實收價格」永遠顯示「待對帳」
                        //      （明明對帳成功，商家見到嘅卻係未對帳 —— 最易被誤解成 bug 嘅一種）。
                        //    ⇒ 加 `netAmount` 做最後一級 fallback（澳覓）。
                        //    ⚠️ 一定要**排在 mfood 欄位之後**：澳覓 payload 唔會有 mfood 欄位，
                        //      反過嚟 mfood payload 亦唔會有 `netAmount` ⇒ 兩者唔會互相蓋過。
                        receive:
                          typeof t.subsidyStoreReceiveAmtn === 'number'
                            ? t.subsidyStoreReceiveAmtn
                            : typeof t.storeReceiveAmtn === 'number'
                              ? t.storeReceiveAmtn
                              : typeof t.netAmount === 'number'
                                ? t.netAmount
                                : null,
                        // 未扣補貼／平台前嘅「營業額」口徑（對帳參考用）
                        gross:
                          typeof t.storeReceiveAmtn === 'number'
                            ? t.storeReceiveAmtn
                            : typeof t.grossAmount === 'number'
                              ? t.grossAmount
                              : null,
                        subsidy:
                          typeof t.subsidyStoreReceiveAmtn === 'number'
                            ? t.subsidyStoreReceiveAmtn
                            : null,
                        business:
                          typeof t.storeBusinessAmtn === 'number'
                            ? t.storeBusinessAmtn
                            : typeof t.turnoverAmount === 'number'
                              ? t.turnoverAmount
                              : null,
                        fee: typeof t.platformServiceFee === 'number' ? t.platformServiceFee : null,
                        period: it.period,
                        at: new Date().toISOString(),
                      };
                    });
                  });

                  // 串行推送（一次一個帳期），避免同時打 POS 令佢當係重複請求。
                  const agg = {
                    ok: false,
                    permanent: false,
                    pushed: 0,
                    orders: 0,
                    updated: 0,
                    notFound: [],
                    unmatchedCount: 0,
                    periods: [],
                    failedPeriods: [],
                    firstReason: null,
                  };
                  let pi = 0;
                  function pushNext() {
                    if (pi >= pushes.length) {
                      const okCount = agg.periods.length;
                      resolve(
                        Object.assign({
                          ok: okCount > 0,
                          permanent: agg.permanent,
                          tabId: tab.id,
                          period: resp.period || (pushes[0] && pushes[0].period) || null,
                          via: resp.summaryIdVia || null,
                          source: resp.source || null,
                          pushed: agg.pushed,
                          orders: agg.orders,
                          updated: agg.updated,
                          notFound: agg.notFound,
                          unmatchedCount: agg.unmatchedCount,
                          // 🔴🔴 第十七次真機：逐帳期結果要外露（popup 要顯示「邊個帳期寫咗幾多」）
                          periodsPushed: agg.periods,
                          periodPushedCount: okCount,
                          failedPeriods: agg.failedPeriods,
                          reason:
                            okCount > 0
                              ? agg.failedPeriods.length
                                ? agg.failedPeriods.length + ' 個帳期推送失敗：' +
                                  (agg.failedPeriods[0].reason || '未知')
                                : null
                              : agg.firstReason || '所有帳期都推送失敗',
                          // 實收對照表（popup 顯示「實收價格」用）
                          settleMap: map,
                          // 🔴🔴 第十六次真機：「抄到幾多 / 平台話有幾多」
                          grabbed: allTxns.length,
                          grabbedTotal:
                            typeof resp.transactionsTotal === 'number'
                              ? resp.transactionsTotal
                              : null,
                          grabbedComplete: !!resp.transactionsComplete,
                          receive: periodAmounts ? periodAmounts.receive : null,
                          should: periodAmounts ? periodAmounts.should : null,
                          fee: periodAmounts ? periodAmounts.fee : null,
                          amountsVia: periodAmounts ? periodAmounts.via : null,
                        }),
                      );
                      return;
                    }
                    const item = pushes[pi++];
                    // 原樣送去 POS（平台欄位名），POS 端負責改名同配對。
                    // 🔴🔴 第九次真機：Store ID 要讀 `cfgStore.machineId`
                    grabPushSettlement(sourceKey, item.transactions, cfgStore.machineId || '', item.amounts).then(
                      (r) => {
                        if (r && r.ok) {
                          agg.pushed += r.pushed || 0;
                          agg.orders += r.orders || 0;
                          agg.updated += r.updated || 0;
                          agg.notFound = agg.notFound.concat(r.notFound || []);
                          agg.unmatchedCount += r.unmatchedCount || 0;
                          agg.periods.push({
                            period: item.period,
                            pushed: r.pushed || 0,
                            updated: r.updated || 0,
                          });
                        } else {
                          if (!agg.firstReason) agg.firstReason = (r && r.reason) || '未知';
                          agg.permanent = agg.permanent || !!(r && r.permanent);
                          agg.failedPeriods.push({
                            period: item.period,
                            reason: (r && r.reason) || '未知',
                          });
                        }
                        return pushNext();
                      },
                    );
                  }
                  pushNext();
                },
              );
            });
          }),
      );
    })
    .then((r) => {
      // 記低結果（成敗都要記 —— 靜默失敗係最難查嘅一種）
      return grabGetState(sourceKey).then((s) => {
        s.lastSettleAt = new Date().toISOString();
        s.lastSettleError = r && r.ok ? null : (r && r.reason) || '未知';
        // 🔴🔴 第十七次真機：**實收對照表**（`tradeNo → 實收金額`）。
        //    popup「擷取到的訂單」每張單下面嗰行「實收價格」就係讀呢度。
        //    一定要**累積**（唔可以覆寫）：一次同步淨係行最新嗰個帳期，
        //    覆寫會令上一輪抄返嚟嘅舊單「實收價格」消失。
        if (r && r.settleMap && Object.keys(r.settleMap).length) {
          s.settleMap = grabMergeSettleMap(s.settleMap, r.settleMap);
        }
        s.lastSettleResult = r
          ? {
              ok: !!r.ok,
              skipped: !!r.skipped,
              pushed: r.pushed || 0,
              updated: r.updated || 0,
              // 🔴 第十七次真機：寫咗幾個帳期（多帳期走訪後唔止一個）
              periodCount:
                typeof r.periodPushedCount === 'number' ? r.periodPushedCount : null,
              failedPeriods: (r.failedPeriods || []).slice(0, 10),
              // 🔴 第十六次真機：抄到幾多 / 平台話有幾多（debug 用）
              grabbed: typeof r.grabbed === 'number' ? r.grabbed : null,
              grabbedTotal: typeof r.grabbedTotal === 'number' ? r.grabbedTotal : null,
              grabbedComplete: !!r.grabbedComplete,
              notFound: (r.notFound || []).length,
              reason: r.reason || null,
              // 🔴 帳期 id 來源（network-event / network-ask / periods-map / dom）
              summaryIdVia: r.via || null,
              // 🔴 2026-09-28 第五次真機：失敗時嘅實際請求證據
              requestUrl: r.requestUrl || null,
              requestStatus: r.requestStatus || null,
              requestBody: r.requestBody || null,
            }
          : null;
        return grabSaveState(sourceKey, s).then(() => r);
      });
    })
    .then((r) => {
      // 🔴 2026-09-26 補：**一定要寫入 popup 可見嘅日誌**。
      //    原本只有 `lastSettleError` 落 state，但 popup 日誌面板係睇 `mfoodLog`，
      //    ⇒ 對帳失敗喺日誌面板完全隱形（正是使用者最介意嘅靜默失敗）。
      //    （測試 [65] 捉到：冇財務頁時 lastSettleError 有值，但 mfoodLog 一片空白。）
      if (r && r.skipped) return r; // 節流跳過唔需要污染日誌
      let summary;
      let level = 'info';
      if (!r || !r.ok) {
        level = 'error';
        summary = '平台對帳失敗：' + ((r && r.reason) || '未知');
      } else if (!r.pushed) {
        summary = '平台對帳：帳期內未有已結算交易（正常）';
      } else {
        summary = '平台對帳：推送 ' + r.pushed + ' 筆，更新 ' + (r.updated || 0) + ' 張單';
        // 🔴🔴 第十六次真機：抄唔齊一定要**寫落日誌**（唔可以淨係靠 popup 一閃）。
        //    呢句就係「平台 32 筆、我只抄到 20」嘅唯一警報。
        if (typeof r.grabbed === 'number' && typeof r.grabbedTotal === 'number' && r.grabbed < r.grabbedTotal) {
          summary += ' ⚠️ 只抄到 ' + r.grabbed + ' / 平台 ' + r.grabbedTotal + ' 筆（未齊！）';
        }
        if (r.notFound && r.notFound.length) {
          summary += '，' + r.notFound.length + ' 筆配對唔到 POS 訂單';
        }
        // 🔴 記錄帳期 id 來源（2026-09-28：改網絡攔截後新增）——
        //    方便日後排查「究竟靠邊條路成功」。
        if (r.via) summary += '（id 來源 ' + r.via + '）';
      }
      return grabAppendLog(
        { key: sourceKey },
        {
          level: level,
          kind: sourceKey + '_settle',
          summary: summary,
          detail: {
            ok: !!(r && r.ok),
            pushed: (r && r.pushed) || 0,
            updated: (r && r.updated) || 0,
            notFound: ((r && r.notFound) || []).length,
            reason: (r && r.reason) || null,
            summaryIdVia: (r && r.via) || null,
            // 🔴 失敗時嘅實際請求證據（URL / HTTP 碼 / body 摘要）
            requestUrl: (r && r.requestUrl) || null,
            requestStatus: (r && r.requestStatus) || null,
            requestBody: (r && r.requestBody) || null,
          },
        },
      ).then(() => r);
    });
}

/**
 * 兼容舊呼叫：`grabSettleMfood(opts)` ＝ `grabSettlePlatform({...opts, sourceKey:'mfood'})`。
 *
 * 🔴 保留呢個 alias 而唔係全部改成新名，係因為測試 harness 會 `vm` 執行
 *    本檔後直接呼叫 `grabSettleMfood`（見 test/background-router.test.cjs）。
 *    改名會令一堆既有測試紅，而佢哋驗嘅行為完全冇變。
 */
function grabSettleMfood(opts) {
  return grabSettlePlatform(Object.assign({}, opts || {}, { sourceKey: 'mfood' }));
}

/** 澳覓對帳（2026-09-29 新增）。 */
function grabSettleAomi(opts) {
  return grabSettlePlatform(Object.assign({}, opts || {}, { sourceKey: 'aomi' }));
}

/**
 * 推結算資料去 POS（`/api/integration/grabber/settlement`）。
 *
 * ⚠️ 同 `grabPush()` 分開：唔同 endpoint、唔同 payload 形狀、語意係 UPDATE 唔係 INSERT。
 *    但驗簽／storeId 檢查／失敗回報嘅規矩完全一樣。
 *
 * 🔴 2026-09-28 第七次真機：新增 `periodAmounts`（帳期級金額，可選）。
 *
 *   為什麼要有佢：使用者要嘅 POS 報表三格（應收／實收／差額率）係**帳期級**數字，
 *   同「逐筆 transaction」係兩個層次嘅嘢。而平台載入財務頁時自己發嘅
 *   `summary/_list` 回應**本身就已經有齊呢三個數**（`subsidyStoreReceiveAmtn`
 *   等）⇒ 我哋搭便車抄低就可以，唔需要重放任何請求。
 *
 *   ⇒ 呢度把佢一併送去 POS（POS 端按同一個 storeId 更新報表）。
 *     即使 `transactions` 為空（例如帳期已結算、明細唔再發），只要
 *     `periodAmounts` 有值，呢次同步仍然係**有價值**嘅，唔應該當「冇 transaction」。
 *
 * @param {string} sourceKey 'mfood' | 'aomi' | ...
 * @param {Array} transactions 逐筆 transaction（可以係空陣列，若 periodAmounts 有值）
 * @param {string} storeId
 * @param {{receive?:number, should?:number, fee?:number, period?:string, receiveKey?:string, via?:string, details?:Array}} [periodAmounts]
 */
function grabPushSettlement(sourceKey, transactions, storeId, periodAmounts) {
  if (POS_SHARED_SECRET === 'FILL_ME_WHEN_POS_API_IS_READY') {
    return Promise.resolve({
      ok: false,
      reason: '系統尚未設定 POS 密鑰（請見 background.js 的 POS_SHARED_SECRET）',
    });
  }
  if (!storeId) {
    return Promise.resolve({
      ok: false,
      permanent: true,
      reason: '未設定 Store ID：請喺 popup「店家設定」填入並按一下旁邊空白處（要失焦才會儲存）',
    });
  }
  // 🔴 空陣列本身唔算錯 —— 只要帳期級金額有值，就係一次成功嘅取數。
  const hasAmounts =
    periodAmounts &&
    (typeof periodAmounts.receive === 'number' || typeof periodAmounts.should === 'number');
  if (!Array.isArray(transactions) || (transactions.length === 0 && !hasAmounts)) {
    return Promise.resolve({ ok: false, reason: 'grabPushSettlement 需要非空陣列（呼叫端 bug）' });
  }

  const headers = { 'Content-Type': 'application/json' };
  headers['X-Grabber-Secret'] = POS_SHARED_SECRET;

  return fetch(POS_SETTLEMENT_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: sourceKey,
      clientVersion: chrome.runtime.getManifest().version,
      capturedAt: new Date().toISOString(),
      storeId: storeId,
      transactions: transactions || [],
      // 🔴 帳期級金額（POS 報表三格用）。舊版 POS 會忽略呢個欄位，唔會壞。
      //    ⚠️ `subsidy` 一定要傳：POS 嘅「實際到帳」口徑係**補貼後優先**
      //    （`periodPayout()`：有 subsidy 用 subsidy，否則落返 receive）。
      //    唔傳就等於永遠報「補貼前」嘅實收 —— 數字偏多，商家以為平台食少咗。
      periodAmounts: hasAmounts
        ? {
            period: periodAmounts.period || null,
            should: typeof periodAmounts.should === 'number' ? periodAmounts.should : null,
            receive: typeof periodAmounts.receive === 'number' ? periodAmounts.receive : null,
            subsidy: typeof periodAmounts.subsidy === 'number' ? periodAmounts.subsidy : null,
            fee: typeof periodAmounts.fee === 'number' ? periodAmounts.fee : null,
            receiveKey: periodAmounts.receiveKey || null,
            via: periodAmounts.via || null,
            details: Array.isArray(periodAmounts.details) ? periodAmounts.details : [],
          }
        : null,
    }),
  })
    .then((r) =>
      r.text().then((text) => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch (e) {
          body = null;
        }
        if (!r.ok) {
          // 🔴 404 通常 ＝ POS 版本未部署呢條 route（或者未跑 migration）。
          //    講清楚，唔好令商家以為係自己設定錯。
          const hint =
            r.status === 404
              ? '（POS 未部署結算端點，請先部署 macau-pos）'
              : r.status === 500
                ? '（可能未跑 migration 0060）'
                : '';
          return { ok: false, reason: `HTTP ${r.status}${hint}: ${text.slice(0, 200)}` };
        }
        if (!body || body.ok !== true) {
          return { ok: false, reason: (body && body.error) || 'POS 回應格式異常' };
        }
        return {
          ok: true,
          pushed: body.received || 0,
          orders: body.orders || 0,
          updated: body.updated || 0,
          notFound: body.notFound || [],
          unmatchedCount: body.unmatchedCount || 0,
        };
      }),
    )
    .catch((e) => ({ ok: false, reason: '網絡錯誤：' + ((e && e.message) || e) }));
}

/**
 * 存活探測（2026-09-25）：問該後台分頁「你仲喺度嗎？」
 *
 * ## 為何唔可以用「有冇新訂單」判斷頁面死活
 * 店冇新單時頁面照樣健康，但 `lastListCaptureAt` 唔會更新
 * ⇒ 10 分鐘後誤報「冇收到資料，請確認後台分頁仍開著且未被登出」（使用者實案）。
 *
 * 回得到 = 內容腳本活住 ⇒ 寫 `lastAliveAt`（popup 用嚟分辨
 * 「頁面正常、只係冇新單」同「真係收唔到嘢」）。
 * 回唔到（`chrome.runtime.lastError`）＝內容腳本已死 ⇒ 交返畀現有嘅自動重載救援。
 */
function grabProbeLiveness(cfg) {
  return grabGetState(cfg.key)
    .then(
      (state) =>
        new Promise((resolve) => {
          if (typeof state.tabId !== 'number') {
            resolve(false);
            return;
          }
          chrome.tabs.sendMessage(state.tabId, { type: 'GRAB_PING' }, (r) => {
            if (chrome.runtime.lastError) {
              resolve(false);
              return;
            }
            resolve(!!(r && r.ok));
          });
        }),
    )
    .then((alive) => {
      if (!alive) return false;
      return grabGetState(cfg.key).then((s2) => {
        s2.lastAliveAt = new Date().toISOString();
        return grabSaveState(cfg.key, s2).then(() => true);
      });
    });
}

function grabSetAllAutomation(enabled) {
  return Promise.all(
    grabSourceList().map((cfg) =>
      grabSaveSettings(
        cfg.key,
        enabled
          ? { autoRefresh: true, autoFetchDetails: true }
          // 🔴 2026-10-02：停止時一定要一齊關 autoSettle。
          //    舊寫法只關 autoRefresh/autoFetchDetails ⇒ grabAutoTick 嘅對帳累加器
          //    依賴 autoSettle（唔理 autoRefresh），令「停止」後 30 分鐘照樣觸發對帳。
          : { autoRefresh: false, autoFetchDetails: false, autoSettle: false },
      ),
    ),
  ).then(() => ({ ok: true, enabled: enabled, sources: grabSourceList().length }));
}

/**
 * 清空所有來源的訂單與品項。
 *
 * 只清 state.orders —— 去重記錄（seen）刻意保留：
 * 若連 seen 一起清，下一輪會把同一批單當成全新的再送一次，
 * 造成重複出單。使用者若真的要重送，另有「清除去重記錄」可按。
 */
function grabClearAllOrders() {
  return Promise.all(
    grabSourceList().map((cfg) =>
      grabGetState(cfg.key).then((state) => {
        const n = Object.keys(state.orders || {}).length;
        state.orders = {};
        // 🔴 名冊也要一起清 —— 否則「清除所有訂單」之後，
        //    那些單會因為名冊說「抓過品項」而永遠不再抓。
        state.detailDone = {};
        state.lastDetailCaptureAt = null;
        return grabSaveState(cfg.key, state).then(() =>
          grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_cleared`,
            summary: `已清除 ${n} 筆訂單與品項，並重設「已抓過品項」名冊（去重記錄保留）`,
            detail: { cleared: n },
          }),
        );
      }),
    ),
  ).then(() => ({ ok: true }));
}

// 頁面多久沒回報就視為卡住（秒）。至少 60 秒，或 3 個週期。
function grabStaleAfterMs(intervalSecs) {
  const eff = Math.max(5, Number(intervalSecs) || 60);
  return Math.max(60, eff * 3) * 1000;
}

// 兩次自動重載之間至少間隔多久，避免無限重載
const GRAB_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * 自動復原：頁面太久沒回報就重新載入它。
 *
 * 為什麼由背景做：內容腳本若已失效（例如擴充功能剛重新載入、
 * 分頁還沒 F5），它是「死」的 —— 收不到任何訊息、也無法自己救援。
 * 但 chrome.tabs.reload 是背景的能力，不需要內容腳本配合，
 * 所以即使分頁處於孤兒狀態也救得回來。
 */
function grabMaybeRecover(cfg, intervalSecs) {
  // 🔴 一定要一齊讀「專用冷卻時間戳」（見 grabReloadKey 註釋）——
  //    state 版本會被其他 state 寫入覆蓋，令冷卻期失效而無限 reload。
  return Promise.all([
    grabGetSettings(cfg.key),
    grabGetState(cfg.key),
    grabGetLastReloadAt(cfg.key),
  ]).then(([s, st, lastReloadIso]) => {
    if (!s.autoRefresh) return undefined; // 沒開自動就不主動介入
    if (s.autoReload === false) return undefined; // 使用者可關掉
    if (typeof st.tabId !== 'number') return undefined; // 沒有分頁可救

    const last = st.lastListCaptureAt ? Date.parse(st.lastListCaptureAt) : 0;
    if (last && Date.now() - last < grabStaleAfterMs(intervalSecs)) return undefined;

    // 取兩者較新嗰個：專用 key（權威）＋ state 欄位（舊資料／顯示用）。
    const lastReload = Math.max(
      st.lastAutoReloadAt ? Date.parse(st.lastAutoReloadAt) || 0 : 0,
      lastReloadIso ? Date.parse(lastReloadIso) || 0 : 0,
    );
    if (lastReload && Date.now() - lastReload < GRAB_RELOAD_COOLDOWN_MS) return undefined;

    const mins = last ? Math.round((Date.now() - last) / 60000) : null;

    /**
     * 🔴 2026-09-25 使用者要求：**唔可以「資料過期就 F5」**。
     *
     * 頁面仲活住嘅話，更新內容嘅正確做法係**按「查詢」**，唔係重新載入整個頁面。
     * 實案：澳覓每 3.5 分鐘被 reload 一次，但頁面根本冇壞
     *（內容腳本答得到 ping）⇒ 純騷擾 + 白費 + 打斷商家操作。
     *
     * ⇒ 只有「內容腳本真係死咗」（存活探測冇回應）才用 F5 救援。
     */
    return grabProbeLiveness(cfg).then((alive) => {
      if (alive) return undefined;
      return new Promise((resolve) => {
        chrome.tabs.reload(st.tabId, {}, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }).then(() =>
      grabGetState(cfg.key).then((s2) => {
        const reloadedAt = new Date().toISOString();
        s2.lastAutoReloadAt = reloadedAt;
        s2.counters.autoReloads = (s2.counters.autoReloads || 0) + 1;
        // 🔴 次序好緊要：**先寫 state**（維持原本時序，唔好延遲佢 ——
        //    同一個 tick 仲有 rescan／詳情派工會寫 state，延遲就會被舊快照覆蓋），
        //    寫完先補寫專用 key（冷卻期嘅真源，見 grabReloadKey 註釋）。
        return grabSaveState(cfg.key, s2)
          .then(() => grabSetLastReloadAt(cfg.key, reloadedAt))
          .then(() =>
          grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_auto_reload`,
            summary:
              mins === null
                ? '尚未收到任何回報，已自動重新載入頁面'
                : `已 ${mins} 分鐘沒有回報，已自動重新載入頁面`,
            detail: { tabId: st.tabId, lastListCaptureAt: st.lastListCaptureAt },
          }),
        );
      }),
      );
    });
  });
}

/** 把「同步間隔」推給該來源的內容腳本（讓它自己計時，可低於 30 秒） */
function grabPushInterval(cfg, secs) {
  return grabGetState(cfg.key).then(
    (state) =>
      new Promise((resolve) => {
        if (typeof state.tabId !== 'number') {
          resolve({ ok: false, reason: '尚未偵測到分頁' });
          return;
        }
        chrome.tabs.sendMessage(state.tabId, { type: 'GRAB_SET_INTERVAL', secs: secs }, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: grabExplainLastError('設定自動刷新間隔') });
            return;
          }
          resolve(r || { ok: false });
        });
      }),
  );
}

// ─────────────────────────────────────────────────────────────
// 測試用假訂單：隨機生成器（v1.39）
// ─────────────────────────────────────────────────────────────
//
// 為何要隨機？
//   固定樣本只驗得到**一條**路徑。真實單會變嘅嘢好多 —— 品項數、加購、
//   餐盒／膠袋費、商家優惠種類、配送方式、生命週期、下單時間。
//   全部寫死 = 一遇到「有優惠嘅單」「自取單」「四件菜嘅單」就即刻盲。
//   更嚴重係：**假資料會掩蓋真 bug** —— 2026-09-24 就係因為假單寫咗
//   `storeSeqNo`（真 bridge 根本冇發呢個名），令「澳覓真單單號對唔上」冇被發現。
//
// 🔴 唯一硬約束：**金額必須自洽**。
//    POS 收據有「對帳」邏輯：原價合計 + 費用 − 優惠合計 === 總金額。
//    亂填數字會令收據多出一行神秘嘅兜底行（「外送費／餐盒費」）。
//    兩個平台嘅官方公式（由真實單據反推）：
//      澳覓  營業額 = 菜品 + 餐盒 + 膠袋 + 節假日服務費 + 配送費(商家)
//                     − 配送費商家減免 − 商家活動支出
//      mfood 營業額 = 菜品 + 打包 + 膠袋 + 服務費 − 代金券 − 滿減 − 月卡紅包
//    ⚠️ 本店冇「配送費(商家)」→ 該項固定 0（使用者確認）。
//
// 另：`grabPush()` 要**非空陣列**，所以一次只少一張。

/** 真實 payload 見過嘅菜名。**唔好作新名**，否則睇落唔真實、亦驗唔到嘢。 */
var FAKE_DISHES = [
  { code: 'F7', name: 'F7.牛肉炒时菜', base: 52, specs: ['西兰花', '西芹', '芥蘭', '走青'], addons: [] },
  { code: 'Z5', name: 'Z5.表嫂酸菜魚', base: 198, specs: ['生魚', '鱸魚', '小辣', '中辣', '大辣'], addons: [] },
  { code: 'A17', name: 'A17.紅燒肉碎燜茄子', base: 51, specs: ['少油', '多汁', '走肉'], addons: [] },
  { code: 'A03', name: '表嫂手打肉餅', base: 58, specs: ['馬蹄', '米飯', '奶茶', '蒸'], addons: [['轉五谷飯', 5], ['加蒸蛋', 4]] },
  { code: 'F2', name: 'F2.陳皮蒸肉餅', base: 46, specs: ['白飯', '油飯', '走鹽'], addons: [['加蛋', 4]] },
  { code: 'Z1', name: 'Z1.酸菜魚（小）', base: 128, specs: ['生魚', '小辣', '中辣'], addons: [] },
  { code: 'V3', name: 'V3.蒜蓉炒時蔬', base: 38, specs: ['菜心', '芥蘭', '生菜', '通菜'], addons: [] },
  { code: 'S2', name: 'S2.雙人套餐', base: 238, specs: ['A餐', 'B餐'], addons: [] },
  { code: 'R1', name: 'R1.白灼蝦', base: 88, specs: ['中蝦', '大蝦'], addons: [] },
  { code: 'D1', name: 'D1.例湯', base: 22, specs: ['老火湯', '清湯'], addons: [] },
  { code: 'B4', name: 'B4.凍檸茶', base: 20, specs: ['少冰', '少甜', '走甜', '多冰'], addons: [['加大', 3]] },
  { code: 'B5', name: 'B5.絲襪奶茶', base: 22, specs: ['少冰', '熱', '凍'], addons: [] },
  { code: 'G1', name: 'G1.咖喱牛腩飯', base: 58, specs: ['小辣', '中辣', '走洋蔥'], addons: [['加腩', 12]] },
  { code: 'G2', name: 'G2.干炒牛河', base: 62, specs: ['少油', '多芽菜', '加辣'], addons: [] },
  { code: 'P1', name: 'P1.椒鹽鮮魷', base: 78, specs: ['大份', '小份'], addons: [] },
  { code: 'M2', name: 'M2.馬介休球', base: 45, specs: [], addons: [] },
  { code: 'K9', name: 'K9.葡式焗鴨飯', base: 72, specs: ['少飯', '多汁'], addons: [] },
  { code: 'J4', name: 'J4.豉椒炒蜆', base: 68, specs: ['小辣', '走蒜'], addons: [] },
];

/** 澳覓顧客（後台只給遮罩電話，唔可以發明完整號碼）。 */
var FAKE_AOMI_CUSTOMERS = [
  { nickname: 'penny', phoneMasked: '853-****3949', address: '媽閣廟（澳門半島） 水手里嘉安閣1樓b座' },
  { nickname: '阿強', phoneMasked: '853-****1177', address: '氹仔 花城公園 牡丹花園第3座' },
  { nickname: 'May', phoneMasked: '853-****5021', address: '新口岸 冼星海大馬路 珠光大廈8樓C' },
  { nickname: '老陳', phoneMasked: '853-****8340', address: '黑沙環 東北大馬路 海名居第2座' },
  { nickname: 'Carmen', phoneMasked: '853-****6612', address: '荷蘭園 正街 永康大廈3樓A' },
  { nickname: '小林', phoneMasked: '853-****9902', address: '沙梨頭 巴波沙大馬路 萬利大廈1樓D' },
  { nickname: 'Wilson', phoneMasked: '853-****4471', address: '路氹 金光大道 星匯豪庭第5座' },
];

/** mfood 顧客（mfood 給嘅係完整號碼 —— 呢度**故意用假號碼**，唔可以抄真實個資）。 */
var FAKE_MFOOD_CUSTOMERS = [
  { name: '葉小姐', nickname: 'Christine', phone: '853-62****65', address: null },
  { name: '李先生', nickname: 'Aming', phone: '853-66****12', address: '氹仔 海洋花園 丁香苑7樓G' },
  { name: '黃太', nickname: 'WongTai', phone: '853-63****88', address: '台山 巴波沙坊 好景大廈4樓B' },
  { name: '張先生', nickname: 'Cheong', phone: '853-66****30', address: '筷子基 宏開大廈第1座' },
  { name: '何小姐', nickname: 'HoHo', phone: '853-62****77', address: null },
  { name: '周先生', nickname: 'Chow', phone: '853-63****54', address: '下環街 福德新邨3樓A' },
];

/** 澳覓生命週期（ASCII enum 一定要含 `ORDER`、且唔可以含 CANCEL／REFUND，才會當 active）。 */
var FAKE_AOMI_STATES = [
  { e: 'ORDER_ARRIVED', r: '客戶已確認收餐' },
  { e: 'ORDER_FINISHED', r: '訂單已完成' },
  { e: 'ORDER_SENDED', r: '騎手已取餐' },
  { e: 'ORDER_ACCEPT', r: '商家已接單' },
];

/**
 * 配送方式。
 * ⚠️ 只有 `ZHUANSONG`（澳覓專送）係**實際觀察到**；其餘兩個係同系列命名，
 *    只作測試多樣性（唔會影響 POS 任何判斷 —— POS 只讀 `stateEnum`）。
 */
var FAKE_AOMI_SEND = [
  { type: '澳覓專送', e: 'ZHUANSONG', delivery: true },
  { type: '商家自送', e: 'ZISONG', delivery: true },
  { type: '到店自取', e: 'ZITI', delivery: false },
];

/** 澳覓商家活動（後台係逐項列出，會落 `merchantActDetails`）。 */
var FAKE_AOMI_ACTS = [
  { content: '滿150.0減9.0', price: 9 },
  { content: '滿100.0減5.0', price: 5 },
  { content: '新客立減券', price: 6 },
  { content: '商家代金券', price: 12 },
  { content: '滿200.0減15.0', price: 15 },
  { content: '掃碼下單立減', price: 3 },
];

var FAKE_REMARKS = [
  null,
  null, // 大多數單其實冇備註
  '不要餐具',
  '加辣',
  '請放門口，唔好按門鐘',
  '少飯，唔要蔥',
  '（測試單）',
  '麻煩準時送到，謝謝',
  '走冰',
];

var FAKE_TABLEWARE = ['', '按餐量提供', '不需要餐具', '1份'];

// ── 隨機小工具 ────────────────────────────────────────────────

function _fkInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function _fkPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function _fkChance(p) {
  return Math.random() < p;
}
/** 由 arr 抽 0..n 個唔重複嘅元素（保留原順序，睇落似真人揀嘅）。 */
function _fkPickSome(arr, maxN) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  var n = _fkInt(0, Math.min(maxN, arr.length));
  var idx = [];
  for (var i = 0; i < arr.length; i++) idx.push(i);
  // Fisher–Yates
  for (var j = idx.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var t = idx[j];
    idx[j] = idx[k];
    idx[k] = t;
  }
  return idx
    .slice(0, n)
    .sort(function (a, b) {
      return a - b;
    })
    .map(function (x) {
      return arr[x];
    });
}
/** 金額一律兩位小數（避免 75.90000000000001 呢種浮點 noise）。 */
function _fkRound(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
/** 由 now 回推 minutesAgo 分鐘，出澳覓用嘅 `YYYY-MM-DD HH:mm:ss`。 */
function _fkLocalStamp(now, minutesAgo) {
  var d = new Date(now.getTime() - minutesAgo * 60000);
  var p = function (v) {
    return (v < 10 ? '0' : '') + v;
  };
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes()) +
    ':' +
    p(d.getSeconds())
  );
}

/**
 * 生成一份共用嘅品項清單（兩個平台共用，但輸出名稱唔同）。
 *
 * 加購（`addons`）係**收費**嘅，所以要計入 `unitPrice` ——
 * 真實 mfood 案例：菜 58 + 加購 9 = 67，而 `skuPrice` 只有 58。
 * 呢個就係之前「67 嘅菜品、總額 126」對唔上嘅原因之一。
 */
function _fkMakeItems(maxItems) {
  var n = _fkInt(1, maxItems);
  var pool = FAKE_DISHES.slice();
  var items = [];

  for (var i = 0; i < n && pool.length > 0; i++) {
    var pickIdx = _fkInt(0, pool.length - 1);
    var dish = pool.splice(pickIdx, 1)[0];

    var qty = _fkChance(0.78) ? 1 : _fkInt(2, 3);
    var specs = _fkPickSome(dish.specs, 3);

    // 加購：1–2 樣，收費
    var paidAddons = [];
    var addonDelta = 0;
    if (dish.addons.length > 0 && _fkChance(0.55)) {
      var chosen = _fkPickSome(dish.addons, 2);
      chosen.forEach(function (a) {
        paidAddons.push(a[0]);
        addonDelta += a[1];
      });
    }

    items.push({
      code: dish.code,
      fullName: dish.name,
      // 平台有時顯示完整名（含編號）、有時淨係菜名 —— 隨機先似真實
      displayName: _fkChance(0.5) ? dish.name.replace(/^[A-Za-z0-9]+\./, '') : dish.name,
      quantity: qty,
      unitPrice: _fkRound(dish.base + addonDelta),
      specs: specs,
      paidAddons: paidAddons,
    });
  }
  return items;
}

/** 澳覓訂單（照 `aomi-bridge.js::normalizeDetail()` 嘅欄位名砌）。 */
function _fkMakeAomiOrder(now, seqHint) {
  var minutesAgo = _fkInt(2, 300);
  var items = _fkMakeItems(4);

  var totalAmt = _fkRound(
    items.reduce(function (s, it) {
      return s + it.unitPrice * it.quantity;
    }, 0),
  );

  // ── 費用 ──
  // 餐盒費：每個要盒嘅品項 1 蚊，最多 3（本店實際係 1–3）
  var boxAmt = _fkChance(0.85) ? _fkInt(1, 3) : 0;
  var plasticAmt = _fkChance(0.75) ? _fkInt(1, 3) : 0;
  var holidayServiceAmt = _fkChance(0.15) ? _fkPick([2, 3, 5, 8]) : 0;

  // ── 商家活動支出（營業額公式係「減」呢項）──
  var merchantActDetails = [];
  var merchantActAmt = 0;
  if (_fkChance(0.5)) {
    var acts = _fkPickSome(FAKE_AOMI_ACTS, 2);
    acts.forEach(function (a) {
      merchantActDetails.push(a);
      merchantActAmt += a.price;
    });
    merchantActAmt = _fkRound(merchantActAmt);
    // 現實上限：商家優惠好少會折超過單值 ~70%（否則會出現「$22 嘅單折 $30」呢種假單）。
    while (merchantActDetails.length > 0 && merchantActAmt > totalAmt * 0.7) {
      merchantActAmt = _fkRound(merchantActAmt - merchantActDetails.pop().price);
    }
    // 🔴 唔可以減到營業額 ≤ 0（否則 POS 會退回去用 payAmount，並出 warning）
    if (totalAmt + boxAmt + plasticAmt + holidayServiceAmt - merchantActAmt <= 0) {
      merchantActDetails = [];
      merchantActAmt = 0;
    }
  }

  var send = _fkPick(FAKE_AOMI_SEND);
  // 專送：顧客通常唔使付配送費（商家專送）；自取一律 0
  var sendAmt = send.delivery ? _fkPick([0, 0, 3, 5, 7]) : 0;

  var turnoverBase = _fkRound(totalAmt + boxAmt + plasticAmt + holidayServiceAmt);
  var turnoverAmount = _fkRound(turnoverBase - merchantActAmt);
  var payAmount = _fkRound(turnoverAmount + sendAmt);
  // 平台服務費 20%（真實單 248 → 49.6 / 結算 198.4，比例吻合）
  var platServiceAmt = _fkRound(turnoverAmount * 0.2);
  var settleAmount = _fkRound(turnoverAmount - platServiceAmt);

  var cust = _fkPick(FAKE_AOMI_CUSTOMERS);
  var state = _fkPick(FAKE_AOMI_STATES);
  var stamp = _fkLocalStamp(now, minutesAgo);

  // 單號：後台係每日流水號，隨機 1–120 最似真實
  var seq = seqHint && seqHint > 0 ? String(seqHint) : String(_fkInt(1, 120));

  return {
    source: 'aomi',
    externalOrderId: 'FAKE-AOMI-' + _fkInt(100000, 999999) + '-' + _fkInt(1000, 9999),
    storeSeq: seq,
    localOrderNo: '#' + seq,
    stateEnum: state.e,
    stateRaw: state.r,
    sendType: send.type,
    sendTypeEnum: send.e,
    memberShip: _fkChance(0.4) ? _fkPick(['VIP', '普通會員']) : null,
    occurredAt: stamp,

    amount: {
      // 菜品原價合計
      totalAmt: totalAmt,
      // 商品總金額 = 菜品 + 餐盒 + 膠袋
      goodsAllAmount: _fkRound(totalAmt + boxAmt + plasticAmt),
      boxAmt: boxAmt,
      plasticAmt: plasticAmt,
      // 配送費（顧客付，唔入營業額，但後台會顯示）
      sendAmt: sendAmt,
      holidayServiceAmt: holidayServiceAmt,
      // 商家活動支出（營業額公式係減呢項）
      merchantActAmt: merchantActAmt,
      // 營業額
      turnoverAmount: turnoverAmount,
      // 顧客實付
      payAmount: payAmount,
      platServiceAmt: platServiceAmt,
      settleAmount: settleAmount,
      refundAmt: 0,
      storeRedpacket: 0,
      tipFeeByUser: 0,
      tipFeeByMerchant: 0,
      breakdown: {
        merchantActDetails: merchantActDetails.map(function (a) {
          return { content: a.content, amount: a.price };
        }),
        platActDetails: [],
        platServiceDetails: [{ name: '平台服務費', amount: platServiceAmt }],
      },
    },

    customer: {
      nickname: cust.nickname,
      phoneMasked: cust.phoneMasked,
      address: send.delivery ? cust.address : null,
      remark: _fkPick(FAKE_REMARKS),
      tableware: _fkPick(FAKE_TABLEWARE),
    },

    items: items.map(function (it) {
      return {
        name: it.fullName,
        displayName: it.displayName,
        itemCode: it.code,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        specs: it.specs,
      };
    }),

    // 落庫前唔應該帶真個資，呢度亦冇
    raw: { sendType: send.e, seq: seq },
  };
}

/** mfood 訂單（照 `mfood-bridge.js::normalizeDetail()` 嘅欄位名砌）。 */
function _fkMakeMfoodOrder(now, seqHint) {
  var minutesAgo = _fkInt(2, 300);
  var items = _fkMakeItems(4);

  var totalAmount = _fkRound(
    items.reduce(function (s, it) {
      return s + it.unitPrice * it.quantity;
    }, 0),
  );

  var boxFee = _fkChance(0.85) ? _fkInt(1, 3) : 0;
  var plasticBagFee = _fkChance(0.75) ? _fkInt(1, 3) : 0;
  var serviceFee = _fkChance(0.12) ? _fkPick([2, 3, 5]) : 0;

  // ── 商家承擔優惠（營業額公式逐項減）──
  //    對應 POS `platformFeeLines()` 嘅「商家代金券 / 商家滿減 / 月卡紅包升級」
  var voucherAmount = _fkChance(0.3) ? _fkPick([3, 5, 8, 10]) : 0;
  var fullReductionAmount = _fkChance(0.55) ? _fkPick([4, 6, 9, 12, 15]) : 0;
  var memberUpAmount = _fkChance(0.15) ? _fkPick([2, 3, 5]) : 0;
  var discSum = voucherAmount + fullReductionAmount + memberUpAmount;
  // 現實上限：商家優惠好少會折超過單值 ~70%（否則會出現「$22 嘅單折 $30」呢種假單）。
  // 依序丟：月卡紅包 → 代金券 → 滿減（滿減最常見，留到最後）。
  var discCap = totalAmount * 0.7;
  if (discSum > discCap) {
    discSum -= memberUpAmount;
    memberUpAmount = 0;
  }
  if (discSum > discCap) {
    discSum -= voucherAmount;
    voucherAmount = 0;
  }
  if (discSum > discCap) {
    discSum -= fullReductionAmount;
    fullReductionAmount = 0;
  }
  if (totalAmount + boxFee + plasticBagFee + serviceFee - discSum <= 0) {
    voucherAmount = 0;
    fullReductionAmount = 0;
    memberUpAmount = 0;
    discSum = 0;
  }

  var businessAmount = _fkRound(totalAmount + boxFee + plasticBagFee + serviceFee - discSum);

  // ── 配送 ──
  //    deliveryType 1 = 外送、3 = 自取（已觀察值）
  var isDelivery = _fkChance(0.6);
  var basicDeliveryFee = isDelivery ? _fkPick([5, 8, 12, 13.9]) : 0;
  // 商家配送費減免：多數係全額補貼（顧客實付 0）
  var merchantDeliveryAmount = basicDeliveryFee > 0 && _fkChance(0.75) ? basicDeliveryFee : 0;
  var deliveryFee = _fkRound(Math.max(0, basicDeliveryFee - merchantDeliveryAmount));

  var payAmount = _fkRound(businessAmount + deliveryFee);

  var cust = _fkPick(FAKE_MFOOD_CUSTOMERS);
  var createdIso = new Date(now.getTime() - minutesAgo * 60000).toISOString();

  // mfood 單號：後台顯示 6 位數字
  var orderNumber = seqHint && seqHint > 0 ? seqHint : _fkInt(100000, 999999);

  var names = {};
  if (fullReductionAmount > 0) names.fullReduction = '滿' + _fkPick([80, 100, 110, 150]) + '減' + fullReductionAmount;
  if (voucherAmount > 0) names.voucher = '商家代金券' + voucherAmount + '元';
  if (basicDeliveryFee > 0 && merchantDeliveryAmount > 0) names.delivery = '商家配送費減免';

  return {
    source: 'mfood',
    externalOrderId: 'FAKE-MFOOD-' + orderNumber + '-' + _fkInt(1000, 9999),
    orderNumber: orderNumber,
    tradeNo: 'CRDFAKE' + _fkInt(100000, 999999),
    tradeSeq: 'OPENMACAUFAKE' + _fkInt(100000, 999999),
    orderStatus: 'completed',
    transactionStatus: 'paid',
    fulfillmentType: isDelivery ? 'delivery' : 'pickup',
    deliveryTypeRaw: isDelivery ? 1 : 3,

    amount: {
      // ⚠️ 全部已是「元」
      // 客人實際支付（扣商家配送補貼之後）
      payAmount: payAmount,
      totalAmount: totalAmount,
      // 商家營業額
      businessAmount: businessAmount,

      boxFee: boxFee,
      plasticBagFee: plasticBagFee,
      serviceFee: serviceFee,

      // 詳情嘅 deliveryFee 係「客人實付」，列表嘅係「原始價」，唔好搞混
      deliveryFee: deliveryFee,
      basicDeliveryFee: basicDeliveryFee,
      merchantDeliveryAmount: merchantDeliveryAmount,
      deliverySubsidyAmount: _fkRound(_fkPick([0, 0.8, 1.5, 2])),

      fullReductionAmount: fullReductionAmount,
      voucherAmount: voucherAmount,
      // 🔴 贈品（giftAmount）POS 未識別 → 一律 0，否則收據會多一行兜底。
      giftAmount: 0,
      thirdPartyAmount: 0,
      pointAmount: 0,
      consumptionAmount: 0,
      mallCouponAmount: 0,
      memberUpAmount: memberUpAmount,
      refundAmount: 0,

      discountNames: names,
    },

    rider: isDelivery
      ? { name: _fkPick(['陳加良', '李偉強', '黃志明', '何家俊']), phone: '853-62****' + _fkInt(10, 99) }
      : { name: null, phone: null },

    customer: {
      name: cust.name,
      nickname: cust.nickname,
      phone: cust.phone,
      address: isDelivery ? cust.address : null,
      remark: _fkPick(FAKE_REMARKS),
      tableware: _fkPick(FAKE_TABLEWARE),
    },

    timeline: {
      created: createdIso,
      paid: createdIso,
      accepted: new Date(new Date(createdIso).getTime() + _fkInt(30, 240) * 1000).toISOString(),
    },

    items: items.map(function (it) {
      return {
        displayName: it.displayName,
        quantity: it.quantity,
        // 實收價（含加購）—— 唔係 skuPrice
        unitPrice: it.unitPrice,
        specs: it.specs,
        paidAddons: it.paidAddons,
      };
    }),

    raw: { orderStatus: 4, transactionStatus: 2, deliveryType: isDelivery ? 1 : 3, isReserve: false },
  };
}

/** 由 payload 取一個顯示用單號（登記去註冊表 / popup 顯示）。 */
function _fkLabel(order) {
  if (order.source === 'aomi') {
    var s = String(order.storeSeq || '').trim();
    return '澳覓' + (s ? (s.charAt(0) === '#' ? s : '#' + s) : '#' + String(order.externalOrderId).slice(-6));
  }
  var n = order.orderNumber;
  return 'MFOOD#' + (n === null || n === undefined || n === '' ? String(order.externalOrderId).slice(-6) : n);
}

/**
 * 測試用：建 1–20 張**隨機**假訂單（形狀同 bridge 正規化出嚟嘅一模一樣），直接推去 POS。
 *
 * @param {string} sourceKey 'aomi' | 'mfood'
 * @param {number} [count]  張數（1–20，預設 1）。同一批會用唔同單號，方便一次過睇多個情境。
 *
 * ⚠️ 刻意**繞過 pushEnabled** —— 呢個掣本身就係用嚟驗推送。
 */
function grabBuildFakeOrder(sourceKey, count) {
  var cfg = grabCfgByPrefix(sourceKey === 'aomi' ? 'AOMI' : 'MFOOD');
  if (!cfg) return Promise.resolve({ ok: false, error: '未知來源：' + sourceKey });

  var n = parseInt(count, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 20) n = 20;

  var now = new Date();
  // 🔴 同一批要**唔同單號**，否則後台睇落全部一樣、亦睇唔到多樣性。
  //    由一個隨機起點往上數，似真人連續幾張單。
  var seqBase = _fkInt(1, 90);

  var orders = [];
  for (var i = 0; i < n; i++) {
    var hint = seqBase + i;
    orders.push(
      sourceKey === 'aomi' ? _fkMakeAomiOrder(now, hint) : _fkMakeMfoodOrder(now, hint),
    );
  }

  return grabGetState(cfg.key)
    .then(function (state) {
      // 順手登記落註冊表，令 popup 清單都睇得到（同真單一致）
      orders.forEach(function (order) {
        var a = order.amount || {};
        grabRegisterOrder(state, order.externalOrderId, {
          tradeNo: order.orderNumber ? String(order.orderNumber) : order.tradeNo || null,
          seq: order.storeSeq || null,
          amount: sourceKey === 'aomi' ? a.turnoverAmount : a.businessAmount,
          at: new Date().toISOString(),
          state: 'pending',
        });
      });
      return grabSaveState(cfg.key, state);
    })
    .then(function () {
      return grabGlobalSettings();
    })
    .then(function (global) {
      return grabPush(cfg, orders, global.storeId);
    })
    .then(function (r) {
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '未知錯誤' };
      // 由 POS 回應抽真正建立張數（`ok:true` 但 `created:0` ＝ payload 有問題，
      // 呢個 case 一定要報出嚟，唔可以當成功 —— 之前踩過靜默假成功）。
      var created = null;
      try {
        var info = JSON.parse(r.response);
        if (info && typeof info.created === 'number') created = info.created;
      } catch (e) {
        created = null;
      }
      return {
        ok: true,
        count: n,
        created: created,
        nos: orders.map(_fkLabel),
        localOrderNo: orders.map(_fkLabel).join('、'),
        response: r.response,
      };
    })
    .catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
}

function grabApplyIntervalAll(secs) {
  return Promise.all(grabSourceList().map((cfg) => grabPushInterval(cfg, secs))).then(() => ({
    ok: true,
    secs: secs,
  }));
}

/** 請各來源的頁面：套用日期區間 → 查詢 → 逐頁抓完 */
/** 當地時區的 YYYY-MM-DD */
function grabTodayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 請各來源的頁面：套用日期區間 → 查詢 → 逐頁抓完。
 *
 * 兩個來源的做法不同（這不是偷懶，是平台限制）：
 *   mfood：簽章不含 request body → 直接重放列表請求，日期由我們指定（via: 'api'）
 *   澳覓 ：簽章涵蓋完整 query string → 只能操作頁面，並回讀驗證（via: 'dom'）
 *
 * 所以同一句「已套用日期」，在日誌裡要被寫成不同的、可驗證的敘述。
 */
function grabSyncRangeAll(startDate, endDate) {
  const to = endDate || grabTodayStr();
  const range = `${startDate} ~ ${to}`;

  return Promise.all(
    grabSourceList().map((cfg) =>
      grabGetState(cfg.key).then(
        (state) =>
          new Promise((resolve) => {
            if (typeof state.tabId !== 'number') {
              resolve({ source: cfg.key, ok: false, reason: '尚未偵測到分頁' });
              return;
            }
            chrome.tabs.sendMessage(
              state.tabId,
              { type: 'GRAB_SYNC_RANGE', startDate: startDate, endDate: to },
              (r) => {
                if (chrome.runtime.lastError) {
                  resolve({
                    source: cfg.key,
                    ok: false,
                    reason: grabExplainLastError('觸發查詢'),
                  });
                  return;
                }
                resolve(Object.assign({ source: cfg.key }, r || { ok: false }));
              },
            );
          }),
      ),
    ),
  ).then((results) => {
    return Promise.all(
      grabSourceList().map((cfg, i) => {
        const r = results[i] || {};
        let summary;

        if (!r.ok) {
          summary = `套用日期失敗：${r.reason}`;
        } else if (r.via === 'api') {
          // 平台自己回的 total 就是「這個區間總共幾張單」。
          // 拿它跟我們實際收到的筆數對比 —— 一次自我驗證，不必靠人手核對。
          const got = r.rows || 0;
          const total = r.total == null ? null : Number(r.total);
          summary =
            `以 API 套用 ${range}，取得 ${got} 張單` +
            (total == null ? '' : `（平台總數 ${total}）`) +
            (total != null && got < total ? ` ⚠️ 少 ${total - got} 張` : '');
        } else {
          const total = Array.isArray(r.types) ? r.types.length : 0;
          const okCount = typeof r.verifiedTypes === 'number' ? r.verifiedTypes : 0;
          // 日期有沒有真的套用，是使用者最在意的一格 —— 一定要寫出來。
          const dateTxt =
            r.dateOk === true
              ? `日期已套用（${r.dateMode === 'datetime' ? '含時間' : '純日期'}）`
              : `⚠️ 日期未能套用：${r.dateReason || '頁面仍用它自己的區間'}`;
          summary =
            `操作頁面：${dateTxt}，共翻 ${r.pages || 0} 頁` +
            (total > 0 ? `；回讀驗證 ${okCount}/${total} 個狀態` : '') +
            (r.fallbackReason ? `（未能用 API：${r.fallbackReason}）` : '');
        }

        return grabAppendLog(cfg, {
          level: r.ok ? 'info' : 'error',
          kind: `${cfg.key}_sync_range`,
          summary: summary,
          detail: r,
        });
      }),
    ).then(() => ({ ok: true, results: results }));
  });
}

function grabSetupAlarm() {
  // 不自行續期 session（那是頁面的事），只在使用者層面告警：
  // 提醒去檢查對應後台分頁是否還開著、是否被登出。
  chrome.alarms.create('grabStaleCheck', { periodInMinutes: 5 });

  // 自動查詢節拍器。
  // chrome.alarms 的週期下限是 30 秒（Chrome 120+），所以用 0.5 分鐘。
  // 實際間隔再由各來源依「同步間隔」自我節流 —— 若使用者設得比 30 秒短，
  // 實際上就是 30 秒一次，這點會顯示在 popup 上。
  chrome.alarms.create('grabAutoTick', { periodInMinutes: 0.5 });
}

async function keepSessionAlive() {
  try {
    await fetch(DASHBOARD_URL, { credentials: 'include' });
  } catch (e) {
    console.error("Keep-alive failed", e);
  }
}
chrome.runtime.onInstalled.addListener(() => {
  setupTimer(30);
  grabSetupAlarm();

  grabSourceList().forEach((cfg) => {
    const key = grabSettingsKey(cfg.key);
    chrome.storage.local.get([key], (res) => {
      if (!res[key]) {
        chrome.storage.local.set({ [key]: GRAB_DEFAULT_SETTINGS });
      }
    });
    grabAppendLog(cfg, {
      level: 'info',
      kind: `${cfg.key}_installed`,
      summary: `${cfg.label}訂單擷取已安裝（觀察模式，預設不推送）`,
    });
  });
});

/**
 * 🔴🔴 長駐電腦 reboot／瀏覽器重開後要「自動復原」（2026-09-29 登入前移）
 * --------------------------------------------------------------------------
 * 使用者原話：「長駐後台，其實唔係喺 macau-pos 嗰邊，係會喺別嘅電腦上面做。」
 * ⇒ 嗰部電腦會關機／重開。MV3 service worker 會死，`chrome.alarms` 雖然會留低，
 *   但**分頁冇咗**，`grabAutoTick` 就算醒咗都搵唔到頁可以撳查詢
 *   ⇒ 表現係「自動開住但永遠冇數據」呢種最難查嘅靜默失敗。
 *
 * 所以 onStartup 要同 popup 撳「開始」做**同一串**嘢：
 *   確保有憑證嘅平台都已登入（冇分頁就背景開一個＋自動填表）→ 整備頁面 → 跑一拍。
 *
 * 🔴 一定要 gate 喺「使用者開過自動化」（autoRefresh）之上：
 *   冇 gate 嘅話，商家只係開瀏覽器睇嘢，extension 就自己彈兩個後台分頁出嚟。
 */
function grabAnyAutomationEnabled() {
  return Promise.all(
    grabSourceList().map((cfg) => grabGetSettings(cfg.key).then((s) => !!(s && s.autoRefresh))),
  ).then((flags) => flags.some(Boolean));
}

function grabResumeOnStartup() {
  grabSetupAlarm();
  return grabAnyAutomationEnabled()
    .then((on) => {
      if (!on) return undefined;
      grabSourceList().forEach((cfg) => {
        grabAppendLog(cfg, {
          level: 'info',
          kind: `${cfg.key}_startup`,
          summary: '瀏覽器重開 —— 自動復原中（重新登入並開頁）',
        });
      });
      return grabLoginAllEnabled()
        .then(() => grabPreparePagesForStart())
        .then(() => grabAutoTick());
    })
    .catch((e) => {
      console.error('[grab] startup resume failed', e && e.message);
    });
}

// 🔴 守衛：測試 harness／精簡環境嘅 `chrome.runtime` 未必有 `onStartup`。
//    冇守衛嘅話一句 TypeError 會喺載入時炸穿成個 background（連訊息路由都冇）。
if (chrome.runtime && typeof chrome.runtime.onStartup === 'object' && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    grabResumeOnStartup();
  });
}

// service worker 被喚醒時確保 alarm 存在（create 同名 alarm 會覆蓋，安全）
grabSetupAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'grabDataAlarm') {
    chrome.storage.local.get('isTimerActive', (res) => {
      if (res.isTimerActive !== false) fetchData();
    });
    return;
  }

  if (alarm.name === 'grabAutoTick') {
    grabAutoTick();
    return;
  }

  if (alarm.name === 'grabStaleCheck') {
    grabSourceList().forEach((cfg) => {
      grabGetState(cfg.key).then((state) => {
        const last = state.lastListCaptureAt ? Date.parse(state.lastListCaptureAt) : null;
        // 從未擷取過（例如根本沒在用這個平台）→ 不打擾使用者
        if (!last) return;
        if (Date.now() - last < GRAB_STALE_MS) return;

        const mins = Math.round((Date.now() - last) / 60000);
        chrome.notifications.create(`grab-stale-${cfg.key}`, {
          type: 'basic',
          iconUrl: GRAB_NOTIFY_ICON,
          title: `${cfg.label}訂單擷取已停止`,
          message: `已經 ${mins} 分鐘沒有收到訂單資料。請確認${cfg.label}後台分頁仍開著且為登入狀態。`,
          priority: 2,
        });
      });
    });
  }
});

/* ==========================================================================
   登入前移（2026-09-29 設計拍板）—— extension 代商家登入兩個平台
   --------------------------------------------------------------------------
   * 憑證方案 A：chrome.storage.local 明文（商家自有電腦，最直接）。
   * 🔴 自動登入 ≠ 自動呼叫 API：澳覓嘅 X-Ca-Signature 綁 URL+nonce 算不出，
      資料擷取仍然靠 *-inject.js 搭便車；呢度只接管「誰去登入」呢一步。
   * 流程：確保有分頁 → 送 *_LOGIN_FILL 畀 login.js →
      login.js dispatchEvent 填表 → 撳 button.el-button--primary →
      偵測離開 #/login → 導向訂單頁 → 回報 *_LOGIN_STATUS。
   * 兩平台登入表單實測一致（2026-09-29）：Element UI、無圖形驗證碼、同頁登入。
   ========================================================================== */

const GRAB_LOGIN_SOURCES = {
  mfood: {
    key: 'mfood',
    label: 'mfood',
    sitePattern: 'https://*.mfoodapp.com/*',
    loginUrl: 'https://merchant.mfoodapp.com/#/login?redirect=%2F',
    orderPageUrl: 'https://merchant.mfoodapp.com/#/trade/tackout',
    financePageUrl: 'https://merchant.mfoodapp.com/#/finance/tackout-check',
    fillType: 'MFOOD_LOGIN_FILL',
    isLoginUrl: (url) => /#\/login/.test(String(url || '')),
  },
  aomi: {
    key: 'aomi',
    label: '澳覓',
    sitePattern: 'https://merchant.aomiapp.com/*',
    loginUrl: 'https://merchant.aomiapp.com/#/login',
    orderPageUrl:
      'https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord',
    financePageUrl:
      'https://merchant.aomiapp.com/#/qrAccountmanage/takeoutAccountManage/takeoutAccount',
    fillType: 'AOMI_LOGIN_FILL',
    isLoginUrl: (url) => /#\/login/.test(String(url || '')),
  },
};

function grabCredsKey(sourceKey) {
  return sourceKey === 'aomi' ? 'aomiCreds' : 'mfoodCreds';
}

/**
 * 讀平台憑證。⚠️ 明文儲存係**拍板嘅方案 A**（商家自有電腦），
 * 但憑證**永遠唔可以**寫入日誌 / 診斷輸出（grabBuildDiagnostics 亦唔好加）。
 */
function grabGetCreds(sourceKey) {
  return new Promise((resolve) => {
    chrome.storage.local.get([grabCredsKey(sourceKey)], (res) => {
      const c = res[grabCredsKey(sourceKey)] || null;
      resolve(c && typeof c === 'object' ? c : null);
    });
  });
}

/**
 * 儲存平台憑證。password 傳空字串 ＝ 「只改 username、密碼不變」
 * （popup 編輯憑證時唔使強迫重打密碼）。
 */
function grabSaveCreds(sourceKey, username, password) {
  return grabGetCreds(sourceKey).then((oldCreds) => {
    const prev = oldCreds || {};
    const next = {
      username: String(username || '').trim(),
      password: String(password || '') || String(prev.password || ''),
    };
    return new Promise((resolve) => {
      chrome.storage.local.set({ [grabCredsKey(sourceKey)]: next }, () => {
        resolve({ ok: true, hasPassword: !!next.password });
      });
    });
  });
}

function grabHasCreds(sourceKey) {
  return grabGetCreds(sourceKey).then(
    (c) => !!(c && c.username && c.password),
  );
}

/** 自動填表嘅冷卻 key —— 防登入失敗時 PAGE_READY 循環觸發（60 秒一次）。 */
function grabLoginCooldownKey(k) {
  return `${k}LoginAt`;
}

/** 成功登入嘅時間戳 key（冷靜期用，見下）。 */
function grabLoginOkKey(k) {
  return `${k}LoginOkAt`;
}

/** 記錄「啱啱成功登入」——之後嘅自動重登要讓路（見 GRAB_LOGIN_SETTLE_MS）。 */
function grabNoteLoginOk(sourceKey) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [grabLoginOkKey(sourceKey)]: Date.now() }, () => resolve());
  });
}

/**
 * 自動重登嘅**全域最小間隔**。
 *
 * 🔴 2026-09-30 真機確診：原本 60 秒，而分頁每 25~40 秒就落一次 `#/login`
 * ⇒ 全日自動登入 **241 次**（日誌 `mfood_login` ×241），變成
 * 「A 分頁登入 → 踢走 B 分頁嘅 session → B 被 redirect 返登入頁 → B 又登入 → 踢走 A」
 * 嘅乒乓迴圈。加長間隔只係止血，真正嘅閘係下面兩條。
 */
const GRAB_LOGIN_RETRY_MIN_MS = 45 * 1000;

/**
 * 成功登入後嘅**冷靜期**：呢段時間內即使有分頁停喺登入頁，都唔再自動重登。
 *
 * 為什麼需要：平台嘅 session 係**按帳號**嘅。短時間內重複登入會令前一個 session
 * 失效，而失效嘅分頁又被 redirect 返登入頁 ⇒ 兩個分頁互相踢 ⇒ 永遠登唔完。
 * 讓平台自己完成 session 落地（實測成功登入後數秒內就穩定）。
 */
const GRAB_LOGIN_SETTLE_MS = 3 * 60 * 1000;

function grabFindSiteTab(sourceKey) {
  const lc = GRAB_LOGIN_SOURCES[sourceKey];
  if (!lc) return Promise.resolve(null);
  return new Promise((resolve) => {
    // 測試 harness 未必有 chrome.tabs（同 grabFindFinanceTab 同一守衛）
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(null);
      return;
    }
    chrome.tabs.query({ url: lc.sitePattern }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve((tabs && tabs[0]) || null);
    });
  });
}

/**
 * 確保平台有分頁：有就攞嚟用；冇就背景開登入頁（active:false，唔搶焦點）。
 * 回 {tab, created} —— created 用嚟決定「already-logged-in 時要不要導去訂單頁」。
 */
function grabLoginEnsureTab(sourceKey) {
  const lc = GRAB_LOGIN_SOURCES[sourceKey];
  return grabFindSiteTab(sourceKey).then((tab) => {
    if (tab) return { tab: tab, created: false };
    return new Promise((resolve) => {
      if (!chrome.tabs || typeof chrome.tabs.create !== 'function') {
        resolve({ tab: null, created: false });
        return;
      }
      chrome.tabs.create({ url: lc.loginUrl, active: false }, (t) => {
        void chrome.runtime.lastError;
        // 等 SPA 載入 + login.js 注入；實際重試交俾 grabSendLoginFill
        setTimeout(() => resolve({ tab: t || null, created: true }), 2500);
      });
    });
  });
}

/**
 * 送 *_LOGIN_FILL 畀分頁，分頁未載入好（Receiving end does not exist）
 * 就每 1.5 秒重試，最多 12 次（≈18 秒）。
 * login.js 會撳住 sendResponse 直到填表＋提交＋偵測完成先回。
 */
function grabSendLoginFill(tabId, payload, attempts) {
  const n = attempts || 0;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      if (chrome.runtime.lastError) {
        if (n >= 12) {
          resolve({ ok: false, reason: '分頁遲遲未載入（登入頁可能改版）' });
          return;
        }
        setTimeout(() => grabSendLoginFill(tabId, payload, n + 1).then(resolve), 1500);
        return;
      }
      resolve(resp || { ok: false, reason: '分頁未回應' });
    });
  });
}

function grabRecordLogin(sourceKey, patch) {
  return grabGetState(sourceKey).then((state) => {
    state.login = Object.assign(
      { at: new Date().toISOString() },
      state.login || {},
      patch,
    );
    return grabSaveState(sourceKey, state);
  });
}

/**
 * 對某平台執行一次自動登入。
 * 回 {ok, stage}：stage = 'submitted'（真的填表提交）| 'already'（本來已登入）。
 * ⚠️ 唔會 throw —— 呢個函式會喺「開始」主流程度 await，唔可以炸穿。
 */
function grabRunLogin(sourceKey) {
  const lc = GRAB_LOGIN_SOURCES[sourceKey];
  if (!lc) return Promise.resolve({ ok: false, reason: '未知平台' });
  return grabGetCreds(sourceKey)
    .then((creds) => {
      if (!creds || !creds.username || !creds.password) {
        return grabRecordLogin(sourceKey, {
          ok: false,
          stage: 'no-creds',
          error: '未設定帳密',
        }).then(() => ({ ok: false, reason: '未設定帳密', noCreds: true }));
      }
      return grabLoginEnsureTab(sourceKey).then((ensured) => {
        const tab = ensured.tab;
        if (!tab || typeof tab.id !== 'number') {
          return { ok: false, reason: '無法開啟平台分頁' };
        }
        return grabSendLoginFill(tab.id, {
          type: lc.fillType,
          username: creds.username,
          password: creds.password,
          orderPageUrl: lc.orderPageUrl,
          /**
           * 🔴🔴 2026-09-30：`navigateOnAlready` 原本**冇人設定** ——
           *    login.js 有個永遠行唔到嘅分支（死代碼）。
           *    ⇒ 一定要**只在「呢個分頁係我哋啱啱開嘅」**才授權佢導頁：
           *      分頁係本來已存在嘅話，佢可能係**對帳頁**
           *      （`grabLoginEnsureTab` 攞 `tabs.query(...)[0]`，冇保證係訂單頁）
           *      ⇒ 授權導頁會**把對帳頁搬去訂單頁** ⇒ 財務頁從此消失
           *      ⇒ 永久「未開啟財務對帳頁」。
           *
           *    交畀 `login.js gotoPage()` 做嘅好處：佢會判斷「係唔係已經喺目標」，
           *    已經喺度就**唔做多餘導航**（`chrome.tabs.update({url})` 去同一個 URL
           *    其實係一次**重新載入**）。
           */
          navigateOnAlready: !!ensured.created,
        }).then((resp) => {
          const r = resp || { ok: false, reason: '分頁未回應' };
          // 分頁係我哋開嘅、而且本來已登入 → 補導去訂單頁
          //（login.js 已經自己導咗嘅話（navigated:true）就唔好再 update 一次）
          if (r.ok && r.stage === 'already' && ensured.created && !r.navigated) {
            if (chrome.tabs && typeof chrome.tabs.update === 'function') {
              chrome.tabs.update(tab.id, { url: lc.orderPageUrl }, () =>
                void chrome.runtime.lastError,
              );
            }
          }
          if (r.ok) {
            // 🔴🔴 2026-09-30（單一分頁模型修正）：登入成功**唔可以**另開一個財務對帳分頁。
            //    使用者原話「mfood 分頁是不允許的」—— mfood 多個同 origin 分頁會互相搶 session，
            //    令訂單／對帳輪流失效。對帳頁係由 `grabSettleSingleTab` 喺每次對帳時，
            //    用**同一個 tab** 經 SPA 跳去 `#/finance/tackout-check` 抓完再跳返訂單頁，
            //    **唔需要常駐第二個分頁**（使用者舊嘅「對帳頁去咗邊」疑慮，已由單一分頁對帳流程解決）。
            // 🔴 2026-09-30：記低「啱啱成功登入」⇒ 之後 3 分鐘內唔再自動重登
            //    （見 GRAB_LOGIN_SETTLE_MS：短時間重複登入會互踢 session）。
            grabNoteLoginOk(sourceKey);
          }
          return r;
        });
      });
    })
    .catch((err) => ({ ok: false, reason: String((err && err.message) || err) }));
}

/** 全部已設憑證嘅平台並行登入（永不 reject）。 */
function grabLoginAllEnabled() {
  const keys = Object.keys(GRAB_LOGIN_SOURCES);
  return Promise.all(
    keys.map((k) =>
      grabHasCreds(k).then((has) => (has ? grabRunLogin(k) : { ok: false, noCreds: true })),
    ),
  ).then(() => undefined);
}

/**
 * PAGE_READY 停喺登入頁／login.js 報 LOGIN_NEEDED 時嘅自動補登入。
 * fire-and-forget；60 秒冷卻防循環（登入失敗＋頁面 reload 嘅組合）。
 * @param {object} cfg GRAB_SOURCES 條目
 * @param {number|null} tabId 已知分頁（LOGIN_NEEDED 會帶 sender.tab.id）
 * @param {boolean} manual popup「測試登入」唔受冷卻限制
 */
function grabAutoLoginOnLoginUrl(cfg, tabId, manual) {
  const lc = GRAB_LOGIN_SOURCES[cfg.key];
  if (!lc) return Promise.resolve();
  return grabGetCreds(cfg.key).then((creds) => {
    if (!creds || !creds.username || !creds.password) {
      grabAppendLog(cfg, {
        level: 'info',
        kind: `${cfg.key}_login`,
        summary: '停在登入頁 —— 未設定帳密，請開啟設定完成',
      });
      return grabRecordLogin(cfg.key, { ok: false, stage: 'no-creds', error: '未設定帳密' });
    }
    return grabClassifyTabs(cfg.key)
      .then((info) => {
        /**
         * 🔴🔴 2026-09-30 打破「登入乒乓」嘅**第一道閘**（真機確診）。
         *
         * 只要同平台**已經有分頁企喺功能頁**（訂單頁／對帳頁），就證明 session 係活嘅
         * ⇒ 呢個停喺登入頁嘅分頁只需要**被導去訂單頁**（純 hash 導航，唔會重新驗證、
         *   唔會令 session 失效），**絕對唔可以再填表登入**。
         *
         * 舊行為：照樣填表 → 新 session 生效、舊 session 失效 → 另一個分頁被踢返
         * 登入頁 → 佢又登入 → 無限迴圈（日誌實測 241 次）。
         */
        const functional = info && !info.unknown ? Number(info.order) + Number(info.finance) : 0;
        if (!manual && functional > 0) {
          return grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_login`,
            summary: `偵測到同平台已有 ${functional} 個已登入分頁，略過自動重登（避免互踢 session），改為導向訂單頁`,
            detail: { tabInfo: grabTabInfoForLog(info) },
          })
            .then(() =>
              grabRecordLogin(cfg.key, { ok: true, stage: 'already', skippedRelogin: true }),
            )
            .then(() =>
              grabGetState(cfg.key).then((state) => {
                const id =
                  typeof tabId === 'number'
                    ? tabId
                    : typeof state.tabId === 'number'
                      ? state.tabId
                      : null;
                if (id === null) return undefined;
                const t = (info.tabs || []).find((x) => x.id === id);
                // ⚠️ 只喺「嗰個分頁真係登入頁」時才導 —— 否則會打斷正在工作嘅分頁
                if (t && t.kind === 'login' && chrome.tabs && typeof chrome.tabs.update === 'function') {
                  chrome.tabs.update(id, { url: lc.orderPageUrl }, () =>
                    void chrome.runtime.lastError,
                  );
                }
                return undefined;
              }),
            );
        }

        // 第二道閘：全域最小間隔 ＋ 成功登入後冷靜期
        return new Promise((resolve) => {
          chrome.storage.local.get(
            [grabLoginCooldownKey(cfg.key), grabLoginOkKey(cfg.key)],
            (res) => {
              const now = Date.now();
              const lastAttempt = Number(res[grabLoginCooldownKey(cfg.key)]) || 0;
              const lastOk = Number(res[grabLoginOkKey(cfg.key)]) || 0;
              if (!manual && lastAttempt && now - lastAttempt < GRAB_LOGIN_RETRY_MIN_MS) {
                resolve(false); // 冷卻中：唔連環填表
                return;
              }
              if (!manual && lastOk && now - lastOk < GRAB_LOGIN_SETTLE_MS) {
                resolve(false); // 啱啱先成功登入 —— 讓個 session 落地，唔好即刻再登
                return;
              }
              chrome.storage.local.set({ [grabLoginCooldownKey(cfg.key)]: now }, () =>
                resolve(true),
              );
            },
          );
        }).then((go) => {
          if (!go) return undefined;
          return grabGetState(cfg.key).then((state) => {
            const id =
              typeof tabId === 'number'
                ? tabId
                : typeof state.tabId === 'number'
                  ? state.tabId
                  : null;
            if (id === null) return undefined;
            setTimeout(() => {
              chrome.tabs.sendMessage(
                id,
                {
                  type: lc.fillType,
                  username: creds.username,
                  password: creds.password,
                  orderPageUrl: lc.orderPageUrl,
                  auto: true,
                },
                () => void chrome.runtime.lastError,
              );
            }, 1200);
            return undefined;
          });
        });
      });
  });
}

/**
 * 「開啟平台後台分頁」：每個已設憑證平台，確保訂單頁＋對帳頁都開住。
 *
 * 🔴🔴 2026-09-30 使用者真機回報：「我看到是成功登入, 但是只看到打開了訂單頁面,
 *    我想問一下對帳的頁面去那裡啦?」
 *
 *    根因：原本 `ensureUrl(lc.sitePattern, url)` 兩個呼叫都用**同一個 sitePattern**
 *    去 `chrome.tabs.query` ⇒ 第一次開完訂單頁之後，第二次查詢就搵到啱啱開嗰個
 *    訂單頁 ⇒ 判定「已有分頁，不重複開」⇒ **對帳頁永遠唔會開**。
 *
 *    ✅ 一定要按**路徑**判斷：只有當「已有分頁嘅 URL 包含目標路徑」時才算已存在。
 *       ⚠️ 唔可以用 `tabs.query({url})` 由 Chrome 做比對 —— SPA 嘅 hash 路由
 *       （`#/finance/tackout-check`）唔一定支援 match pattern，所以攞晒該站分頁
 *       自己逐個比對 `indexOf(path)` 最穩。
 *
 * 🔴 2026-09-30 補充（日誌分析後）：呢條路徑**由頭到尾冇任何 log** ⇒
 *    當對帳失敗講「未開啟財務頁」時，完全查唔到「當時到底有冇開過、開咗幾次」。
 *    ⇒ 每次開頁都寫一條 `<key>_open_tabs` 事件（目標 URL、開之前查到乜、有冇新開）。
 */
function grabOpenAdminTabs() {
  const keys = Object.keys(GRAB_LOGIN_SOURCES);
  return Promise.all(
    keys.map((k) => {
      const lc = GRAB_LOGIN_SOURCES[k];
      return grabHasCreds(k).then((has) => {
        if (!has) {
          // 冇帳密都要記錄 —— 否則「開唔到頁」會同上一個問題一樣變成黑盒
          return grabAppendLog(lc, {
            kind: k + '_open_tabs',
            level: 'info',
            summary: '未設定帳密，略過開啟後台分頁',
            detail: { orderPageUrl: lc.orderPageUrl, financePageUrl: lc.financePageUrl },
          }).then(() => ({ key: k, ok: false, reason: '未設定帳密' }));
        }
        return grabEnsureTabForUrl(lc.sitePattern, lc.orderPageUrl)
          .then((openedOrder) =>
            grabAppendLog(lc, {
              kind: k + '_open_tabs',
              level: 'info',
              // 🔴 單一分頁模型：淨係開／確保「訂單頁」呢一個 tab。
              //    對帳頁**唔另開分頁** —— 對帳時由 `grabSettleSingleTab` 用同一個 tab
              //    經 SPA 跳去對帳頁抓完再跳返；mfood 多分頁會互搶 session，絕對唔可以開。
              summary:
                '已確保後台分頁（單一分頁）：訂單頁' +
                (openedOrder ? '（新開）' : '（本來已在）') +
                '；對帳頁由單一分頁對帳流程喺對帳時自動切換，唔另開分頁',
              detail: {
                orderPageUrl: lc.orderPageUrl,
                financePageUrl: lc.financePageUrl,
                openedOrderPage: !!openedOrder,
                openedFinancePage: false,
              },
            }).then(() => ({ key: k, ok: true, openedAny: !!openedOrder })),
          );
      });
    }),
  ).then((results) => ({ ok: true, results: results }));
}

/**
 * 確保「某個路徑」嘅分頁存在：冇就背景開一個（active:false，唔搶焦點）。
 *
 * @param {string} sitePattern 該平台嘅分頁查詢範圍（`https://*.mfoodapp.com/*`）
 * @param {string} targetUrl   完整目標 URL（hash 路由）
 * @returns {Promise<boolean>} 今次有冇新開分頁
 */
function grabEnsureTabForUrl(sitePattern, targetUrl) {
  // 由完整 URL 抽路徑部分（`#/finance/tackout-check`）做存在判斷
  const marker = (function () {
    const i = String(targetUrl || '').indexOf('#');
    return i >= 0 ? String(targetUrl).slice(i) : String(targetUrl || '');
  })();
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(false);
      return;
    }
    chrome.tabs.query({ url: sitePattern }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      const exists = (tabs || []).some((t) => {
        const u = String((t && t.url) || '');
        // 🔴 一定要比對**路徑**，唔可以只比對 host ——
        //    否則訂單頁會被當成「對帳頁已開」（就係本次 bug）。
        return marker && u.indexOf(marker) >= 0;
      });
      if (exists) {
        resolve(false);
        return;
      }
      if (typeof chrome.tabs.create !== 'function') {
        resolve(false);
        return;
      }
      chrome.tabs.create({ url: targetUrl, active: false }, (t) => {
        void chrome.runtime.lastError;
        resolve(!!t);
      });
    });
  });
}

/** 匯出日誌：所有來源的觀察日誌打成一包 JSON（已遮蔽，日誌本身唔含憑證）。 */
function grabExportLog() {
  const keys = grabSourceList().map((cfg) => cfg.key);
  return Promise.all(
    keys.map((k) =>
      new Promise((resolve) => {
        chrome.storage.local.get([grabLogKey(k)], (res) => {
          resolve([k, Array.isArray(res[grabLogKey(k)]) ? res[grabLogKey(k)] : []]);
        });
      }),
    ),
  ).then((pairs) => {
    const logs = {};
    pairs.forEach(([k, arr]) => {
      logs[k] = arr;
    });
    const payload = {
      exportedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      logs: logs,
    };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename =
      'grabber-log-' +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds()) +
      '.json';
    return { ok: true, filename: filename, json: JSON.stringify(payload, null, 2) };
  });
}

/** 全平台立即掃描（工具選單「立即掃描一次」）。 */
function grabRescanAll() {
  const list = grabSourceList();
  return Promise.all(
    list.map((cfg) =>
      grabRescan(cfg, 'manual').then((r) => ({ key: cfg.key, result: r })),
    ),
  ).then((results) => ({ ok: true, results: results }));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return false;

  // ---- MacauPay（舊介面，用 request.action）----
  // ⚠️ 必須放在 type 檢查「之前」。MacauPay 的訊息只有 action、沒有 type，
  // 若先檢查 type 就會被提早 return，令手動刷新 / Start / Stop 全部失效。
  if (typeof request.action === 'string') {
    if (request.action === 'manualGrab') fetchData();
    else if (request.action === 'updateTimer') setupTimer(request.intervalSecs);
    else if (request.action === 'stopTimer') stopTimer();
    return false;
  }

  if (typeof request.type !== 'string') return false;

  // 診斷匯出是全域的（包含所有來源），所以不掛在任何來源前綴下
  if (request.type === 'GRAB_DIAGNOSTICS') {
    grabBuildDiagnostics().then(sendResponse);
    return true;
  }

  // 套用同步間隔（可低於 30 秒，由內容腳本自行計時）
  if (request.type === 'GRAB_APPLY_INTERVAL') {
    grabApplyIntervalAll(request.secs).then(sendResponse);
    return true;
  }

  // 套用日期區間並逐頁抓完
  if (request.type === 'GRAB_SYNC_RANGE') {
    grabSyncRangeAll(request.startDate, request.endDate).then(sendResponse);
    return true;
  }

  // 🔴 查店名（2026-09-25）：popup 輸入 Store ID 之後即刻顯示「呢個 ID 係邊間店」。
  if (request.type === 'GRAB_LOOKUP_STORE') {
    grabLookupStore(request.storeId).then(sendResponse);
    return true;
  }

  // 清除所有訂單
  if (request.type === 'GRAB_CLEAR_ALL_ORDERS') {
    grabClearAllOrders().then(sendResponse);
    return true;
  }

  // 測試用：建一張假訂單並直接推去 POS（繞過 pushEnabled）
  if (request.type === 'GRAB_BUILD_FAKE_ORDER') {
    grabBuildFakeOrder(request.source, request.count).then(sendResponse);
    return true;
  }

  // 平台結算（實收）：立即對帳（2026-09-26）—— 手動觸發，忽略節流。
  // 🔴🔴 2026-09-30：改走單一分頁路徑（暫停訂單 → 切去財務頁 → 抓一次 → 切返）。
  if (request.type === 'GRAB_SETTLE_NOW') {
    const cfg = grabSourceList().find((c) => c.key === 'mfood');
    grabSettleSingleTab(cfg).then(sendResponse);
    return true;
  }

  // 🔴 2026-09-29 澳覓對帳：立即對帳（手動觸發，忽略節流）。
  if (request.type === 'GRAB_SETTLE_AOMI_NOW') {
    const cfg = grabSourceList().find((c) => c.key === 'aomi');
    grabSettleSingleTab(cfg).then(sendResponse);
    return true;
  }

  /**
   * 🔴🔴 第十七次真機：定時**自動對帳**開關（2026-09-29）。
   *
   * 使用者原話：「我們要把"立即對帳" 這個也自動化, 放到上面的timer 的功能里面,
   *              就比如: 我set 了 60秒, 就60秒做一次立即對帳的功能.」
   *
   * ⇒ 開咗之後，`grabAutoTick()` 會用**同步間隔**（`intervalSecs`）做節流，
   *   而唔係原本嘅 6 小時。
   *
   * 🔴 2026-09-29：`sourceKey` 由 request 帶入（預設 mfood，兼容舊 popup）。
   *    澳覓同 mfood 各有自己嘅 `autoSettle` 設定（設定係 per-source 嘅）。
   */
  if (request.type === 'GRAB_SET_AUTO_SETTLE') {
    const sk = request.sourceKey === 'aomi' ? 'aomi' : 'mfood';
    grabSaveSettings(sk, { autoSettle: !!request.enabled }).then((s) =>
      sendResponse({ ok: true, autoSettle: !!s.autoSettle, sourceKey: sk }),
    );
    return true;
  }

  /**
   * 🔴 對帳頁 DOM 診斷（2026-09-28）—— 只讀，唔撳任何嘢。
   *
   * 為什麼要有：真頁面同假設有出入時（實測 2026-09-28：真後台「詳情」彈窗係
   * **帳單明細**，同我哋假設嘅「帳期列」唔同；`__vue__` 亦可能唔存在），
   * 靠截圖猜會反覆修錯。呢個掣一撳就 dump 真實 DOM，一次對準。
   */
  if (request.type === 'GRAB_SETTLE_DOMDUMP') {
    grabAskFinanceTab('domdump').then(sendResponse);
    return true;
  }

  /**
   * 🔴🔴 2026-09-30 使用者要求：「你需要給商家在extension 上, 選擇用那家店,
   *    去做mfood 對帳」
   *
   * ⇒ 讀出 mfood 財務頁商家下拉**真實可揀嘅店家清單**，交返 popup 畫成
   *   選單。商家從此唔需要再手打商家名（真機 80/80 都係打錯／格式唔同）。
   *
   * ⚠️ 呢個係**讀取**：財務頁只會「開一次下拉讀文字」再收返，
   *    唔會揀任何嘢、唔會改對帳狀態。
   */
  if (request.type === 'GRAB_MFOOD_STORE_OPTIONS') {
    grabAskFinanceTab('storeoptions', 'mfood').then(sendResponse);
    return true;
  }

  /**
   * 🔴 財務請求取證（2026-09-28 第五次真機）—— 只讀，唔撳任何嘢。
   *
   * 為什麼要有：真機重放一直 HTTP 404，但請求 **body 完全正確**（有 weekId）、
   * POS 端點亦正常（回 400）⇒ 唯一未驗證嘅假設就係**請求 host**。
   * 呢個掣問財務頁「你見過嘅財務請求**絕對 URL** 係咩？你頁面 origin 係咩？」
   * 兩者一比就即刻確定重放應該打邊個 host，唔使再猜。
   */
  if (request.type === 'GRAB_FINANCE_FORENSIC') {
    grabAskFinanceTab('forensic').then(sendResponse);
    return true;
  }

  /**
   * 🔴 2026-09-28 第十一次真機（使用者要求）：
   *    「不如你先不要做配對, 先把所有的訂單都先拿在手上, 然後我再幫你分析好不好?」
   *
   * ⇒ 呢個 route **只做一件事**：把財務頁目前已攔截到嘅**全部原始資料**帶返 popup。
   *    · 唔配對、唔計算、唔改名、唔推 POS
   *    · 唔會觸發任何新請求（只讀已攔到嘅嘢）
   *   ⇒ 就算之後配對邏輯全錯，使用者手上仍然有完整原始數據可以離線分析。
   */
  if (request.type === 'GRAB_FINANCE_RAW') {
    grabAskFinanceTab('raw', request.sourceKey).then(sendResponse);
    return true;
  }

  // 🔴🔴 2026-10-02：停止時真正中斷對帳。
  //    按「停止」除咗 GRAB_SET_AUTOMATION(false)（關 autoRefresh/autoSettle），
  //    仲要清走每個來源嘅「忙於對帳」鎖同累加器，並叫對帳中嘅分頁即時切返訂單頁
  //    （否則 grabSettleSingleTab 嘅導航閉環會繼續跑完、甚至重試 5 次）。
  if (request.type === 'GRAB_STOP_ALL') {
    Promise.all(
      grabSourceList().map((cfg) =>
        grabGetState(cfg.key).then((st) => {
          st.busySettling = false;
          st.settleAccumMs = 0;
          if (typeof st.tabId === 'number') {
            try {
              chrome.tabs.sendMessage(st.tabId, { type: 'GRAB_RESUME_ORDERS' });
            } catch (e) {
              /* 分頁可能已閉 */
            }
          }
          return grabSaveState(cfg.key, st);
        }),
      ),
    ).then(() => sendResponse({ ok: true }));
    return true;
  }

  // MacauPay（舊後台直抓鏈）主面板卡片 —— 只讀狀態（2026-10-02 恢復為第三張卡）
  if (request.type === 'MPAY_GET_DASHBOARD') {
    grabMpayDashboard().then(sendResponse);
    return true;
  }

  // MacauPay「同步到 macau-pos」開關（寫入 mpayPushEnabled；預設開）
  if (request.type === 'MPAY_SAVE_SETTINGS') {
    const patch = request.patch || {};
    if (typeof patch.pushEnabled === 'boolean') {
      chrome.storage.local.set({ mpayPushEnabled: patch.pushEnabled }, () =>
        sendResponse({ ok: true, settings: { pushEnabled: patch.pushEnabled } }),
      );
    } else {
      sendResponse({ ok: true, settings: {} });
    }
    return true;
  }

  // 「開始 / 停止」＝三個平台的總開關
  if (request.type === 'GRAB_SET_AUTOMATION') {
    const enabled = request.enabled !== false;
    grabSetAllAutomation(enabled).then((r) => {
      // 開啟時把間隔推給內容腳本（讓它自行計時），並立刻跑一次
      const after = enabled
        ? grabGlobalSettings()
            .then((g) => grabApplyIntervalAll(g.intervalSecs))
            // 🔴🔴 登入前移（2026-09-29）：按「開始」＝先確保已設憑證嘅平台都係
            //    登入狀態（冇分頁就背景開 + 自動登入），之後先整備頁面同跑第一 tick。
            //    唔係嘅話 session 過期咗，preparePages 會喺登入頁空轉。
            .then(() => grabLoginAllEnabled())
            // 🔴 2026-09-25：按「開始」＝ 自動整備頁面（先設篩選、再重新載入），
            //    之後才跑第一個 tick —— 唔使商家自己 F5。
            .then(() => grabPreparePagesForStart())
            .then(() => {
              grabAutoTick();
            })
        : grabApplyIntervalAll(0);
      after.then(() => sendResponse(r));
    });
    return true;
  }

  // ---- 登入前移（2026-09-29）----------------------------------------------

  // 儲存憑證（password 空字串 = 只改 username，密碼不變）
  if (request.type === 'GRAB_SET_CREDENTIALS') {
    const sk = request.sourceKey === 'aomi' ? 'aomi' : 'mfood';
    grabSaveCreds(sk, request.username, request.password).then((r) => {
      grabCfgByPrefix(sk === 'aomi' ? 'AOMI' : 'MFOOD') &&
        grabAppendLog(grabCfgByPrefix(sk === 'aomi' ? 'AOMI' : 'MFOOD'), {
          level: 'info',
          kind: `${sk}_login`,
          summary: `已儲存${r.hasPassword ? '帳號與密碼' : '帳號（密碼不變）'}`,
        });
      sendResponse(r);
    });
    return true;
  }

  // 讀憑證狀態（⚠️ 永遠唔回傳密碼本身）
  if (request.type === 'GRAB_GET_CREDENTIALS') {
    const sk = request.sourceKey === 'aomi' ? 'aomi' : 'mfood';
    grabGetCreds(sk).then((c) => {
      sendResponse({
        ok: true,
        username: (c && c.username) || '',
        hasPassword: !!(c && c.password),
        configured: !!(c && c.username && c.password),
      });
    });
    return true;
  }

  // 單平台「測試登入」（精靈／平台卡「重新登入」）
  if (request.type === 'GRAB_LOGIN_TEST_ONE') {
    grabRunLogin(request.sourceKey).then(sendResponse);
    return true;
  }

  // 全部平台「測試登入」（工具選單）
  if (request.type === 'GRAB_LOGIN_TEST_ALL') {
    const keys = Object.keys(GRAB_LOGIN_SOURCES);
    Promise.all(keys.map((k) => grabRunLogin(k).then((r) => [k, r]))).then(
      (pairs) => {
        const results = {};
        pairs.forEach(([k, r]) => {
          results[k] = r;
        });
        sendResponse({ ok: true, results: results });
      },
    );
    return true;
  }

  // 開啟平台後台分頁（訂單頁＋對帳頁，只補唔搶）
  if (request.type === 'GRAB_OPEN_ADMIN_TABS') {
    grabOpenAdminTabs().then(sendResponse);
    return true;
  }

  // 匯出日誌（JSON）
  if (request.type === 'GRAB_EXPORT_LOG') {
    grabExportLog().then(sendResponse);
    return true;
  }

  // 全平台立即掃描
  if (request.type === 'GRAB_RESCAN_ALL') {
    grabRescanAll().then(sendResponse);
    return true;
  }

  // ---- 擷取來源訊息（AOMI_* / MFOOD_*），由 GRAB_SOURCES 自動路由 ----
  const underscore = request.type.indexOf('_');
  if (underscore > 0) {
    const cfg = grabCfgByPrefix(request.type.slice(0, underscore));

    if (cfg) {
      switch (request.type.slice(underscore + 1)) {
        case 'PAGE_READY':
          grabRememberTab(cfg, sender);
          // 🔴🔴 登入前移（2026-09-29）：分頁停喺 #/login ＝ session 過期／未登入。
          //    有憑證就自動填表（60 秒冷卻）；冇憑證就記日誌提醒。
          if (
            GRAB_LOGIN_SOURCES[cfg.key] &&
            GRAB_LOGIN_SOURCES[cfg.key].isLoginUrl(request.href)
          ) {
            grabAutoLoginOnLoginUrl(cfg, null, false);
          }
          // 分頁剛載入就把目前的間隔推給它，讓內容腳本開始自行計時
          grabGlobalSettings().then((g) => {
            setTimeout(() => grabPushInterval(cfg, g.intervalSecs), 800);
          });
          // 🔴 重新載入之後再設一次篩選（2026-09-25）：
          //    F5 會令 SPA 篩選還原成預設（mfood「已完成」）⇒ 唔補一次就會用返
          //    「已完成」嘅請求範本重放 ⇒ 永遠漏新單。
          //    延遲 2.5 秒等 SPA 渲染完（太快會搵唔到個欄位）。
          if (cfg.needsOrderStatusAll) {
            setTimeout(() => {
              grabApplyPagePrepare(cfg, 'page-ready');
            }, 2500);
          }
          grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_page_ready`,
            summary: `${cfg.label}後台頁面已載入，攔截器就緒`,
            detail: { href: request.href },
          });
          sendResponse({ ok: true });
          return true;

        case 'ORDER_LIST_CAPTURED':
          grabHandleList(cfg, request);
          sendResponse({ ok: true });
          return true;

        case 'AUTO_QUERY':
          // 頁面切了狀態卻沒自己查詢 → 擴充功能代按了一次查詢。
          // 記在日誌裡，商家才看得見「選了狀態就會載入」是怎麼發生的。
          grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_auto_query`,
            summary: request.reason || '已代為查詢',
            detail: request,
          });
          sendResponse({ ok: true });
          return true;

        case 'ORDER_DETAIL_CAPTURED':
          grabHandleDetail(cfg, request);
          sendResponse({ ok: true });
          return true;

        case 'STATS_CAPTURED':
          grabHandleStats(cfg, request);
          sendResponse({ ok: true });
          return true;

        case 'GET_DASHBOARD':
          grabDashboard(cfg).then(sendResponse);
          return true;

        case 'SAVE_SETTINGS':
          // 🔴 2026-09-25：由「未啟用同步」轉「啟用」嗰一刻要**補送**之前只登記咗嘅單。
          //    詳見 grabReleaseHeldOrders 註釋（要放行去重名冊，再由列表路徑推）。
          // 🔴 2026-09-25（介面簡化）：popup 已經冇「定時自動查詢／自動抓訂單詳情／
          //    自動重載」三個開關 —— 商家只需要決定「要唔要同步到 POS」。
          //    所以啟用同步嗰一刻，呢三項**一律強制打開**（喺呢度焊死，唔係靠 UI 暗示）：
          //      ・autoRefresh      —— 冇佢根本唔會有新訂單入嚟
          //      ・autoFetchDetails —— 冇佢推送 payload 冇品項，POS 一定拒收（同日實案）
          //      ・autoReload       —— 分頁卡死時自我修復（冷卻期見 grabReloadKey）
          const rawPatch = request.patch || {};
          const patch =
            rawPatch.pushEnabled === true
              ? Object.assign({}, rawPatch, {
                  autoRefresh: true,
                  autoFetchDetails: true,
                  autoReload: true,
                })
              : rawPatch;
          grabGetSettings(cfg.key).then((before) =>
            grabSaveSettings(cfg.key, patch).then((settings) => {
              sendResponse({ ok: true, settings });
              if (before.pushEnabled !== true && settings.pushEnabled === true) {
                grabReleaseHeldOrders(cfg)
                  .then(() => grabRescan(cfg, 'push-enabled'))
                  .catch(() => {});
              }
            }),
          );
          return true;

        case 'CLEAR_LOG':
          chrome.storage.local.set({ [grabLogKey(cfg.key)]: [] }, () => sendResponse({ ok: true }));
          return true;

        case 'RESET_SEEN':
          grabGetState(cfg.key).then((state) => {
            state.seen = {};
            state.counters.duplicatesSkipped = 0;
            grabSaveState(cfg.key, state).then(() => sendResponse({ ok: true }));
          });
          return true;

        case 'RESCAN':
          grabRescan(cfg, 'manual').then(sendResponse);
          return true;

        /**
         * 🔴 2026-09-30：popup 卡片嘅「重試」掣 —— **真正嘅重試推送**。
         *
         * 舊行為只送 `RESCAN`（代按「查詢」）⇒ 唔重置配額、唔放行去重名冊
         * ⇒ 配額用完之後撳佢完全冇用（真機：卡片一直「推送失敗」）。
         */
        case 'RETRY_PUSH':
          grabRetryPushNow(cfg).then(sendResponse);
          return true;

        // 手動觸發 —— force = true，不受自動開關限制，並回傳結果供 UI 顯示
        case 'FETCH_DETAILS':
          grabMaybeFetchDetails(cfg, true).then(sendResponse);
          return true;

        case 'DIAGNOSTICS':
          grabBuildDiagnostics().then(sendResponse);
          return true;

        // 內容腳本回報：請求範本已擷取（值已遮蔽）
        // 內容腳本回報：請求範本已擷取（值已遮蔽）
        // ⚠️ 注意命名：listener 的參數叫 request，所以範本本體放在
        //    request.template。不要寫成 request.headers 那會是 undefined。
        case 'TEMPLATE_CAPTURED': {
          const tpl = request.template || {};
          grabAppendLog(cfg, {
            level: 'info',
            kind: `${cfg.key}_template`,
            summary: `已擷取詳情請求範本（${tpl.method || '?'} ${tpl.url || ''}）`,
            detail: {
              url: tpl.url || null,
              method: tpl.method || null,
              headerNames: tpl.headerNames || [],
              redactedHeaders: grabRedactHeaders(tpl.headers || {}),
              bodyPreview: grabRedact('body', tpl.body || ''),
              sampleId: tpl.sampleId || null,
            },
          });
          sendResponse({ ok: true });
          return true;
        }

        // 內容腳本回報：路線 B 的自我測試結果
        case 'REPLAY_TEST':
          grabAppendLog(cfg, {
            level: request.ok ? 'push_ok' : 'error',
            kind: `${cfg.key}_replay_test`,
            summary: request.ok
              ? '請求重放測試成功 —— 可直接抓取詳情'
              : `請求重放測試失敗，改用模擬點擊：${request.reason || ''}`,
            detail: request,
          });
          sendResponse({ ok: true });
          return true;

        // 🔴🔴 登入前移（2026-09-29）：login.js 偵測到登入表單（可能 session 過期）
        //    → 有憑證就自動填。
        case 'LOGIN_NEEDED':
          grabAutoLoginOnLoginUrl(
            cfg,
            sender && sender.tab && typeof sender.tab.id === 'number'
              ? sender.tab.id
              : null,
            false,
          );
          sendResponse({ ok: true });
          return true;

        // login.js 回報登入結果 → 記入 state.login（主面板「登入狀態」用）＋日誌
        case 'LOGIN_STATUS': {
          const loginOk = request.status === 'ok';
          grabRecordLogin(cfg.key, {
            ok: loginOk,
            stage: request.stage || null,
            error: request.error || null,
          }).then(() => {
            grabAppendLog(cfg, {
              level: loginOk ? 'push_ok' : 'error',
              kind: `${cfg.key}_login`,
              summary: loginOk
                ? `自動登入成功${request.stage === 'already' ? '（原本已登入）' : ''}`
                : `自動登入失敗：${request.error || '未知原因'}`,
              detail: {
                stage: request.stage || null,
                error: request.error || null,
                href: request.href || null,
              },
            });
            sendResponse({ ok: true });
          });
          return true;
        }

        // 內容腳本回報：批次進度
        case 'DETAIL_BATCH_DONE':
          grabGetState(cfg.key).then((state) => {
            state.counters.detailsFetched =
              (state.counters.detailsFetched || 0) + (request.ok || 0);
            state.counters.detailsFailed =
              (state.counters.detailsFailed || 0) + (request.failed || 0);
            return grabSaveState(cfg.key, state).then(() =>
              grabAppendLog(cfg, {
                level: request.failed > 0 ? 'error' : 'info',
                kind: `${cfg.key}_detail_done`,
                summary: `詳情批次完成：成功 ${request.ok || 0} 筆、失敗 ${request.failed || 0} 筆`,
                detail: request,
              }),
            );
          });
          sendResponse({ ok: true });
          return true;
      }
    }
  }

  return false;
});

function stopTimer() {
  chrome.alarms.clear("grabDataAlarm", () => {
    chrome.storage.local.set({ isTimerActive: false, nextRefreshTime: null, fetchStatus: "Stopped" });
  });
}

function setupTimer(seconds) {
  const mins = parseFloat(seconds) / 60;
  chrome.alarms.clear("grabDataAlarm", () => {
    chrome.alarms.create("grabDataAlarm", { periodInMinutes: mins });
    chrome.storage.local.set({
      isTimerActive: true,
      currentIntervalSecs: seconds,
      nextRefreshTime: Date.now() + (seconds * 1000)
    });
    fetchData();
  });
}

async function fetchData() {
  chrome.storage.local.set({ fetchStatus: "Fetching...", lastSyncStatus: "Syncing..." });
  await keepSessionAlive();

  const settings = await chrome.storage.local.get(['startDate', 'machineId', 'currentIntervalSecs', 'isTimerActive']);

  const now = new Date();
  const currentTimeStr = formatDateTime(now);

  // Logic to prevent "Date Range Illegal" (max 30 days)
  let start = settings.startDate ? new Date(settings.startDate) : new Date("2026-06-30");
  const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

  if (start < thirtyDaysAgo) {
    console.warn("Date range too long. Adjusting to 30 days ago.");
    start = thirtyDaysAgo;
  }

  const startTimeStr = `${start.getFullYear()}-${(start.getMonth()+1).toString().padStart(2,'0')}-${start.getDate().toString().padStart(2,'0')} 00:00:00`;

  const params = new URLSearchParams();
  params.append('storeNo', '-1');
  params.append('orderTime', startTimeStr);
  params.append('endOrderTime', currentTimeStr);
  params.append('pageNo', '1');
  params.append('pageSize', '100');

  try {
    const response = await fetch(TARGET_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: params.toString()
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`MacauPay Error ${response.status}: ${errText.substring(0, 50)}`);
    }

    const data = await response.json();
    if (data.result === "false") throw new Error(data.message || "MacauPay denied request");

    if (data.list) {
      // 🔴🔴 2026-10-02：尊重主面板「同步到 macau-pos」開關（mpayPushEnabled）。
      //    關咗就只記低、唔推 Supabase（預設開，保持舊行為）。
      const mpayPush = await new Promise((res) =>
        chrome.storage.local.get(['mpayPushEnabled'], (r) => res(r.mpayPushEnabled !== false)),
      );
      if (mpayPush) await syncToSupabase(data.list, settings.machineId);
    }

    let updateObj = {
      lastGrabbedData: data,
      lastGrabTime: new Date().toLocaleString(),
      fetchStatus: "Success",
      error: null
    };

    if (settings.isTimerActive !== false) {
      updateObj.nextRefreshTime = Date.now() + ((settings.currentIntervalSecs || 60) * 1000);
    }
    await chrome.storage.local.set(updateObj);

  } catch (error) {
    await chrome.storage.local.set({
      error: error.message,
      fetchStatus: "Failed",
      lastSyncStatus: "Sync Failed",
      lastGrabTime: new Date().toLocaleString()
    });
  }
}

async function syncToSupabase(transactions, machineId) {
  const payload = transactions.map(tx => ({
    machine_id: machineId || "unknown",
    pay_order_no: tx.payordNo || null,
    order_time: tx.orderTime || null,
    order_amount: tx.orderAmt ? parseFloat(tx.orderAmt) : 0,
    order_currency: tx.orderCcy || null,
    store_name: tx.storeName || tx.merchantNameCh || null,
    transaction_status: tx.transStatus || null,
    trade_no: tx.tradeNo || null,
    order_no: tx.orderNo || null,
    raw_json: tx
  }));

  try {
    const response = await fetch(`${SUPABASE_BASE_URL}?on_conflict=pay_order_no`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await response.text());
    chrome.storage.local.set({ lastSyncStatus: `Synced ${transactions.length} records` });
  } catch (e) {
    chrome.storage.local.set({ lastSyncStatus: "Sync Error: " + e.message.substring(0, 50) });
  }
}