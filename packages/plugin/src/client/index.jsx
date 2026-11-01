/**
 * 插件页（侧栏「插件」→ dsh-life-saver 那一行的「配置」）里的自建配置页。
 *
 * 渲染契约（照 plugin-manager 的实现读出来的）：
 *   - 通过 `plugins.row.config` 注册，key 是 `<包名>#<行 id>` = `dsh-life-saver#life-saver`；
 *   - 页面宿主传 `form = { state, mutate(ops, revision) }`：
 *       state  = { status, value, base, user, revision, writable }（配置镜像的快照）
 *       mutate = 提交一串 `{op:'set'|'unset', path:[...], value?}`，返回是否写成功。
 *   - 只有保存才写；离开页面丢弃草稿。
 *
 * 配置里没有密码：三个密码走凭据中心，经宿主 bridge `/api/dsh-life-saver/*` 读写，
 * 「测试连接」也走同一个 bridge（真连一次禅道）。
 */

import * as React from "react";

const BRIDGE_PREFIX = "/api/dsh-life-saver";

/*
 * 下面这些 typedef 描述「桥接返回值」的形状。
 *
 * 为什么需要它们：这个文件（1600 多行 JSX）以前完全不参与类型检查——宿主的
 * tsconfig 只把 src 下的 .ts 收进去，esbuild 只转译不检查，于是「引用了不存在的
 * 变量」这类错误要等用户点开配置页、看到白屏才知道（真实事故：TargetCard 里用了
 * map 外才有的 `repo`，整页空白）。现在由 tsconfig.client.json 的 checkJs 兜住；
 * 而 `useState(null)` 这种「先空后填」的状态必须显式标注，否则 TS 把它推成
 * `null`，后面 `result.value.xxx` 会全报「属性不存在于 never」。
 *
 * 失败形状是统一的（`{ok:false, message, code?}`，见 src/bridge/routes.ts）；
 * 成功形状按各路由真正读到的字段列，用不到的字段一律可选。
 */

/** @typedef {{tone: "ok"|"info"|"error", text: string}} Notice */

/**
 * @typedef {object} SessionSubmodule
 * @property {string} path
 * @property {string} [branch]
 * @property {string} action
 * @property {string} message
 */

/**
 * @typedef {object} SessionRepo
 * @property {string} role
 * @property {string} path
 * @property {string} action
 * @property {string} message
 * @property {SessionSubmodule[]} [submodules]
 */

/**
 * @typedef {object} SessionValue
 * @property {string} message
 * @property {string} [sessionId]
 * @property {string} [title]
 * @property {boolean} [reused]
 * @property {SessionRepo[]} [repos]
 * @property {Array<{name: string}>} [candidates]
 * @property {string[]} [warnings]
 * @property {Array<{cwd: string}>} [elsewhere]
 */

/** @typedef {{ok: true, value: SessionValue}|{ok: false, message?: string, code?: string}} SessionResult */

/**
 * @typedef {object} SessionInfo
 * @property {Array<{id: string, name: string, path: string}>} [targets]
 * @property {{reuseExisting?: boolean, agentAutoStart?: boolean}} [session]
 * @property {{workspaceRegistry?: boolean, sessionController?: boolean}} [host]
 */

/**
 * @typedef {object} Health
 * @property {boolean} [ready]
 * @property {string[]} [missing]
 * @property {{detail?: string, reason?: string}} [probe]
 */

/** @typedef {{ok: true, value: {db?: Health, http?: Health}}|{ok: false, message?: string}} ProbeResult */

/**
 * @typedef {object} CredStatus
 * @property {boolean} [available]
 * @property {Record<string, boolean>} [configured]
 * @property {Record<string, boolean>} [fromEnv]
 */

/** 凭据 ref（与 `src/config.ts` 的 SECRET_REFS 对齐）。 */
const SECRET_REFS = {
  httpPassword: "ZENTAO_PASSWORD",
  dbPassword: "ZENTAO_DB_PASSWORD",
  sftpPassword: "ZENTAO_SFTP_PASSWORD",
};

/** 字段表：path 是配置里的位置，逐段与 Config 的嵌套结构对应。 */
const FIELDS = [
  { path: ["http", "baseUrl"], label: "禅道地址", hint: "例如 http://zentao.example.com，带不带 /zentao 都行", kind: "text", section: "http" },
  { path: ["http", "account"], label: "禅道账号", hint: "密码在下面「凭据」里配置", kind: "text", section: "http" },
  { path: ["http", "timeoutMs"], label: "HTTP 超时（毫秒）", hint: "单次请求的最长等待", kind: "number", section: "http" },
  { path: ["http", "skin"], label: "页面皮肤", hint: "", kind: "text", section: "_hidden" },

  { path: ["db", "host"], label: "数据库地址", hint: "只读库，例如 zentao.example.com", kind: "text", section: "db" },
  { path: ["db", "port"], label: "端口", hint: "禅道库端口，通常是 13306 或 3306", kind: "number", section: "db" },
  { path: ["db", "database"], label: "库名", hint: "默认 zentao", kind: "text", section: "db" },
  { path: ["db", "user"], label: "数据库账号", hint: "只读账号即可；密码在「凭据」里配置", kind: "text", section: "db" },
  { path: ["db", "prefix"], label: "表前缀", hint: "默认 zt_", kind: "text", section: "db" },
  { path: ["db", "connectionLimit"], label: "连接池上限", hint: "1–16", kind: "number", section: "db" },
  { path: ["db", "keywords"], label: "搜索是否带 keywords", hint: "", kind: "text", section: "_hidden" },

  { path: ["sftp", "host"], label: "SFTP 主机", hint: "通常与数据库同机", kind: "text", section: "sftp" },
  { path: ["sftp", "port"], label: "SFTP 端口", hint: "默认 22", kind: "number", section: "sftp" },
  { path: ["sftp", "user"], label: "SFTP 账号", hint: "密码在「凭据」里配置", kind: "text", section: "sftp" },
  { path: ["sftp", "uploadBase"], label: "upload 目录", hint: "例如 /home/zentao/zentao/www/data/upload", kind: "text", section: "sftp" },
  { path: ["sftp", "privateKeyPath"], label: "私钥路径（可选）", hint: "改用私钥登录时填绝对路径，密码可留空", kind: "text", section: "sftp" },

  { path: ["limits", "maxAttachments"], label: "单个对象最多落盘附件数", hint: "0–200，默认 40", kind: "number", section: "limits" },
  { path: ["limits", "maxAttachmentBytes"], label: "单附件大小上限（字节）", hint: "超过只记录不落盘", kind: "number", section: "limits" },
  { path: ["limits", "maxRelated"], label: "最多递归关联对象数", hint: "0–20，默认 8", kind: "number", section: "limits" },

  { path: ["output", "dir"], label: "落盘目录", hint: "留空则放到会话工作区的 zentao-extract/ 下", kind: "text", section: "output" },

  // 下面几项不在通用字段区渲染（各有专门的编辑器），但要参与「改了什么」的比对，
  // 所以仍然登记在表里：diffOps/draftFrom/valueFromDraft 都是按这张表走的。
  { path: ["write", "enabled"], label: "允许写入禅道", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["write", "mode"], label: "写通道", hint: "", kind: "text", section: "_hidden" },
  { path: ["write", "allowOthers"], label: "允许代别人操作", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["targets"], label: "工作区目标表", hint: "", kind: "json", section: "_hidden" },
  { path: ["session", "enabled"], label: "启用开新会话", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["session", "agentAutoStart"], label: "允许模型主动开新会话", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["session", "autoPrompt"], label: "建好会话就自动发开场提示词", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["session", "promptTemplate"], label: "开场提示词模板", hint: "", kind: "text", section: "_hidden" },
  { path: ["session", "reuseExisting"], label: "同编号优先复用旧会话", hint: "", kind: "boolean", section: "_hidden" },
  // 结构探测：一般不用动（默认自己认），但换版本认错时得有个手工兜底的口子。
  { path: ["discovery", "enabled"], label: "启用结构探测", hint: "", kind: "boolean", section: "_hidden" },
  { path: ["discovery", "ttlMs"], label: "探测缓存有效期", hint: "", kind: "number", section: "_hidden" },
];

const SECTIONS = [
  { id: "http", title: "HTTP 通道", note: "账号密码登录换 cookie 再走页面，和人工看到的一致。" },
  { id: "db", title: "数据库通道（只读库）", note: "快、能批量、不惊动禅道审计日志；附件靠下面的 SFTP 读。" },
  { id: "sftp", title: "附件读取（SFTP）", note: "只有要走附件时才用得上。" },
  { id: "limits", title: "取数上限", note: "防止一次拉爆。" },
  { id: "output", title: "输出位置", note: "" },
];

const MODES = [
  { id: "auto", label: "自动（先库后页面）" },
  { id: "db", label: "只用数据库" },
  { id: "http", label: "只用页面" },
];

const WRITE_MODES = [
  { id: "http", label: "走禅道页面（推荐）" },
  { id: "db", label: "直接改数据库" },
  { id: "auto", label: "先页面，失败降级到库" },
];

const CREDENTIALS = [
  { key: SECRET_REFS.httpPassword, label: "禅道登录密码", note: "对应上面 HTTP 通道的账号" },
  { key: SECRET_REFS.dbPassword, label: "数据库密码", note: "对应上面数据库账号" },
  { key: SECRET_REFS.sftpPassword, label: "SFTP 密码", note: "用私钥登录可留空" },
];

const styles = {
  page: { display: "flex", flexDirection: "column", gap: "20px", paddingBottom: "24px" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px 18px",
    borderRadius: "var(--dsw-radius-xl)",
    border: "0.5px solid var(--dsw-alias-border-l3)",
    background: "var(--dsw-alias-bg-layer-1)",
  },
  sectionTitle: { margin: 0, fontSize: "14px", fontWeight: 500, lineHeight: "22px" },
  sectionNote: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" },
  field: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
  label: { fontSize: "13px", color: "var(--dsw-alias-label-primary)", lineHeight: "20px" },
  hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" },
  input: {
    height: "34px",
    padding: "0 10px",
    fontSize: "13px",
    color: "var(--dsw-alias-label-primary)",
    background: "var(--dsw-alias-bg-layer-3)",
    border: "0.5px solid var(--dsw-alias-border-l4)",
    borderRadius: "var(--dsw-radius-md)",
    outline: "none",
    font: "inherit",
  },
  footer: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  button: {
    height: "32px",
    padding: "0 14px",
    fontSize: "13px",
    borderRadius: "var(--dsw-radius-md)",
    border: "0.5px solid var(--dsw-alias-border-l4)",
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-primary)",
    cursor: "pointer",
    font: "inherit",
  },
  primary: {
    height: "32px",
    padding: "0 16px",
    fontSize: "13px",
    borderRadius: "var(--dsw-radius-md)",
    border: "none",
    background: "var(--dsw-alias-state-business-primary)",
    color: "var(--dsw-alias-label-primary-foreground)",
    cursor: "pointer",
    font: "inherit",
  },
  pill: /** @param {string} [tone] */ (tone) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    lineHeight: "18px",
    background:
      tone === "ok"
        ? "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)"
        : tone === "warn"
          ? "var(--dsw-alias-state-warn-tertiary)"
          : "var(--dsw-alias-bg-layer-3)",
    color:
      tone === "ok"
        ? "var(--dsw-alias-state-success-primary)"
        : tone === "warn"
          ? "var(--dsw-alias-state-warn-label)"
          : "var(--dsw-alias-label-tertiary)",
  }),
  status: { fontSize: "12.5px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)", margin: 0 },
  error: { fontSize: "12.5px", lineHeight: "20px", color: "var(--dsw-alias-state-error-primary)", margin: 0 },
  credentialRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
    paddingTop: "4px",
    borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  },
};

/**
 * 把 catch 到的任意东西变成一句人话。
 *
 * 为什么单独拎出来：JS 里 `error.message` 在 checkJs 下是报错的（catch 变量被推成
 * `{}`），而三个地方（新会话、保存、测试连接）都要这同一段逻辑，之前是各抄一遍。
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = /** @type {{message?: unknown}} */ (error).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return String(error);
}

function getIn(source, path) {
  let cursor = source;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** 把草稿与当前配置比一遍，只提交改过的路径。 */
function diffOps(draft, current) {
  const ops = [];
  for (const field of FIELDS) {
    const before = getIn(current, field.path);
    // 草稿是「摊平」的：键是 field.path.join(".")，不是嵌套对象。
    // 这里以前误用 getIn(draft, ...) 取嵌套值，结果只有 mode 能比对出来，
    // 其余字段一律当成「没改」→ 点保存等于什么都没提交（真实踩过的坑）。
    const after = draft[field.path.join(".")];
    if (after === undefined) continue;
    // 空串 vs 未设置：两者对用户都是「没填」，别拿它凑成一次「改动」。
    if (after === "" && (before === undefined || before === null)) continue;
    if (field.kind === "number") {
      if (after === "" || after === null) continue;
      const parsed = Number(after);
      if (!Number.isFinite(parsed)) continue;
      if (parsed === before) continue;
      ops.push({ op: "set", path: field.path, value: parsed });
      continue;
    }
    if (field.kind === "boolean") {
      if (Boolean(after) === Boolean(before)) continue;
      ops.push({ op: "set", path: field.path, value: Boolean(after) });
      continue;
    }
    if (field.kind === "json") {
      // 草稿里是字符串、配置里是数组/对象，直接 === 比永远不等：
      // 结果就是「什么都没改，一保存也把工作区目标表当成改动提交一遍」。
      const beforeText =
        before === undefined || before === null ? "" : typeof before === "string" ? before : JSON.stringify(before);
      if (after === beforeText) continue;
      try {
        ops.push({ op: "set", path: field.path, value: typeof after === "string" ? JSON.parse(after) : after });
      } catch {
        // 草稿里的 JSON 已经坏了：不提交，等用户在页面上改对。
      }
      continue;
    }
    if (after === before) continue;
    ops.push({ op: "set", path: field.path, value: after });
  }
  if (draft.mode !== undefined && draft.mode !== current.mode) {
    ops.push({ op: "set", path: ["mode"], value: draft.mode });
  }
  return ops;
}

/** 从快照的 value 里摊平成草稿。 */
function draftFrom(state) {
  const value = (state && state.value) || {};
  const draft = { mode: value.mode ?? "auto" };
  for (const field of FIELDS) {
    const raw = getIn(value, field.path);
    // json 段（工作区目标表）在草稿里一律是字符串：编辑器按字符串改，写回时再解析。
    // 宿主给的原始值可能是数组（schema 里就是 json），不转一次的话 parseTargets 会当成空表，
    // 页面看着是「没配过工作区」，一保存就把已配的目标表顶没了。
    const normalized =
      field.kind === "json" && raw !== undefined && raw !== null && typeof raw !== "string"
        ? JSON.stringify(raw)
        : raw;
    draft[field.path.join(".")] =
      field.kind === "boolean" ? normalized === true : normalized === undefined || normalized === null ? "" : normalized;
  }
  return draft;
}

function draftValue(draft, field) {
  return draft[field.path.join(".")];
}

/** 把摊平的草稿收成嵌套配置对象；空值跳过，免得把已保存的配置顶成空。 */
function valueFromDraft(draft) {
  const value = { mode: draft.mode ?? "auto" };
  for (const field of FIELDS) {
    const raw = draft[field.path.join(".")];
    if (field.kind === "boolean") {
      // 布尔项即使为 false 也要写回去：false 是「关」，不是「没填」。
      let cursor = value;
      for (const segment of field.path.slice(0, -1)) {
        const key = segment;
        if (cursor[key] === undefined || typeof cursor[key] !== "object") cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[field.path[field.path.length - 1]] = raw === true;
      continue;
    }
    if (raw === undefined || raw === null || raw === "") continue;
    let parsed = raw;
    if (field.kind === "number") {
      parsed = Number(raw);
      if (!Number.isFinite(parsed)) continue;
    }
    if (field.kind === "json") {
      // 草稿里是字符串，写回配置时必须还原成对象/数组，否则 schema 校验会拒收。
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        continue;
      }
    }
    let cursor = value;
    for (const segment of field.path.slice(0, -1)) {
      const key = segment;
      if (cursor[key] === undefined || typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[field.path[field.path.length - 1]] = parsed;
  }
  return value;
}

async function bridge(name, body) {
  let response;
  try {
    response = await fetch(`${BRIDGE_PREFIX}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    // 宿主重启 / 端口换了的时候 fetch 直接抛，不抛的话页面会一直「正在保存…」。
    return { ok: false, code: "network", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await response.json();
  } catch {
    return { ok: false, code: "bad-response", message: `HTTP ${response.status}` };
  }
}

function CredentialRow(props) {
  const { item, status, onSave, onClear, busy } = props;
  const [value, setValue] = React.useState("");
  const configured = Boolean(status && status.configured && status.configured[item.key]);
  const fromEnv = Boolean(status && status.fromEnv && status.fromEnv[item.key]);
  return React.createElement(
    "div",
    { style: styles.credentialRow },
    React.createElement(
      "div",
      { style: { ...styles.field, flex: "1 1 200px" } },
      React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px" } },
        React.createElement("span", { style: styles.label }, item.label),
        React.createElement(
          "span",
          { style: styles.pill(configured ? "ok" : fromEnv ? "warn" : "off") },
          configured ? "已配置" : fromEnv ? "来自环境变量" : "未配置",
        ),
        React.createElement("span", { style: styles.hint }, item.key),
      ),
      React.createElement("input", {
        style: styles.input,
        type: "password",
        autoComplete: "new-password",
        placeholder: "输入新密码后点保存",
        value,
        disabled: busy,
        onChange: (event) => setValue(event.target.value),
      }),
    ),
    React.createElement(
      "div",
      { style: { display: "flex", gap: "8px", flex: "0 0 auto" } },
      React.createElement(
        "button",
        {
          type: "button",
          style: styles.button,
          disabled: busy || value.trim().length === 0,
          onClick: async () => {
            await onSave(item.key, value.trim());
            setValue("");
          },
        },
        busy ? "写入中…" : "保存",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          style: styles.button,
          disabled: busy || !configured,
          onClick: () => onClear(item.key),
        },
        "清除",
      ),
    ),
    React.createElement("div", { style: styles.hint }, item.note),
  );
}

/** @param {string} label @param {Health} [health] */
function probeLine(label, health) {
  if (!health) return `${label}：未配置`;
  if (health.ready) return `${label}：可用${health.probe && health.probe.detail ? `（${health.probe.detail}）` : ""}`;
  const missing = Array.isArray(health.missing) && health.missing.length > 0 ? `，缺 ${health.missing.join("、")}` : "";
  const reason = health.probe && health.probe.reason ? `，${health.probe.reason}` : "";
  return `${label}：不可用${missing}${reason}`;
}

/* ------------------------------------------------------------------ */
/* 工作区目标：禅道项目 → 工作区路径 + 多个 git 仓库（前端/后端/移动端…）    */
/* ------------------------------------------------------------------ */

/** 配置里存的是 JSON 字符串（桥接只接受标量），读出来坏了就当空表，别把页面搞崩。 */
function parseTargets(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeTarget) : [];
  } catch {
    return [];
  }
}

/** 老配置里仓库是单个 `branch`，新配置是 `branches`（有序）；读进来统一成数组，页面才好编辑。 */
function normalizeTarget(target) {
  if (target === null || typeof target !== "object") return target;
  const repos = Array.isArray(target.repos) ? target.repos : [];
  return {
    ...target,
    repos: repos.map((repo) => {
      if (repo === null || typeof repo !== "object") return repo;
      const chain = Array.isArray(repo.branches) ? repo.branches.map((item) => (typeof item === "string" ? item : "")) : [];
      const legacy = typeof repo.branch === "string" ? repo.branch.trim() : "";
      const { branch: _legacy, ...rest } = repo;
      return {
        ...rest,
        branches: chain.length > 0 ? chain : legacy === "" ? [""] : [legacy],
        submodules: normalizeSubmodules(repo.submodules),
      };
    }),
  };
}

/**
 * 子模块分支配置：配置里允许写成 `{ "acme-web-admin": "develop/v2.6.2-demo" }`
 * 这种键值对，也允许写成 `[{ match, branches }]`；页面统一成数组好编辑。
 */
function normalizeSubmodules(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (item === null || typeof item !== "object") return null;
        const match = typeof item.match === "string" ? item.match : "";
        const list = Array.isArray(item.branches) ? item.branches : [];
        const legacy = typeof item.branch === "string" ? item.branch.trim() : "";
        const chains = list.filter((one) => typeof one === "string" && one.trim() !== "");
        return { match, branches: chains.length > 0 ? chains : legacy === "" ? [""] : [legacy] };
      })
      .filter((item) => item !== null);
  }
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw).map(([match, value]) => {
      const chains = typeof value === "string" ? value.split(/[,，;；]/).map((one) => one.trim()).filter((one) => one !== "") : [];
      return { match, branches: chains.length > 0 ? chains : [""] };
    });
  }
  return [];
}

function emptySubmodule() {
  return { match: "", branches: [""] };
}

function emptyRepo() {
  return { role: "", path: "", gitUrl: "", branches: [""], submodules: [] };
}

function smallButton(extra) {
  return { ...styles.button, height: 28, padding: "0 10px", fontSize: 12, ...extra };
}

function Row(props) {
  const { children } = props;
  return React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, children);
}

function TextInput(props) {
  const { value, onChange, placeholder, disabled, width } = props;
  return React.createElement("input", {
    style: { ...styles.input, flex: `1 1 ${width || 140}px`, minWidth: 90 },
    type: "text",
    value: value ?? "",
    placeholder: placeholder || "",
    spellCheck: false,
    disabled,
    onChange: (event) => onChange(/** @type {HTMLInputElement} */ (event.target).value),
  });
}

/** 一个目标 = 一个工作区目录 + 若干 git 仓库。 */
function TargetCard(props) {
  const { target, index, disabled, onChange, onRemove } = props;
  const repos = Array.isArray(target.repos) ? target.repos : [];
  const patch = (next) => onChange({ ...target, ...next });
  const patchRepo = (repoIndex, next) => {
    const copy = repos.slice();
    copy[repoIndex] = { ...copy[repoIndex], ...next };
    patch({ repos: copy });
  };
  const branchesOf = (repo) => (Array.isArray(repo.branches) && repo.branches.length > 0 ? repo.branches : [""]);
  const patchBranch = (repoIndex, branchIndex, value) => {
    const repo = repos[repoIndex];
    const chain = branchesOf(repo).slice();
    chain[branchIndex] = value;
    patchRepo(repoIndex, { branches: chain });
  };
  const addBranch = (repoIndex) => patchRepo(repoIndex, { branches: [...branchesOf(repos[repoIndex]), ""] });
  const removeBranch = (repoIndex, branchIndex) => {
    const chain = branchesOf(repos[repoIndex]).filter((_, index) => index !== branchIndex);
    patchRepo(repoIndex, { branches: chain.length === 0 ? [""] : chain });
  };
  const submodulesOf = (repo) => (Array.isArray(repo.submodules) ? repo.submodules : []);
  const patchSubmodule = (repoIndex, subIndex, next) => {
    const list = submodulesOf(repos[repoIndex]).slice();
    list[subIndex] = { ...list[subIndex], ...next };
    patchRepo(repoIndex, { submodules: list });
  };
  const addSubmodule = (repoIndex) => patchRepo(repoIndex, { submodules: [...submodulesOf(repos[repoIndex]), emptySubmodule()] });
  const removeSubmodule = (repoIndex, subIndex) =>
    patchRepo(repoIndex, { submodules: submodulesOf(repos[repoIndex]).filter((_, index) => index !== subIndex) });
  /** 子模块单独配分支：键写子模块目录名的一段就行（模糊匹配），没写的跟随父仓库。 */
  const submoduleRows = (repo, repoIndex) => {
    const rules = submodulesOf(repo);
    return React.createElement(
      "div",
      { key: `submodules-${repoIndex}`, style: { display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12 } },
      React.createElement(
        Row,
        null,
        React.createElement("span", { style: { ...styles.hint, flex: "0 0 88px" } }, "子模块分支"),
        React.createElement(
          "span",
          { style: { ...styles.hint, flex: "1 1 auto" } },
          "只给和父仓库不一致的子模块写：左边写子模块名（模糊匹配），右边写它的分支链，多个分支用逗号隔开。没写的跟随父仓库。",
        ),
      ),
      rules.map((rule, subIndex) =>
        React.createElement(
          Row,
          { key: subIndex },
          React.createElement(TextInput, {
            value: rule.match,
            disabled,
            placeholder: "子模块，如 acme-web-admin",
            width: 200,
            onChange: (value) => patchSubmodule(repoIndex, subIndex, { match: value }),
          }),
          React.createElement(TextInput, {
            value: Array.isArray(rule.branches) ? rule.branches.join(", ") : "",
            disabled,
            placeholder: "它的分支链，如 develop/v2.6.2-demo",
            width: 260,
            onChange: (value) =>
              patchSubmodule(repoIndex, subIndex, {
                branches: value
                  .split(/[,，;；]/)
                  .map((item) => item.trim())
                  .filter((item) => item !== ""),
              }),
          }),
          React.createElement(
            "button",
            {
              type: "button",
              style: smallButton({ color: "var(--dsw-alias-state-error-primary)" }),
              disabled,
              onClick: () => removeSubmodule(repoIndex, subIndex),
            },
            "×",
          ),
        ),
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { type: "button", style: smallButton(), disabled, onClick: () => addSubmodule(repoIndex) },
          "+ 添加子模块分支",
        ),
      ),
    );
  };

  /** 一个仓库的分支链：序号 1 是改动落点，后面的靠 cherry-pick 接力。 */
  const branchRow = (repo, repoIndex) =>
    React.createElement(
      "div",
      { key: `branches-${repoIndex}`, style: { display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12 } },
      React.createElement(
        Row,
        null,
        React.createElement(
          "span",
          { style: { ...styles.hint, flex: "0 0 88px" } },
          "分支（有序）",
        ),
        React.createElement(
          "span",
          { style: { ...styles.hint, flex: "1 1 auto" } },
          "序号 1 是改动落点，改完依次 cherry-pick 到 2、3…（留空表示不校验分支）",
        ),
      ),
      branchesOf(repo).map((branch, branchIndex) =>
        React.createElement(
          Row,
          { key: branchIndex },
          React.createElement(
            "span",
            { style: { ...styles.hint, flex: "0 0 44px", textAlign: "right" } },
            `序号 ${branchIndex + 1}`,
          ),
          React.createElement(TextInput, {
            value: branch,
            disabled,
            placeholder: branchIndex === 0 ? "改动落点分支，如 develop/v2.6.2" : "下一级分支，如 release/v2.6.2",
            width: 200,
            onChange: (value) => patchBranch(repoIndex, branchIndex, value),
          }),
          React.createElement(
            "button",
            {
              type: "button",
              style: smallButton({ color: "var(--dsw-alias-state-error-primary)" }),
              disabled,
              onClick: () => removeBranch(repoIndex, branchIndex),
            },
            "×",
          ),
        ),
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { type: "button", style: smallButton(), disabled, onClick: () => addBranch(repoIndex) },
          "+ 添加分支",
        ),
      ),
    );

  return React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: "var(--dsw-radius-md)",
        background: "var(--dsw-alias-bg-layer-2)",
      },
    },
    React.createElement(
      Row,
      null,
      React.createElement("span", { style: { ...styles.label, flex: "0 0 auto" } }, `#${index + 1}`),
      React.createElement(TextInput, {
        value: target.name,
        disabled,
        placeholder: "工作区名称，例如 园区V2",
        width: 180,
        onChange: (value) => patch({ name: value }),
      }),
      React.createElement(TextInput, {
        value: target.path,
        disabled,
        placeholder: "工作区根目录绝对路径，例如 D:\\workspace\\park-v2",
        width: 320,
        onChange: (value) => patch({ path: value }),
      }),
      React.createElement(
        "button",
        { type: "button", style: smallButton({ color: "var(--dsw-alias-state-error-primary)" }), disabled, onClick: onRemove },
        "删除",
      ),
    ),
    React.createElement(
      Row,
      null,
      React.createElement("span", { style: { ...styles.hint, flex: "0 0 88px" } }, "禅道项目名"),
      React.createElement(TextInput, {
        value: Array.isArray(target.zentaoProjects) ? target.zentaoProjects.join(", ") : "",
        disabled,
        placeholder: "逗号分隔，命中就自动选这个工作区，例如 园区V2, 智慧园区",
        width: 380,
        onChange: (value) =>
          patch({
            zentaoProjects: value
              .split(/[,，;；]/)
              .map((item) => item.trim())
              .filter((item) => item !== ""),
          }),
      }),
    ),
    React.createElement("span", { style: styles.hint }, "仓库（一个工作区可以有多个：前端 / 后端 / 移动端…）"),
    repos.map((repo, repoIndex) =>
      React.createElement(
        "div",
        {
          key: repoIndex,
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            paddingTop: 6,
            borderTop: "0.5px solid var(--dsw-alias-border-l3)",
          },
        },
        React.createElement(
          Row,
          null,
          React.createElement(TextInput, {
            value: repo.role,
            disabled,
            placeholder: "角色，如 web",
            width: 90,
            onChange: (value) => patchRepo(repoIndex, { role: value }),
          }),
          React.createElement(TextInput, {
            value: repo.path,
            disabled,
            placeholder: "目录名或绝对路径，如 web",
            width: 150,
            onChange: (value) => patchRepo(repoIndex, { path: value }),
          }),
          React.createElement(TextInput, {
            value: repo.gitUrl,
            disabled,
            placeholder: "git 地址（缺目录时按它 clone）",
            width: 240,
            onChange: (value) => patchRepo(repoIndex, { gitUrl: value }),
          }),
          React.createElement(
            "button",
            {
              type: "button",
              style: smallButton({ color: "var(--dsw-alias-state-error-primary)" }),
              disabled,
              onClick: () => patch({ repos: repos.filter((_, item) => item !== repoIndex) }),
            },
            "×",
          ),
        ),
        // 每个仓库自己的分支链与子模块规则必须跟着这个仓库渲染：
        // 之前它们被写在 map 外面，引用的是不存在的 repo，整张配置页会直接抛
        // ReferenceError，被插槽的边界吞掉，看起来就是「配置页空白」。
        branchRow(repo, repoIndex),
        submoduleRows(repo, repoIndex),
      ),
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "button",
        {
          type: "button",
          style: smallButton(),
          disabled,
          onClick: () => patch({ repos: [...repos, emptyRepo()] }),
        },
        "+ 添加仓库",
      ),
    ),
  );
}

/**
 * 「在新会话处理」面板：填编号 → 试运行（只看仓库状态）→ 真开工。
 *
 * 这是「人工点触发」那个默认入口：模型自己不能开，人可以在这里一键开。
 */
function SessionPanel(props) {
  // `targetsVersion` 是「工作区目标表」被改过的次数：面板拉的是宿主的实时目标表，
  // 用户在上面编辑保存后要重拉一次，否则下拉里还是旧的那几条。
  const { disabled, onError, targetsVersion } = props;
  const [kind, setKind] = React.useState("bug");
  const [id, setId] = React.useState("");
  const [targetId, setTargetId] = React.useState("");
  const [info, setInfo] = React.useState(/** @type {SessionInfo | null} */ (null));
  const [busy, setBusy] = React.useState("");
  const [result, setResult] = React.useState(/** @type {SessionResult | null} */ (null));

  React.useEffect(() => {
    let cancelled = false;
    bridge("session-targets", {})
      .then((payload) => {
        if (cancelled || !payload || !payload.ok) return;
        setInfo(payload.value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [targetsVersion]);

  const run = async (name) => {
    if (id.trim() === "") {
      onError && onError("先填禅道编号");
      return;
    }
    setBusy(name);
    setResult(null);
    try {
      const payload = await bridge(name, {
        kind,
        id: id.trim(),
        ...(targetId !== "" ? { targetId } : {}),
        ...(name === "session-probe" ? { dryRun: true } : {}),
      });
      setResult(payload);
    } catch (error) {
      setResult({ ok: false, message: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const targets = (info && info.targets) || [];
  const session = (info && info.session) || {};
  const host = (info && info.host) || {};

  return React.createElement(
    "section",
    { style: styles.section },
    React.createElement("h3", { style: styles.sectionTitle }, "在新会话处理"),
    React.createElement(
      "p",
      { style: styles.sectionNote },
      "拉完一条禅道单子后，在对应工作区里建一个新会话：先补齐并更新各端仓库，再建会话、起标题。",
      session.reuseExisting === false
        ? "（已关掉「同编号优先回到旧会话」，每次都会新建）"
        : "（同一编号之前开过会话时，会回到那个会话继续）",
      session.agentAutoStart ? "（当前允许模型自己发起）" : "（默认只有人在这里点才会开）",
    ),
    host.workspaceRegistry === false || host.sessionController === false
      ? React.createElement(
          "p",
          { style: styles.error },
          `宿主服务不全：工作区注册表${host.workspaceRegistry ? "✅" : "❌"} / 会话控制器${host.sessionController ? "✅" : "❌"}。这个版本的 DSH 可能不支持开新会话。`,
        )
      : null,
    React.createElement(
      Row,
      null,
      React.createElement(
        "select",
        {
          style: { ...styles.input, height: 34, flex: "0 0 110px" },
          value: kind,
          disabled: !!busy,
          onChange: (event) => setKind(event.target.value),
        },
        [
          { id: "bug", label: "BUG" },
          { id: "task", label: "任务" },
          { id: "story", label: "需求" },
        ].map((item) => React.createElement("option", { key: item.id, value: item.id }, item.label)),
      ),
      React.createElement(TextInput, {
        value: id,
        disabled: !!busy,
        placeholder: "禅道编号，如 5967",
        width: 130,
        onChange: setId,
      }),
      React.createElement(
        "select",
        {
          style: { ...styles.input, height: 34, flex: "1 1 220px" },
          value: targetId,
          disabled: !!busy,
          onChange: (event) => setTargetId(event.target.value),
        },
        [
          React.createElement("option", { key: "", value: "" }, targets.length === 0 ? "（还没配置工作区目标）" : "自动匹配工作区"),
          ...targets.map((item) => React.createElement("option", { key: item.id, value: item.id }, `${item.name} — ${item.path}`)),
        ],
      ),
      React.createElement(
        "button",
        { type: "button", style: styles.button, disabled: !!busy || disabled || targets.length === 0, onClick: () => run("session-probe") },
        busy === "session-probe" ? "探测中…" : "试运行",
      ),
      React.createElement(
        "button",
        { type: "button", style: styles.primary, disabled: !!busy || disabled || targets.length === 0, onClick: () => run("session-start") },
        busy === "session-start" ? "开工中…" : "开新会话",
      ),
    ),
    result === null
      ? null
      : result.ok
        ? React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("p", { style: styles.status }, result.value.message),
            result.value.sessionId
              ? React.createElement(
                  "p",
                  { style: styles.hint },
                  `会话 ${result.value.sessionId}「${result.value.title || ""}」—— ${
                    result.value.reused === true ? "这是同编号的旧会话，已回到它继续；" : ""
                  }去左侧会话列表里打开它（不会自动跳转）。`,
                )
              : null,
            (result.value.repos || []).flatMap((repo, index) => {
              const rows = [
                React.createElement(
                  "p",
                  { key: `r${index}`, style: styles.hint },
                  `${repo.role}（${repo.path}）：${repo.action} — ${repo.message}`,
                ),
              ];
              for (const [subIndex, sub] of (repo.submodules || []).entries()) {
                rows.push(
                  React.createElement(
                    "p",
                    { key: `r${index}s${subIndex}`, style: styles.hint },
                    `　└ 子模块 ${sub.path}${sub.branch ? `（${sub.branch}）` : ""}：${sub.action} — ${sub.message}`,
                  ),
                );
              }
              return rows;
            }),
            (result.value.candidates || []).length > 0
              ? React.createElement(
                  "p",
                  { style: styles.hint },
                  `没自动选中工作区：${result.value.message}。候选：${(result.value.candidates || []).map((item) => item.name).join("、")}`,
                )
              : null,
            (result.value.warnings || []).map((item, index) =>
              React.createElement("p", { key: `w${index}`, style: styles.hint }, `⚠️ ${item}`),
            ),
            (result.value.elsewhere || []).length > 0
              ? React.createElement(
                  "p",
                  { style: styles.hint },
                  `另外这些目录里也有同编号的会话（没自动接管，要用就去那边开）：${(result.value.elsewhere || [])
                    .map((item) => `${item.cwd}`)
                    .join("、")}`,
                )
              : null,
          )
        : React.createElement("p", { style: styles.error }, `没成：${result.message || "未知原因"}`),
  );
}

function LifeSaverPage(props) {
  const { view, form } = props;
  const state = form && form.state;
  const writable = Boolean(state && state.writable !== false);
  const revision = state && typeof state.revision === "number" ? state.revision : undefined;
  const stateValue = state && state.value;

  const [draft, setDraft] = React.useState(() => draftFrom(state));
  const [baseline, setBaseline] = React.useState(() => (state && state.value) || {});
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState("");
  const [message, setMessage] = React.useState(/** @type {Notice | null} */ (null));
  const [probe, setProbe] = React.useState(/** @type {ProbeResult | null} */ (null));
  const [probing, setProbing] = React.useState(false);
  const [credStatus, setCredStatus] = React.useState(/** @type {CredStatus | null} */ (null));
  const [credBusy, setCredBusy] = React.useState("");
  /** 目标表保存成功后自增，让 SessionPanel 重拉一次宿主的实时目标表。 */
  const [savedCount, setSavedCount] = React.useState(0);

  // 配置被别处改过（保存成功 / 另一个页面写过）就重建草稿。
  // 判据是**内容**不是对象身份：宿主每次渲染给的 state.value 都是新对象，
  // 按身份依赖会在用户正打字时把草稿冲回已保存值。序列化后的字符串是原始类型，
  // 既能进依赖数组，又只在内容真的变了才变。
  const valueSignature = JSON.stringify(stateValue || {});
  const appliedSignature = React.useRef(/** @type {string | null} */ (null));
  React.useEffect(() => {
    if (appliedSignature.current === valueSignature) return;
    appliedSignature.current = valueSignature;
    setBaseline(stateValue || {});
    setDraft(draftFrom({ value: stateValue }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSignature]);

  React.useEffect(() => {
    let cancelled = false;
    bridge("credentials-status", {})
      .then((result) => {
        if (cancelled) return;
        if (result && result.ok) setCredStatus(result.value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (view === "summary") {
    return "禅道 task/bug/story 内容全量提取：只读库 + SFTP 或账号密码登录页面。";
  }

  if (form === undefined || state === undefined || state.status === "loading") {
    // 一直停在这里通常意味着存下来的配置没通过 schema 校验（status 会停在 loading），
    // 所以把这句话直接写在加载态里，免得用户对着转圈的地方猜。
    return React.createElement(
      "p",
      { style: styles.status },
      "正在读取插件配置…（若一直停在这里，说明 cordis.patch.yml 里的 config 没通过 schema 校验）",
    );
  }

  if (state.status === "unavailable") {
    return React.createElement("p", { style: styles.error }, "dsh-life-saver 这一行没有加载成功，先到插件页把它打开再回来配置。");
  }

  const setField = (field, raw) => {
    setDraft((previous) => ({ ...previous, [field.path.join(".")]: raw }));
  };

  const dirty = diffOps(draft, baseline).length > 0;

  const save = async () => {
    if (!form) return;
    const ops = diffOps(draft, baseline);
    if (ops.length === 0) {
      setMessage({ tone: "info", text: "没有改动。" });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      // 先走宿主 bridge：它把 settings.mutate 抛的原文带回来。
      // 配置镜像的 form.mutate 只回 true/false，失败时页面说不出原因。
      let viaBridge;
      try {
        viaBridge = await bridge("config-set", { ops, revision });
      } catch {
        viaBridge = null; // 路由没注册（宿主里跑着旧版插件）→ 退回配置镜像
      }
      if (viaBridge && viaBridge.ok) {
        setBaseline(valueFromDraft(draft));
        setSavedAt(new Date().toLocaleTimeString());
        setSavedCount((previous) => previous + 1);
        setMessage({ tone: "ok", text: `已保存 ${ops.length} 项，工具下一次调用就会用上新配置。` });
        return;
      }
      if (viaBridge && viaBridge.ok === false && viaBridge.code !== "bad-response") {
        setMessage({ tone: "error", text: `保存失败：${viaBridge.message || "未知原因"}` });
        return;
      }
      const ok = await form.mutate(ops, revision);
      if (ok) {
        setBaseline(valueFromDraft(draft));
        setSavedAt(new Date().toLocaleTimeString());
        setSavedCount((previous) => previous + 1);
        setMessage({ tone: "ok", text: `已保存 ${ops.length} 项。` });
      } else {
        setMessage({
          tone: "error",
          text: writable
            ? "保存被拒绝：配置可能在别处被改过，或其中有字段不允许改，请刷新后再试。"
            : "当前配置是只读的，改不动。",
        });
      }
    } catch (error) {
      setMessage({ tone: "error", text: `保存失败：${errorText(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      // 带上页面里还没保存的值：填完就能测，不用先存一次。
      const result = await bridge("test", { overrides: valueFromDraft(draft) });
      setProbe(result);
    } catch (error) {
      setProbe({ ok: false, message: errorText(error) });
    } finally {
      setProbing(false);
    }
  };

  /** 凭据写/清共用一套流程：只有路由名和文案不同。 */
  const changeCredential = async (name, key, body, done, failed) => {
    setCredBusy(key);
    try {
      const result = await bridge(name, body);
      setMessage(
        result && result.ok
          ? { tone: "ok", text: done(key) }
          : { tone: "error", text: `${failed}：${(result && result.message) || "未知原因"}` },
      );
      const status = await bridge("credentials-status", {});
      if (status && status.ok) setCredStatus(status.value);
    } catch (error) {
      setMessage({ tone: "error", text: `${failed}：${errorText(error)}` });
    } finally {
      setCredBusy("");
    }
  };

  const saveCredential = (key, value) =>
    changeCredential(
      "credentials-set",
      key,
      { key, value },
      (name) => `已写入凭据 ${name}，工具下一次调用就会用上。`,
      "写入失败",
    );

  const clearCredential = (key) =>
    changeCredential(
      "credentials-unset",
      key,
      { key },
      (name) => `已清除凭据 ${name}。`,
      "清除失败",
    );

  const children = [];

  // 通道选择
  children.push(
    React.createElement(
      "section",
      { key: "mode", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "取数通道"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        "自动 = 先查只读库，失败再退回页面；只走页面时不需要数据库和 SFTP。",
      ),
      React.createElement(
        "div",
        { style: styles.grid },
        React.createElement(
          "label",
          { style: styles.field },
          React.createElement("span", { style: styles.label }, "模式"),
          React.createElement(
            "select",
            {
              style: { ...styles.input, height: "36px" },
              value: draft.mode ?? "auto",
              disabled: !writable,
              onChange: (event) => setDraft((previous) => ({ ...previous, mode: event.target.value })),
            },
            MODES.map((mode) => React.createElement("option", { key: mode.id, value: mode.id }, mode.label)),
          ),
        ),
      ),
    ),
  );

  for (const section of SECTIONS) {
    const fields = FIELDS.filter((field) => field.section === section.id);
    children.push(
      React.createElement(
        "section",
        { key: section.id, style: styles.section },
        React.createElement("h3", { style: styles.sectionTitle }, section.title),
        section.note ? React.createElement("p", { style: styles.sectionNote }, section.note) : null,
        React.createElement(
          "div",
          { style: styles.grid },
          fields.map((field) =>
            React.createElement(
              "label",
              { key: field.path.join("."), style: styles.field },
              React.createElement("span", { style: styles.label }, field.label),
              React.createElement("input", {
                style: styles.input,
                type: field.kind === "number" ? "number" : "text",
                value: draftValue(draft, field) ?? "",
                disabled: !writable,
                spellCheck: false,
                onChange: (event) => setField(field, event.target.value),
              }),
              React.createElement("span", { style: styles.hint }, field.hint),
            ),
          ),
        ),
      ),
    );
  }

  // 结构探测：默认就能自己认，这里只是手工兜底的口子。
  // 换禅道版本后如果读实体报 skin-unknown、搜索报 SQL 错，先在这儿钉死比翻文档快。
  const setDraftKey = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
  const discoveryEnabled = draft["discovery.enabled"] !== false;
  const discoveryTtl = String(draft["discovery.ttlMs"] || 600000);
  const skinChoice = draft["http.skin"] || "auto";
  const keywordsChoice = draft["db.keywords"] || "auto";

  children.push(
    React.createElement(
      "section",
      { key: "discovery", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "结构探测（自探索）"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        "换禅道版本 / 皮肤后，插件在体检时自己认库结构、页面皮肤和登录算法；认不出来就退回代码默认值，并在 zentao_status 里标「未确认」。一般不用动这里。",
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: discoveryEnabled,
          disabled: !writable,
          onChange: (event) => setDraftKey("discovery.enabled", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "体检时自动探测结构"),
        React.createElement("span", { style: styles.hint }, "关掉 = 一律用默认结构，不再多发那两条 information_schema 查询"),
      ),
      React.createElement(
        "label",
        { style: styles.field },
        React.createElement("span", { style: styles.label }, "探测缓存有效期"),
        React.createElement(
          "select",
          {
            style: { ...styles.input, height: "36px" },
            value: discoveryTtl,
            disabled: !writable || !discoveryEnabled,
            onChange: (event) => setDraftKey("discovery.ttlMs", Number(event.target.value)),
          },
          [
            { value: "600000", label: "10 分钟（默认）" },
            { value: "1800000", label: "30 分钟" },
            { value: "3600000", label: "1 小时" },
            { value: "0", label: "每次体检都重探" },
          ].map((item) => React.createElement("option", { key: item.value, value: item.value }, item.label)),
        ),
        React.createElement("span", { style: styles.hint }, "体检只在 zentao_status 里跑；工具调用不会顺手探"),
      ),
      React.createElement(
        "label",
        { style: styles.field },
        React.createElement("span", { style: styles.label }, "页面皮肤（读不到正文时钉死）"),
        React.createElement(
          "select",
          {
            style: { ...styles.input, height: "36px" },
            value: skinChoice,
            disabled: !writable,
            onChange: (event) => setDraftKey("http.skin", event.target.value),
          },
          [
            { value: "auto", label: "自动识别（推荐）" },
            { value: "detail-section", label: "新版：.detail-section（禅道 15+ / biz）" },
            { value: "detail", label: "老版：.detail（12.x 一类）" },
            { value: "article", label: "最老版：.article" },
          ].map((item) => React.createElement("option", { key: item.value, value: item.value }, item.label)),
        ),
      ),
      React.createElement(
        "label",
        { style: styles.field },
        React.createElement("span", { style: styles.label }, "搜索匹配方式（搜索报 SQL 错时钉死）"),
        React.createElement(
          "select",
          {
            style: { ...styles.input, height: "36px" },
            value: keywordsChoice,
            disabled: !writable,
            onChange: (event) => setDraftKey("db.keywords", event.target.value),
          },
          [
            { value: "auto", label: "自动识别（推荐）" },
            { value: "on", label: "标题 + keywords 两列都匹配（新库）" },
            { value: "off", label: "只匹配标题（老库没有 keywords 列）" },
          ].map((item) => React.createElement("option", { key: item.value, value: item.value }, item.label)),
        ),
      ),
    ),
  );

  // 工作区目标表：禅道项目 → 工作区（含多端 git 仓库）
  const targets = parseTargets(draft["targets"]);
  const writeTargets = (next) => setDraft((previous) => ({ ...previous, targets: JSON.stringify(next) }));
  children.push(
    React.createElement(
      "section",
      { key: "targets", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "工作区目标"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        "一条禅道单子 → 一个 DSH 工作区。工作区里可以有多个 git 仓库（前端 / 后端 / 移动端），开工前会先把它们补齐并更新到最新。仓库是父子模块（有子模块）还是单仓库，插件自己认，不用配；子模块的分支默认跟着父仓库，和父仓库不一致的（比如园区前端）在下面「子模块分支」里单独写一条就行；有未提交改动的子模块不动它。",
      ),
      targets.map((target, index) =>
        React.createElement(TargetCard, {
          key: index,
          target,
          index,
          disabled: !writable,
          onChange: (next) => {
            const copy = targets.slice();
            copy[index] = next;
            writeTargets(copy);
          },
          onRemove: () => writeTargets(targets.filter((_, item) => item !== index)),
        }),
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          {
            type: "button",
            style: styles.button,
            disabled: !writable,
            onClick: () =>
              writeTargets([
                ...targets,
                { id: "", name: "", path: "", zentaoProjects: [], repos: [emptyRepo()] },
              ]),
          },
          "+ 添加工作区",
        ),
      ),
      React.createElement(
        "p",
        { style: styles.hint },
        "id 留空会按名称自动生成；禅道项目名填上后，同名项目的单子会自动落到这个工作区，不用每次手选。",
      ),
    ),
  );

  // 开新会话的开关
  const sessionDraft = (key, fallback) => (draft[`session.${key}`] === undefined ? fallback : draft[`session.${key}`]);
  const setSessionDraft = (key, value) => setDraft((previous) => ({ ...previous, [`session.${key}`]: value }));

  // 写入：三个开关。默认「允许写入 + 走页面 + 只动自己名下的」。
  const writeDraft = (key, fallback) => (draft[`write.${key}`] === undefined ? fallback : draft[`write.${key}`]);
  const setWriteDraft = (key, value) => setDraft((previous) => ({ ...previous, [`write.${key}`]: value }));

  children.push(
    React.createElement(
      "section",
      { key: "write", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "写入禅道"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        "工具 zentao_task_op / zentao_bug_op 会**真的改禅道数据**，没有预览。防护靠状态白名单、归属校验与写后回读。",
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: writeDraft("enabled", true) === true,
          disabled: !writable,
          onChange: (event) => setWriteDraft("enabled", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "允许写入（关掉 = 插件只读）"),
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: writeDraft("allowOthers", false) === true,
          disabled: !writable,
          onChange: (event) => setWriteDraft("allowOthers", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "允许改别人名下的任务/BUG"),
        React.createElement("span", { style: styles.hint }, "默认关：只允许动指派给自己或自己创建的记录"),
      ),
      React.createElement(
        "label",
        { style: styles.field },
        React.createElement("span", { style: styles.label }, "写操作走哪条线"),
        React.createElement(
          "select",
          {
            style: { ...styles.input, height: "36px" },
            value: writeDraft("mode", "http"),
            disabled: !writable,
            onChange: (event) => setWriteDraft("mode", event.target.value),
          },
          WRITE_MODES.map((mode) =>
            React.createElement("option", { key: mode.id, value: mode.id }, mode.label),
          ),
        ),
        React.createElement(
          "span",
          { style: styles.hint },
          "页面：走禅道自己的业务逻辑，历史、通知、看板泳道都由它写全（推荐）。库：直接改 7 张表，快但需要完全复刻副作用。",
        ),
      ),
    ),
  );

  children.push(
    React.createElement(
      "section",
      { key: "session", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "开新会话"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        "工具 zentao_session_start 与下面「在新会话处理」面板的行为开关。",
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: sessionDraft("enabled", true) === true,
          disabled: !writable,
          onChange: (event) => setSessionDraft("enabled", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "启用「在新会话处理」"),
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: sessionDraft("agentAutoStart", false) === true,
          disabled: !writable,
          onChange: (event) => setSessionDraft("agentAutoStart", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "允许模型自己开新会话"),
        React.createElement("span", { style: styles.hint }, "默认关：只有你在这里点按钮才会开"),
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: sessionDraft("autoPrompt", false) === true,
          disabled: !writable,
          onChange: (event) => setSessionDraft("autoPrompt", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "建好会话就自动发开场提示词"),
        React.createElement("span", { style: styles.hint }, "关掉时只建会话不发消息，避免一开就消耗额度"),
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked: sessionDraft("reuseExisting", true) === true,
          disabled: !writable,
          onChange: (event) => setSessionDraft("reuseExisting", event.target.checked),
        }),
        React.createElement("span", { style: styles.label }, "同一编号优先回到旧会话"),
        React.createElement(
          "span",
          { style: styles.hint },
          "只认编号：之前给 BUG 5967 开过会话，再来还进那个；找不到（或不在这个工作区）才新建",
        ),
      ),
      React.createElement(
        "label",
        { style: styles.field },
        React.createElement("span", { style: styles.label }, "开场提示词模板（可选）"),
        React.createElement("textarea", {
          style: { ...styles.input, height: 96, padding: 8, resize: "vertical", fontFamily: "inherit" },
          value: draft["session.promptTemplate"] ?? "",
          disabled: !writable,
          placeholder: "留空用内置模板。可用占位符：{{kind}} {{id}} {{title}} {{target}} {{repos}} {{branches}} {{submodules}} {{submodulebranches}} {{zentao}}",
          onChange: (event) => setSessionDraft("promptTemplate", event.target.value),
        }),
        React.createElement(
          "span",
          { style: styles.hint },
          "内置模板会让新会话先跑 zentao_read 读全正文，并交代清楚当前分支与「不要 git push」。",
        ),
      ),
    ),
  );

  children.push(
    React.createElement(SessionPanel, {
      key: "session-panel",
      disabled: !writable,
      targetsVersion: savedCount,
      onError: (text) => setMessage({ tone: "error", text }),
    }),
  );

  children.push(
    React.createElement(
      "section",
      { key: "credentials", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "凭据"),
      React.createElement(
        "p",
        { style: styles.sectionNote },
        credStatus && credStatus.available
          ? "密码存在 DSH 凭据中心，不写进配置文件。"
          : "凭据服务还没就绪；也可以先用环境变量。",
      ),
      CREDENTIALS.map((item) =>
        React.createElement(CredentialRow, {
          key: item.key,
          item,
          status: credStatus,
          busy: credBusy === item.key,
          onSave: saveCredential,
          onClear: clearCredential,
        }),
      ),
    ),
  );

  children.push(
    React.createElement(
      "section",
      { key: "probe", style: styles.section },
      React.createElement("h3", { style: styles.sectionTitle }, "连通性"),
      React.createElement(
        "div",
        { style: styles.footer },
        React.createElement(
          "button",
          { type: "button", style: styles.button, disabled: probing, onClick: runProbe },
          probing ? "正在连禅道…" : "测试连接",
        ),
        React.createElement(
          "span",
          { style: styles.hint },
          "会真连一次：数据库建连接跑一条查询，页面通道登录一次。",
        ),
      ),
      probe === null
        ? null
        : probe.ok
          ? React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              React.createElement("p", { style: styles.status }, probeLine("数据库通道", probe.value && probe.value.db)),
              React.createElement("p", { style: styles.status }, probeLine("页面通道", probe.value && probe.value.http)),
            )
          : React.createElement("p", { style: styles.error }, `测试失败：${probe.message || "未知原因"}`),
    ),
  );

  children.push(
    React.createElement(
      "div",
      { key: "actions", style: styles.footer },
      React.createElement(
        "button",
        { type: "button", style: styles.primary, disabled: saving || !dirty, onClick: save },
        saving ? "保存中…" : "保存",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          style: styles.button,
          disabled: saving || !dirty,
          onClick: () => setDraft(draftFrom(state)),
        },
        "放弃修改",
      ),
      React.createElement(
        "span",
        { style: styles.hint },
        !writable
          ? "当前部署的配置是只读的（保存会失败并给出原因）。"
          : dirty
            ? "有未保存的修改"
            : savedAt
              ? `已保存（${savedAt}）`
              : "已与当前配置一致",
      ),
    ),
  );

  if (message) {
    children.push(
      React.createElement(
        "p",
        { key: "message", style: message.tone === "error" ? styles.error : styles.status },
        message.text,
      ),
    );
  }

  return React.createElement("div", { style: styles.page }, children);
}

export const inject = ["slots"];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-life-saver#life-saver",
          },
          LifeSaverPage,
        ),
      ),
    "dsh-life-saver: settings page",
  );
}
