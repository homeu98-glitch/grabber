#!/usr/bin/env node
/**
 * 由**已開啟嘅 mfood 財務頁**直接抽「全部原始資料」，唔經 extension 任何一跳。
 *
 * 🔴 為什麼要有呢支（2026-09-28 第十三次真機）：
 *    使用者原話：「在 network 里面一看就看到所有的返回內容, 為什麼要搞那麼久.」
 *
 *    完全正確。extension 路線要 5 跳：
 *      MAIN world fetch hook → window.postMessage → isolated bridge
 *      → chrome.runtime → background → popup
 *    任何一跳死都靜默失敗，而且每一跳都要 debug 一次。
 *
 *    呢支改為**直接喺頁面上下文**用 CDP 攔 `fetch`/`XHR`，
 *    把 `_get-order-summary-list` 嘅 **原始 response JSON** 抄落嚟。
 *    零 extension、零 postMessage、零 storage。
 *
 * 用法：
 *   1. 先確保 Chrome 開咗 mfood 財務對帳頁，並且**按咗「查詢」**（令頁面發出請求）
 *   2. node tools/grab-finance-raw.cjs [--port=9222] [--out=path.json]
 *
 * 前置：Chrome 要用 --remote-debugging-port=9222 開，
 *      或者用 puppeteer 自己開一個（見 --launch）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const PORT = Number(argOf('port', '9222'));
const OUT = argOf('out', path.join(process.cwd(), 'finance-raw.json'));
const LAUNCH = args.includes('--launch');
const TARGET_URL = argOf('url', 'https://merchant.mfoodapp.com/#/finance/tackout-check');
const WAIT_MS = Number(argOf('wait', '120000'));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('JSON parse failed: ' + d.slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * 喺頁面內注入嘅攔截器。
 *
 * ⚠️ 一定要用函式字串（唔可以 require），因為要喺頁面 context 執行。
 *    回傳一個 Promise，resolve 成 {list: [...], detail: [...], seen: [...]}
 */
const INSTALL_HOOK = `
(function () {
  if (window.__RAWGRAB__) return 'already';
  var store = { list: [], detail: [], data: [], seen: [] };
  window.__RAWGRAB__ = store;
  window.__RAWGRAB_RESULT__ = null;

  function isDetail(u) { return /_get-order-summary(-list|-data)?/i.test(u); }
  function isList(u)   { return /\\/summary(s)?\\/_list|\\/summary\\/list/i.test(u); }
  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u); }
  }
  function push(u, body) {
    var url = abs(u);
    store.seen.push(url);
    var parsed = body;
    if (typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
    }
    var entry = { url: url, at: Date.now(), body: parsed };
    if (isList(url))   store.list.push(entry);
    if (isDetail(url)) {
      var p = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      if (/_get-order-summary-data/i.test(url)) store.data.push(entry);
      else store.detail.push(entry);
      // 交返出嚟：只留關鍵 5 欄，其餘原樣
      try {
        var rows = p && Array.isArray(p.result) ? p.result : [];
        window.__RAWGRAB_RESULT__ = {
          url: url,
          total: p && p.total != null ? p.total : null,
          rowCount: rows.length,
          rows: rows,
          respTopKeys: p && typeof p === 'object' ? Object.keys(p) : []
        };
      } catch (e) {}
    }
  }

  // ---- fetch ----
  var of = window.fetch;
  window.fetch = function (input, init) {
    var u = (input && input.url) || input;
    return of.apply(this, arguments).then(function (res) {
      try {
        var ct = (res.headers.get('content-type') || '');
        if (ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1) {
          res.clone().text().then(function (t) { push(u, t); }).catch(function () {});
        }
      } catch (e) {}
      return res;
    });
  };

  // ---- XHR ----
  var OX = window.XMLHttpRequest;
  if (OX && OX.prototype) {
    var oOpen = OX.prototype.open;
    var oSend = OX.prototype.send;
    OX.prototype.open = function (m, u) {
      try { this.__grabUrl = u; } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    OX.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener('load', function () {
          try {
            var t = self.responseType === 'json' ? self.response : self.responseText;
            push(self.__grabUrl, t);
          } catch (e) {}
        });
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }

  return 'installed';
})()
`;

async function main() {
  // 1. 揀一條連得上嘅 DevTools endpoint
  let base;
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      const v = await getJson(`http://${host}:${PORT}/json/version`);
      if (v && v.webSocketDebuggerUrl) {
        base = `http://${host}:${PORT}`;
        break;
      }
    } catch (e) {
      /* 試下一個 */
    }
  }
  if (!base) {
    console.error(
      `\n❌ 連唔到 Chrome DevTools (port ${PORT})。\n` +
        `   請用以下方式開 Chrome：\n` +
        `     chrome.exe --remote-debugging-port=${PORT} --user-data-dir=<臨時目錄>\n` +
        `   然後喺嗰個 Chrome 開 mfood 財務對帳頁、按「查詢」。\n`,
    );
    process.exit(2);
  }
  console.log(`✓ DevTools: ${base}`);

  // 2. 搵財務頁分頁
  const tabs = await getJson(base + '/json/list');
  const page = (tabs || []).find(
    (t) => t.type === 'page' && /mfoodapp\.com/.test(t.url || ''),
  );
  if (!page) {
    console.error(
      '\n❌ 喺 Chrome 度搵唔到 mfoodapp.com 嘅分頁。\n' +
        '   已開嘅分頁：\n' +
        (tabs || [])
          .filter((t) => t.type === 'page')
          .map((t) => '     - ' + t.url)
          .join('\n') +
        '\n',
    );
    process.exit(2);
  }
  console.log(`✓ 目標分頁: ${page.url}`);

  if (!page.webSocketDebuggerUrl) {
    console.error('❌ 該分頁冇 webSocketDebuggerUrl');
    process.exit(2);
  }

  // 3. 連 CDP
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });

  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  console.log('✓ CDP 已連線');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description
          : JSON.stringify(r.exceptionDetails),
      );
    }
    return r.result && r.result.value;
  };

  // 4. 裝 hook
  const installed = await evaluate(INSTALL_HOOK);
  console.log('✓ 攔截器:', installed);

  const before = await evaluate('window.__RAWGRAB__ ? window.__RAWGRAB__.seen.length : -1');
  console.log(`  已攔到 URL 數（裝 hook 之前）: ${before}`);

  // 5. 主動代按「查詢」，令頁面自己重新發請求
  console.log('  嘗試代按「查詢」…');
  const clicked = await evaluate(`
    (function () {
      var btns = Array.prototype.slice.call(document.querySelectorAll('button,a,span'));
      var hit = btns.filter(function (b) {
        var t = (b.textContent || '').trim();
        return t === '查詢' || t === '搜索' || t === '搜尋' || t === '查询';
      })[0];
      if (hit) { hit.click(); return (hit.textContent || '').trim(); }
      return null;
    })()
  `);
  console.log('  代按結果:', clicked ? `✓ 撳了「${clicked}」` : '⚠️ 搵唔到查詢掣（請自己撳）');

  // 6. 等資料到
  console.log(`  等明細回應（最多 ${Math.round(WAIT_MS / 1000)} 秒）…`);
  const t0 = Date.now();
  let snap = null;
  while (Date.now() - t0 < WAIT_MS) {
    snap = await evaluate(`
      (function () {
        var s = window.__RAWGRAB__;
        return {
          seenCount: s.seen.length,
          listCount: s.list.length,
          detailCount: s.detail.length,
          seen: s.seen.slice(-12),
          result: window.__RAWGRAB_RESULT__ || null
        };
      })()
    `);
    if (snap && snap.result && snap.result.rows && snap.result.rows.length) break;
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write('.');
  }
  console.log('');

  if (!snap || !snap.result || !snap.result.rows || !snap.result.rows.length) {
    console.error(
      '\n⚠️ 等唔到明細回應。目前攔到嘅 URL：\n' +
        (snap ? snap.seen.map((u) => '   - ' + u).join('\n') : '   (無)') +
        '\n\n　請喺頁面手動撳「查看詳情」，再重跑呢支腳本。\n',
    );
    ws.close();
    process.exit(3);
  }

  const r = snap.result;
  const rows = r.rows;

  // 7. 逐列抽出用戶要嘅欄位，同時保留原樣
  const simplified = rows.map((row) => ({
    tradeNo: row.tradeNo != null ? row.tradeNo : null,
    subsidyStoreReceiveAmtn:
      row.subsidyStoreReceiveAmtn != null ? row.subsidyStoreReceiveAmtn : null,
    storeReceiveAmtn: row.storeReceiveAmtn != null ? row.storeReceiveAmtn : null,
    storeBusinessAmtn: row.storeBusinessAmtn != null ? row.storeBusinessAmtn : null,
    platformServiceFee: row.platformServiceFee != null ? row.platformServiceFee : null,
    orderTime: row.orderTime != null ? row.orderTime : null,
  }));

  const out = {
    說明: 'mfood 財務頁原始明細（直接由頁面攔截，未經任何配對／篩選）',
    抓取時間: new Date().toISOString(),
    頁面: page.url,
    端點: r.url,
    平台聲稱總數: r.total,
    實際列數: rows.length,
    回應最外層欄位: r.respTopKeys,
    第一列全部欄位: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [],
    簡化列: simplified,
    原始列: rows,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n════════════════════════════════════════');
  console.log(`✓ 抓到了：${rows.length} 列（平台聲稱總數 ${r.total}）`);
  console.log(`✓ 端點：${r.url}`);
  console.log(`✓ 已寫入：${OUT}`);
  console.log('════════════════════════════════════════\n');
  console.log('前 3 列（tradeNo / subsidyStoreReceiveAmtn）：');
  simplified.slice(0, 3).forEach((x, i) => {
    console.log(
      `  [${i + 1}] ${x.tradeNo}  →  subsidy=${x.subsidyStoreReceiveAmtn}  receive=${x.storeReceiveAmtn}`,
    );
  });
  const sum = simplified.reduce(
    (a, x) => a + (Number(x.subsidyStoreReceiveAmtn) || 0),
    0,
  );
  console.log(`\n  Σ subsidyStoreReceiveAmtn = ${sum.toFixed(2)}`);

  ws.close();
}

main().catch((e) => {
  console.error('\n❌ 出錯：', e && e.message ? e.message : e);
  process.exit(1);
});
