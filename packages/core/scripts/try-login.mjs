/**
 * 一次性诊断脚本：用插件同样的算法试登录，把禅道回的原文打出来。
 *   node scripts/try-login.mjs <account> <password> [baseUrl]
 * 只读，不改配置、不写任何文件。
 */

import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const account = process.argv[2];
const password = process.argv[3];
const base = (process.argv[4] ?? "http://zentao.example.com").replace(/\/+$/, "");
if (!account || !password) {
  console.error("用法: node scripts/try-login.mjs <account> <password> [baseUrl]");
  process.exit(2);
}

const randResponse = await fetch(`${base}/index.php?m=user&f=refreshRandom`, {
  headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" },
  signal: AbortSignal.timeout(15000),
});
const randText = (await randResponse.text()).trim();
const preCookies = (randResponse.headers.getSetCookie?.() ?? []).map((line) => line.split(";", 1)[0]);
console.log(`refreshRandom cookies: ${JSON.stringify(preCookies)}`);
console.log(`refreshRandom: HTTP ${randResponse.status} → ${JSON.stringify(randText.slice(0, 40))}`);

const form = new FormData();
form.set("account", account);
form.set("password", md5(md5(password) + randText));
form.set("passwordStrength", "1");
form.set("referer", "/index.php");
form.set("verifyRand", randText);
form.set("keepLogin", "1");
form.set("captcha", "");

const response = await fetch(`${base}/index.php?m=user&f=login&t=json`, {
  method: "POST",
  body: form,
  headers: {
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${base}/index.php?m=user&f=login`,
    ...(preCookies.length > 0 ? { Cookie: preCookies.join("; ") } : {}),
  },
  signal: AbortSignal.timeout(15000),
  redirect: "manual",
});
const text = await response.text();
const cookies = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";", 1)[0]);
console.log(`login: HTTP ${response.status} cookies=${JSON.stringify(cookies)}`);
console.log(`body: ${text.slice(0, 300)}`);
