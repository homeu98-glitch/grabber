/**
 * 驗證 mfood-bridge.js 的正規化邏輯（用你提供的真實 API 回應）
 *
 * 最重要的一組測試是「金額單位」：mfood 是元，澳覓是分。
 * 若有人誤改成除以 100，這裡會立刻失敗。
 *
 * 執行：node test/mfood.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BRIDGE_PATH = path.join(__dirname, "..", "mfood-bridge.js");

// ------------------------------------------------------------ 真實樣本

const LIST_SAMPLE = {
  result: [
    {
      id: "202609230932086463403",
      storeName: "表嫂美食(蒸煎手打肉餅,酸菜魚,沙薑雞飯)",
      createTime: 1790127128000,
      finishTime: 1790131657000,
      tradeNo: "CRD202609230932086463403",
      amtn: 75.9,
      businessAmtn: 62,
      discountFee: 5.0,
      deliveryFee: 13.9,
      discountDeliveryAmtn: 0.0,
      orderStatus: 4,
      transactionStatus: 2,
      deliveryType: 1,
      productAmtn: 64.0,
      boxFee: 2.0,
      plasticBagFee: 1.0,
      serviceFee: 0.0,
      isViewRefund: true,
      isHandlerRefund: false,
      plasticBagQty: 1,
      plasticBagPrice: 1.0,
      merchantDeliveryAmtn: 12.0,
      orderNumber: 1,
      fullReductionAmtn: 2.0,
      discountVoucherAmtn: 3.0,
      refundAmtn: 0.0,
      isReserve: false,
      storeId: "202208171133015979780",
      receiverMobile: "",
    },
    {
      id: "202609211813141397400",
      storeName: "表嫂美食",
      createTime: 1789985594000,
      finishTime: 1789987053995,
      tradeNo: "CRD202609211813141397400",
      amtn: 59,
      businessAmtn: 59,
      deliveryFee: 0.0,
      orderStatus: 4,
      transactionStatus: 2,
      deliveryType: 3,
      productAmtn: 58.0,
      boxFee: 2.0,
      plasticBagFee: 1.0,
      orderNumber: 2,
      refundAmtn: 0.0,
      storeId: "202208171133015979780",
    },
  ],
  total: 110,
};

const DETAIL_SAMPLE = {
  id: "202609230932086463403",
  buyerNick: "Nana",
  receiverName: "郭",
  receiverMobile: "853-63726611",
  receiverGender: 1,
  address: "大三巴牌坊(花王堂區)大三巴街11號華發大廈5/a",
  remark: "醬油分開，不吃蔥，不吃香菜，不吃蒜，謝謝，減油，減糖，減鹽，謝謝",
  deliveryType: 1,
  prdtList: [
    {
      productId: "202609230932086513404",
      productName: "表嫂手打肉餅",
      productType: 1,
      skuId: "202503071118319513935",
      skuName: "份",
      skuPrice: 58,
      boxPrice: 1,
      boxNum: 2,
      buyCount: 1,
      refundQty: 0,
      productAmtn: 64,
      imgUrl: "https://media.mfoodapp.com/merchant/product/2025/3/x.png",
      propertiesNames: ["馬蹄", "米飯", "奶茶", "蒸"],
      ingredientNames: ["加蒸蛋"],
      extendNames: [],
    },
  ],
  tablewareQty: "無需餐具",
  boxFee: 2,
  plasticBagFee: 1,
  serviceFee: 0,
  deliveryFee: 1.9,
  giftAmtn: 10,
  voucherAmtn: 3,
  fullReductionAmtn: 2,
  disFullName: "滿60減2",
  disVoucherName: "$3，滿50可用",
  disGiftName: "$10，滿60可用",
  totalAmtn: 63.9,
  amtn: 53.9,
  createDate: 1790127128000,
  tradeNo: "CRD202609230932086463403",
  tradeSeq: "BOCAPPPAY202609230932119689361",
  payTime: 1790127138000,
  acceptDate: 1790127162000,
  merchantDisDeliveryAmtn: 12.0,
  deliverySubsidyAmtn: 0.8,
  riderName: "吳偉光",
  riderPhone: "853-66394021",
  basicDeliveryFee: 13.9,
  businessAmtn: 62.0,
  placeOrderVoucherName: "返無門檻$3商家券",
  memberLevel: 0,
  orderStatus: 4,
  transactionStatus: 2,
};

const STATS_SAMPLE = {
  orderCount: 110,
  totalOrderAmt: 10738.25,
  storeBusinessAmt: 9425.0,
  avgAmt: 85.68,
  orderDiscountFee: 421.0,
  orderDeliveryFee: 1313.25,
  merchantDeliveryFee: 1221.0,
  merchantSpecialDeliveryFee: 1221.0,
  merchantFarawayDeliveryFee: 0,
  merchantSelfDeliveryFee: 0.0,
};

// ------------------------------------------------------------ 沙箱

function loadBridge() {
  let listener = null;
  const sent = [];
  const state = { onMessage: null };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Set, Map, Object, Array, Number, String, Boolean,
    JSON, Math, Date, isFinite, parseInt, parseFloat, RegExp,
    window: {
      location: { href: "https://merchant.mfoodapp.com/#/order", origin: "https://merchant.mfoodapp.com" },
      addEventListener(type, fn) { if (type === "message") listener = fn; },
      postMessage() {},
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) { sent.push(msg); if (cb) cb(); },
        onMessage: { addListener(fn) { state.onMessage = fn; } },
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, "utf8"), sandbox, { filename: "mfood-bridge.js" });

  function feed(kind, payload, meta) {
    if (!listener) throw new Error("bridge 沒有註冊 message listener");
    listener({ source: sandbox.window, data: { __mfoodGrabber: true, kind, payload, meta: meta || {} } });
  }

  return { feed, sent, state };
}

// ------------------------------------------------------------ 斷言

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

function group(name) { console.log(`\n${name}`); }

// ------------------------------------------------------------ 測試

group("[1] 🔴 金額單位：mfood 是「元」，絕對不能除以 100");
{
  const b = loadBridge();
  b.feed("order_list", LIST_SAMPLE);
  const row = b.sent.find((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").rows[0];

  check("businessAmtn 62 → 62（不是 0.62）", row.amount.businessAmount, 62);
  check("amtn 75.9 → 75.9（不是 0.759）", row.amount.payAmount, 75.9);
  check("productAmtn 64 → 64", row.amount.productAmount, 64);
  check("deliveryFee 13.9 → 13.9", row.amount.deliveryFee, 13.9);
  check("boxFee 2 → 2", row.amount.boxFee, 2);
  check("明確的 0 保留為 0", row.amount.refundAmount, 0);

  const list = b.sent.find((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED");
  check("第二筆自取單 amtn 59 → 59", list.rows[1].amount.payAmount, 59);
}

group("[2] 時間：epoch 毫秒 → ISO 8601");
{
  const b = loadBridge();
  b.feed("order_list", LIST_SAMPLE);
  const row = b.sent.find((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").rows[0];

  check("createTime 轉 ISO", row.createdAt, new Date(1790127128000).toISOString());
  check("原始毫秒保留", row.createdAtMs, 1790127128000);
  check("finishTime 轉 ISO", row.finishedAt, new Date(1790131657000).toISOString());
  check("ISO 格式正確", /^\d{4}-\d{2}-\d{2}T/.test(row.createdAt), true);
}

group("[3] 枚舉解碼");
{
  const b = loadBridge();
  b.feed("order_list", LIST_SAMPLE);
  const rows = b.sent.find((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").rows;

  check("deliveryType 1 → delivery", rows[0].fulfillmentType, "delivery");
  check("deliveryType 3 → pickup", rows[1].fulfillmentType, "pickup");
  check("orderStatus 4 → completed", rows[0].orderStatus, "completed");
  check("transactionStatus 2 → paid", rows[0].transactionStatus, "paid");
  check("原始碼保留", rows[0].orderStatusRaw, 4);

  // 未觀察到的值必須回 null（不猜）
  b.feed("order_list", {
    result: [{ id: "TK_UNKNOWN", tradeNo: "X", amtn: 10, orderStatus: 99, deliveryType: 7 }],
    total: 1,
  });
  const unknown = b.sent.filter((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows[0];
  check("未觀察到的 orderStatus 回 null", unknown.orderStatus, null);
  check("未觀察到的 deliveryType 回 null", unknown.fulfillmentType, null);
  check("但原始碼仍保留", unknown.orderStatusRaw, 99);
}

group("[4] 列表 vs 詳情的 amtn 差異（同單不同值）");
{
  const b = loadBridge();
  b.feed("order_list", LIST_SAMPLE);
  const fromList = b.sent.find((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").rows[0];

  b.feed("order_detail", DETAIL_SAMPLE);
  const fromDetail = b.sent.find((m) => m.type === "MFOOD_ORDER_DETAIL_CAPTURED").detail;

  check("列表 amtn = 75.9（未扣補貼與贈品）", fromList.amount.payAmount, 75.9);
  check("詳情 amtn = 53.9（客人實際支付）", fromDetail.amount.payAmount, 53.9);
  check("兩者確實不同（不可互換）", fromList.amount.payAmount !== fromDetail.amount.payAmount, true);
  check("詳情 totalAmtn = 63.9（扣贈品前）", fromDetail.amount.totalAmount, 63.9);
  check("兩邊 businessAmtn 一致 = 62", [fromList.amount.businessAmount, fromDetail.amount.businessAmount], [62, 62]);
}

group("[5] 品項與規格合併");
{
  const b = loadBridge();
  b.feed("order_detail", DETAIL_SAMPLE);
  const d = b.sent.find((m) => m.type === "MFOOD_ORDER_DETAIL_CAPTURED").detail;

  check("品項數 = 1", d.items.length, 1);
  const it = d.items[0];
  check("菜名", it.displayName, "表嫂手打肉餅");
  check("mfood 菜名無編號，itemCode 為 null", it.itemCode, null);
  check("數量 buyCount", it.quantity, 1);
  // 🔴 2026-09-24 改：單價由 `skuPrice` 改成「實收單價」= productAmtn / 數量。
  //
  // 原因（使用者提供嘅真實 payload）：表嫂手打肉餅 skuPrice 58，
  // 但 productAmtn 67 —— 差額係**加購**（轉五谷飯、加蒸蛋）。
  // 用 skuPrice 會令 POS 收據「原價合計」少咗加購嘅錢 → 同平台嘅營業額對唔上，
  // 商家對數就會對唔到。平台自己嘅商品資訊欄顯示嘅亦係實收價（67）。
  check("實收單價 = productAmtn / 數量（含加購）→ 64", it.unitPrice, 64);
  check("小計 productAmtn 64 → 64", it.lineTotal, 64);
  check("skuName", it.skuName, "份");
  check(
    "規格三組合併（規格＋加料＋額外）",
    it.specs,
    ["馬蹄", "米飯", "奶茶", "蒸", "加蒸蛋"],
  );
  check("退款數量", it.refundQuantity, 0);
}

group("[6] 顧客、騎手、優惠名稱");
{
  const b = loadBridge();
  b.feed("order_detail", DETAIL_SAMPLE);
  const d = b.sent.find((m) => m.type === "MFOOD_ORDER_DETAIL_CAPTURED").detail;

  check("顧客姓名", d.customer.name, "郭");
  check("顧客暱稱", d.customer.nickname, "Nana");
  check("顧客電話（完整，非遮罩）", d.customer.phone, "853-63726611");
  check("地址", d.customer.address, "大三巴牌坊(花王堂區)大三巴街11號華發大廈5/a");
  check("備註", d.customer.remark.startsWith("醬油分開"), true);
  check("餐具", d.customer.tableware, "無需餐具");

  check("騎手姓名", d.rider.name, "吳偉光");
  check("騎手電話", d.rider.phone, "853-66394021");

  check("滿減名稱", d.amount.discountNames.fullReduction, "滿60減2");
  check("商家券名稱", d.amount.discountNames.voucher, "$3，滿50可用");
  check("贈品名稱", d.amount.discountNames.gift, "$10，滿60可用");
  check("贈品金額 10 → 10", d.amount.giftAmount, 10);
  check("商家配送補貼 12 → 12", d.amount.merchantDeliveryAmount, 12);

  check("支付流水號", d.tradeSeq, "BOCAPPPAY202609230932119689361");
  check("時間軸：下單", d.timeline.created, new Date(1790127128000).toISOString());
  check("時間軸：付款", d.timeline.paid, new Date(1790127138000).toISOString());
}

group("[7] 頁面統計");
{
  const b = loadBridge();
  b.feed("stats", STATS_SAMPLE);
  const msg = b.sent.find((m) => m.type === "MFOOD_STATS_CAPTURED");

  check("有送出統計", !!msg, true);
  check("訂單總數", msg.stats.orderCount, 110);
  check("營業總額 9425 → 9425", msg.stats.storeBusinessAmount, 9425);
  check("平均客單價", msg.stats.avgAmount, 85.68);
  check("總金額 10738.25 → 10738.25", msg.stats.totalOrderAmount, 10738.25);
}

group("[8] 防禦性：壞資料不崩潰、不誤判");
{
  const b = loadBridge();
  const count = () => b.sent.filter((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").length;

  // 🔴 2026-09-25 改：空結果**一定要轉發**。
  //    舊斷言（「空列表不轉發」）令「店冇新單」被當成「頁面死咗」
  //    ⇒ 10 分鐘後誤報「冇收到資料」（使用者實案）。
  //    0 行係安全嘅：background 收到 rows: [] 只更新 lastListCaptureAt，fresh 空 ⇒ 唔推送。
  b.feed("order_list", { result: [], total: 0 });
  check("🔴 空列表都要轉發（否則無法分辨頁面死活）", count(), 1);
  const emptyMsg = b.sent.filter((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").pop();
  check("標記 empty = true", emptyMsg.meta.empty, true);
  check("rows 係空陣列", emptyMsg.rows.length, 0);
  check("parseFailures = 0（唔係解析失敗）", emptyMsg.meta.parseFailures, 0);

  // 有 1 行但冇 id ＝ 解析失敗 → **轉發但標記**（唔可以靜默當「冇單」，會掩蓋解析壞掉）
  b.feed("order_list", { result: [{ amtn: 10 }], total: 1 });
  check("整頁解析失敗仍然轉發（唔可以靜默）", count(), 2);
  const badMsg = b.sent.filter((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").pop();
  check("🔴 標記 parseFailures = 1", badMsg.meta.parseFailures, 1);
  check("rows 係空", badMsg.rows.length, 0);

  b.feed("order_list", { result: [null, { id: "TK_OK", tradeNo: "T", amtn: 5 }], total: 2 });
  const rows = b.sent.filter((m) => m.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows;
  check("null 列被濾掉", rows.length, 1);
  check("保留的那筆正確", rows[0].externalOrderId, "TK_OK");

  // 缺欄位 → null，不是 0
  check("缺 businessAmtn 回 null", rows[0].amount.businessAmount, null);

  // 不是訂單的物件不應被誤判
  b.feed("order_detail", { foo: "bar" });
  check("無效詳情不轉發", b.sent.filter((m) => m.type === "MFOOD_ORDER_DETAIL_CAPTURED").length, 0);
}

group("[9] 去重（詳情層）");
{
  const b = loadBridge();
  b.feed("order_detail", DETAIL_SAMPLE);
  b.feed("order_detail", DETAIL_SAMPLE);
  check(
    "重複詳情只轉發一次",
    b.sent.filter((m) => m.type === "MFOOD_ORDER_DETAIL_CAPTURED").length,
    1,
  );
}

group("[10] 🔴 平台「訂單號」係字串（#1）—— 唔可以當成 NaN 而跌落「id 尾 6 位」");
{
  // 真實 mfood 後台：訂單編號 = CRD… ／ 訂單號 = #1、#2（每日流水）
  // 舊寫法 `Number("#1")` = NaN ⇒ 當成冇訂單號 ⇒ POS 顯示 `MFOOD#269108`
  // （＝CRD202609251303412269108 嘅尾 6 位），而唔係店員用嘅 `#1`。
  // 商家實案：「為什麼 mfood 訂單是這個編號???」
  const b = loadBridge();
  b.feed("order_list", {
    result: [
      {
        id: "202609251303412269108",
        tradeNo: "CRD202609251303412269108",
        orderNumber: "#1",
        amtn: 65,
        orderStatus: 4,
      },
    ],
    total: 1,
  });
  const row = b.sent.filter((x) => x.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows[0];
  check("🔴 認得字串 '#1'", row.orderNumber, 1);
  check("🔴 localOrderNo 要係 '#1'（唔可以變 269108）", row.localOrderNo, "#1");
  check("externalOrderId 不受影響", row.externalOrderId, "202609251303412269108");

  // 對照 1：平台真係俾數字時，照樣要 work
  const b2 = loadBridge();
  b2.feed("order_list", {
    result: [{ id: "202609250937046870290", orderNumber: 2, amtn: 62, orderStatus: 4 }],
    total: 1,
  });
  const row2 = b2.sent.filter((x) => x.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows[0];
  check("數字 2 → localOrderNo '2'（唔可以變 '2' 以外嘅嘢）", row2.localOrderNo, "2");

  // 對照 2：真係冇訂單號 → 兜底（維持原本行為：id 尾 6 位）
  const b3 = loadBridge();
  b3.feed("order_list", {
    result: [{ id: "202609250937046870290", amtn: 62, orderStatus: 4 }],
    total: 1,
  });
  const row3 = b3.sent.filter((x) => x.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows[0];
  check("冇訂單號 → 兜底用 id 尾 6 位", row3.localOrderNo, "870290");
}

// ---------------------------------------------------------------------------
// 🔴🔴 2026-09-29：詳情路徑以前**完全冇單號欄位**
//
// 後果：凡係「補 items 嗰輪由詳情路徑送出」嘅單，POS `grabberLocalOrderNo()`
// 五個候選全空 ⇒ 必然跌到 `MFOOD#<externalOrderId 尾 6 位>`（實案 `MFOOD#883658`），
// 同 popup 由**列表**記低嘅 `#75` 唔同 ⇒ 商家當係「寄錯單」。
//
// 呢組測試鎖兩件事：
//   ① 詳情 payload 有單號 → 一定要帶出去（數字 ＋ 平台原字串）
//   ② 詳情 payload 冇單號 → **只可以係 null**，絕對唔可以喺 bridge 層 fallback
//      做「id 尾 6 位」（否則 background.js 嘅註冊表回填永遠冇機會生效，
//      兩條路徑亦會永遠對唔上）
// ---------------------------------------------------------------------------

function detailOf(b) {
  const m = b.sent.filter((x) => x.type === "MFOOD_ORDER_DETAIL_CAPTURED").pop();
  return m ? m.detail : null;
}

group("[9] 🔴 詳情路徑一定要帶單號（2026-09-29 修：以前完全冇）");
{
  // ① 平台俾字串 "#75"
  const b1 = loadBridge();
  b1.feed("order_detail", {
    id: "202609241710000786777",
    orderNumber: "#75",
    tradeNo: "CRD202609241710000786777",
    amtn: 59,
    orderStatus: 4,
    prdtList: [],
  });
  const d1 = detailOf(b1);
  check("詳情有單號 → orderNumber 要係數字 75", d1.orderNumber, 75);
  check("詳情有單號 → localOrderNo 要係平台原字串 '#75'", d1.localOrderNo, "#75");
  check("externalOrderId 不受影響", d1.externalOrderId, "202609241710000786777");

  // ② 平台俾數字
  const b2 = loadBridge();
  b2.feed("order_detail", {
    id: "202609291313345883658",
    orderNumber: 883658,
    amtn: 63,
    orderStatus: 4,
    prdtList: [],
  });
  check("數字單號照樣認得", detailOf(b2).localOrderNo, "883658");

  // ③ 🔴 冇單號 → 一定要係 null（唔可以 fallback 尾 6 位）
  const b3 = loadBridge();
  b3.feed("order_detail", {
    id: "202609291313345883658",
    amtn: 63,
    orderStatus: 4,
    prdtList: [],
  });
  const d3 = detailOf(b3);
  check("🔴 詳情冇單號 → orderNumber 一定要係 null", d3.orderNumber, null);
  check("🔴 詳情冇單號 → localOrderNo 一定要係 null（唔可以變 883658）", d3.localOrderNo, null);

  // ④ 兩條路徑同一張單，單號必須一致（呢個就係「寄錯單」錯覺嘅源頭）
  const b4 = loadBridge();
  b4.feed("order_list", {
    result: [{ id: "202609241710000786777", orderNumber: "#75", amtn: 59, orderStatus: 4 }],
    total: 1,
  });
  const listRow = b4.sent.filter((x) => x.type === "MFOOD_ORDER_LIST_CAPTURED").pop().rows[0];
  check("🔴 列表同詳情要出同一個單號", listRow.localOrderNo, d1.localOrderNo);
}

// ------------------------------------------------------------ 結果

// 🔴🔴 2026-09-30：訂單狀態 DOM 測試（鎖實真機單選 DOM）
//   真機結構：readonly input（placeholder「請選擇」）＋ `<li><span>店名</span></li>` 選項；
//   頁面仲有 訂單類型／配送類型 等其他 `.el-select`，全部都有自己嘅「全部」選項。
//   呢場測試證明：setOrderStatusAll 一定要 scope 到「訂單狀態」嗰個 .el-select，
//   唔可以掃成個頁（否則會撳錯兄弟 select 嘅「全部」）。

function mkEl(tag, opts) {
  opts = opts || {};
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    _cls: opts.cls || "",
    _selfText: opts.text || "",
    _attrs: opts.attrs || {},
    value: opts.value === undefined ? "" : opts.value,
    children: [],
    parentElement: null,
    _w: opts.w === undefined ? 200 : opts.w,
    _h: opts.h === undefined ? 28 : opts.h,
    clicked: 0,
    onClick: opts.onClick || null,
    get textContent() {
      let s = el._selfText;
      for (const c of el.children) s += c.textContent;
      return s;
    },
    get className() { return el._cls; },
    classList: {
      _s: new Set(String(opts.cls || "").split(/\s+/).filter(Boolean)),
      contains(c) { return this._s.has(c); },
      add(c) { this._s.add(c); },
    },
    getBoundingClientRect() { return { width: el._w, height: el._h, top: 0, left: 0 }; },
    click() { el.clicked++; if (typeof el.onClick === "function") el.onClick(el); },
    closest(sel) {
      let n = el;
      while (n) { if (matchToken(n, sel)) return n; n = n.parentElement; }
      return null;
    },
    querySelectorAll(sel) { return docCollect(el, sel); },
    querySelector(sel) { return docCollect(el, sel)[0] || null; },
  };
  return el;
}
function append(parent, child) { child.parentElement = parent; parent.children.push(child); return child; }
function matchToken(el, tok) {
  tok = tok.trim();
  if (tok[0] === "[") {
    const m = tok.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    return m[2] === undefined ? (m[1] in el._attrs) : String(el._attrs[m[1]] || "") === m[2];
  }
  const m = tok.match(/^([a-zA-Z0-9]*)((?:[.#][\w-]+)*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[2]) {
    const classes = m[2].split(/(?=[.#])/).map((s) => s.slice(1));
    for (const c of classes) if (!el.classList.contains(c)) return false;
  }
  return true;
}
function matchesAny(el, sel) {
  return sel.split(",").some((part) => {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    return matchToken(el, toks[toks.length - 1]);
  });
}
function docCollect(root, sel) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (matchesAny(c, sel)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}
function setVisible(items, vis) { for (const it of items) { it._w = vis ? 200 : 0; it._h = vis ? 30 : 0; } }

function buildOrderStatusPage(opts) {
  opts = opts || {};
  const body = mkEl("body");
  const mkOpts = (names) =>
    names.map((n) => {
      const li = mkEl("li", { cls: "el-select-dropdown__item", w: 0, h: 0 });
      append(li, mkEl("span", { text: n }));
      return li;
    });

  // 兄弟 select：訂單類型（都有「全部」）—— 放喺前面，模擬「另一個 dropdown 都開住」排喺前面
  const tItems = mkOpts(["全部", "自取", "外送"]);
  const tInput = mkEl("input", { cls: "el-input__inner", value: "" });
  const tSelect = mkEl("div", { cls: "el-select" });
  const tDropdown = mkEl("div", { cls: "el-select-dropdown" });
  const tUl = mkEl("ul", { cls: "el-select-dropdown__list" });
  tItems.forEach((li) => { li.onClick = () => { tInput.value = li.textContent; }; append(tUl, li); });
  append(tDropdown, tUl); append(tSelect, tInput); append(tSelect, tDropdown);
  const tForm = mkEl("div", { cls: "el-form-item", text: "訂單類型" });
  append(tForm, mkEl("label", { text: "訂單類型" })); append(tForm, tSelect);
  append(body, tForm);

  // 訂單狀態 select（目標）
  const osItems = mkOpts(["全部", "待接單", "商家已接單", "待送達", "待退款", "已完成", "已退款"]);
  const osInput = mkEl("input", { cls: "el-input__inner", value: opts.statusValue || "" });
  const osSelect = mkEl("div", { cls: "el-select" });
  const osDropdown = mkEl("div", { cls: "el-select-dropdown" });
  const osUl = mkEl("ul", { cls: "el-select-dropdown__list" });
  osItems.forEach((li) => { li.onClick = () => { osInput.value = li.textContent; }; append(osUl, li); });
  append(osDropdown, osUl); append(osSelect, osInput); append(osSelect, osDropdown);
  const osForm = mkEl("div", { cls: "el-form-item", text: "訂單狀態" });
  append(osForm, mkEl("label", { text: "訂單狀態" })); append(osForm, osSelect);
  append(body, osForm);

  // 🔴🔴 保真度關鍵：真機 body 係成張表，文字數以千計。nearOrderStatusLabel 有
  //    `t.length <= 60` 守衛（防止「祖先太長就唔算 label」）。如果 mock body 太短，
  //    「訂單類型」嗰個 input 會因 body 含有「訂單狀態」而誤判命中 ⇒ 揀錯 select。
  //    ⇒ 加一嚿大 filler，令 body.textContent 遠超 60，守衛先會同真機一樣踢走 body。
  append(body, mkEl("div", { text: "頁面其他內容".repeat(20) }));

  return { body, osInput, osItems, tInput, tItems, osSelect };
}

function loadOrderStatusBridge(page, hash) {
  let onMessage = null;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    Set, Map, Object, Array, Number, String, Boolean, JSON, Math, Date,
    isFinite, parseInt, parseFloat, RegExp,
    document: {
      querySelectorAll: (sel) => docCollect(page.body, sel),
      querySelector: (sel) => docCollect(page.body, sel)[0] || null,
    },
    window: {
      location: { href: "https://merchant.mfoodapp.com/" + (hash || "#/order"), hash: hash || "#/order", origin: "https://merchant.mfoodapp.com" },
      addEventListener() {},
      postMessage() {},
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage() {},
        onMessage: { addListener(fn) { onMessage = fn; } },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, "utf8"), sandbox, { filename: "mfood-bridge.js" });
  return { sandbox, get onMessage() { return onMessage; } };
}

group("[11] 🔴🔴 訂單狀態→「全部」（真機單選 DOM + 兄弟 select 同名「全部」，2026-09-30）");
const orderStatusTestsDone = (async () => {
  // ① 需要選：預先開 dropdown（模擬面板已展開）→ 直接揀「全部」
  {
    const page = buildOrderStatusPage({ statusValue: "" });
    setVisible(page.osItems, true);
    const b = loadOrderStatusBridge(page, "#/order");
    const resp = await new Promise((res) => b.onMessage({ type: "GRAB_SET_ORDER_STATUS_ALL" }, {}, res));
    check("① 需要選 → ok:true", !!(resp && resp.ok), true);
    check("① 揀中後 input.value＝全部", page.osInput.value, "全部");
  }
  // ② 已經係全部：唔開、唔撳
  {
    const page = buildOrderStatusPage({ statusValue: "全部" });
    const b = loadOrderStatusBridge(page, "#/order");
    const resp = await new Promise((res) => b.onMessage({ type: "GRAB_SET_ORDER_STATUS_ALL" }, {}, res));
    check("② 已經全部 → already:true", !!(resp && resp.already), true);
    check("② 完全冇開過 dropdown（input.clicked=0）", page.osInput.clicked, 0);
  }
  // ③ 🔴🔴 兄弟 select 同名「全部」都開住 → 一定要 scope 到訂單狀態嗰個 .el-select
  {
    const page = buildOrderStatusPage({ statusValue: "" });
    setVisible(page.osItems, true);
    setVisible(page.tItems, true); // 訂單類型 dropdown 都開住、且排喺前面
    const b = loadOrderStatusBridge(page, "#/order");
    const resp = await new Promise((res) => b.onMessage({ type: "GRAB_SET_ORDER_STATUS_ALL" }, {}, res));
    check("③ 兄弟都開住 → 照樣 ok:true", !!(resp && resp.ok), true);
    check("③ 只揀訂單狀態嘅全部", page.osInput.value, "全部");
    check("③ 兄弟 select 冇被撳錯（tInput 仍空白）", page.tInput.value, "");
  }
  // ④ 財務頁 → skipped（唔使設，唔當失敗）
  {
    const page = buildOrderStatusPage({ statusValue: "" });
    const b = loadOrderStatusBridge(page, "#/finance/tackout-check");
    const resp = await new Promise((res) => b.onMessage({ type: "GRAB_SET_ORDER_STATUS_ALL" }, {}, res));
    check("④ 財務頁 → skipped（唔當失敗）", !!(resp && resp.skipped), true);
  }
})();

// 🔴🔴 一定要等 [11] 個 async 訂單狀態測試全部跑完（含兄弟 select 碰撞、財務頁 skipped）
//    先出報告 —— 唔可以擺喺一個 detach 嘅 microtask，否則 process.exit 會先殺咗佢哋。
orderStatusTestsDone
  .then(() => {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("🔴 [11] 訂單狀態測試異常：", e);
    process.exit(1);
  });
