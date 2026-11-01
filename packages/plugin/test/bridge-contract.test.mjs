// 门面契约：桥接路由与写工具的「对外承诺」。
//
// 这些测试不打真禅道，也不进浏览器，只用假宿主把契约钉死：
//   - /config-describe 必须原样摊出宿主眼里的那一行（命名空间、revision、值）；
//   - /config-set 的校验、往返、冲突翻译不能悄悄变（页面全靠它把错误原文给用户看）；
//   - zentao_bug_op / zentao_task_op 的动作白名单不能串味（写错 kind 会往禅道写脏数据）。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Config, unwrapConfig } from "life-saver-core/config.js";
import { makeBridgeRoutes } from "../lib/bridge/routes.js";
import { LifeSaverService } from "life-saver-core/service.js";
import { BUG_ACTIONS, TASK_ACTIONS } from "life-saver-core/channels/write.js";
import { createBugOpTool } from "../lib/tools/bugop.js";
import { createTaskOpTool } from "../lib/tools/taskop.js";

const base = unwrapConfig(new Config({}));

/** 造一个只够路由用的假宿主：describe/mutate 直接操作内存里那一行。 */
function fakeSettings(rows = [{ ns: "life-saver", revision: 3, value: { ...base } }]) {
  const store = JSON.parse(JSON.stringify(rows));
  return {
    store,
    describe: () => store.map((row) => ({ ...row })),
    async mutate(ns, ops, expectedRevision) {
      const row = store.find((item) => item.ns === ns);
      if (row === undefined) throw new Error(`找不到命名空间 ${ns}`);
      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        const error = new Error(`版本不一致：期望 ${expectedRevision}，实际 ${row.revision}`);
        error.name = "SettingsConflictError";
        throw error;
      }
      for (const op of ops) {
        const path = op.path;
        let cursor = row.value;
        for (const segment of path.slice(0, -1)) {
          if (cursor[segment] === undefined || cursor[segment] === null) cursor[segment] = {};
          cursor = cursor[segment];
        }
        const last = path[path.length - 1];
        if (op.op === "set") cursor[last] = op.value;
        else delete cursor[last];
      }
      row.revision += 1;
      return { revision: row.revision };
    },
  };
}

function fakeService() {
  const config = {
    ...base,
    http: { ...base.http, baseUrl: "http://127.0.0.1:1", account: "tester" },
    db: { ...base.db, host: "127.0.0.1", port: 1, user: "root" },
  };
  return new LifeSaverService({ config: () => config, secrets: async () => ({ dbPassword: "x" }) });
}

/** 只看 config-* 两三条路由，其余依赖给最小占位。 */
function makeRoutes(settings = fakeSettings()) {
  return {
    settings,
    routes: makeBridgeRoutes({
      credentials: () => undefined,
      service: fakeService(),
      secrets: async () => ({}),
      config: () => ({ ...base }),
      settings: () => (settings === null ? undefined : settings),
      workspaceRegistry: () => undefined,
      sessionController: () => undefined,
      namespace: "life-saver",
    }),
  };
}

/** 造一个够用的 req：能 for-await 出体、带 headers；res 只收状态码与 JSON。 */
function callRoute(route, { body, method = "POST", headers = {} } = {}) {
  const payload = Buffer.from(body === undefined ? "" : JSON.stringify(body));
  const req = Readable.from([payload]);
  req.method = method;
  req.headers = { host: "127.0.0.1:64588", "content-type": "application/json", ...headers };
  const res = {
    status: 0,
    headers: {},
    payload: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (typeof chunk === "string") this.payload += chunk;
    },
  };
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.status,
    body: res.payload === "" ? undefined : JSON.parse(res.payload),
  }));
}

function routeOf(routes, name) {
  const route = routes.find((item) => item.path.endsWith(`/${name}`));
  assert.ok(route, `缺少路由 ${name}`);
  return route;
}

test("契约：config-describe 原样摊开宿主眼里的这一行", async () => {
  const { routes } = makeRoutes();
  const { status, body } = await callRoute(routeOf(routes, "config-describe"), {});
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.namespace, "life-saver");
  assert.deepEqual(body.value.available, ["life-saver"]);
  assert.equal(body.value.found, true);
  assert.equal(body.value.revision, 3);
  assert.equal(body.value.value.db.prefix, base.db.prefix);
});

test("契约：config-describe 在没有本插件的行时如实说 found:false", async () => {
  const { routes } = makeRoutes(fakeSettings([{ ns: "别家的插件", revision: 1, value: {} }]));
  const { body } = await callRoute(routeOf(routes, "config-describe"), {});
  assert.equal(body.ok, true);
  assert.equal(body.value.found, false);
  assert.deepEqual(body.value.available, ["别家的插件"]);
  assert.equal(body.value.value, undefined);
});

test("契约：config-set → config-describe 往返，且 revision 前进一位", async () => {
  const { routes, settings } = makeRoutes();
  const set = await callRoute(routeOf(routes, "config-set"), {
    body: { ops: [{ op: "set", path: ["db", "port"], value: 13307 }], revision: 3 },
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.ok, true, set.body.message);
  assert.equal(set.body.value.applied, 1);
  assert.equal(set.body.value.revision, 4);
  assert.equal(set.body.value.saved.db.port, 13307);
  assert.equal(settings.store[0].value.db.port, 13307);

  const describe = await callRoute(routeOf(routes, "config-describe"), {});
  assert.equal(describe.body.value.revision, 4);
  assert.equal(describe.body.value.value.db.port, 13307);
});

test("契约：config-set 的 unset 真的把键删掉", async () => {
  const { routes, settings } = makeRoutes();
  const result = await callRoute(routeOf(routes, "config-set"), {
    body: { ops: [{ op: "unset", path: ["output", "dir"] }], revision: 3 },
  });
  assert.equal(result.body.ok, true, result.body.message);
  assert.equal(Object.hasOwn(settings.store[0].value.output, "dir"), false);
});

test("契约：明显不合法的提交在碰到宿主之前就被拒", async () => {
  const { routes, settings } = makeRoutes();
  const cases = [
    { ops: [], code: /非空数组/ },
    { ops: [{ op: "set", path: ["db", "port"], value: 1 }].concat(Array.from({ length: 64 }, () => ({ op: "unset", path: ["a"] }))), code: /64/ },
    { ops: [{ op: "del", path: ["db"] }], code: /未知操作/ },
    { ops: [{ op: "set", path: [], value: 1 }], code: /1–4 段/ },
    { ops: [{ op: "set", path: ["db", "po-rt"], value: 1 }], code: /非法配置路径/ },
    { ops: [{ op: "set", path: ["targets"], value: [{ id: "x" }] }], code: /只接受标量/ },
  ];
  for (const item of cases) {
    const { body } = await callRoute(routeOf(routes, "config-set"), { body: { ops: item.ops } });
    assert.equal(body.ok, false, JSON.stringify(item.ops).slice(0, 60));
    assert.equal(body.code, "config-rejected");
    assert.match(body.message, item.code);
  }
  assert.equal(settings.store[0].revision, 3, "被拒的提交不许动宿主状态");
});

test("契约：版本冲突翻成 config-conflict，其它写失败翻成 config-write-failed", async () => {
  const { routes } = makeRoutes();
  const conflict = await callRoute(routeOf(routes, "config-set"), {
    body: { ops: [{ op: "set", path: ["mode"], value: "http" }], revision: 99 },
  });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.code, "config-conflict");
  assert.match(conflict.body.message, /版本不一致/);

  const broken = makeRoutes({
    describe: () => [],
    async mutate() {
      throw new Error("磁盘写满");
    },
  });
  const failed = await callRoute(routeOf(broken.routes, "config-set"), {
    body: { ops: [{ op: "set", path: ["mode"], value: "http" }] },
  });
  assert.equal(failed.body.code, "config-write-failed");
  assert.match(failed.body.message, /磁盘写满/);
});

test("契约：设置服务没就绪时说人话，而不是崩", async () => {
  const { routes } = makeRoutes(null);
  const describe = await callRoute(routeOf(routes, "config-describe"), {});
  assert.equal(describe.body.code, "settings-unavailable");
  const set = await callRoute(routeOf(routes, "config-set"), {
    body: { ops: [{ op: "set", path: ["mode"], value: "http" }] },
  });
  assert.equal(set.body.code, "settings-unavailable");
});

test("契约：桥接只接受本机或同源的非 GET POST", async () => {
  const { routes } = makeRoutes();
  const route = routeOf(routes, "config-describe");
  const wrongMethod = await callRoute(route, { body: {}, method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, "method-not-allowed");

  // 恶意网页往 127.0.0.1 发 POST：Host 是回环地址，光看 Host 挡不住，必须看 Origin。
  const crossSite = await callRoute(route, {
    body: {},
    headers: { host: "127.0.0.1:64588", origin: "https://evil.example.com" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.code, "forbidden");

  // 非回环 Host 又不带 Origin（外部机器直连）：也挡。
  const remote = await callRoute(route, { body: {}, headers: { host: "192.0.2.11:64588" } });
  assert.equal(remote.status, 403);

  const sameOrigin = await callRoute(route, {
    body: undefined,
    headers: { host: "127.0.0.1:64588", origin: "http://127.0.0.1:64588" },
  });
  assert.equal(sameOrigin.status, 200);
});

test("契约：zentao_bug_op 不认任务的动作，且把合法动作写在报错里", async () => {
  const tool = createBugOpTool(fakeService());
  await assert.rejects(
    () => tool.execute({ id: "1", action: "finish" }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGS");
      for (const action of BUG_ACTIONS) assert.match(error.message, new RegExp(action));
      assert.doesNotMatch(error.message, /finish/);
      return true;
    },
  );
});

test("契约：zentao_task_op 不认 BUG 专属动作", async () => {
  const tool = createTaskOpTool(fakeService());
  await assert.rejects(
    () => tool.execute({ id: "1", action: "resolve" }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGS");
      for (const action of TASK_ACTIONS) assert.match(error.message, new RegExp(action));
      return true;
    },
  );
});

test("契约：写工具的前置参数校验先于任何连接（resolve 缺 resolution / 记工时缺 consumed）", async () => {
  const bug = createBugOpTool(fakeService());
  await assert.rejects(
    () => bug.execute({ id: "1", action: "resolve" }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, "bad-args");
      assert.match(error.message, /resolution/);
      return true;
    },
  );
  await assert.rejects(
    () => bug.execute({ id: "1", action: "recordworkhour" }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, "bad-args");
      assert.match(error.message, /consumed/);
      return true;
    },
  );
  await assert.rejects(
    () => bug.execute({ id: "0", action: "comment", comment: "x" }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, "bad-args");
      return true;
    },
  );
});
