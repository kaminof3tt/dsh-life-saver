/**
 * 父子模块仓库：探测与同步。
 *
 * 这里真的建临时 git 仓库来跑（不用假数据），因为要验证的就是 git 自己的行为：
 * 子模块指针漂移会不会把父仓库判脏、同步时会不会误伤脏的子模块、游离头会不会被乱切。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { probeRepos, syncRepos } from "../lib/session/git.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: ENV, windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} 失败：${stderr || error.message}`));
    });
  });
}

const created = [];

after(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

/** 建一个「父仓库 + 一个子模块 + 一个 remote」的现场。 */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "life-saver-submodule-"));
  created.push(base);
  const remote = join(base, "remote-child.git");
  const seed = join(base, "seed-child");
  const parentRemote = join(base, "remote-parent.git");
  const root = join(base, "workspace");
  const parent = join(root, "server");

  await run(base, ["init", "--bare", "-b", "main", remote]);
  await run(base, ["init", "-b", "main", seed]);
  await writeFile(join(seed, "child.txt"), "child\n", "utf8");
  await run(seed, ["add", "."]);
  await run(seed, ["commit", "-m", "child init"]);
  await run(seed, ["remote", "add", "origin", remote]);
  await run(seed, ["push", "-u", "origin", "main"]);

  await run(base, ["init", "--bare", "-b", "main", parentRemote]);
  await run(base, ["init", "-b", "main", parent]);
  await writeFile(join(parent, "parent.txt"), "parent\n", "utf8");
  await run(parent, ["add", "."]);
  await run(parent, ["commit", "-m", "parent init"]);
  await run(parent, ["-c", "protocol.file.allow=always", "submodule", "add", remote, "child"]);
  await run(parent, ["commit", "-m", "add submodule"]);
  // 父仓库也要有 origin，否则 fetch/快进那一步没法跑。
  await run(parent, ["remote", "add", "origin", parentRemote]);
  await run(parent, ["push", "-u", "origin", "main"]);

  const repos = [{ role: "server", path: "server", gitUrl: "", branches: ["main"] }];
  return { base, root, parent, remote, seed, repos };
}

describe("父子模块仓库", () => {
  it("识别出子模块，并读出它的分支", async () => {
    const { root, repos } = await fixture();
    const report = await probeRepos(root, repos);
    const server = report.repos[0];
    assert.equal(server.dirty, false);
    assert.equal(server.hasSubmodules, true);
    assert.equal(server.submodules?.length, 1);
    assert.equal(server.submodules?.[0]?.path, "child");
    // 子模块刚 add 完会检出一条分支（不是游离头）。
    assert.equal(server.submodules?.[0]?.branch, "main");
    assert.equal(server.submodules?.[0]?.dirty, false);
  });

  it("子模块指针漂移不算父仓库脏（否则父子模块仓库永远不更新）", async () => {
    const { root, repos, parent } = await fixture();
    // 在子模块里多提交一次，但不在父仓库里提交指针 → 父仓库 status 会显示 ` M child`。
    const childPath = join(parent, "child");
    await writeFile(join(childPath, "child.txt"), "child changed\n", "utf8");
    await run(childPath, ["commit", "-am", "child moves on"]);
    const raw = (await run(parent, ["status", "--porcelain"])).trim();
    assert.match(raw, /M child/, "前提：父仓库 status 确实会报子模块指针漂移");

    const report = await probeRepos(root, repos);
    const server = report.repos[0];
    assert.equal(server.dirty, false, "父仓库自身是干净的");
    assert.equal(server.submodules?.[0]?.drifted, true);
  });

  it("脏的子模块原样不动，但仍会报告；父仓库照常更新", async () => {
    const { root, repos, parent, seed } = await fixture();
    const childPath = join(parent, "child");
    // 子模块里放一个未提交的改动。
    await writeFile(join(childPath, "child.txt"), "dirty work\n", "utf8");
    // 远端再往前走一步，父仓库应该有东西可更新。
    await writeFile(join(seed, "child.txt"), "remote move\n", "utf8");
    await run(seed, ["commit", "-am", "remote move"]);
    await run(seed, ["push", "origin", "main"]);

    const report = await syncRepos(root, repos, { clone: false, update: true });
    const server = report.results[0];
    assert.equal(server.action, "up-to-date", "父仓库自身没有新提交");
    const child = server.submodules?.[0];
    assert.equal(child?.action, "skipped");
    assert.match(child?.message ?? "", /未提交改动/);
    // 脏改动必须还在。
    assert.equal((await run(childPath, ["status", "--porcelain"])).trim().includes("child.txt"), true);
  });

  it("干净的子模块跟着父仓库一起快进", async () => {
    const { root, repos, parent, seed } = await fixture();
    // 子模块切到远端分支并跟踪，制造一个「干净且落后」的状态。
    await writeFile(join(seed, "child.txt"), "remote move\n", "utf8");
    await run(seed, ["commit", "-am", "remote move"]);
    await run(seed, ["push", "origin", "main"]);

    const report = await syncRepos(root, repos, { clone: false, update: true });
    const child = report.results[0].submodules?.[0];
    assert.equal(child?.action, "updated");
    assert.match(child?.message ?? "", /已更新到 origin\/main 最新/);
    // 父仓库里子模块指针没提交，所以父仓库本身仍是「无新提交」，但它干净。
    const childPath = join(parent, "child");
    assert.equal((await run(childPath, ["log", "-1", "--pretty=%s"])).trim(), "remote move");
  });

  it("游离头的子模块：没单独配分支时跟随父仓库分支", async () => {
    const { root, repos, parent } = await fixture();
    const childPath = join(parent, "child");
    const head = (await run(childPath, ["rev-parse", "HEAD"])).trim();
    await run(childPath, ["checkout", "--detach", head]);

    const probe = await probeRepos(root, repos);
    const probed = probe.repos[0].submodules?.[0];
    assert.equal(probed?.branch, undefined, "游离头读不到分支名");
    assert.equal(probed?.target, "main", "没单独配 → 目标是父仓库的 main");
    assert.equal(probed?.targetFrom, "parent");

    const report = await syncRepos(root, repos, { clone: false, update: true });
    const child = report.results[0].submodules?.[0];
    assert.equal(child?.action, "switched");
    assert.equal(child?.branch, "main");
    assert.equal((await run(childPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "main", "切到了父仓库分支");
  });

  it("子模块单独配了分支：按配置切过去（园区前端那种父子分支不一致的情况）", async () => {
    const { root, repos, parent } = await fixture();
    const childPath = join(parent, "child");
    // 在子模块上造一条自己的分支，和父仓库的 main 不一致。
    await run(childPath, ["checkout", "-b", "develop/demo"]);
    await run(childPath, ["push", "origin", "develop/demo"]);
    await run(childPath, ["checkout", "main"]);
    await run(childPath, ["checkout", "--detach", (await run(childPath, ["rev-parse", "main"])).trim()]);

    const configured = [
      {
        ...repos[0],
        submodules: [{ match: "child", branches: ["develop/demo"] }],
      },
    ];
    const probe = await probeRepos(root, configured);
    const probed = probe.repos[0].submodules?.[0];
    assert.equal(probed?.target, "develop/demo");
    assert.equal(probed?.targetFrom, "submodule");
    assert.equal(probed?.matchedBy, "child");

    const report = await syncRepos(root, configured, { clone: false, update: true });
    const child = report.results[0].submodules?.[0];
    assert.equal(child?.branch, "develop/demo");
    assert.equal(child?.action, "switched");
    assert.equal((await run(childPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "develop/demo");
  });

  it("子模块配的分支不存在：原样不动，并提示去改配置", async () => {
    const { root, repos, parent } = await fixture();
    const childPath = join(parent, "child");
    const head = (await run(childPath, ["rev-parse", "HEAD"])).trim();
    await run(childPath, ["checkout", "--detach", head]);

    const configured = [{ ...repos[0], submodules: [{ match: "child", branches: ["no-such-branch"] }] }];
    const report = await syncRepos(root, configured, { clone: false, update: true });
    const child = report.results[0].submodules?.[0];
    assert.equal(child?.action, "skipped");
    assert.match(child?.message ?? "", /不存在/);
    assert.equal((await run(childPath, ["rev-parse", "HEAD"])).trim(), head, "没把它切走");
  });

  it("单仓库（没有子模块）不会多出子模块字段", async () => {
    const { root, repos } = await fixture();
    const report = await probeRepos(root, [{ ...repos[0], path: "server/child" }]);
    const child = report.repos[0];
    assert.equal(child.hasSubmodules, undefined);
    assert.equal(child.submodules, undefined);
  });
});
