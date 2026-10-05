#!/usr/bin/env node
/**
 * 驗證 v2 snippet 嘅「跨頁累積 ＋ 去重」核心邏輯（唔靠瀏覽器）。
 *
 * 2026-09-28 第十四次真機背景：
 *   v1 只拿到 20 列，但平台聲稱 32 筆 —— 因為只讀第一頁。
 *   v2 改成「代撳下一頁，繼續搭便車」，所以要驗證：
 *     ① 兩頁合併後 = 32 列（唔可以漏、唔可以重複）
 *     ② 同一筆喺兩頁都出現（平台分頁邊界重疊）⇒ 只可以算一次
 *     ③ 加總要對得上平台聲稱嘅總額
 *
 * 用法：node tools/verify-extract-logic.cjs
 */

// ---- 由 snippet 抄出嚟嘅核心邏輯（保持一致）----
function rowsOf(body) {
  const p =
    body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data
      : body;
  return p && Array.isArray(p.result) ? p.result : [];
}

function makeAbsorber() {
  const byTradeNo = new Map();
  const noTradeNo = [];
  return {
    absorb(rows) {
      rows.forEach((r) => {
        const k = r && r.tradeNo != null ? String(r.tradeNo) : null;
        if (k) byTradeNo.set(k, r);
        else noTradeNo.push(r);
      });
    },
    all() {
      return Array.from(byTradeNo.values()).concat(noTradeNo);
    },
  };
}

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, '\n      得到:', JSON.stringify(got), '\n      期望:', JSON.stringify(want));
  }
};

// ---- 真機形狀：32 筆，分 2 頁（每頁 20）----
const ALL = [];
for (let i = 1; i <= 32; i++) {
  ALL.push({
    tradeNo: 'CRD202609' + String(1000000000 + i),
    subsidyStoreReceiveAmtn: 10 + i,
    storeReceiveAmtn: 20 + i,
    storeBusinessAmtn: 30 + i,
    platformServiceFee: 5,
    orderTime: 1789488000000 + i * 1000,
  });
}
const TRUE_SUM = ALL.reduce((a, x) => a + x.subsidyStoreReceiveAmtn, 0);

const PAGE1 = { data: { result: ALL.slice(0, 20), total: 32 } };
const PAGE2 = { data: { result: ALL.slice(20), total: 32 } };

console.log('\n[1] 兩頁合併 = 32 列');
{
  const acc = makeAbsorber();
  acc.absorb(rowsOf(PAGE1));
  check('第一頁 20 列', acc.all().length, 20);
  acc.absorb(rowsOf(PAGE2));
  check('兩頁合併 32 列', acc.all().length, 32);
  const sum = acc.all().reduce((a, x) => a + x.subsidyStoreReceiveAmtn, 0);
  check('加總 = 真值', sum, TRUE_SUM);
}

console.log('\n[2] 分頁邊界重疊 → 唔可以重複計');
{
  // 模擬平台「第 2 頁由第 20 筆開始」（overlap 一筆，真機常見）
  const acc = makeAbsorber();
  acc.absorb(rowsOf(PAGE1)); // 1..20
  acc.absorb(rowsOf({ data: { result: ALL.slice(19), total: 32 } })); // 20..32
  check('仍然 32 列（去重生效）', acc.all().length, 32);
  const sum = acc.all().reduce((a, x) => a + x.subsidyStoreReceiveAmtn, 0);
  check('加總仍然 = 真值（冇重複加）', sum, TRUE_SUM);
}

console.log('\n[3] 同一頁重複讀兩次（撳咗下一頁但平台回同一頁）');
{
  const acc = makeAbsorber();
  acc.absorb(rowsOf(PAGE1));
  acc.absorb(rowsOf(PAGE1)); // 再讀一次
  check('仍然 20 列', acc.all().length, 20);
  const sum = acc.all().reduce((a, x) => a + x.subsidyStoreReceiveAmtn, 0);
  check(
    '加總 = 第一頁真值（唔可以翻倍）',
    sum,
    ALL.slice(0, 20).reduce((a, x) => a + x.subsidyStoreReceiveAmtn, 0),
  );
}

console.log('\n[4] 冇 tradeNo 嘅列要保留（唔可以靜默丟）');
{
  const acc = makeAbsorber();
  acc.absorb([
    { tradeNo: 'A', subsidyStoreReceiveAmtn: 1 },
    { subsidyStoreReceiveAmtn: 2 }, // 冇 tradeNo
    { subsidyStoreReceiveAmtn: 3 }, // 冇 tradeNo
  ]);
  check('全部 3 列都在', acc.all().length, 3);
}

console.log('\n[5] 空頁 / 壞 payload 唔可以拋');
{
  check('null → 0 列', rowsOf(null).length, 0);
  check('{} → 0 列', rowsOf({}).length, 0);
  check('result 非陣列 → 0 列', rowsOf({ result: 'oops' }).length, 0);
  const acc = makeAbsorber();
  acc.absorb(rowsOf(null));
  acc.absorb(rowsOf({}));
  check('累積器仍然安全', acc.all().length, 0);
}

console.log('\n[6] 平舖 result（冇 data 包裝）');
{
  check('平舖都抽到', rowsOf({ result: ALL.slice(0, 3), total: 3 }).length, 3);
}

console.log('\n==================================================');
console.log(`通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
