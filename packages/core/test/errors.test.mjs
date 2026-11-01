// 报错要能指导下一步：用户没配就直说没配，两条通道都挂了要说清各挂在哪。
// 全部指向 127.0.0.1:1（立刻 ECONNREFUSED），所以这些用例都是毫秒级。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, unwrapConfig } from "../lib/config.js";
import { LifeSaverService } from "../lib/service.js";

const base = unwrapConfig(new Config({}));
const deadDb = { ...base.db, host: "127.0.0.1", port: 1, user: "root" };
const deadHttp = { ...base.http, baseUrl: "http://127.0.0.1:1" };

async function failureOf(config, secrets = { dbPassword: "x" }) {
  const service = new LifeSaverService({ config: () => config, secrets: async () => secrets });
  try {
    await service.read({
      kind: "bug",
      id: 5967,
      scope: "brief",
      withAttachments: false,
      maxAttachments: 1,
      maxAttachmentBytes: 1,
    });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await service.dispose();
  }
}

test("db 通道没配地址：直接说没配，不去连默认地址", async () => {
  const error = await failureOf({ ...base, mode: "db", db: { ...base.db, host: "" } });
  assert.equal(error.code, "config");
  assert.match(error.message, /未配置 db\.host/);
});

test("db 通道没配账号 / 密码：分别点名缺什么", async () => {
  const noUser = await failureOf({ ...base, mode: "db", db: { ...deadDb, user: "" } });
  assert.match(noUser.message, /未配置 db\.user/);
  const noPassword = await failureOf({ ...base, mode: "db", db: deadDb }, {});
  assert.match(noPassword.message, /未配置 ZENTAO_DB_PASSWORD/);
});

test("http 通道缺账号：说清缺的是账号而不是密码", async () => {
  const error = await failureOf({ ...base, mode: "http", http: deadHttp });
  assert.match(error.message, /未配置 http\.account/);
});

test("连不上库时给出原因与下一步，而不是一条空白错误", async () => {
  const error = await failureOf({ ...base, mode: "db", db: deadDb });
  assert.match(error.message, /ECONNREFUSED/);
  assert.match(error.message, /端口上没有服务在监听/);
});

test("auto 两条都挂：交代降级链与上一条的真实原因，且不重复实体名", async () => {
  const error = await failureOf({ ...base, mode: "auto", db: deadDb, http: deadHttp });
  assert.match(error.message, /已尝试：db → http/);
  assert.match(error.message, /db 的原因：connect ECONNREFUSED/);
  assert.ok(!/bug#5967失败/.test(error.message), `实体名重复了：${error.message}`);
  const occurrences = error.message.split("bug#5967").length - 1;
  assert.equal(occurrences, 1);
});

test("配置类错误带一句“去哪儿改”的 hint", async () => {
  const error = await failureOf({ ...base, mode: "db", db: { ...base.db, host: "" } });
  assert.match(error.hint ?? "", /配置|环境变量|凭据中心/);
});
