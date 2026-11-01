// DB 写线：用假连接 + 假事务把 finish 的「七张表都写到了」锁住。
//
// 这条线最危险的地方不是写不进去，而是**只写了一半**：任务状态改了、action 流水没写，
// 团队任何人点开详情看到的「历史」面板就是空白。所以下面的断言逐表检查。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeViaDb } from "../lib/channels/db/write.js";

/** 库里 decimal 列读回来可能是字符串也可能是数字，比较前统一成数字。 */
const num = (value) => Math.round(Number(value) * 100) / 100;

/** 一条真实形状的任务行（字段照 zt_task 抄，值用 zhangsan 那条 2042 的形状）。 */
function taskRow(overrides = {}) {
  return {
    id: 2042,
    project: 146,
    parent: 0,
    execution: 147,
    story: 0,
    name: "账户综合查询菜单开给街道能看到全部小区",
    status: "doing",
    consumed: "5.00",
    left: "3.00",
    assignedTo: "zhangsan",
    openedBy: "lisi",
    finishedBy: "",
    finishedDate: null,
    realStarted: "2026-10-30 09:27:00",
    closedBy: "",
    closedDate: null,
    closedReason: "",
    canceledBy: "",
    canceledDate: null,
    activatedDate: null,
    lastEditedBy: "zhangsan",
    lastEditedDate: "2026-10-30 15:45:29",
    vision: "rnd",
    deleted: 0,
    ...overrides,
  };
}

/**
 * 假 DbHandle：内存里维护一张任务行，按 SQL 分派。
 * 只认 DB 写线真正会发的语句——认不出的直接抛，避免「悄悄没写」。
 */
function fakeDb({ task, bug, lanes = [], children = [], parents = {} } = {}) {
  const state = {
    task: task ?? null,
    bug: bug ?? null,
    /** parent>0 的子任务集合：父任务汇总要按它算。 */
    children,
    /** 父任务行，按 id 索引；`UPDATE ... WHERE id` 会写到这里。 */
    parents,
    searchindex: [],
    searchdict: [],
    storyUpdates: [],
    buildUpdates: [],
    nextEffortId: 2214,
    actions: [],
    actionProducts: [],
    actionRecent: [],
    history: [],
    notify: [],
    efforts: [],
    cellUpdates: [],
    laneUpdates: [],
    statements: [],
    nextActionId: 84600,
  };

  const cells = [
    // 与真实 exec147 同构：wait / develop / developing / developed / pause / canceled / closed
    { id: 1, lane: 130, columnId: 982, columnType: "wait", cards: "" },
    { id: 2, lane: 130, columnId: 983, columnType: "develop", cards: "" },
    { id: 3, lane: 130, columnId: 984, columnType: "developing", cards: ",2042,903," },
    { id: 4, lane: 130, columnId: 985, columnType: "developed", cards: ",144," },
    { id: 5, lane: 130, columnId: 986, columnType: "pause", cards: "" },
    { id: 6, lane: 130, columnId: 987, columnType: "canceled", cards: "" },
    { id: 7, lane: 130, columnId: 988, columnType: "closed", cards: "" },
  ];

  const handleUpdateTask = (sql, params) => {
    // UPDATE zt_task SET `a` = ?, `b` = ? WHERE id = ?
    const setPart = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
    const fields = [...setPart.matchAll(/`([^`]+)`\s*=\s*\?/g)].map((match) => match[1]);
    const target = Number(params[params.length - 1]);
    const row = state.task && target === state.task.id ? state.task : state.parents[target];
    if (row === undefined) throw new Error(`UPDATE zt_task 未知 id：${target}`);
    fields.forEach((field, index) => {
      row[field] = params[index];
    });
  };

  const tx = {
    table: (name) => `zt_${name}`,
    async query(sql, params = []) {
      state.statements.push(["query", sql, params]);
      if (/FROM zt_projectproduct/.test(sql)) return [{ product: 2 }, { product: 7 }];
      // 父任务汇总：两次查询形状不同（一次带工时列，一次只要 status/closedReason），都按 children 回。
      if (/FROM zt_task/.test(sql) && /parent = \?/.test(sql)) return state.children;
      // 索引重建要读「该对象的全部动作」来定 addedDate/editedDate 和拼 comment。
      if (/FROM zt_action/.test(sql) && /objectType = \?/.test(sql)) {
        const [objectType, objectID] = params;
        return state.actions
          .map((row, index) => ({
            id: 84600 + index,
            objectType: row[0],
            objectID: row[1],
            action: row[6],
            date: row[7],
            comment: row[8],
          }))
          .filter((row) => row.objectType === objectType && Number(row.objectID) === Number(objectID));
      }
      if (/FROM zt_searchindex/.test(sql)) return [];
      if (/FROM zt_searchdict/.test(sql)) return [];
      if (/FROM zt_user/.test(sql)) {
        return [
          { account: "zhangsan", realname: "张三" },
          { account: "lisi", realname: "李四" },
        ];
      }
      if (/FROM zt_kanbanlane/.test(sql)) return lanes.map((id) => ({ id }));
      if (/FROM zt_kanbancell/.test(sql)) return cells;
      if (/FROM zt_story/.test(sql)) return [];
      throw new Error(`未预置的 query：${sql}`);
    },
    async one(sql, params = []) {
      state.statements.push(["one", sql, params]);
      if (/FROM zt_task/.test(sql)) {
        const id = Number(params[0]);
        if (state.task && id === state.task.id) return { ...state.task };
        return state.parents[id] ? { ...state.parents[id] } : undefined;
      }
      if (/FROM zt_searchindex/.test(sql)) return undefined;
      if (/FROM zt_effort/.test(sql)) return undefined;
      if (/FROM zt_bug/.test(sql)) return state.bug ? { ...state.bug } : undefined;
      if (/FROM zt_story/.test(sql)) return undefined;
      throw new Error(`未预置的 one：${sql}`);
    },
    async execute(sql, params = []) {
      state.statements.push(["execute", sql, params]);
      if (/UPDATE zt_task/.test(sql)) {
        handleUpdateTask(sql, params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/INSERT INTO zt_actionproduct/.test(sql)) {
        // 多行插入：每 2 个参数一组（action, product）
        for (let index = 0; index + 1 < params.length; index += 2) {
          state.actionProducts.push({ action: params[index], product: params[index + 1] });
        }
        return { affectedRows: 1, insertId: 0 };
      }
      if (/INSERT INTO zt_actionrecent/.test(sql)) {
        state.actionRecent.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/INSERT INTO zt_action\b/.test(sql)) {
        state.nextActionId += 1;
        state.actions.push(params);
        return { affectedRows: 1, insertId: state.nextActionId };
      }
      if (/INSERT INTO zt_history/.test(sql)) {
        // 多行插入：每 6 个参数一组
        for (let index = 0; index + 5 < params.length; index += 6) {
          state.history.push({
            action: params[index],
            field: params[index + 1],
            old: params[index + 2],
            oldValue: params[index + 3],
            new: params[index + 4],
            newValue: params[index + 5],
          });
        }
        return { affectedRows: 1, insertId: 0 };
      }
      if (/INSERT INTO zt_notify/.test(sql)) {
        state.notify.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/INSERT INTO zt_effort/.test(sql)) {
        state.efforts.push(params);
        // effort 的真实 id 要回给调用方：工时动作、索引重建都靠它。
        return { affectedRows: 1, insertId: state.nextEffortId++ };
      }
      if (/REPLACE INTO zt_searchindex|INSERT INTO zt_searchindex/.test(sql)) {
        state.searchindex.push(params);
        return { affectedRows: 1, insertId: 1 };
      }
      if (/INSERT INTO zt_searchdict/.test(sql)) {
        state.searchdict.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_story/.test(sql)) {
        state.storyUpdates.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_build/.test(sql)) {
        state.buildUpdates.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_kanbancell/.test(sql)) {
        state.cellUpdates.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      if (/UPDATE zt_kanbanlane/.test(sql)) {
        state.laneUpdates.push(params);
        return { affectedRows: 1, insertId: 0 };
      }
      throw new Error(`未预置的 execute：${sql}`);
    },
  };

  return {
    state,
    db: {
      table: (name) => `zt_${name}`,
      transaction: async (run) => run(tx),
      async query() {
        throw new Error("不该在事务外查询");
      },
      async one() {
        throw new Error("不该在事务外查询");
      },
      async close() {},
    },
  };
}

const CTX = (db) => ({ db, account: "zhangsan", baseUrl: "http://192.0.2.10" });

test("DB 写线 finish：七张表都写到，且字段口径与禅道一致", async () => {
  const { db, state } = fakeDb({ task: taskRow(), lanes: [130] });

  const outcome = await writeViaDb(CTX(db), {
    kind: "task",
    id: 2042,
    action: "finish",
    consumed: 2,
    realStarted: "2026-10-30 09:27:00",
    finishedDate: "2026-11-01 10:00:00",
    comment: "做完了",
  });

  assert.equal(outcome.channel, "db");
  assert.equal(outcome.actionName, "finished");

  // ① zt_task：完成、剩余归零、指派回创建人
  assert.equal(state.task.status, "done");
  assert.equal(num(state.task.consumed), 7, "5 + 2");
  assert.equal(num(state.task.left), 0);
  assert.equal(state.task.assignedTo, "lisi", "禅道 finish 会把 assignedTo 指回 openedBy");
  assert.equal(state.task.finishedBy, "zhangsan");
  assert.ok(state.task.finishedDate);

  // ② zt_effort：一条工时，date 取 finishedDate 的日期部分，left 归零
  assert.equal(state.efforts.length, 1);
  const effort = state.efforts[0];
  assert.equal(effort[0], "task", "objectType");
  assert.equal(effort[1], 2042, "objectID");
  assert.equal(effort[7], "2026-11-01", "date 用 finishedDate 的日期");
  assert.equal(effort[8], 0, "left");
  assert.equal(effort[9], 2, "consumed 是本次增量，不是总量");

  // ③ zt_action：两条流水——工时先插一条 effort 的 created，再插 finished
  assert.equal(state.actions.length, 2);
  assert.equal(state.actions[0][0], "effort", "记工时时禅道会额外建一条 effort 动作");
  assert.equal(state.actions[0][6], "created");
  assert.equal(state.actions[0][2], ",0,", "effort 动作的 product 固定是 ,0,");
  const finishedAction = state.actions[1];
  assert.equal(finishedAction[6], "finished");
  assert.equal(finishedAction[9], "", "finished 的 extra 是空串");

  // ④ zt_actionrecent：每条动作都同 id 写一份，否则首页「最近动态」看不到
  assert.equal(state.actionRecent.length, 2);
  assert.equal(state.actionRecent[1][0], state.nextActionId, "recent 用同一个 action id");

  // ⑤ 搜索索引：finished 带了 comment，禅道会重建索引（title+content+所有评论）
  assert.equal(state.searchindex.length, 1, "带 comment 的动作要重建 zt_searchindex");

  // ⑤ zt_history：每个变更字段一行，且带中文显示名
  const fields = state.history.map((row) => row.field);
  for (const expected of ["status", "consumed", "left", "assignedTo", "finishedBy"]) {
    assert.ok(fields.includes(expected), `history 缺字段 ${expected}，实际：${fields.join(",")}`);
  }
  const statusRow = state.history.find((row) => row.field === "status");
  assert.equal(statusRow.old, "doing");
  assert.equal(statusRow.new, "done");
  assert.equal(statusRow.oldValue, "进行中", "oldValue 是中文显示名");
  assert.equal(statusRow.newValue, "已完成");
  const assignRow = state.history.find((row) => row.field === "assignedTo");
  assert.equal(assignRow.newValue, "李四", "人名要显示中文名，不是账号");

  // ⑥ zt_notify：收件人 = 写后的 assignedTo（也就是 openedBy）
  assert.equal(state.notify.length, 1);
  assert.equal(state.notify[0][1], ",lisi,", "toList 被逗号包裹");
  assert.match(String(state.notify[0][2]), /完成了任务/);
  assert.match(String(state.notify[0][2]), /\[#2042::/);

  // ⑦ 看板：卡片从「研发中」挪到「已开发」，lane 的 lastEditedTime 被刷
  assert.ok(state.cellUpdates.length > 0, "应该有 cell 更新");
  assert.equal(state.laneUpdates.length, 1);

  // 写后快照来自回读
  assert.equal(outcome.after.status, "done");
  assert.equal(outcome.after.consumed, 7);
});

test("DB 写线 recordworkhour：只加不覆盖，且不发通知", async () => {
  const { db, state } = fakeDb({ task: taskRow(), lanes: [130] });

  const outcome = await writeViaDb(CTX(db), {
    kind: "task",
    id: 2042,
    action: "recordworkhour",
    consumed: 1.5,
    left: 1.5,
    date: "2026-11-01",
    comment: "调接口",
  });

  assert.equal(outcome.actionName, "recordestimate");
  assert.equal(num(state.task.consumed), 6.5, "5 + 1.5，不是覆盖成 1.5");
  assert.equal(num(state.task.left), 1.5);
  assert.equal(state.efforts[0][9], 1.5);
  const recordAction = state.actions.find((row) => row[6] === "recordestimate");
  assert.ok(recordAction, "要有一条 recordestimate 动作");
  assert.equal(String(recordAction[9]), "1.5", "recordestimate 的 extra 是本次工时数值");
  // 工时的 effort 动作也要一起写
  assert.ok(state.actions.some((row) => row[0] === "effort" && row[6] === "created"));
  // 实测：recordworkhour 的 86 条 action 一条通知都没有
  assert.equal(state.notify.length, 0);
  // 状态没变，不该动看板
  assert.equal(state.cellUpdates.length, 0);
});

test("DB 写线 comment：只插动作流水，不碰业务字段也不碰看板", async () => {
  const { db, state } = fakeDb({ task: taskRow(), lanes: [130] });

  await writeViaDb(CTX(db), { kind: "task", id: 2042, action: "comment", comment: "先记一笔" });

  assert.equal(state.actions[0][6], "commented");
  assert.equal(state.history.length, 0, "备注没有字段变更，history 应为空");
  assert.equal(state.cellUpdates.length, 0);
  assert.equal(state.efforts.length, 0);
  // 业务字段一个都不能变
  assert.equal(state.task.status, "doing");
  assert.equal(num(state.task.consumed), 5);
  assert.equal(num(state.task.left), 3);
});

test("DB 写线：DB 层自己也校验状态（不指望上层拦住）", async () => {
  // 上层 service 有状态白名单，db 层仍然挡一遍：对 done 的任务记工时必须拒绝。
  const { db, state } = fakeDb({ task: taskRow({ status: "done" }), lanes: [130] });

  await assert.rejects(
    () => writeViaDb(CTX(db), { kind: "task", id: 2042, action: "recordworkhour", consumed: 1, left: 0 }),
    (error) => {
      assert.equal(error.code, "write-rejected");
      assert.match(error.message, /不能记工时/);
      return true;
    },
  );
  assert.equal(state.task.status, "done", "拒了就不该动数据");
  assert.equal(state.actions.length, 0);
  assert.equal(state.history.length, 0);
});

test("DB 写线：任务不存在报 not-found，不会静默成功", async () => {
  const { db } = fakeDb({ task: null });
  await assert.rejects(
    () => writeViaDb(CTX(db), { kind: "task", id: 999999, action: "comment", comment: "x" }),
    (error) => error.code === "not-found",
  );
});

test("DB 写线：子任务要提醒父任务汇总没复刻", async () => {
  const { db, state } = fakeDb({ task: taskRow({ parent: 1999 }), lanes: [130] });
  const outcome = await writeViaDb(CTX(db), {
    kind: "task",
    id: 2042,
    action: "recordworkhour",
    consumed: 1,
    left: 2,
    date: "2026-11-01",
  });
  assert.ok(
    outcome.warnings.some((item) => item.includes("父任务")),
    `应该提醒父任务，实际：${JSON.stringify(outcome.warnings)}`,
  );
  assert.equal(state.task.status, "doing");
});
