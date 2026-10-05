/**
 * 驗證 aomi-bridge.js 的正規化與去重邏輯（用你提供的真實 API 範例）
 *
 * 為什麼要這支測試：擴充功能本身要在 Chrome 裡才能跑，但「欄位對應」與
 * 「去重」是最容易出錯又最難肉眼驗證的部分。這裡用 DOM/chrome stub 把
 * bridge.js 載進 node，直接餵真實 JSON，斷言輸出正確。
 *
 * 執行：node test/normalize.test.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BRIDGE_PATH = path.join(__dirname, "..", "aomi-bridge.js");

// ------------------------------------------------------------ 測試資料

const ORDER_LIST_SAMPLE = {
  resultCode: "200",
  businessMsg: { businessCode: 0, businessNote: "Success", traceId: "1733dca50f509f7e" },
  detailMsg: {
    total: 3,
    list: [
      {
        storeId: "16857",
        storeName: "表嫂美食（蒸煎手打肉餅&酸菜魚&沙薑雞飯&蒸飯）",
        orderDateTime: "2026-09-17 19:07:11",
        finishTime: "2026-09-17 19:58:01",
        storeSeqNo: "#2",
        orderId: "TK001361260917190710813",
        goodsAmount: 13400,
        merchantActAmount: 1100,
        turnoverAmount: 12600,
        refundAmt: 0,
        settleAmount: 10019,
        sendType: "專送",
        stateVal: "訂單已送達",
        memberPhone: "853-****9190",
        tipFeeByUser: 0,
        tipFeeByMerchant: 0,
        boxOrPackageAmt: 0,
        plasticBagAmt: 0,
        holidayServiceFeeAmt: 0,
        sendFeeAmt: 1200,
        storeRedpacket: 700,
      },
      {
        storeId: "16857",
        storeName: "表嫂美食",
        orderDateTime: "2026-09-17 18:53:14",
        finishTime: "2026-09-17 20:39:56",
        storeSeqNo: "#R1",
        orderId: "TK001950260917185313340",
        goodsAmount: 10700,
        merchantActAmount: 1200,
        turnoverAmount: 9800,
        refundAmt: 0,
        settleAmount: 7421,
        sendType: "快送",
        stateVal: "訂單已送達",
        memberPhone: "853-****2119",
        sendFeeAmt: 1555,
        storeRedpacket: 1000,
      },
      {
        storeId: "16857",
        storeName: "表嫂美食",
        orderDateTime: "2026-09-17 12:00:32",
        finishTime: "2026-09-17 12:48:42",
        storeSeqNo: "#1",
        orderId: "TK001114260917120032008",
        goodsAmount: 5600,
        merchantActAmount: 600,
        turnoverAmount: 5300,
        refundAmt: 0,
        settleAmount: 4033,
        sendType: "專送",
        stateVal: "訂單已送達",
        memberPhone: "853-****0326",
        sendFeeAmt: 1200,
        storeRedpacket: 0,
      },
    ],
  },
};

const ORDER_DETAIL_SAMPLE = {
  resultCode: "200",
  businessMsg: { businessCode: 0, businessNote: "Success", traceId: "17298c42244082d6" },
  detailMsg: {
    orderId: "TK001361260917190710813",
    orderStateStr: "客戶已確認收餐",
    orderState: "ORDER_ARRIVED",
    cancelType: "NORMAL",
    storeSeq: "2",
    memberShip: "VIP",
    sendType: "澳覓專送",
    sendTypeEnum: "ZHUANSONG",
    userId: "201709281702090996857361",
    userNickName: "古",
    userName: "古",
    userRegistPhone: "853-****9190",
    userAddress: "新福花園（風順堂區） 河邊新街，新福花園13樓D",
    remark: null,
    tableware: "",
    orderGoods: [
      {
        menuName: "A16.洋蔥炒雞",
        params: "",
        oriPrice: 6700,
        actPrice: 6700,
        copies: 1,
        totalActPrice: 6700,
      },
      {
        menuName: "A22.蕃茄香煎時魚",
        params: "",
        oriPrice: 6700,
        actPrice: 6700,
        copies: 1,
        totalActPrice: 6700,
      },
    ],
    storeFullTicket: "返80-7商家券",
    boxAmt: 200,
    plasticAmt: 100,
    sendAmt: 1200,
    totalAmt: 13400,
    merchantActAmt: 1100,
    merchantActDetails: [
      { actContent: "滿110.0減4.0", actPrice: 400, merchantActPrice: 400 },
      { actContent: "商家代金券$7", actPrice: 700, merchantActPrice: 700 },
    ],
    platActDetails: [{ actContent: "平台券平台承担费用", actPrice: 700, merchantActPrice: 0 }],
    turnoverAmt: 12600,
    platServiceAmt: 2581,
    settleAmount: 10019,
    payAmt: 12100,
    goodsAllAmount: 13700,
    states: [
      { stateName: "付款成功", stateDate: "2026-09-17 19:07:21" },
      { stateName: "商家接單", stateDate: "2026-09-17 19:07:48" },
      { stateName: "商家出餐", stateDate: "2026-09-17 19:50:00" },
      { stateName: "訂單完成", stateDate: "2026-09-17 19:58:01" },
    ],
    arrivedPic: "https://external-uploads-cdn.aomiapp.com/express/orderinfo/9c32.jpg",
  },
};

// ------------------------------------------------------------ 沙箱載入

function loadBridge() {
  let listener = null;
  const sent = [];
  const state = { onMessage: null };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Set,
    Map,
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
    window: {
      location: { href: "https://merchant.aomiapp.com/#/orderManage/storesTakeoutOrderRecord", origin: "https://merchant.aomiapp.com" },
      addEventListener(type, fn) {
        if (type === "message") listener = fn;
      },
      postMessage() {},
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          sent.push(msg);
          if (cb) cb();
        },
        onMessage: { addListener(fn) { state.onMessage = fn; } },
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, "utf8"), sandbox, { filename: "aomi-bridge.js" });

  function feed(kind, payload, meta) {
    if (!listener) throw new Error("bridge 沒有註冊 message listener");
    listener({
      source: sandbox.window,
      data: { __aomiGrabber: true, kind, payload, meta: meta || {} },
    });
  }

  return { feed, sent };
}

// ------------------------------------------------------------ 斷言工具

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

function group(name) {
  console.log(`\n${name}`);
}

// ------------------------------------------------------------ 測試

group("[1] 訂單列表正規化");
{
  const b = loadBridge();
  b.feed("order_list", ORDER_LIST_SAMPLE);

  const msg = b.sent.find((m) => m.type === "AOMI_ORDER_LIST_CAPTURED");
  check("有送出 ORDER_LIST_CAPTURED", !!msg, true);
  check("筆數 = 3", msg.rows.length, 3);

  const r0 = msg.rows[0];
  check("externalOrderId 保留原樣", r0.externalOrderId, "TK001361260917190710813");
  check("source 標記為 aomi", r0.source, "aomi");
  check("storeSeqNo 保留 # 號", r0.storeSeqNo, "#2");
  check("localOrderNo 去掉 # 號", r0.localOrderNo, "2");
  check("stateRaw 保留原始中文字", r0.stateRaw, "訂單已送達");
  check("memberPhoneMasked 保留遮罩", r0.memberPhoneMasked, "853-****9190");

  // 金額：分 → MOP 元，且不可用浮點誤差
  check("turnoverAmount 12600分 → 126 元", r0.amount.turnoverAmount, 126);
  check("settleAmount 10019分 → 100.19 元", r0.amount.settleAmount, 100.19);
  check("sendFeeAmt 1200分 → 12 元", r0.amount.sendFeeAmt, 12);
  check("storeRedpacket 700分 → 7 元", r0.amount.storeRedpacket, 7);
  check("goodsAmount 13400分 → 134 元", r0.amount.goodsAmount, 134);

  // 列表 API 不含明細
  check("列表列不含 items", r0.items, []);

  const r1 = msg.rows[1];
  check("#R1 的 localOrderNo 去掉 #", r1.localOrderNo, "R1");
  check("快送單 sendType", r1.sendType, "快送");
}

group("[2] 訂單詳情正規化（含菜名拆編號）");
{
  const b = loadBridge();
  b.feed("order_detail", ORDER_DETAIL_SAMPLE);

  const msg = b.sent.find((m) => m.type === "AOMI_ORDER_DETAIL_CAPTURED");
  check("有送出 ORDER_DETAIL_CAPTURED", !!msg, true);

  const d = msg.detail;
  check("externalOrderId", d.externalOrderId, "TK001361260917190710813");
  check("orderState enum 保留", d.stateEnum, "ORDER_ARRIVED");
  check("orderStateStr 中文保留", d.stateRaw, "客戶已確認收餐");
  check("兩者都有（狀態有三種寫法，不可只存一個）", !!d.stateEnum && !!d.stateRaw, true);
  check("localOrderNo 補上 #", d.localOrderNo, "#2");
  check("memberShip", d.memberShip, "VIP");

  check("品項數 = 2", d.items.length, 2);
  check("品項0 拆出編號 A16", d.items[0].itemCode, "A16");
  check("品項0 顯示名去掉編號", d.items[0].displayName, "洋蔥炒雞");
  check("品項0 原菜名保留（含編號）", d.items[0].name, "A16.洋蔥炒雞");
  check("品項1 拆出編號 A22", d.items[1].itemCode, "A22");
  check("品項1 顯示名", d.items[1].displayName, "蕃茄香煎時魚");
  check("單價 6700分 → 67 元", d.items[0].unitPrice, 67);
  check("數量", d.items[0].quantity, 1);

  check("顧客地址", d.customer.address, "新福花園（風順堂區） 河邊新街，新福花園13樓D");
  check("顧客電話為遮罩值", d.customer.phoneMasked, "853-****9190");
  check("顧客名", d.customer.name, "古");

  // 金額口徑：payAmt 是客人實付，turnoverAmt 是商家營業額，兩者不同
  check("payAmount 12100分 → 121 元（客人實付）", d.amount.payAmount, 121);
  check("turnoverAmount 12600分 → 126 元（營業額）", d.amount.turnoverAmount, 126);
  check("settleAmount 10019分 → 100.19 元（預計收入）", d.amount.settleAmount, 100.19);
  check("platServiceAmt 2581分 → 25.81 元（平台服務費）", d.amount.platServiceAmt, 25.81);
  check("payAmount 與 turnoverAmount 不相等", d.amount.payAmount !== d.amount.turnoverAmount, true);

  check("商家活動拆解 2 筆", d.amount.breakdown.merchantActDetails.length, 2);
  check("商家活動首筆內容", d.amount.breakdown.merchantActDetails[0].content, "滿110.0減4.0");
  check("平台券商家承擔 0", d.amount.breakdown.platActDetails[0].merchantBorne, 0);

  check("狀態時間軸 4 筆", d.timeline.length, 4);
  check("時間軸首筆", d.timeline[0].name, "付款成功");
}

group("[3] 去重");
{
  const b = loadBridge();
  // 同一份列表送兩次
  b.feed("order_list", ORDER_LIST_SAMPLE);
  b.feed("order_list", ORDER_LIST_SAMPLE);

  const lists = b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED");
  check("列表訊息仍應為 2 次（去重在 background 做，bridge 全部轉發）", lists.length, 2);

  // 詳情同一份送兩次 → bridge 層就會擋掉第二次
  b.feed("order_detail", ORDER_DETAIL_SAMPLE);
  b.feed("order_detail", ORDER_DETAIL_SAMPLE);
  const details = b.sent.filter((m) => m.type === "AOMI_ORDER_DETAIL_CAPTURED");
  check("重複詳情只轉發一次", details.length, 1);
}

group("[4] 防禦性：壞資料不應崩潰、不應誤判，且 0 與 null 必須區分");
{
  const b = loadBridge();

  // resultCode 不是 200 —— 不該送出任何東西
  b.feed("order_list", { resultCode: "500", detailMsg: { list: [] } });
  check("失敗回應不轉發", b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED").length, 0);

  // detailMsg 結構不符 —— 不該誤判成訂單
  b.feed("order_list", { resultCode: "200", detailMsg: { total: 0 } });
  check("結構不符不轉發", b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED").length, 0);

  // 列表中有 null / 缺 orderId 的列 —— 應被過濾掉而非崩潰
  b.feed("order_list", {
    resultCode: "200",
    detailMsg: {
      list: [null, { storeSeqNo: "#9" }, { orderId: "TK_OK", storeSeqNo: "#9" }],
    },
  });
  const filtered = b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED").pop();
  check("只保留有 orderId 的列", filtered.rows.length, 1);
  check("保留的那筆正確", filtered.rows[0].externalOrderId, "TK_OK");
  check("缺欄位回 null（settleAmount 未提供）", filtered.rows[0].amount.settleAmount, null);
  check("缺欄位回 null（refundAmt 未提供）", filtered.rows[0].amount.refundAmt, null);

  // 🔴 2026-09-25 改：整頁解析失敗要**轉發並標記**。
  //    唔轉發 ⇒「平台改版令解析壞掉」會同「店冇訂單」睇落一樣（靜默故障）；
  //    而「空結果」同「解析失敗」係兩件事，background 要分得出（meta.parseFailures）。
  const before = b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED").length;
  b.feed("order_list", { resultCode: "200", detailMsg: { list: [null, { storeSeqNo: "#1" }] } });
  const afterList = b.sent.filter((m) => m.type === "AOMI_ORDER_LIST_CAPTURED");
  check("整頁解析失敗時仍然轉發（唔可以靜默）", afterList.length, before + 1);
  check("🔴 標記 parseFailures = 2", afterList[afterList.length - 1].meta.parseFailures, 2);

  // ---- 0 與 null 的區別（用完整範例驗證，這是最容易寫錯的地方）----
  const b2 = loadBridge();
  b2.feed("order_list", ORDER_LIST_SAMPLE);
  const full = b2.sent.find((m) => m.type === "AOMI_ORDER_LIST_CAPTURED").rows[0];

  check("明確的 0 保留為 0（refundAmt: 0）", full.amount.refundAmt, 0);
  check("明確的 0 保留為 0（tipFeeByUser: 0）", full.amount.tipFeeByUser, 0);
  check("明確的 0 保留為 0（boxOrPackageAmt: 0）", full.amount.boxOrPackageAmt, 0);
  check("有值的欄位正常換算", full.amount.turnoverAmount, 126);
  check("0 不等於 null", full.amount.refundAmt === null, false);
}

group("[5] 菜名拆編號的邊界情況");
{
  const cases = [
    { input: "A16.洋蔥炒雞", code: "A16", name: "洋蔥炒雞" },
    { input: "A22.蕃茄香煎時魚", code: "A22", name: "蕃茄香煎時魚" },
    { input: "B1.凍檸茶", code: "B1", name: "凍檸茶" },
    { input: "S12 例湯", code: "S12", name: "例湯" },
    { input: "洋蔥炒雞", code: null, name: "洋蔥炒雞" },
    { input: "1.白飯", code: "1", name: "白飯" },
  ];

  cases.forEach((c) => {
    const b = loadBridge();
    b.feed("order_detail", {
      resultCode: "200",
      detailMsg: { orderId: "TK_TEST", orderGoods: [{ menuName: c.input, copies: 1, actPrice: 100 }] },
    });
    const msg = b.sent.find((m) => m.type === "AOMI_ORDER_DETAIL_CAPTURED");
    const item = msg && msg.detail.items[0];
    check(`"${c.input}" → code=${JSON.stringify(c.code)}`, item ? item.itemCode : undefined, c.code);
    check(`"${c.input}" → name="${c.name}"`, item ? item.displayName : undefined, c.name);
  });
}

// ------------------------------------------------------------ 結果

console.log(`\n${"=".repeat(50)}`);
console.log(`通過 ${passed} 項，失敗 ${failed} 項`);
process.exit(failed > 0 ? 1 : 0);
