/**
 * 开新会话（zentao_session_start 的 launcher）：假宿主服务跑真链路。
 *
 *   node --test test/session-launcher.test.mjs
 *
 * 用假的 workspaceRegistry / sessionController 替身，确认：
 * 目标匹配、dryRun 不建会话、建会话→改名→发提示词的调用顺序、
 * session.create 只给 workspaceId、agent 自主调用受开关约束、匹配不上列候选、
 * 已登记同路径工作区直接复用。
 *
 * 另外锁住一个真实踩过的坑：宿主 `SessionController.prompt(request, signal)`
 * 第一行就是 `signal.throwIfAborted()`，signal 不是可选参数——这里故意让替身
 * 复刻该行为，谁把 signal 改回可选就会当场红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSession } from "../lib/session/launcher.js";

/** 造一套假宿主 + 临时工作区根目录，返回 {root, config, deps, calls, cleanup}。 */
async function harness({ registerWorkspace = false, sessions = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "life-saver-session-"));
  const calls = [];
  // 会话行的 cwd 要指向这个临时目录，但目录是这里才创建的，所以让调用方写 "<root>" 占位。
  const items = sessions.map((item) => (item.cwd === "<root>" ? { ...item, cwd: root } : item));

  const config = {
    targets: JSON.stringify([
      {
        id: "park",
        name: "园区V2",
        path: root,
        zentaoProjects: ["园区V2"],
        repos: [{ role: "server", path: "server", gitUrl: "", branches: [] }],
      },
    ]),
    session: { enabled: true, agentAutoStart: true, autoPrompt: false, promptTemplate: "", reuseExisting: true },
  };

  const entity = {
    kind: "bug",
    id: 5967,
    title: "登录页报错",
    projectName: "园区V2",
    productName: "园区",
    moduleName: "登录",
    url: "http://192.0.2.10/bug-view-5967.html",
  };

  const service = { async read() { return { envelope: { entity, source: "db" }, rendered: "" }; } };

  const workspaceRegistry = {
    list: () => (registerWorkspace ? [{ id: "ws-existing", path: root.toUpperCase(), title: "老工作区" }] : []),
    create: async (path, title) => {
      calls.push(["create", { path, title }]);
      return { id: "ws-1", path, title };
    },
  };

  const sessionController = {
    list: async () => {
      calls.push(["session.list", {}]);
      return { items };
    },
    create: async (request) => {
      calls.push(["session.create", request]);
      return { sessionId: "session-abc" };
    },
    rename: async (request) => {
      calls.push(["session.rename", request]);
      return { title: request.title };
    },
    prompt: async (request, signal) => {
      // 复刻宿主行为：signal 缺失就炸。
      if (signal === undefined || typeof signal.throwIfAborted !== "function") {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      calls.push(["session.prompt", request]);
      return { accepted: true };
    },
  };

  const deps = {
    config: () => config,
    service,
    workspaceRegistry: () => workspaceRegistry,
    sessionController: () => sessionController,
    origin: "ui",
  };

  return { root, config, entity, deps, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("干跑：只探测不建会话，并把 zentao_read 指引写进提示词", async () => {
  const h = await harness();
  try {
    const dry = await startSession(h.deps, { kind: "bug", id: 5967, dryRun: true, cloneMissing: false });
    assert.equal(dry.ok, true, dry.message);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.sessionId, undefined);
    assert.ok(dry.prompt.includes("zentao_read"), "提示词应包含 zentao_read");
    assert.equal(
      h.calls.filter(([name]) => ["session.create", "session.rename", "session.prompt"].includes(name)).length,
      0,
      "dryRun 不该建会话",
    );
  } finally {
    await h.cleanup();
  }
});

test("真开工：建工作区 → 建会话 → 改名，顺序固定且只给 workspaceId", async () => {
  const h = await harness();
  try {
    const real = await startSession(h.deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(real.ok, true, real.message);
    assert.equal(real.sessionId, "session-abc");
    assert.equal(real.prompted, false, "autoPrompt 关着就不该发提示词");
    const writes = h.calls.filter(([name]) => name !== "session.list");
    assert.deepEqual(
      writes.map(([name]) => name),
      ["create", "session.create", "session.rename"],
      `调用顺序不对：${JSON.stringify(writes.map(([n]) => n))}`,
    );
    assert.deepEqual(writes[1][1], { workspaceId: "ws-1" }, "session.create 只能给 workspaceId，不能带 cwd");
    assert.equal(real.title.startsWith("BUG #5967"), true, `标题不对：${real.title}`);
    assert.ok(writes[2][1].title.length <= 80, "标题不该超过 80 字");
  } finally {
    await h.cleanup();
  }
});

test("显式 prompt：最后一步发提示词，正文原样、requestId 带前缀，且 signal 不是 undefined", async () => {
  const h = await harness();
  try {
    const sent = await startSession(h.deps, { kind: "bug", id: 5967, prompt: "自己看", cloneMissing: false });
    assert.equal(sent.ok, true, sent.message);
    assert.equal(sent.prompted, true, `提示词没发出去：${sent.warnings.join("; ")}`);
    // 假工作区里的目录不是 git 仓库，开工记账会如实说一句「没记基线」——这不算异常。
    assert.deepEqual(
      sent.warnings.filter((item) => !item.includes("没有记开工基线")),
      [],
      `不该有别的警告：${sent.warnings.join("; ")}`,
    );
    const [name, request] = h.calls.at(-1);
    assert.equal(name, "session.prompt");
    assert.equal(request.content[0].text, "自己看");
    assert.ok(request.requestId.startsWith("life-saver-bug-5967-"), `requestId 不对：${request.requestId}`);
  } finally {
    await h.cleanup();
  }
});

test("agent 自主调用：agentAutoStart 关着就拒绝，并给出人能看懂的 code", async () => {
  const h = await harness();
  try {
    h.config.session.agentAutoStart = false;
    const blocked = await startSession({ ...h.deps, origin: "agent" }, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "auto-start-disabled");
    assert.deepEqual(h.calls, [], "被拒时不该动工作区或会话");
  } finally {
    await h.cleanup();
  }
});

test("项目名对不上：不猜，列候选让人选", async () => {
  const h = await harness();
  try {
    const deps = {
      ...h.deps,
      service: {
        read: async () => ({
          envelope: { entity: { ...h.entity, projectName: "别的项目", productName: "", moduleName: "" }, source: "db" },
          rendered: "",
        }),
      },
    };
    const ambiguous = await startSession(deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "target-ambiguous");
    assert.equal(ambiguous.candidates.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("工作区已登记同路径：直接复用，不再 create（大小写不同也认）", async () => {
  const h = await harness({ registerWorkspace: true });
  try {
    const reuse = await startSession(h.deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(reuse.ok, true, reuse.message);
    assert.equal(reuse.workspace.id, "ws-existing");
    assert.equal(h.calls.some(([name]) => name === "create"), false, "同路径不该再建工作区");
    const created = h.calls.find(([name]) => name === "session.create");
    assert.equal(created[1].workspaceId, "ws-existing");
  } finally {
    await h.cleanup();
  }
});

test("同编号旧会话：回到它继续，不再建会话也不改名", async () => {
  const h = await harness({
    sessions: [
      {
        sessionId: "session-old",
        cwd: "<root>",
        updatedAt: 1700,
        projections: { values: { title: "BUG #5967 登录页报错" } },
      },
    ],
  });
  try {
    const reused = await startSession(h.deps, { kind: "bug", id: 5967, prompt: "接着干", cloneMissing: false });
    assert.equal(reused.ok, true, reused.message);
    assert.equal(reused.reused, true);
    assert.equal(reused.sessionId, "session-old");
    assert.equal(reused.title, "BUG #5967 登录页报错");
    assert.equal(reused.prompted, true, `提示词没发出去：${reused.warnings.join("; ")}`);
    const writes = h.calls.filter(([name]) => name !== "session.list");
    assert.deepEqual(
      writes.map(([name]) => name),
      ["session.prompt"],
      `复用旧会话时只该发提示词，实际：${JSON.stringify(writes.map(([n]) => n))}`,
    );
    assert.equal(writes[0][1].sessionId, "session-old");
  } finally {
    await h.cleanup();
  }
});

test("同编号旧会话在别的目录：不接管，照常新建，并把别处那条列出来", async () => {
  const h = await harness({
    sessions: [
      { sessionId: "session-other", cwd: "C:\\另一个工作区", updatedAt: 1800, projections: { values: { title: "BUG #5967 登录页报错" } } },
    ],
  });
  try {
    const created = await startSession(h.deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(created.ok, true, created.message);
    assert.notEqual(created.reused, true, "别的目录的会话不该被接管");
    assert.equal(created.sessionId, "session-abc");
    assert.equal(created.elsewhere.length, 1);
    assert.equal(created.elsewhere[0].sessionId, "session-other");
  } finally {
    await h.cleanup();
  }
});

test("只认编号：标题改过也认得；编号不同就不算（5967 vs 59670）", async () => {
  const h = await harness({
    sessions: [
      { sessionId: "session-renamed", cwd: "<root>", updatedAt: 1900, projections: { values: { title: "BUG #5967 换了新标题" } } },
      { sessionId: "session-59670", cwd: "<root>", updatedAt: 2000, projections: { values: { title: "BUG #59670 另一条" } } },
    ],
  });
  try {
    const reused = await startSession(h.deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(reused.sessionId, "session-renamed", `认错了会话：${reused.sessionId}`);
    assert.equal(reused.reused, true);
  } finally {
    await h.cleanup();
  }
});

test("同编号多条会话：规范前缀优先，同类取最近活跃的一条", async () => {
  const h = await harness({
    sessions: [
      { sessionId: "session-loose-new", cwd: "<root>", updatedAt: 3000, projections: { values: { title: "随手记 #5967" } } },
      { sessionId: "session-strict-old", cwd: "<root>", updatedAt: 1000, projections: { values: { title: "BUG #5967 老的那个" } } },
      { sessionId: "session-strict-new", cwd: "<root>", updatedAt: 2000, projections: { values: { title: "BUG #5967 新的那个" } } },
    ],
  });
  try {
    const reused = await startSession(h.deps, { kind: "bug", id: 5967, cloneMissing: false });
    assert.equal(reused.sessionId, "session-strict-new", `应取 strict 且最新的：${reused.sessionId}`);
  } finally {
    await h.cleanup();
  }
});

test("复用开关关掉：即使有同编号旧会话也新建；dryRun 只报告不建", async () => {
  const h = await harness({
    sessions: [{ sessionId: "session-old", cwd: "<root>", updatedAt: 1700, projections: { values: { title: "BUG #5967 登录页报错" } } }],
  });
  try {
    const fresh = await startSession(h.deps, { kind: "bug", id: 5967, reuse: false, cloneMissing: false });
    assert.notEqual(fresh.reused, true);
    assert.equal(fresh.sessionId, "session-abc");

    const dry = await startSession(h.deps, { kind: "bug", id: 5967, dryRun: true, cloneMissing: false });
    assert.equal(dry.reused, true);
    assert.equal(dry.sessionId, "session-old");
    assert.equal(dry.prompted, false);
  } finally {
    await h.cleanup();
  }
});

test("排除自己：发起调用的那个会话不会被当成「旧会话」复用", async () => {
  const h = await harness({
    sessions: [{ sessionId: "session-self", cwd: "<root>", updatedAt: 1700, projections: { values: { title: "BUG #5967 登录页报错" } } }],
  });
  try {
    const created = await startSession(h.deps, { kind: "bug", id: 5967, excludeSessionId: "session-self", cloneMissing: false });
    assert.notEqual(created.reused, true);
    assert.equal(created.sessionId, "session-abc");
  } finally {
    await h.cleanup();
  }
});

test("分支链：提示词里按序号列清楚，并要求从序号 1 一路 cherry-pick 上去", async () => {
  const h = await harness();
  try {
    h.config.targets = JSON.stringify([
      {
        id: "park",
        name: "园区V2",
        path: h.root,
        zentaoProjects: ["园区V2"],
        repos: [
          { role: "server", path: "server", gitUrl: "", branches: ["dev", "release", "main"] },
          { role: "web", path: "web", gitUrl: "", branches: [] },
        ],
      },
    ]);
    const dry = await startSession(h.deps, { kind: "bug", id: 5967, dryRun: true, cloneMissing: false });
    assert.equal(dry.ok, true, dry.message);
    assert.ok(dry.prompt.includes("1. dev → 2. release → 3. main"), `分支链没写对：
${dry.prompt}`);
    assert.ok(dry.prompt.includes("cherry-pick"), "提示词里应有 cherry-pick 指引");
    assert.ok(dry.prompt.includes("只改在序号 1"), "提示词里应指明改动落点是序号 1");
    const chainBlocks = dry.prompt.split("分支链（序号由小到大，改动只落在序号 1）：");
    const chainSection = chainBlocks[1].split("\n\n")[0];
    assert.ok(chainSection.includes("server"), `分支链清单里应有 server：${chainSection}`);
    assert.equal(chainSection.includes("web"), false, `没配分支链的仓库不该出现在分支链清单里：${chainSection}`);
  } finally {
    await h.cleanup();
  }
});

test("分支链：一个都没配时整段省掉，不留下空标题", async () => {
  const h = await harness();
  try {
    const dry = await startSession(h.deps, { kind: "bug", id: 5967, dryRun: true, cloneMissing: false });
    assert.equal(dry.ok, true, dry.message);
    assert.equal(dry.prompt.includes("分支链"), false, "没配分支时不该出现分支链段落");
    assert.equal(dry.prompt.includes("cherry-pick"), false, "没配分支时不该提 cherry-pick");
  } finally {
    await h.cleanup();
  }
});

test("父子模块：提示词里交代子模块跟着父仓库同一条链走", async () => {
  const h = await harness();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = (cwd, args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env, windowsHide: true }, (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${args.join(" ")} 失败：${stderr || error.message}`));
      });
    });
  try {
    // 造一个「父仓库 + 一个子模块」的小现场，放在 harness 的根目录里。
    const remote = join(h.root, "remote-child.git");
    const seed = join(h.root, "seed-child");
    const parent = join(h.root, "server");
    await run(h.root, ["init", "--bare", "-b", "main", remote]);
    await run(h.root, ["init", "-b", "main", seed]);
    await writeFile(join(seed, "child.txt"), "child\n", "utf8");
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "child init"]);
    await run(seed, ["remote", "add", "origin", remote]);
    await run(seed, ["push", "-u", "origin", "main"]);
    await run(h.root, ["init", "-b", "main", parent]);
    await writeFile(join(parent, "parent.txt"), "parent\n", "utf8");
    await run(parent, ["add", "."]);
    await run(parent, ["commit", "-m", "parent init"]);
    await run(parent, ["-c", "protocol.file.allow=always", "submodule", "add", remote, "child"]);
    await run(parent, ["commit", "-m", "add submodule"]);
    // 父仓库也要有 origin，否则开工前那步 fetch 会直接失败、子模块就不会被同步。
    const parentRemote = join(h.root, "remote-parent.git");
    await run(h.root, ["init", "--bare", "-b", "main", parentRemote]);
    await run(parent, ["remote", "add", "origin", parentRemote]);
    await run(parent, ["push", "-u", "origin", "main"]);

    h.config.targets = JSON.stringify([
      {
        id: "park",
        name: "园区V2",
        path: h.root,
        zentaoProjects: ["园区V2"],
        repos: [{ role: "server", path: "server", gitUrl: "", branches: ["main"] }],
      },
    ]);

    const dry = await startSession(h.deps, { kind: "bug", id: 5967, dryRun: true, cloneMissing: false });
    assert.equal(dry.ok, true, dry.message);
    assert.ok(dry.prompt.includes("父子模块"), `提示词里应有父子模块说明：\n${dry.prompt}`);
    assert.ok(dry.prompt.includes("子模块"), "提示词里应提到子模块");
    assert.ok(dry.prompt.includes("1 个子模块"), `仓库行应带子模块数量：\n${dry.prompt}`);
    assert.ok(dry.prompt.includes("同一条链"), "应说明子模块跟父仓库同一条链");
  } finally {
    await h.cleanup();
  }
});
