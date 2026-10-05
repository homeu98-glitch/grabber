/**
 * 跑全套測試並統計（方便一眼睇「幾多項、有冇失敗」）。
 *
 * 🔴 為咩唔用 `execFileSync`：測試用 `process.exit()` 收尾，
 *    execFileSync 會拋例外而且 capture 唔到 stdout。
 *    用 `spawnSync` 就算非零 exit code 都一定拿到完整輸出。
 *
 * 用法：node tools/run-all-tests.cjs
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NODE = process.execPath;
const testDir = path.join(__dirname, "..", "test");

const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".cjs"))
  .sort();

// 🔴 2026-09-28 第十三次真機：`tools/` 下亦有「自帶斷言」嘅驗證器
//    （例如 verify-extract-logic.cjs —— 用真實 payload 形狀驗抽取邏輯）。
//    佢哋一樣印「通過 N 項，失敗 N 項」，所以要一齊納入統計，
//    否則會出現「測試全綠但驗證器其實紅」嘅盲區。
//
// ⚠️ 但要**排除要開真瀏覽器嘅**（verify-popup-render / verify-finance-dom）——
//    佢哋要 `puppeteer-core` ＋ `NODE_PATH`，而本 runner 用純 node 跑，
//    強行納入會變成一條「環境唔啱」嘅假紅。
//    呢兩支要另外用：
//      NODE_PATH=<managed>/node/workspace/node_modules node tools/verify-*.cjs
const toolsDir = __dirname;
const BROWSER_VERIFIERS = ["verify-popup-render.cjs", "verify-finance-dom.cjs"];
const toolVerifiers = fs
  .readdirSync(toolsDir)
  .filter((f) => /^verify-.*\.cjs$/.test(f) && !BROWSER_VERIFIERS.includes(f))
  .sort()
  .map((f) => ({ dir: toolsDir, file: f }));

const targets = [
  ...files.map((f) => ({ dir: testDir, file: f })),
  ...toolVerifiers,
];

let total = 0;
let totalFail = 0;

for (const { dir, file } of targets) {
  // 🔴 部分環境（沙箱）下 spawnSync 嘅 pipe 會 capture 唔到輸出，
  //    所以改用「導向去暫存檔再讀」—— 最穩。
  const tmp = path.join(os.tmpdir(), "grabber-test-" + file + ".out");
  const r = spawnSync(NODE, [path.join(dir, file)], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", fs.openSync(tmp, "w"), fs.openSync(tmp, "w")],
  });
  let out = "";
  try {
    out = fs.readFileSync(tmp, "utf8");
  } catch (e) {
    out = (r.stdout || "") + (r.stderr || "");
  }
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    /* 忽略 */
  }

  const mp = /通過 (\d+) 項/.exec(out);
  const mf = /失敗 (\d+) 項/.exec(out);
  if (!mp) {
    const err = out.split("\n").find((l) => /Error|ReferenceError|TypeError/.test(l)) || "無輸出";
    console.log(file.padEnd(32), "?? " + err.trim().slice(0, 60));
    totalFail += 1;
    continue;
  }
  const p = Number(mp[1]);
  const f = mf ? Number(mf[1]) : 0;
  total += p;
  totalFail += f;
  const mark = f > 0 ? "✗" : "✓";
  console.log(`${mark} ${file.padEnd(30)} ${String(p).padStart(4)} 通過${f > 0 ? " / " + f + " 失敗" : ""}`);
}

console.log("-".repeat(52));
console.log(`共 ${targets.length} 檔，通過 ${total} 項，失敗 ${totalFail} 項`);
process.exit(totalFail > 0 ? 1 : 0);
