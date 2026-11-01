// 结构探测（自探索）的回归：这份代码的价值全在「换了部署别读错」，
// 所以每一层都要能单独验：缓存怎么失效、覆盖层怎么压过探索层、
// 库结构怎么判、皮肤怎么认、状态页有没有把「未确认」说清楚。
//
// 全部离线：假 DbHandle + 手写 HTML，不连禅道。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, unwrapConfig } from "life-saver-core/config.js";
import { findStory, searchBugs, searchStories } from "life-saver-core/channels/db/queries.js";
import { probeSchema } from "life-saver-core/channels/db/schema.js";
import { parsePage } from "life-saver-core/channels/http/parse.js";
import {
  DEFAULT_DB_FEATURES,
  DiscoveryStore,
  fingerprintOf,
  isStale,
  resolveDbFeatures,
  resolveSkin,
} from "life-saver-core/domain/discovery.js";
import { LifeSaverService } from "life-saver-core/service.js";
import { createStatusTool } from "../lib/tools/status.js";

const base = unwrapConfig(new Config({}));

/** 拼一份配置：只覆盖关心的那几层，其余沿用 schema 默认值。 */
function makeConfig(patch = {}) {
  return {
    ...base,
    ...patch,
    db: { ...base.db, ...(patch.db ?? {}) },
    http: { ...base.http, ...(patch.http ?? {}) },
    sftp: { ...base.sftp, ...(patch.sftp ?? {}) },
    discovery: { ...base.discovery, ...(patch.discovery ?? {}) },
  };
}

const deployed = makeConfig({
  db: { host: "192.0.2.10", port: 3306, database: "zentao", prefix: "zt_" },
  http: { baseUrl: "http://192.0.2.10/" },
});

/** 一份最小快照（只放探测层真正会写的字段）。 */
function snapshotOf(fingerprint, extra = {}) {
  return { fingerprint, at: 1000, dbNotes: [], warnings: [], ...extra };
}

test("探测缓存：同指纹复用，换部署直接丢弃旧结论", () => {
  const store = new DiscoveryStore(() => 1000);
  const fp = fingerprintOf(deployed);
  const db = { hasKeywords: false, projectSource: "story", confirmed: true };
  const snap = store.merge(fp, { db, dbNotes: ["搜索：只有标题"] });

  assert.equal(snap.at, 1000);
  assert.equal(snap.db.hasKeywords, false);
  assert.deepEqual(snap.dbNotes, ["搜索：只有标题"]);
  assert.equal(store.get(fp).db.projectSource, "story");

  // 指纹不符 = 另一套禅道。把上一套的结论套上来比不探更危险。
  assert.equal(store.get(fp + "-other"), undefined);
});

test("探测失败不续 TTL：没探到事实就不能算「刚探过」", () => {
  let now = 1000;
  const store = new DiscoveryStore(() => now);
  const fp = fingerprintOf(deployed);
  store.merge(fp, { db: { hasKeywords: true, projectSource: "relation", confirmed: true } });

  now = 900000;
  const after = store.merge(fp, { warnings: ["读 information_schema 失败：denied"] });
  assert.equal(after.at, 1000, "失败的一次不能把探测时间刷新，否则会一直用旧结论装作刚探过");
  assert.equal(after.warnings.length, 1);
  assert.match(after.warnings[0], /denied/);
});

test("过期判定：ttl 为 0 视为每次都重探", () => {
  const fp = fingerprintOf(deployed);
  const snap = snapshotOf(fp);
  assert.equal(isStale(undefined, 0, 60000), true);
  assert.equal(isStale(snap, 60999, 60000), false);
  assert.equal(isStale(snap, 61000, 60000), true);
  assert.equal(isStale(snap, 1001, 0), true);
});

test("覆盖层压过探索层：db.keywords 显式配了就按配置", () => {
  const fp = fingerprintOf(deployed);
  const probed = snapshotOf(fp, {
    db: { hasKeywords: true, projectSource: "relation", confirmed: true },
  });

  const off = resolveDbFeatures(makeConfig({ db: { keywords: "off" } }), probed);
  assert.equal(off.hasKeywords, false);
  assert.equal(off.confirmed, true, "手工指定也是「确认过的」");

  const on = resolveDbFeatures(makeConfig({ db: { keywords: "on" } }), undefined);
  assert.equal(on.hasKeywords, true);
  assert.equal(on.confirmed, true);

  const autoNoProbe = resolveDbFeatures(makeConfig(), undefined);
  assert.deepEqual(autoNoProbe, DEFAULT_DB_FEATURES, "没探到时用默认层，并标未确认");

  const autoProbed = resolveDbFeatures(
    makeConfig(),
    snapshotOf(fp, { db: { hasKeywords: false, projectSource: "none", confirmed: true } }),
  );
  assert.equal(autoProbed.hasKeywords, false);
  assert.equal(autoProbed.projectSource, "none");
  assert.equal(autoProbed.confirmed, true);
});

test("皮肤：配了用配置，没配用探索层，都没探到返回 undefined", () => {
  assert.equal(resolveSkin(makeConfig({ http: { skin: "detail" } }), undefined), "detail");
  assert.equal(resolveSkin(makeConfig(), snapshotOf(fingerprintOf(deployed), { skin: "article" })), "article");
  assert.equal(resolveSkin(makeConfig(), undefined), undefined);
});

/** 假 DbHandle：按 information_schema 的两条查询分派。 */
function fakeSchemaDb({ columns = [], relation = false, failColumns = false, failRelation = false } = {}) {
  const calls = [];
  return {
    calls,
    table: (name) => `zt_${name}`,
    async query(sql) {
      calls.push(sql);
      if (/information_schema\.COLUMNS/.test(sql)) {
        if (failColumns) throw new Error("SELECT command denied");
        return columns.map((name) => ({ name }));
      }
      if (/information_schema\.TABLES/.test(sql)) {
        if (failRelation) throw new Error("SELECT command denied");
        return relation ? [{ name: "zt_projectstory" }] : [];
      }
      throw new Error(`未预置的查询：${sql}`);
    },
  };
}

test("库结构探测：新库（有关联表）→ keywords 两列匹配 + 关联表取项目", async () => {
  const db = fakeSchemaDb({ columns: ["id", "title", "keywords", "status"], relation: true });
  const result = await probeSchema(db);

  assert.deepEqual(result.features, { hasKeywords: true, projectSource: "relation", confirmed: true });
  assert.deepEqual(result.warnings, []);
  assert.match(result.notes.join(" "), /keywords/);
  assert.match(result.notes.join(" "), /zt_projectstory/);
  assert.equal(db.calls.length, 2, "探测预算就是两条查询");
  assert.ok(db.calls.every((sql) => !/FROM zt_story/.test(sql)), "不碰业务表");
});

test("库结构探测：老库（无 keywords、无关联表但有 project 列）", async () => {
  const db = fakeSchemaDb({ columns: ["id", "title", "project"], relation: false });
  const result = await probeSchema(db);

  assert.equal(result.features.hasKeywords, false);
  assert.equal(result.features.projectSource, "story");
  assert.equal(result.features.confirmed, true);
  assert.match(result.notes.join(" "), /没有 keywords 列/);
  assert.match(result.notes.join(" "), /zt_story\.project/);
});

test("库结构探测：story 表都查不到 → 未确认，并点名 db.prefix", async () => {
  const db = fakeSchemaDb({ columns: [], relation: false });
  const result = await probeSchema(db);

  assert.equal(result.features.confirmed, false);
  assert.equal(result.features.hasKeywords, DEFAULT_DB_FEATURES.hasKeywords);
  assert.match(result.warnings.join(" "), /找不到 zt_story/);
  assert.match(result.warnings.join(" "), /db\.prefix/);
});

test("库结构探测：information_schema 没权限 → 降级成 warning，不抛", async () => {
  const db = fakeSchemaDb({ failColumns: true, failRelation: true });
  const result = await probeSchema(db);

  assert.equal(result.features.confirmed, false);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(" "), /denied/);
});

const SKIN_NEW = `<div zui-key="body">
  <div class="detail-section"><div class="detail-section-title">重现步骤</div><div class="detail-section-content">步骤一</div></div>
</div>`;
const SKIN_OLD = `<div class="detail"><div class="detail-title">描述</div><div class="detail-content">老正文</div></div>`;
const SKIN_ARTICLE = `<div class="article">裸正文</div>`;

test("页面皮肤：三套选择器都要能认出来，并报出命中的是哪一套", () => {
  assert.equal(parsePage(SKIN_NEW).skin, "detail-section");
  assert.equal(parsePage(SKIN_OLD).skin, "detail");
  assert.equal(parsePage(SKIN_ARTICLE).skin, "article");
  assert.equal(parsePage(SKIN_OLD).sections[0].text, "老正文");
});

test("页面皮肤：配了 http.skin 就把那档提到最前（串味时能手工钉死）", () => {
  const mixed = SKIN_OLD + SKIN_ARTICLE;
  assert.equal(parsePage(mixed).skin, "detail", "默认按新→老顺序");
  const pinned = parsePage(mixed, { skin: "article" });
  assert.equal(pinned.skin, "article");
  assert.equal(pinned.sections[0].text, "裸正文");
});

test("空页面：skin 为 undefined 且带原 HTML 长度（供上层显式报错）", () => {
  const html = "<div></div>";
  const page = parsePage(html);
  assert.equal(page.skin, undefined);
  assert.equal(page.sections.length, 0);
  assert.equal(page.htmlLength, html.length);
});

/** 假 DbHandle：只收集 SQL，用来锁「能力开关有没有真的改变语句」。 */
function captureDb() {
  const seen = [];
  return {
    seen,
    table: (name) => `zt_${name}`,
    async one(sql, params) {
      seen.push({ sql, params });
      return undefined;
    },
    async query(sql, params) {
      seen.push({ sql, params });
      return [];
    },
  };
}

const RELATION = { hasKeywords: true, projectSource: "relation", confirmed: true };
const OLD_STORY = { hasKeywords: false, projectSource: "story", confirmed: true };
const NO_PROJECT = { hasKeywords: false, projectSource: "none", confirmed: true };

test("feature-aware SQL：所属项目按探测结果换写法", async () => {
  const relation = captureDb();
  await findStory(relation, 1, RELATION);
  assert.match(relation.seen[0].sql, /zt_projectstory/);

  const old = captureDb();
  await findStory(old, 1, OLD_STORY);
  assert.doesNotMatch(old.seen[0].sql, /zt_projectstory/);
  assert.match(old.seen[0].sql, /product, module, project, parent/);

  const none = captureDb();
  await findStory(none, 1, NO_PROJECT);
  assert.match(none.seen[0].sql, /NULL AS project/);
});

test("feature-aware SQL：没有 keywords 列就只按标题搜（不许报 SQL 错）", async () => {
  const modern = captureDb();
  await searchStories(modern, "%登录%", 5, RELATION);
  assert.match(modern.seen[0].sql, /keywords LIKE \?/);
  assert.deepEqual(modern.seen[0].params, ["%登录%", "%登录%", 5]);

  const legacy = captureDb();
  await searchBugs(legacy, "%登录%", 5, NO_PROJECT);
  assert.doesNotMatch(legacy.seen[0].sql, /keywords/);
  assert.match(legacy.seen[0].sql, /title LIKE \?/);
  assert.deepEqual(legacy.seen[0].params, ["%登录%", 5], "参数个数要跟着 where 一起变，否则 LIMIT 会吃错值");
});

test("兜底：结构还没探过 + 老库缺 keywords 列 → 自动退成只匹配标题", async () => {
  const calls = [];
  const legacy = {
    table: (name) => `zt_${name}`,
    async one() {
      return undefined;
    },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/keywords/.test(sql)) {
        const error = new Error("Unknown column 'zt_story.keywords' in 'where clause'");
        error.code = "ER_BAD_FIELD_ERROR";
        throw error;
      }
      return [{ id: 7, title: "登录页", status: "active" }];
    },
  };

  const rows = await searchStories(legacy, "%登录%", 5);
  assert.equal(calls.length, 2, "先按默认（带 keywords）试一次，撞错再按标题重来一次");
  assert.match(calls[0].sql, /keywords LIKE \?/);
  assert.doesNotMatch(calls[1].sql, /keywords/);
  assert.deepEqual(rows, [{ id: 7, title: "登录页", status: "active" }]);
});

test("兜底不许伪装：结构已确认时缺 keywords 列要如实报错", async () => {
  const failing = {
    table: (name) => `zt_${name}`,
    async one() {
      return undefined;
    },
    async query() {
      const error = new Error("Unknown column 'zt_story.keywords' in 'where clause'");
      error.code = "ER_BAD_FIELD_ERROR";
      throw error;
    },
  };
  await assert.rejects(() => searchStories(failing, "%x%", 5, RELATION), /keywords/);

  const otherColumn = {
    table: (name) => `zt_${name}`,
    async one() {
      return undefined;
    },
    async query() {
      const error = new Error("Unknown column 'zt_story.stage' in 'field list'");
      error.code = "ER_BAD_FIELD_ERROR";
      throw error;
    },
  };
  await assert.rejects(
    () => searchStories(otherColumn, "%x%", 5),
    /stage/,
    "别的缺列错误不能被当成 keywords 吞掉，否则真正的结构问题会被藏起来",
  );
});

/** 起一个服务：两条通道都指向 127.0.0.1:1（立刻 ECONNREFUSED），所以探活毫秒级失败。 */
function deadService(patch = {}) {
  const config = makeConfig({
    db: { host: "127.0.0.1", port: 1, user: "root" },
    http: { baseUrl: "http://127.0.0.1:1" },
    ...patch,
  });
  const service = new LifeSaverService({
    config: () => config,
    secrets: async () => ({ dbPassword: "x", httpPassword: "y" }),
  });
  return service;
}

test("状态页：探不通时也要把「结构未确认」说清楚，而不是留空", async () => {
  const service = deadService();
  try {
    const status = await service.status();
    assert.equal(status.discovery.enabled, true);
    assert.equal(status.discovery.confirmed, false);
    assert.equal(status.discovery.skin, undefined);
    assert.equal(status.discovery.loginFlow, undefined);
    assert.match(status.discovery.where, /127\.0\.0\.1:1\/zentao/);
    assert.equal(status.discovery.stale, true, "没有快照 = 过期，下次体检会重探");

    const tool = createStatusTool(service);
    const out = await tool.execute({}, { signal: undefined });
    assert.match(out.markdown, /结构探测/);
    assert.match(out.markdown, /未确认（用默认值）/);
    assert.match(out.markdown, /页面皮肤：未确认/);
    assert.match(out.markdown, /登录算法：未确认/);
  } finally {
    await service.dispose();
  }
});

test("状态页：自探索关掉就明说用的是默认结构", async () => {
  const service = deadService({ discovery: { enabled: false } });
  try {
    const tool = createStatusTool(service);
    const out = await tool.execute({}, { signal: undefined });
    assert.match(out.markdown, /已关闭/);
    assert.match(out.markdown, /默认结构/);
  } finally {
    await service.dispose();
  }
});
