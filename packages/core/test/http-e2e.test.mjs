// HTTP 通道端到端：起一个假禅道，走完「登录换 cookie → 取 zin 页面 → 解析 → 下附件落盘」。
// 真实禅道的行为（refreshRandom / 二次 md5 / zin JSON / historypanel）都按 12.x 的约定模拟，
// 这样在拿到真账号密码之前，这条链路的代码就是被真跑过的。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpChannel } from "../lib/channels/http/index.js";

const ACCOUNT = "tester";
const PASSWORD = "pw-123456";
const md5 = (value) => createHash("md5").update(value, "utf8").digest("hex");

const MAIN_HTML = `
<div class="datalist">
  <div class="datalist-item"><span class="datalist-item-label">Bug状态：</span><div class="datalist-item-content">激活</div></div>
  <div class="datalist-item"><span class="datalist-item-label">严重程度：</span><div class="datalist-item-content">2</div></div>
  <div class="datalist-item"><span class="datalist-item-label">优先级：</span><div class="datalist-item-content">3</div></div>
  <div class="datalist-item"><span class="datalist-item-label">所属产品：</span><div class="datalist-item-content">省协会会员系统</div></div>
  <div class="datalist-item"><span class="datalist-item-label">当前指派：</span><div class="datalist-item-content">wangwu</div></div>
  <div class="datalist-item"><span class="datalist-item-label">由谁创建：</span><div class="datalist-item-content">hongshun</div></div>
  <div class="datalist-item"><span class="datalist-item-label">创建日期：</span><div class="datalist-item-content">2026-10-30 14:17:56</div></div>
</div>
<div class="detail">
  <div class="detail-title">重现步骤</div>
  <div class="detail-content">1. 打开注册页<img src="/index.php?m=file&amp;f=read&amp;fileID=20881" />
2. 手机号重复也能提交</div>
</div>
<div zui-create-historypanel='{"actions":[
  {"date":"2026-10-30 14:18:02","actor":"wangwu","action":"commented","comment":"已经定位到校验函数"},
  {"date":"2026-10-30 15:00:00","actor":"hongshun","comment":"<p>补充：机构法人不受影响</p>"}
]}'></div>
<div class="files">
  <a href="/index.php?m=file&amp;f=download&amp;fileID=20881">image.png (42.5 KB)</a>
  <a href="/index.php?m=file&amp;f=download&amp;fileID=20890">规则说明.docx (21.5 KB)</a>
</div>
`;

// 只有正文内嵌图、没有「附件」栏的那种 bug 页（真机上很常见：截图直接贴在正文里）。
const INLINE_ONLY_HTML = `
<div id="mainContent">
  <span class="entity-title-text" title="BUG #5969 只有内嵌截图">BUG #5969 只有内嵌截图</span>
  <div class="datalist">
    <div class="datalist-item"><span class="datalist-item-label">Bug状态：</span><div class="datalist-item-content">激活</div></div>
  </div>
  <div class="detail">
    <div class="detail-title">重现步骤</div>
    <div class="detail-content">点这里就崩了<img src="/index.php?m=file&amp;f=read&amp;t=png&amp;fileID=20899" /></div>
  </div>
</div>
`;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function startFakeZentao() {
  const state = {
    logins: 0,
    downloads: 0,
    sessionValid: true,
    sid: "",
    rand: "",
    /** refreshRandom 不带 cookie 回来时，禅道把这算一次「无会话登录」。 */
    loginsWithoutCookie: 0,
    /** 正文内嵌图片的取字节次数（`f=read`）。 */
    reads: 0,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const query = url.searchParams;
    const cookie = request.headers.cookie ?? "";

    // 登录第一步：拿随机数。真实禅道会同时发一个会话 cookie，并把 rand 绑在这个会话上。
    if (query.get("m") === "user" && query.get("f") === "refreshRandom") {
      state.sid = `sess-${state.logins}-${Date.now().toString(36)}`;
      state.rand = `rand-${Math.random().toString(36).slice(2, 10)}`;
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": [`zentaosid=${state.sid}; path=/`, "lang=zh-cn; path=/"],
      });
      response.end(state.rand);
      return;
    }

    // 登录第二步：multipart 表单 → JSON
    if (query.get("m") === "user" && query.get("f") === "login") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      // 只把真正的登录 POST 记一次。会话过期时 fetch 会跟着 302 跳到这个 URL 上，
      // 那是一次 GET，不构成一次登录——把它算进来会让「有没有重登」这个断言失去意义。
      if (request.method === "POST") state.logins += 1;
      // 没有带着 refreshRandom 那个会话 cookie 就登不进——这是真机踩到的坑。
      if (!cookie.includes(`zentaosid=${state.sid}`)) {
        state.loginsWithoutCookie += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "failed", reason: "登录失败，请检查您的用户名或密码是否填写正确。" }));
        return;
      }
      state.sessionValid = true;
      const accountOk = body.includes(`name="account"\r\n\r\n${ACCOUNT}`) || body.includes(`\r\n\r\n${ACCOUNT}\r\n`);
      const passwordOk = body.includes(md5(md5(PASSWORD) + state.rand));
      if (!accountOk || !passwordOk) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "failed", reason: "登录失败，请检查您的用户名或密码是否填写正确。" }));
        return;
      }
      // 真实禅道成功时**不重发** zentaosid，只补 za/lang 这些；会话 id 还是第一步那个。
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": ["lang=zh-cn; path=/", `za=${ACCOUNT}; path=/`],
      });
      response.end(JSON.stringify({ status: "success", locate: "/index.php?m=my&f=index" }));
      return;
    }

    // 测试用：把当前会话踢掉（模拟 cookie 过期）
    if (query.get("m") === "__kick") {
      state.sessionValid = false;
      response.writeHead(200);
      response.end("kicked");
      return;
    }

    // 之后的页面都要 cookie
    if (!state.sessionValid || !cookie.includes(`zentaosid=${state.sid}`)) {
      response.writeHead(302, { location: "/index.php?m=user&f=login" });
      response.end();
      return;
    }

    if (query.get("m") === "my" && query.get("f") === "index") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<div id='mainContent'>我的地盘</div>");
      return;
    }

    if (query.get("m") === "bug" && query.get("f") === "view") {
      if (String(query.get("bugID")) === "5969") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<html><body>${INLINE_ONLY_HTML}</body></html>`);
        return;
      }
      if (String(query.get("bugID")) !== "5967") {
        response.writeHead(404, { "content-type": "text/html" });
        response.end("<title>404</title>");
        return;
      }
      if (query.get("zin") === "1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([
          { name: "title", data: "<span>BUG #5967 手机号重复仍可注册</span>" },
          { name: "main", data: MAIN_HTML },
        ]));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><head><title>BUG #5967 手机号重复仍可注册</title></head><body><div id="mainContent">${MAIN_HTML}</div></body></html>`);
      return;
    }

    if (query.get("m") === "file" && query.get("f") === "read") {
      state.reads += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG_BYTES);
      return;
    }

    if (query.get("m") === "file" && query.get("f") === "download") {
      state.downloads += 1;
      const id = query.get("fileID");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(`bytes-of-${id}`);
      return;
    }

    response.writeHead(500);
    response.end("unexpected");
  });
  return { server, state };
}

async function withServer(run) {
  const { server, state } = startFakeZentao();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function channelAt(baseUrl, password = PASSWORD) {
  return createHttpChannel({ baseUrl, account: ACCOUNT, password, timeoutMs: 5000 });
}

test("登录换 cookie → 取 zin 页面 → 字段/正文/备注/附件全部落位", async () => {
  const dir = join(tmpdir(), `life-saver-http-${process.pid}`);
  await withServer(async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const { entity, source, missing } = await channel.read({
      kind: "bug",
      id: 5967,
      withAttachments: true,
      attachmentDir: dir,
      maxAttachments: 10,
      maxAttachmentBytes: 1024 * 1024,
    });
    assert.equal(source, "http");
    assert.ok(Array.isArray(missing));

    assert.equal(entity.kind, "bug");
    assert.equal(entity.id, 5967);
    assert.equal(entity.title, "BUG #5967 手机号重复仍可注册");
    assert.equal(entity.status, "激活");
    assert.equal(entity.severity, 2);
    assert.equal(entity.pri, 3);
    assert.equal(entity.productName, "省协会会员系统");
    assert.equal(entity.assignedTo, "wangwu");
    // 正文里的 <img> 变成占位符，交给渲染层决定怎么展示
    assert.match(entity.steps, /@@file:20881@@/);
    assert.match(entity.steps, /手机号重复也能提交/);

    // 两条备注：一处来自 historypanel 的 comment，一处来自 content（HTML 被去标签）
    assert.equal(entity.notes.length, 2);
    assert.equal(entity.notes[0].who, "wangwu");
    assert.match(entity.notes[1].comment, /机构法人不受影响/);

    // 附件清单 + 真落盘
    const ids = entity.attachments.map((item) => item.fileId).sort();
    assert.deepEqual(ids, [20881, 20890]);
    const png = entity.attachments.find((item) => item.fileId === 20881);
    assert.equal(png.isImage, true);
    assert.equal(png.size, 43520);
    assert.ok(png.localPath, "图片应已下载");
    assert.equal(await readFile(png.localPath, "utf8"), "bytes-of-20881");
    assert.equal(state.logins, 1, "只应登录一次");
    assert.equal(state.loginsWithoutCookie, 0, "登录必须带上 refreshRandom 那个会话 cookie，否则真机会报「用户名或密码不正确」");
    assert.equal(state.downloads, 2);

    // 第二次读取复用 cookie，不再登录
    await channel.read({ kind: "bug", id: 5967, withAttachments: false, maxAttachments: 0, maxAttachmentBytes: 0 });
    assert.equal(state.logins, 1, "cookie 应被复用");
    await channel.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});

test("密码错：报禅道原话，不假装成功", async () => {
  await withServer(async (baseUrl) => {
    const channel = channelAt(baseUrl, "wrong-password");
    await assert.rejects(
      () => channel.read({ kind: "bug", id: 5967, withAttachments: false, maxAttachments: 0, maxAttachmentBytes: 0 }),
      (error) => error.code === "login" && /登录失败|用户名或密码/.test(error.message),
    );
    await channel.dispose();
  });
});

test("probe：登录成功且能取页面才算 ready", async () => {
  await withServer(async (baseUrl) => {
    const channel = channelAt(baseUrl);
    const probe = await channel.probe();
    assert.equal(probe.ok, true);
    await channel.dispose();
    const bad = channelAt(baseUrl, "nope");
    const failed = await bad.probe();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /登录失败|用户名或密码/);
    await bad.dispose();
  });
});

test("附件预算为 0 时不下载任何附件，但清单照给", async () => {
  await withServer(async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const { entity } = await channel.read({
      kind: "bug",
      id: 5967,
      withAttachments: true,
      attachmentDir: join(tmpdir(), `life-saver-http-${process.pid}`),
      maxAttachments: 0,
      maxAttachmentBytes: 1024,
    });
    assert.equal(state.downloads, 0);
    assert.equal(entity.attachments.length, 2);
    assert.ok(entity.attachments.every((item) => item.localPath === undefined));
    await channel.dispose();
  });
});

test("正文内嵌的图片也落盘：按字节头补扩展名，并在 missing 里不再说拿不到附件字节", async () => {
  const dir = join(tmpdir(), `life-saver-http-inline-${process.pid}`);
  await withServer(async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    const { entity, missing } = await channel.read({
      kind: "bug",
      id: 5969,
      withAttachments: true,
      attachmentDir: dir,
      maxAttachments: 10,
      maxAttachmentBytes: 1024 * 1024,
    });

    assert.equal(entity.attachments.length, 1);
    const image = entity.attachments[0];
    assert.equal(image.fileId, 20899);
    assert.equal(image.isImage, true);
    assert.match(image.localPath, /20899-image\.png$/);
    const bytes = await readFile(image.localPath);
    assert.equal(bytes.subarray(0, 4).toString("hex"), "89504e47");
    assert.deepEqual(missing, [], "已经落盘了就别再说「附件字节拿不到」");
    assert.equal(state.reads, 1, "内嵌图走 f=read，只取一次");

    await channel.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});

test("会话过期（302 到登录页）会自动重登一次", async () => {
  await withServer(async (baseUrl, state) => {
    const channel = channelAt(baseUrl);
    await channel.read({ kind: "bug", id: 5967, withAttachments: false, maxAttachments: 0, maxAttachmentBytes: 0 });
    assert.equal(state.logins, 1);
    // 服务端把会话踢掉：下一次取页面会 302 到登录页，通道应重登后再取一次
    await fetch(`${baseUrl}/index.php?m=__kick`);
    const again = (await channel.read({ kind: "bug", id: 5967, withAttachments: false, maxAttachments: 0, maxAttachmentBytes: 0 })).entity;
    assert.equal(state.logins, 2, "会话失效后应重新登录");
    assert.equal(again.title, "BUG #5967 手机号重复仍可注册");
    await channel.dispose();
  });
});

test("目录里只出现收敛后的文件名", async () => {
  const dir = join(tmpdir(), `life-saver-http-names-${process.pid}`);
  await withServer(async (baseUrl) => {
    const channel = channelAt(baseUrl);
    await channel.read({
      kind: "bug",
      id: 5967,
      withAttachments: true,
      attachmentDir: dir,
      maxAttachments: 10,
      maxAttachmentBytes: 1024 * 1024,
    });
    assert.deepEqual((await readdir(dir)).sort(), ["20881_image.png", "20890_规则说明.docx"]);
    await channel.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});
