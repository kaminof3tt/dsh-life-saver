// DB 线补齐的那些「联动」：父任务汇总、需求阶段、版本回填、搜索索引。
//
// 这些副作用是团队最容易发现的地方——父任务状态不动、需求阶段不跟着变、改了备注搜不到，
// 都会让人觉得「插件写的东西是假的」。这里的断言全部按禅道源码 + 本库实测数据写成。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeBeginAndEnd,
  computeWorkingHours,
  linkBugToBuild,
  syncParentTask,
  syncStoryStage,
} from "../lib/channels/db/followups.js";
import { shouldRebuildIndex, stripTags, utf8Split } from "../lib/channels/db/search.js";

/** 记录 hooks 产生的动作，供断言。 */
function makeEnv({ children = [], parent, build, tasks = [], rows = {} } = {}) {
  const created = [];
  const histories = [];
  const executed = [];
  const state = { parent: parent ? { ...parent } : undefined, build: build ? { ...build } : undefined };

  const tx = {
    table: (name) => `zt_${name}`,
    async query(sql, params = []) {
      executed.push(["query", sql, params]);
      if (/FROM zt_task\s+WHERE parent = \? AND status != 'cancel'/.test(sql)) {
        return children.filter((row) => row.status !== "cancel");
      }
      if (/FROM zt_task\s+WHERE parent = \? AND deleted = 0/.test(sql)) return children;
      if (/FROM zt_task t1 LEFT JOIN zt_projectstory/.test(sql)) return rows.executions ?? [];
      if (/FROM zt_projectstory/.test(sql)) return rows.executions ?? [];
      if (/FROM zt_task/.test(sql) && /story = \?/.test(sql)) return rows.storyTasks ?? [];
      if (/FROM zt_release/.test(sql)) return rows.releases ?? [];
      if (/FROM zt_story/.test(sql)) return rows.story ? [rows.story] : [];
      throw new Error(`未预置的 query：${sql}`);
    },
    async one(sql, params = []) {
      executed.push(["one", sql, params]);
      if (/FROM zt_task/.test(sql)) return tasks.find((row) => row.id === Number(params[0]));
      if (/FROM zt_product/.test(sql)) return { id: Number(params[0]), type: "normal" };
      if (/FROM zt_build/.test(sql)) return state.build;
      if (/FROM zt_release/.test(sql)) return undefined;
      if (/FROM zt_story/.test(sql)) return rows.story;
      throw new Error(`未预置的 one：${sql}`);
    },
    async execute(sql, params = []) {
      executed.push(["execute", sql, params]);
      if (/UPDATE zt_task/.test(sql)) {
        const id = Number(params[params.length - 1]);
        const target = tasks.find((row) => row.id === id) ?? state.parent;
        const setPart = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
        const fields = [...setPart.matchAll(/`?([A-Za-z]+)`?\s*=\s*\?/g)].map((match) => match[1]);
        fields.forEach((field, index) => {
          if (target) target[field] = params[index];
        });
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_build/.test(sql)) {
        if (state.build) state.build.bugs = params[0];
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_story/.test(sql)) return { affectedRows: 1, insertId: 0 };
      throw new Error(`未预置的 execute：${sql}`);
    },
  };

  return {
    state,
    created,
    histories,
    executed,
    env: {
      tx,
      now: "2026-11-01 11:00:00",
      account: "zhangsan",
      warnings: [],
      hooks: {
        createAction: async (params) => {
          created.push(params);
          return 99000 + created.length;
        },
        logHistory: async (actionId, changes) => {
          histories.push({ actionId, changes });
        },
        resolveProduct: async () => ",2,7,",
      },
    },
  };
}

function parentRow(overrides = {}) {
  return {
    id: 1356,
    parent: 0,
    story: 0,
    project: 146,
    execution: 147,
    status: "wait",
    assignedTo: "daizhichao",
    openedBy: "daizhichao",
    estimate: "0.00",
    consumed: "0.00",
    left: "0.00",
    estStarted: "",
    realStarted: "",
    deadline: "",
    finishedBy: "",
    finishedDate: null,
    closedBy: "",
    closedDate: null,
    closedReason: "",
    canceledBy: "",
    canceledDate: null,
    ...overrides,
  };
}

test("computeWorkingHours：剩余工时只累加非已关闭的子任务", async () => {
  const parent = parentRow();
  const { env } = makeEnv({
    parent,
    tasks: [parent],
    children: [
      { id: 1, estimate: "8.00", consumed: "5.00", left: "3.00", status: "doing" },
      { id: 2, estimate: "2.00", consumed: "2.00", left: "0.00", status: "done" },
      // 已关闭的子任务：estimate/consumed 照加，left 不加
      { id: 3, estimate: "1.00", consumed: "1.00", left: "9.00", status: "closed" },
    ],
  });

  await computeWorkingHours(env, 1356);
  assert.equal(parent.estimate, "11.00");
  assert.equal(parent.consumed, "8.00");
  assert.equal(parent.left, "3.00", "closed 子任务的 left 不计入");
  assert.equal(parent.lastEditedBy, "zhangsan");
});

test("computeBeginAndEnd：取最早的计划/实际开始与最晚的截止", async () => {
  const parent = parentRow();
  const { env } = makeEnv({
    parent,
    tasks: [parent],
    children: [
      { id: 1, estStarted: "2026-09-12", realStarted: "2026-09-12 09:00", deadline: "2026-09-18", status: "done" },
      { id: 2, estStarted: "2026-09-10", realStarted: "2026-09-10 14:00", deadline: "2026-09-15", status: "done" },
    ],
  });

  await computeBeginAndEnd(env, 1356);
  assert.equal(parent.estStarted, "2026-09-10");
  assert.equal(parent.realStarted, "2026-09-10 14:00");
  assert.equal(parent.deadline, "2026-09-18");
});

test("syncParentTask：还有子任务没做完时父任务应回到 doing，并写一条 started 动作", async () => {
  const parent = parentRow({ status: "done", finishedBy: "tiany" });
  const child = parentRow({ id: 2042, parent: 1356, story: 0, status: "wait" });
  const { env, created, histories } = makeEnv({
    parent,
    tasks: [parent, child],
    children: [
      { id: 2042, status: "wait", closedReason: "" },
      { id: 900, status: "done", closedReason: "done" },
    ],
  });

  const changed = await syncParentTask(env, 2042);
  assert.equal(changed, true);
  assert.equal(parent.status, "doing", "(done 或 closedReason=done) 且有 wait → doing");
  assert.equal(created.length, 1, "父任务状态变了要写动作");
  assert.equal(created[0].objectType, "task");
  assert.equal(created[0].objectID, 1356);
  // 旧状态 done 不是 wait/pause → 源码映射表给的是 activated
  assert.equal(created[0].action, "activated", "旧 done → 新的 doing，动作名是 activated");
  assert.equal(histories.length, 1);
  assert.ok(histories[0].changes.some((row) => row.field === "status"));
});

test("syncParentTask：父任务状态没变就不写动作（本库没有「只改工时」的 edited）", async () => {
  const parent = parentRow({ status: "doing" });
  const child = parentRow({ id: 2042, parent: 1356, status: "doing" });
  const { env, created } = makeEnv({
    parent,
    tasks: [parent, child],
    children: [{ id: 2042, status: "doing", closedReason: "" }],
  });

  const changed = await syncParentTask(env, 2042);
  assert.equal(changed, false);
  assert.equal(created.length, 0, "状态没变不该造动作");
});

test("syncParentTask：不是子任务就直接返回", async () => {
  const child = parentRow({ id: 2042, parent: 0 });
  const { env, created } = makeEnv({ tasks: [child] });
  assert.equal(await syncParentTask(env, 2042), false);
  assert.equal(created.length, 0);
});

test("syncStoryStage：需求已关闭就直接置 closed", async () => {
  const { env, executed } = makeEnv({
    rows: { story: { id: 1419, status: "closed", stage: "developing", product: 2, branch: 0 } },
  });
  const changed = await syncStoryStage(env, 1419);
  assert.equal(changed, true);
  assert.ok(
    executed.some(([kind, sql]) => kind === "execute" && /UPDATE zt_story/.test(sql)),
    "要真的写 zt_story.stage",
  );
});

test("syncStoryStage：需求下一条任务都没有时置 projected", async () => {
  const { env, executed } = makeEnv({
    rows: {
      story: { id: 1419, status: "active", stage: "wait", product: 2, branch: 0 },
      executions: [{ project: 146, branch: 0 }],
      storyTasks: [],
    },
  });
  await syncStoryStage(env, 1419);
  // stage 是写死在 SQL 里的字面量，参数只有 story id
  assert.ok(
    executed.some(([kind, sql]) => kind === "execute" && /UPDATE zt_story SET stage = 'projected'/.test(sql)),
    `要写 stage = projected，实际：${JSON.stringify(executed.filter(([kind]) => kind === "execute"))}`,
  );
});

test("linkBugToBuild：把 BUG 追加进版本的 bugs 列表，并去重", async () => {
  const { env, state } = makeEnv({ build: { id: 5, bugs: "5193,5950" } });
  await linkBugToBuild(env, 5968, "5");
  assert.equal(state.build.bugs, "5193,5950,5968");

  // 已经在了就不重复追加
  await linkBugToBuild(env, 5968, "5");
  assert.equal(state.build.bugs, "5193,5950,5968");
});

test("linkBugToBuild：trunk 或空版本不写 build", async () => {
  for (const build of ["", "trunk"]) {
    const { env, executed } = makeEnv({ build: { id: 5, bugs: "5193" } });
    await linkBugToBuild(env, 5968, build);
    assert.equal(
      executed.some(([kind, sql]) => kind === "execute" && /zt_build/.test(sql)),
      false,
      `${build || "(空)"} 不该动 zt_build`,
    );
  }
});

test("shouldRebuildIndex：动作在白名单里、或带了备注才重建", () => {
  assert.equal(shouldRebuildIndex("edited", ""), true, "edited 在白名单里");
  assert.equal(shouldRebuildIndex("finished", ""), false, "finished 不在白名单且没备注");
  assert.equal(shouldRebuildIndex("finished", "做完了"), true, "带备注就重建");
  assert.equal(shouldRebuildIndex("recordestimate", "开发"), true);
});

test("utf8Split：中文变 5 位码点，整数包成 |N| 并补足 5 位", () => {
  const { words, dict } = utf8Split("中");
  assert.equal(words, " 20013", "中 = U+4E2D = 20013");
  assert.equal(dict.get(20013), "中", "中文码点要进字典（键是数字码点）");

  const numeric = utf8Split("12");
  assert.match(numeric.words, /\|12\|_/, "整数要包成 |12| 再补足 5 位");

  const long = utf8Split("abcdef");
  assert.equal(long.words, " abcdef", "6 个字符的单词不需要补");
});

test("stripTags：去掉标签本身但保留正文", () => {
  assert.equal(stripTags("<p><span>综合查询</span></p>"), "综合查询");
});
