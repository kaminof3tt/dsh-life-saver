/**
 * zentao_commit 的行为契约。
 *
 * 重点不是「能提交」，而是三件容易做错的事：
 *   1. 只提交本次对话动过的文件（基线差集）；
 *   2. 别人 `git add` 进默认索引的东西不跟着走（私有索引隔离）；
 *   3. 开工前就脏着的文件被挡下来并如实列出来（heldBack），不是悄悄一起提交。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommit } from "../lib/commit/run.js";
import { recordWorkStart } from "../lib/commit/start.js";

const TICKET = { kind: "bug", id: 5967, title: "附件上传失败" };
const URL = "http://zentao.example.com/index.php?m=bug&f=view&bugID=5967";
const TICKET_WITH_URL = { ...TICKET, url: URL };

/** 只实现 read：commit 只在显式给了 kind+id 时才会去取标题。 */
const service = {
  async read() {
    return { envelope: { entity: { title: TICKET.title, url: URL } }, rendered: "" };
  },
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "ls-commit-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "a.txt"), "a\n", "utf8");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function headOf(repo) {
  return git(repo, "rev-parse", "HEAD");
}

function commitCount(repo) {
  return Number(git(repo, "rev-list", "--count", "HEAD"));
}

function filesInHead(repo) {
  return git(repo, "show", "--name-only", "--pretty=format:", "HEAD")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const repos = [];
test.after(async () => {
  for (const dir of repos) await rm(dir, { recursive: true, force: true });
});

async function repoWithBaseline(sessionId = "s1") {
  const repo = await makeRepo();
  repos.push(repo);
  await recordWorkStart({
    repos: [{ path: repo }],
    ticket: TICKET_WITH_URL,
    sessionId,
    overwriteBaseline: true,
  });
  return repo;
}

test("dryRun 只预览，不动 git", async () => {
  const repo = await repoWithBaseline();
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");
  const before = headOf(repo);

  const out = await runCommit({ dryRun: true }, { service, cwd: repo, sessionId: "s1" });

  assert.equal(out.dryRun, true);
  assert.deepEqual(out.files, ["b.txt"]);
  assert.equal(out.sha, undefined);
  assert.equal(headOf(repo), before);
  assert.equal(commitCount(repo), 1);
  assert.match(out.markdown, /试运行/);
});

test("提交信息是两行：类型 #编号 标题 + 链接", async () => {
  const repo = await repoWithBaseline();
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");

  const out = await runCommit({}, { service, cwd: repo, sessionId: "s1" });

  assert.equal(out.ok, true);
  assert.deepEqual(out.files, ["b.txt"]);
  assert.deepEqual(filesInHead(repo), ["b.txt"]);
  // 标题与正文之间必须有空行，否则 git 会把两行当同一段落。
  assert.equal(git(repo, "log", "-1", "--pretty=%B"), `BUG #5967 ${TICKET.title}\n\n${URL}`);
  assert.equal(git(repo, "log", "-1", "--pretty=%s"), `BUG #5967 ${TICKET.title}`, "标题里不能混进链接");
  assert.equal(git(repo, "log", "-1", "--pretty=%b"), URL);
  assert.equal(out.subject, `BUG #5967 ${TICKET.title}`);
  assert.equal(out.link, URL);
});

test("开工前就脏着的文件被挡下并列出（heldBack）", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await writeFile(join(repo, "c.txt"), "c\n", "utf8");
  await recordWorkStart({ repos: [{ path: repo }], ticket: TICKET_WITH_URL, sessionId: "s1", overwriteBaseline: true });
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");

  const out = await runCommit({}, { service, cwd: repo, sessionId: "s1" });

  assert.deepEqual(out.files, ["b.txt"]);
  assert.deepEqual(out.heldBack, ["c.txt"]);
  assert.deepEqual(filesInHead(repo), ["b.txt"]);
  assert.ok(git(repo, "status", "--porcelain", "-uall", "-z").includes("c.txt"), "c.txt 应该还是脏的");
});

test("别人暂存进默认索引的文件不跟着走", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await writeFile(join(repo, "d.txt"), "d\n", "utf8");
  await recordWorkStart({ repos: [{ path: repo }], ticket: TICKET_WITH_URL, sessionId: "s1", overwriteBaseline: true });
  git(repo, "add", "d.txt"); // 另一个会话把文件 add 进了默认索引
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");

  const out = await runCommit({}, { service, cwd: repo, sessionId: "s1" });

  assert.deepEqual(out.files, ["b.txt"]);
  assert.deepEqual(out.stagedElsewhere, ["d.txt"]);
  assert.deepEqual(filesInHead(repo), ["b.txt"], "提交树里不能有别人暂存的文件");
});

test("并行会话：默认差集会给出警告，显式 files 才是精确隔离", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await recordWorkStart({ repos: [{ path: repo }], ticket: TICKET_WITH_URL, sessionId: "s1", overwriteBaseline: true });
  await recordWorkStart({ repos: [{ path: repo }], ticket: TICKET_WITH_URL, sessionId: "s2", overwriteBaseline: true });

  await writeFile(join(repo, "b.txt"), "b\n", "utf8");
  await writeFile(join(repo, "e.txt"), "e\n", "utf8");

  // 不给 files：git 分不清哪个文件是谁改的，差集是两边新改动的合集——必须如实警告。
  const loose = await runCommit({ dryRun: true }, { service, cwd: repo, sessionId: "s1" });
  assert.deepEqual(loose.files, ["b.txt", "e.txt"]);
  assert.ok(
    loose.warnings.some((item) => item.includes("会话")),
    "别的会话也在这个仓库开工过时必须提示",
  );

  // 给了 files：各提交各的，且不再警告。
  const first = await runCommit({ files: ["b.txt"] }, { service, cwd: repo, sessionId: "s1" });
  assert.deepEqual(first.files, ["b.txt"]);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(filesInHead(repo), ["b.txt"]);

  const second = await runCommit({ files: ["e.txt"] }, { service, cwd: repo, sessionId: "s2" });
  assert.deepEqual(second.files, ["e.txt"]);
  assert.deepEqual(filesInHead(repo), ["e.txt"]);
});

test("显式 files：只提交点名的文件", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");
  await writeFile(join(repo, "f.txt"), "f\n", "utf8");

  const out = await runCommit({ kind: "bug", id: 5967, files: ["b.txt"] }, { service, cwd: repo, sessionId: "s9" });

  assert.deepEqual(out.files, ["b.txt"]);
  assert.deepEqual(filesInHead(repo), ["b.txt"]);
  assert.ok(git(repo, "status", "--porcelain", "-uall", "-z").includes("f.txt"), "f.txt 应该还没提交");
});

test("没有改动时报 nothing-to-commit", async () => {
  const repo = await repoWithBaseline();
  await assert.rejects(
    () => runCommit({}, { service, cwd: repo, sessionId: "s1" }),
    (error) => error.code === "nothing-to-commit",
  );
});

test("既没单子也没基线时报各自的错误码", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");

  await assert.rejects(
    () => runCommit({}, { service, cwd: repo, sessionId: "fresh" }),
    (error) => error.code === "no-ticket",
  );
  await assert.rejects(
    () => runCommit({ kind: "bug", id: 5967 }, { service, cwd: repo, sessionId: "fresh" }),
    (error) => error.code === "no-baseline",
  );
});

test("只给 message、不给单子也能提交", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await writeFile(join(repo, "b.txt"), "b\n", "utf8");

  const out = await runCommit(
    { message: "chore: 顺手修个错别字", files: ["b.txt"] },
    { service, cwd: repo, sessionId: "no-ticket" },
  );

  assert.deepEqual(out.files, ["b.txt"]);
  assert.equal(git(repo, "log", "-1", "--pretty=%B"), "chore: 顺手修个错别字");
  assert.equal(out.link, undefined);
});

test("files 里给了没改动的路径时报 not-dirty", async () => {
  const repo = await makeRepo();
  repos.push(repo);
  await assert.rejects(
    () => runCommit({ kind: "bug", id: 5967, files: ["a.txt"] }, { service, cwd: repo, sessionId: "s1" }),
    (error) => error.code === "not-dirty",
  );
});
