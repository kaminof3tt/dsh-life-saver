/**
 * 工作区目标表解析：重点是仓库的「分支链」。
 *
 *   node --test test/targets.test.mjs
 *
 * 分支链是有序的：`branches[0]` 是序号 1，也就是改动落点；后面的靠 cherry-pick 接力。
 * 老配置里仓库只有一个 `branch` 字段，这里锁住「老配置照样能用」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTargets, primaryBranch, submoduleChain } from "../lib/domain/targets.js";

const ROOT = "D:\\workspace\\park";

function one(repo) {
  const result = parseTargets(JSON.stringify([{ name: "园区V2", path: ROOT, repos: [repo] }]));
  return result.targets[0].repos[0];
}

test("branches 是有序的，序号 1 就是改动落点", () => {
  const repo = one({ role: "server", path: "server", branches: ["dev", "release", "main"] });
  assert.deepEqual(repo.branches, ["dev", "release", "main"]);
  assert.equal(primaryBranch(repo), "dev");
});

test("老配置的单个 branch 仍然认，并折成长度为 1 的链", () => {
  const repo = one({ role: "server", path: "server", branch: "develop/v2.6.2" });
  assert.deepEqual(repo.branches, ["develop/v2.6.2"]);
  assert.equal(primaryBranch(repo), "develop/v2.6.2");
});

test("branches 与 branch 同时出现时以 branches 为准", () => {
  const repo = one({ role: "server", path: "server", branch: "旧的", branches: ["新的"] });
  assert.deepEqual(repo.branches, ["新的"]);
});

test("重复分支去重但保留首次出现的序号", () => {
  const repo = one({ role: "server", path: "server", branches: ["a", "b", "a"] });
  assert.deepEqual(repo.branches, ["a", "b"]);
});

test("没配分支就是空链，不会瞎猜一个分支出来", () => {
  const repo = one({ role: "server", path: "server" });
  assert.deepEqual(repo.branches, []);
  assert.equal(primaryBranch(repo), "");
});

test("branches 里混了非字符串：坏值丢掉，好的顺序不变", () => {
  const repo = one({ role: "server", path: "server", branches: ["a", 3, null, "b"] });
  assert.deepEqual(repo.branches, ["a", "b"]);
});

test("子模块分支：键值对写法和数组写法都收，值可以是单分支 / 逗号链 / 数组", () => {
  const kv = one({
    role: "web",
    path: "web",
    submodules: { "acme-web-admin": "develop/v2.6.2-demo", "common-": ["a", "b"], other: "x, y" },
  });
  assert.deepEqual(kv.submodules, [
    { match: "acme-web-admin", branches: ["develop/v2.6.2-demo"] },
    { match: "common-", branches: ["a", "b"] },
    { match: "other", branches: ["x", "y"] },
  ]);
  const list = one({
    role: "web",
    path: "web",
    submodules: [{ match: "acme-web-admin", branches: ["develop/v2.6.2-demo"] }],
  });
  assert.deepEqual(list.submodules, [{ match: "acme-web-admin", branches: ["develop/v2.6.2-demo"] }]);
});

test("子模块模糊匹配：全路径 / 末尾 / 任意一段 / 子串都算，多个命中取键最长的", () => {
  const repo = one({
    role: "web",
    path: "web",
    submodules: {
      "acme-web-admin": "by-name",
      "modules/acme-web-admin": "by-path",
      "common-": "by-prefix",
    },
  });
  assert.equal(submoduleChain(repo, "acme-web-admin")[0], "by-name");
  assert.equal(submoduleChain(repo, "modules/acme-web-admin")[0], "by-path");
  assert.equal(submoduleChain(repo, "modules/acme-web-admin/sub")[0], "by-path");
  assert.equal(submoduleChain(repo, "common-flowable")[0], "by-prefix");
  assert.deepEqual(submoduleChain(repo, "not-configured"), []);
});

test("没配 submodules 的老目标：字段缺省而不是报错", () => {
  const repo = one({ role: "server", path: "server" });
  assert.deepEqual(repo.submodules, []);
});
