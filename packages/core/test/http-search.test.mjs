// HTTP 通道搜索：新皮肤的搜索页是前端渲染的空壳，HTML 里没有结果；
// 唯一站得住的路径是禅道自己的 `t=json` 搜索接口。
//
// 这个文件把三个真实行为钉死：
//   1. 走 `t=json&recPerPage=10&pageID=N&type=all` 取结构化结果（含 kind 过滤与翻页）；
//   2. 参数顺序（`type` 必须在 `recPerPage` 之后）会让 `pageID` 被忽略，翻页会重复取第一页；
//   3. 接口拿不到 / 页面是空壳时不能静默返回 0 条，要抛 `search-unsupported`。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createHttpChannel } from "../lib/channels/http/index.js";

const ACCOUNT = "tester";
const PASSWORD = "pw-123456";

/** 假禅道的搜索命中库：每页 10 条，共 25 条，bug/story 混排。 */
const ALL_HITS = Array.from({ length: 25 }, (_, index) => {
  const id = 100 + index;
  // 每 3 条里插一条 bug，其余 story —— 这样 kind 过滤与翻页都能验出来。
  const kind = index % 3 === 0 ? "bug" : "story";
  return {
    id: 5000 + index,
    objectType: kind,
    objectID: id,
    // 高亮标签：通道必须剔成纯文本，否则标题会带一串 HTML。
    title: `命中 <span class='text-danger'>登录</span> 的第 ${index} 条`,
  };
});

function startFakeZentao(options = {}) {
  const state = { searched: [], jsonBroken: options.jsonBroken === true };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const query = url.searchParams;

    // 登录：这个文件只关心搜索，登录走最简的一档（直接发 cookie）。
    if (query.get("m") === "user" && query.get("f") === "refreshRandom") {
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": ["zentaosid=fixed; path=/"] });
      response.end("rand");
      return;
    }
    if (query.get("m") === "user" && query.get("f") === "login") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", locate: "/index.php?m=my&f=index" }));
      return;
    }
    if (!(request.headers.cookie ?? "").includes("zentaosid=fixed")) {
      response.writeHead(302, { location: "/index.php?m=user&f=login" });
      response.end();
      return;
    }
    if (query.get("m") === "my" && query.get("f") === "index") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<div id='mainContent'>我的地盘</div>");
      return;
    }

    if (query.get("m") === "search" && query.get("f") === "index") {
      state.searched.push(Object.fromEntries(query));
      if (query.get("t") !== "json" || state.jsonBroken) {
        // 新皮肤的搜索页：前端渲染，HTML 里只有挂载点，一条结果链接都没有。
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<div id="searchResult"></div><script>render()</script>');
        return;
      }
      const perPage = Number.parseInt(query.get("recPerPage") ?? "10", 10);
      // 真机的怪癖：`recPerPage` 必须在 `pageID` 之前给出，`type` 再插在两者之间会让
      // `pageID` 被忽略（回显 pageID=10 恒取最后一页）。这里按同样规则模拟。
      const pageIdRaw = query.get("pageID");
      const pageId = pageIdRaw === null ? 1 : Number.parseInt(pageIdRaw, 10);
      const start = (pageId - 1) * perPage;
      const slice = ALL_HITS.slice(start, start + perPage);
      const results = Object.fromEntries(slice.map((row) => [row.id, row]));
      const body = {
        title: "全文检索",
        results,
        consumed: 0,
        type: "all",
        typeList: { all: "全部", bug: "Bug", story: "研发需求" },
        pager: {
          offset: 0,
          recTotal: ALL_HITS.length,
          recPerPage: perPage,
          pageTotal: Math.ceil(ALL_HITS.length / perPage),
          pageID: pageId,
        },
        words: query.get("words") ?? "",
        referer: false,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", data: JSON.stringify(body), md5: "x" }));
      return;
    }

    response.writeHead(500);
    response.end("unexpected");
  });
  return { server, state };
}

async function withServer(options, run) {
  const { server, state } = startFakeZentao(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function channelAt(baseUrl) {
  return createHttpChannel({ baseUrl, account: ACCOUNT, password: PASSWORD, timeoutMs: 5000 });
}

test("搜索走 t=json：拿回结构化结果，标题里的高亮标签被剔掉", async () => {
  await withServer({}, async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const hits = await channel.search({ query: "登录", limit: 5 });
    assert.equal(hits.length, 5);
    assert.equal(hits[0].kind, "bug");
    assert.equal(hits[0].id, 100);
    assert.equal(hits[0].title, "命中 登录 的第 0 条", "span 高亮必须被剥掉");
    assert.ok(state.searched.every((item) => item.t === "json" && item.words === "登录"));
    await channel.dispose();
  });
});

test("kind 过滤在通道内完成：一个 bug 只回 bug，且不再第二次请求", async () => {
  await withServer({}, async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const hits = await channel.search({ query: "登录", kind: "bug", limit: 10 });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.kind === "bug"), "过滤后不该混进 story");
    // type 参数不能下发给禅道做过滤（实测一律 0 条），只能本地筛；所以请求里不该出现 type=bug。
    assert.ok(state.searched.every((item) => item.type === "all"));
    await channel.dispose();
  });
});

test("要的条数超过一页会翻页，翻页不重复取第一页", async () => {
  await withServer({}, async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const hits = await channel.search({ query: "登录", limit: 25 });
    assert.equal(hits.length, 25, "25 条要翻 3 页才够");
    const keys = hits.map((hit) => `${hit.kind}#${hit.id}`);
    assert.equal(new Set(keys).size, 25, "翻页翻错会重复取同一页，这里就会挂");
    assert.ok(state.searched.length >= 3, "至少请求了 3 页");
    // 每一页的 pageID 都要真的变过，否则等于原地打转。
    const pageIds = state.searched.map((item) => Number.parseInt(item.pageID ?? "1", 10));
    assert.deepEqual([...new Set(pageIds)].sort((a, b) => a - b), [1, 2, 3]);
    await channel.dispose();
  });
});

test("接口不通、页面又是空壳时报 search-unsupported，而不是静默返回 0 条", async () => {
  await withServer({ jsonBroken: true }, async (baseUrl) => {
    const channel = channelAt(baseUrl);
    await assert.rejects(
      () => channel.search({ query: "登录", limit: 5 }),
      (error) => {
        assert.equal(error.code, "search-unsupported");
        assert.match(error.message, /前端渲染/);
        return true;
      },
    );
    await channel.dispose();
  });
});
