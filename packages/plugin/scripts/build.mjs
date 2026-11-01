/**
 * 构建：宿主侧走 tsc（保留相对 import 的形状），客户端走 esbuild 并包成
 * DSH 的插件包格式 `window.__ModuleLoader__.load({ id, factory })`。
 *
 * 客户端为什么必须手包这一层：DSH 的 Web 端不是普通 ESM 环境，插件包里
 * 只能拿到 `factory(require)` 提供的 `require`（react / react-dom / react/jsx-runtime
 * 以及宿主插件的 `@deepseek-ai/*` 由它解析）。官方插件 dsh-free-search 的
 * lib/client.js 就是这个形状，这里照抄。
 */

import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "lib");

/** 插件包名：既是 ModuleLoader 的 id，也是客户端日志里的名字。 */
const PACKAGE_NAME = "dsh-life-saver";

/** 客户端从这里 require，宿主已经提供，不打进包里。 */
const CLIENT_EXTERNALS = ["react", "react-dom", "react/jsx-runtime", "react-dom/client"];

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`));
    });
  });
}

async function buildHost() {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], root);
}

async function buildClient() {
  const result = await build({
    entryPoints: [join(root, "src", "client", "index.jsx")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: CLIENT_EXTERNALS,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const body = result.outputFiles[0].text;
  const wrapped = [
    "// dsh-life-saver 客户端：由 scripts/build.mjs 生成，不要手改。",
    "// DSH Web 端只接受这个形状：window.__ModuleLoader__.load({ id, factory })。",
    "window.__ModuleLoader__.load({",
    `  id: ${JSON.stringify(PACKAGE_NAME)},`,
    "  factory: (require) => {",
    "    var module = { exports: {} };",
    "    var exports = module.exports;",
    body,
    "    return module.exports;",
    "  },",
    "});",
    "",
  ].join("\n");

  await writeFile(join(outDir, "client.js"), wrapped, "utf8");
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await buildHost();
  await buildClient();

  // 冒烟：宿主入口确实是 ESM 且导出了 apply / name
  const entry = await readFile(join(outDir, "index.js"), "utf8");
  if (!/export (function apply|const name)/.test(entry)) {
    throw new Error("lib/index.js 没有导出 apply/name，构建产物不对");
  }
  const client = await readFile(join(outDir, "client.js"), "utf8");
  if (!client.includes("__ModuleLoader__.load")) {
    throw new Error("lib/client.js 没有包成 ModuleLoader 形式");
  }
  console.log("build ok → lib/");
}

await main();
