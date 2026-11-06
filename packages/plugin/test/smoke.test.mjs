/**
 * 冒烟测试：只验证「构建产物能被宿主装进去」这件事，不连禅道。
 *
 *   node --test test/smoke.test.mjs
 *
 * 1. 宿主侧：import lib/index.js，喂一个假 ctx，确认三个工具都注册了、
 *    设置页策略被调用、bridge 路由挂在 /api/dsh-life-saver/*。
 * 2. 客户端侧：喂一个假 window.__ModuleLoader__ 加载 lib/client.js，
 *    确认它包成了 DSH 要的 factory 形状，且 apply() 往 plugins.row.config 注册了 key。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 假 ctx：够入口用就行——inject 直接同步回调，effect 收集卸载函数。 */
function makeContext(extras = {}) {
  const tools = [];
  const routes = [];
  const disposers = [];
  const settingsCalls = [];
  const skillProviders = [];
  const ctx = {
    fiber: { uid: 1 },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get(name) {
      return typeof extras.services === "function" ? extras.services(name) : undefined;
    },
    effect(factory) {
      const dispose = typeof factory === "function" ? factory() : undefined;
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    inject(_names, callback) {
      const scoped = {
        ...ctx,
        tools: { register: (definition) => (tools.push(definition), () => {}) },
        webServer: { register: (route) => (routes.push(route), () => {}) },
        settings: { configure: (options, fiber) => (settingsCalls.push({ options, fiber }), () => {}) },
        skills: {
          registerProvider: (create) => {
            skillProviders.push(create({ signal: new AbortController().signal, invalidate() {} }));
            return () => {};
          },
        },
      };
      callback(scoped);
    },
    tools: { register: (definition) => (tools.push(definition), () => {}) },
  };
  return { ctx, tools, routes, settingsCalls, disposers, skillProviders };
}

/** 把一条 exact 路由当 HTTP 请求打一次，返回 { status, body }。 */
function callRoute(route, { method = "POST", headers = {}, body, raw } = {}) {
  return new Promise((resolve) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = {
      method,
      headers: { host: "127.0.0.1:50661", "content-type": "application/json", ...headers },
      async *[Symbol.asyncIterator]() {
        if (payload !== undefined) yield payload;
      },
      destroy() {},
    };
    const res = {
      status: 0,
      payload: "",
      writeHead(code) {
        this.status = code;
      },
      end(payload) {
        this.payload = payload ?? "";
        resolve({ status: this.status, body: this.payload ? JSON.parse(this.payload) : undefined });
      },
    };
    void route.handler(req, res);
  });
}

test("宿主入口：注册八个工具、关掉自动表单、挂九条 bridge 路由", async () => {
  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  assert.equal(mod.name, "life-saver", "cordis 行名必须是 life-saver");
  assert.equal(typeof mod.apply, "function");

  const { ctx, tools, routes, settingsCalls } = makeContext();
  mod.apply(ctx, mod.Config());

  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "zentao_bug_op",
    "zentao_commit",
    "zentao_read",
    "zentao_search",
    "zentao_session_start",
    "zentao_status",
    "zentao_task_op",
    "zentao_workhours",
  ]);

  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 10, `${tool.name} 缺描述`);
    assert.equal(typeof tool.execute, "function");
  }

  assert.equal(settingsCalls.length, 1);
  assert.equal(settingsCalls[0].options.auto, false, "自建页面时必须关掉自动表单");

  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [
      "/api/dsh-life-saver/config-describe",
      "/api/dsh-life-saver/config-set",
      "/api/dsh-life-saver/credentials-set",
      "/api/dsh-life-saver/credentials-status",
      "/api/dsh-life-saver/credentials-unset",
      "/api/dsh-life-saver/session-probe",
      "/api/dsh-life-saver/session-start",
      "/api/dsh-life-saver/session-targets",
      "/api/dsh-life-saver/test",
    ],
  );
});

test("随包 skill：三个禅道 skill 都注册进技能表，正文能取到", async () => {
  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  const { ctx, skillProviders } = makeContext();
  mod.apply(ctx, mod.Config());

  assert.equal(skillProviders.length, 1, "应该只注册一个 skill provider");
  const provider = skillProviders[0];
  assert.equal(provider.name, "dsh-life-saver");

  const candidates = await provider.list({});
  assert.deepEqual(
    candidates.map((item) => item.name).sort(),
    ["zentao-change-assignee-scrub-trace", "zentao-extract", "zentao-weekly-report"],
  );

  for (const candidate of candidates) {
    assert.equal(candidate.provider, "dsh-life-saver", "candidate.provider 必须与 provider 同名");
    assert.equal(candidate.source, "bundled");
    // 600 = BUNDLED_SKILL_RANK：比用户级 ~/.dsh/skills（400）低，用户自建的同名 skill 继续优先
    assert.equal(candidate.rank, 600);
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
    assert.ok(candidate.description.length > 10, `${candidate.name} 缺 description`);
    assert.equal(candidate.resourceBase.kind, "directory");
    assert.ok(!candidate.resourceBase.path.includes("\\"), "资源目录要用 / 分隔");
    assert.ok(candidate.resourceBase.path.endsWith(candidate.name));

    const definition = await provider.get(candidate, {});
    assert.ok(definition.content.length > 200, `${candidate.name} 正文太短`);
    assert.ok(!definition.content.startsWith("---"), "正文不能带 frontmatter");
    assert.equal(definition.rank, undefined, "技能定义里不该带 rank");
  }

  // weekly 的脚本必须随包一起发出去（模型会按 base directory 拼 scripts/xxx.py 直接跑）
  const weekly = candidates.find((item) => item.name === "zentao-weekly-report");
  const scripts = join(dirname(weekly.locator), "scripts");
  assert.ok(existsSync(scripts), `缺 scripts 目录：${scripts}`);
  for (const script of ["_db.py", "audit_backlog.py", "build_week.py", "q.py", "verify_week.py"]) {
    assert.ok(existsSync(join(scripts, script)), `缺脚本 ${script}`);
  }
});

test("skill 资产缺失时跳过该 skill，不影响插件其余部分", async () => {
  const skills = await import(pathToFileURL(join(root, "lib", "skills", "index.js")).href);
  const warnings = [];
  const provider = skills.makeSkillProvider(join(root, "assets", "no-such-dir"), {
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(await provider.list({}), []);
  assert.equal(warnings.length, 3);
  for (const message of warnings) assert.match(message, /跳过 skill/);
});

test("bridge 路由只接受 POST + 本机/同源请求", async () => {
  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  const { ctx, routes } = makeContext();
  mod.apply(ctx, mod.Config());
  const status = routes.find((route) => route.path.endsWith("/credentials-status"));

  const call = (req) =>
    new Promise((resolve) => {
      const res = {
        status: 0,
        headers: undefined,
        body: "",
        writeHead(code, headers) {
          this.status = code;
          this.headers = headers;
        },
        end(payload) {
          this.body = payload ?? "";
          resolve(this);
        },
      };
      status.handler(req, res);
    });

  const get = await call({ method: "GET", headers: { host: "127.0.0.1:50661" } });
  assert.equal(get.status, 405);

  const foreign = await call({ method: "POST", headers: { host: "example.com", origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);

  const local = await call({ method: "POST", headers: { host: "127.0.0.1:50661" } });
  assert.equal(local.status, 200);
  const payload = JSON.parse(local.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.value.available, false, "没有凭据服务时应如实说不可用");
  assert.deepEqual(Object.keys(payload.value.configured).sort(), [
    "ZENTAO_DB_PASSWORD",
    "ZENTAO_PASSWORD",
    "ZENTAO_SFTP_PASSWORD",
  ]);
});

test("bridge /config-set：校验 ops，并把宿主写配置的原文错误带回来", async () => {
  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  const written = [];
  const settingsService = {
    describe: () => [{ ns: "life-saver", revision: 7, value: { http: { account: "huzihao" } } }],
    async mutate(ns, ops, revision) {
      written.push({ ns, ops, revision });
      if (ops.some((op) => op.path.join(".") === "http.account" && op.value === "BOOM")) {
        throw new Error('Config field "http.account" is not volatile');
      }
    },
  };
  const { ctx, routes } = makeContext({ services: (name) => (name === "settings" ? settingsService : undefined) });
  mod.apply(ctx, mod.Config());
  const route = routes.find((item) => item.path.endsWith("/config-set"));

  const badKind = await callRoute(route, { body: { ops: [{ op: "remove", path: ["mode"] }] } });
  assert.equal(badKind.body.code, "config-rejected");

  const badPath = await callRoute(route, { body: { ops: [{ op: "set", path: ["http", "$where"], value: "x" }] } });
  assert.equal(badPath.body.code, "config-rejected");

  const objectValue = await callRoute(route, { body: { ops: [{ op: "set", path: ["http", "account"], value: { x: 1 } }] } });
  assert.equal(objectValue.body.code, "config-rejected");

  const ok = await callRoute(route, {
    body: { ops: [{ op: "set", path: ["http", "account"], value: "huzihao" }], revision: 7 },
  });
  assert.equal(ok.body.ok, true);
  assert.deepEqual(written[0], {
    ns: "life-saver",
    ops: [{ op: "set", path: ["http", "account"], value: "huzihao" }],
    revision: 7,
  });
  assert.equal(ok.body.value.revision, 7);

  const failed = await callRoute(route, { body: { ops: [{ op: "set", path: ["http", "account"], value: "BOOM" }] } });
  assert.equal(failed.body.ok, false);
  assert.match(failed.body.message, /not volatile/, "要原样带回宿主的错误文案");
});

test("bridge 请求体：GBK 字节不静默变乱码，UTF-8 照旧", async () => {
  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  const written = [];
  const settingsService = {
    describe: () => [{ ns: "life-saver", revision: 1, value: {} }],
    async mutate(ns, ops) {
      written.push({ ns, ops });
    },
  };
  const { ctx, routes } = makeContext({ services: (name) => (name === "settings" ? settingsService : undefined) });
  mod.apply(ctx, mod.Config());
  const route = routes.find((item) => item.path.endsWith("/config-set"));

  // Windows 控制台的 `curl -d '...中文...'` 发的是 GBK 字节（联通 = c1aa cda8）。
  // 以前这里会被 utf8 解码静默替换成 U+FFFD，JSON 照常解析，中文悄悄烂掉。
  const gbk = Buffer.concat([
    Buffer.from('{"ops":[{"op":"set","path":["http","account"],"value":"', "utf8"),
    Buffer.from("c1aacda8d0d4", "hex"), // 联通性
    Buffer.from('"}]}', "utf8"),
  ]);
  const decoded = await callRoute(route, { raw: gbk });
  assert.equal(decoded.body.ok, true, `GBK 请求体被拒了：${JSON.stringify(decoded.body)}`);
  assert.equal(written[0].ops[0].value, "联通性", "GBK 字节要按 GB18030 解回来，不能变成 U+FFFD");

  // 正常 UTF-8 不受影响。
  const utf8 = await callRoute(route, {
    raw: Buffer.from(JSON.stringify({ ops: [{ op: "set", path: ["http", "account"], value: "联通性" }] }), "utf8"),
  });
  assert.equal(utf8.body.ok, true);
  assert.equal(written[1].ops[0].value, "联通性");

  // 真正的坏字节仍然报 malformed-body，不要假装能救。
  const broken = await callRoute(route, { raw: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) });
  assert.equal(broken.body.code, "malformed-body");
});

test("bridge /test：带草稿就按草稿连，草稿里的账号算已配置", async () => {  const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
  const { ctx, routes } = makeContext();
  mod.apply(ctx, mod.Config());
  const route = routes.find((item) => item.path.endsWith("/test"));

  const rejected = await callRoute(route, { body: { overrides: [1, 2] } });
  assert.equal(rejected.body.code, "probe-rejected");

  const ok = await callRoute(route, {
    body: { overrides: { mode: "http", http: { baseUrl: "http://127.0.0.1:9", account: "huzihao", timeoutMs: 1500 } } },
  });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.value.draft, true);
  assert.ok(
    !ok.body.value.http.missing.includes("http.account"),
    `草稿里的账号应算进配置，实际 missing=${JSON.stringify(ok.body.value.http.missing)}`,
  );
});

test("客户端产物：包成 ModuleLoader，apply() 注册 plugins.row.config", async () => {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  assert.match(source, /__ModuleLoader__\.load\(/);

  let loaded;
  const sandbox = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  };
  // lib/client.js 是 DSH 的 ModuleLoader 形状，只能在有 window 的环境里跑
  const run = new Function("window", source);
  run(sandbox);
  assert.ok(loaded, "必须调用 window.__ModuleLoader__.load");
  assert.equal(loaded.id, "dsh-life-saver");

  // factory(require)：只认 react，其余一律当成错误用出来
  const reactShim = { createElement: () => null, Fragment: "fragment", useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (fn) => fn() };
  const exportsOfModule = loaded.factory((id) => {
    if (id === "react") return reactShim;
    throw new Error(`客户端 require 了未声明的模块：${id}`);
  });

  assert.equal(typeof exportsOfModule.apply, "function");
  assert.deepEqual(exportsOfModule.inject, ["slots"]);

  const registered = [];
  exportsOfModule.apply({
    effect(factory) {
      return factory();
    },
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, "plugins.row.config");
  assert.equal(registered[0].options.key, "dsh-life-saver#life-saver");
  assert.equal(typeof registered[0].component, "function");
});
