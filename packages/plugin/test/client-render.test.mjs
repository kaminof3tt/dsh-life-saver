/**
 * 客户端配置页的「能不能渲染出来」回归测试。
 *
 * 为什么值得这么测：这个 bundle 是浏览器里跑的，宿主那边构建通过、工具注册成功
 * 都不代表页面不炸；而页面炸了只会在 GUI 里显示一片空白，从终端看不见。
 * 所以这里用一套最小的 React 替身（createElement/useState/useEffect）把
 * lib/client.js 真的执行一遍，按 DSH 给的 prop 形状渲染三种状态，
 * 断言它没抛异常、且关键文案出现在树里。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientPath = join(root, "lib", "client.js");

/** 极简 React：只够这个页面用（createElement + 三个 hook）。 */
function makeReact() {
  // 根组件（被测量的那个页面）的 hook 状态要跨 rerender 保留，所以单独一个 frame；
  // 子组件（TargetCard / TextInput / SessionPanel…）每次展开时各开一个临时 frame，
  // 它们的状态不需要跨次保留，但必须真的执行到 —— 之前只渲染根组件，
  // 子组件里的 ReferenceError 在测试里永远看不见。
  const freshFrame = () => ({ slots: [], cursor: 0, effects: [], effectCursor: 0, effectDeps: [] });
  let rootFrame = freshFrame();
  let stack = [];
  let nestedEffects = [];
  const current = () => (stack.length > 0 ? stack[stack.length - 1] : rootFrame);
  const sameDeps = (before, after) =>
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every((value, index) => Object.is(value, after[index]));
  return {
    api: {
      // 真 React 会把 children 放进 props.children，页面里的包装组件（Row）就是按这个取的；
      // 只放在 element.children 上的话，Row 拿到的是 undefined，整块内容会静默渲染成空。
      createElement: (type, props, ...children) => {
        const flat = children.flat(Infinity);
        const normalized = props ?? {};
        if (flat.length > 0 && normalized.children === undefined) {
          normalized.children = flat.length === 1 ? flat[0] : flat;
        }
        return { type, props: normalized, children: flat };
      },
      useState: (initial) => {
        const frame = current();
        const index = frame.cursor++;
        if (!(index in frame.slots)) frame.slots[index] = typeof initial === "function" ? initial() : initial;
        const set = (next) => {
          frame.slots[index] = typeof next === "function" ? next(frame.slots[index]) : next;
        };
        return [frame.slots[index], set];
      },
      // 依赖没变就不重跑：页面有两个 effect，其中一个是「配置变了就重建草稿」，
      // 每次都跑会把测试里刚改的草稿冲掉，也不符合 React 的语义。
      useEffect: (fn, deps) => {
        const frame = current();
        const index = frame.effectCursor++;
        if (frame.effectDeps[index] === undefined || deps === undefined || !sameDeps(frame.effectDeps[index], deps)) {
          frame.effectDeps[index] = deps;
          frame.effects.push(fn);
        }
      },
      useRef: (initial) => ({ current: initial }),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    },
    /** 渲染一个子组件（函数组件），拿到它的返回树。 */
    renderComponent(component, props) {
      const frame = freshFrame();
      stack.push(frame);
      try {
        return component(props);
      } finally {
        stack.pop();
        nestedEffects.push(...frame.effects);
      }
    },
    begin() {
      rootFrame = freshFrame();
      stack = [];
      nestedEffects = [];
    },
    /** 保留 state、只把游标拨回 0：用来「同一份 state 再渲染一次」。 */
    rewind() {
      rootFrame.cursor = 0;
      rootFrame.effects = [];
      rootFrame.effectCursor = 0;
      nestedEffects = [];
    },
    effects: () => [...rootFrame.effects, ...nestedEffects],
  };
}

/** 把函数组件真的展开成 DOM 元素的树（深度优先）。 */
function expandTree(react, node) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => expandTree(react, child));
  if (typeof node.type === "function") return expandTree(react, react.renderComponent(node.type, node.props));
  return { type: node.type, props: node.props, children: (node.children ?? []).map((child) => expandTree(react, child)) };
}

/** 深度遍历渲染树，收集满足条件的元素。 */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

/** 按标签文案找输入框（label 里第一个 input）。 */
function findInputByLabel(tree, label) {
  for (const node of findAll(tree, (element) => element.type === "label")) {
    if (!textOf(node).includes(label)) continue;
    const input = findAll(node, (element) => element.type === "input")[0];
    if (input !== undefined) return input;
  }
  return undefined;
}

/** 按按钮文案找按钮。 */
function findButtonByText(tree, text) {
  return findAll(tree, (node) => node.type === "button" && (node.children ?? []).includes(text))[0];
}

/** 把渲染树摊平成文本，用来找文案。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const own = Object.entries(node.props ?? {})
    .filter(([key, value]) => key !== "children" && (typeof value === "string" || typeof value === "number"))
    .map(([, value]) => String(value));
  return [...own, textOf(node.children)].join(" ");
}

/** 用一个假的 ModuleLoader 把产物装进来，拿到工厂里的 module.exports。 */
async function loadClient() {
  const react = makeReact();
  let loaded;
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, exports: factory((name) => {
          if (name.startsWith("react")) return react.api;
          throw new Error(`客户端不应 require('${name}')：宿主没有提供这个模块`);
        }) };
      },
    },
  };
  // 每次测试都重新求值一遍产物，避免模块级状态串味。
  const source = readFileSync(clientPath, "utf8");
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  await import(`${dataUrl}#${Math.random()}`);
  assert.ok(loaded, "lib/client.js 没有调用 window.__ModuleLoader__.load");
  return { loaded, react };
}

/** 按 DSH 的 plugins.row.config 契约拿到行页组件。 */
function mountPage(loaded) {
  let component;
  const ctx = {
    effect: (factory) => {
      factory();
    },
    slots: {
      inject: (_slot, factory) => {
        factory();
      },
      register: (_meta, target) => {
        component = target;
      },
    },
  };
  loaded.exports.apply(ctx);
  assert.equal(typeof component, "function", "apply() 没有注册行页组件");
  return component;
}

function render(react, component, props) {
  react.begin();
  const tree = expandTree(react, component(props));
  for (const effect of react.effects()) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanup();
  }
  return tree;
}

/** 同一份 state 再渲染一次（不清空 useState 槽位），用来模拟「用户改完再重画」。 */
function rerender(react, component, props) {
  react.rewind();
  const tree = expandTree(react, component(props));
  for (const effect of react.effects()) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanup();
  }
  return tree;
}

test("客户端产物：包成 ModuleLoader，id 与包名一致", async () => {
  const { loaded } = await loadClient();
  assert.equal(loaded.id, "dsh-life-saver");
  assert.equal(typeof loaded.exports.apply, "function");
});

test("加载态：不炸，且提示没通过 schema 校验的可能", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const text = textOf(
    render(react, Page, { view: "page", form: { state: { status: "loading" }, mutate: async () => true } }),
  );
  assert.match(text, /正在读取插件配置/);
});

test("不可用态：告诉用户去插件页把这一行打开", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const text = textOf(
    render(react, Page, { view: "page", form: { state: { status: "unavailable" }, mutate: async () => true } }),
  );
  assert.match(text, /没有加载成功/);
});

test("就绪态：字段、分组标题、保存按钮都在（配置为空也不炸）", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const text = textOf(
    render(react, Page, {
      view: "page",
      form: {
        state: { status: "ready", writable: true, revision: 3, value: {} },
        mutate: async () => true,
      },
    }),
  );
  for (const label of ["禅道地址", "数据库地址", "SFTP 主机", "保存"]) {
    assert.ok(text.includes(label), `就绪态渲染里缺少「${label}」`);
  }
});

test("摘要态：只回一行文字，不渲染整页", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const tree = render(react, Page, { view: "summary", form: undefined });
  assert.equal(typeof tree, "string");
  assert.match(tree, /禅道/);
});

test("只读态：不写也能渲染（writable=false 时按钮禁用）", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const tree = render(react, Page, {
    view: "page",
    form: {
      state: { status: "ready", writable: false, revision: 1, value: { mode: "db" } },
      mutate: async () => true,
    },
  });
  const text = textOf(tree);
  assert.match(text, /只读|不可修改|writable/i);
});

test("保存：先走宿主 /config-set，把它的错误原话显示出来", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const state = { status: "ready", writable: true, revision: 5, value: { mode: "auto", http: { baseUrl: "http://zentao.example.com" } } };
  const form = {
    state,
    mutate: async () => {
      throw new Error("走了 form.mutate：bridge 兜底没生效");
    },
  };
  let tree = render(react, Page, { view: "page", form });
  const account = findInputByLabel(tree, "禅道账号");
  assert.ok(account, "找不到「禅道账号」输入框");
  account.props.onChange({ target: { value: "huzihao" } });

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/config-set")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: false, code: "config-write-failed", message: 'Config field "http.account" is not volatile' };
        },
      };
    }
    return { ok: true, status: 200, async json() {
      return { ok: true, value: { available: false, configured: {}, fromEnv: {} } };
    } };
  };

  tree = rerender(react, Page, { view: "page", form });
  // 页面里不止一个「保存」（凭据区每个密码各有一个），要的是最底下那个整页保存。
  const saveButton = findAll(tree, (node) => node.type === "button" && (node.children ?? []).includes("保存")).pop();
  assert.ok(saveButton, "找不到保存按钮");
  await saveButton.props.onClick();

  const after = textOf(rerender(react, Page, { view: "page", form }));

  const posted = requests.find((item) => item.url.endsWith("/config-set"));
  assert.ok(posted, `保存没有走 /config-set；抓到的请求=${JSON.stringify(requests)}；页面文案=${after}`);
  assert.deepEqual(posted.body.ops, [{ op: "set", path: ["http", "account"], value: "huzihao" }]);
  assert.equal(posted.body.revision, 5);
  assert.match(after, /not volatile/, "页面要把宿主原话显示出来，别只说「保存失败」");
});

test("测试连接：把页面里没保存的草稿一起送过去", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const state = { status: "ready", writable: true, revision: 2, value: {} };
  const form = { state, mutate: async () => true };
  let tree = render(react, Page, { view: "page", form });
  findInputByLabel(tree, "禅道账号").props.onChange({ target: { value: "huzihao" } });

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init && init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, async json() {
      if (String(url).endsWith("/test")) {
        return { ok: true, value: { draft: true, db: { ready: true }, http: { ready: false, missing: ["ZENTAO_PASSWORD"] } } };
      }
      return { ok: true, value: { available: false, configured: {}, fromEnv: {} } };
    } };
  };

  tree = rerender(react, Page, { view: "page", form });
  await findButtonByText(tree, "测试连接").props.onClick();

  const posted = requests.find((item) => item.url.endsWith("/test"));
  assert.ok(posted, "测试连接没有走 /test");
  assert.equal(posted.body.overrides.http.account, "huzihao", "草稿里的账号没送过去，测试连接就等于白点");
});


/**
 * 回归：工作区里配了仓库时，分支链和子模块规则必须跟着那个仓库渲染。
 *
 * 之前这两块被写在 repos.map 外面，引用的是 map 回调里才有的 repo/repoIndex，
 * 渲染到工作区卡片就抛 ReferenceError —— 插件页的插槽边界把它吞了，
 * GUI 上表现为「配置页一片空白」，构建和测试全绿也看不出来。
 */
test("回归：工作区里配了仓库时，分支与子模块规则跟着仓库渲染", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const state = {
    status: "ready",
    writable: true,
    revision: 4,
    value: {
      targets: [
        {
          id: "demo-v2",
          name: "园区V2",
          path: "D:\\workspace\\demo-v2",
          repos: [
            {
              role: "web",
              path: "web",
              gitUrl: "git@example.com:park/web.git",
              branches: ["develop/v2.6", "release/v2.6"],
              submodules: [{ match: "acme-web-admin", branches: ["develop/v2.6-demo"] }],
            },
          ],
        },
      ],
    },
  };
  const form = { state, mutate: async () => true };
  const tree = render(react, Page, { view: "page", form });
  const text = textOf(tree);
  const values = findAll(tree, (node) => node.type === "input").map((node) => node.props.value);
  assert.ok(values.includes("园区V2"), `工作区卡片没渲染出来；非空输入框值=${JSON.stringify(values.filter(Boolean))}`);
  assert.ok(text.includes("分支（有序）"), "仓库的分支链没跟着仓库渲染");
  assert.ok(text.includes("子模块分支"), "子模块规则没跟着仓库渲染");
  assert.ok(text.includes("develop/v2.6-demo"), "子模块的分支链没渲染出来");

  // 配置里 targets 是数组、草稿里是 JSON 字符串：什么都没改就点保存，
  // 不能凭空提交一条 targets 改动（那等于把已配好的目标表按字符串写回去）。
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, async json() { return { ok: true, value: { revision: 5 } }; } };
  };
  const saved = rerender(react, Page, { view: "page", form });
  const saveButton = findAll(saved, (node) => node.type === "button" && (node.children ?? []).includes("保存")).pop();
  assert.ok(saveButton, "找不到保存按钮");
  await saveButton.props.onClick();
  const configSet = requests.find((item) => item.url.endsWith("/config-set"));
  const touchedTargets =
    configSet !== undefined && (configSet.body.ops ?? []).some((op) => JSON.stringify(op.path).includes("targets"));
  assert.ok(!touchedTargets, `没改任何东西却提交了 targets：${JSON.stringify(configSet && configSet.body)}`);
});

/**
 * 回归：页面加完分支点保存，targets 必须以**字符串**提交。
 *
 * 配置 schema 里 targets 是 `Schema.string()`（存 JSON 文本），桥接的 config-set
 * 只收标量。之前客户端把草稿 JSON.parse 成数组塞进 op.value，宿主原话回
 * 「配置项 targets 只接受标量」，加完分支永远保存不上。
 */
test("回归：加完分支保存时，targets 以 JSON 字符串提交", async () => {
  const { loaded, react } = await loadClient();
  const Page = mountPage(loaded);
  const state = {
    status: "ready",
    writable: true,
    revision: 7,
    value: {
      targets: [
        {
          id: "demo-v2",
          name: "园区V2",
          path: "D:\\workspace\\demo-v2",
          zentaoProjects: ["园区物管"],
          repos: [
            { role: "server", path: "server", gitUrl: "git@example.com:park/server.git", branches: ["develop/v2.6"] },
          ],
        },
      ],
    },
  };
  const form = { state, mutate: async () => true };
  let tree = render(react, Page, { view: "page", form });

  const branchInput = findAll(tree, (node) => node.type === "input" && node.props.value === "develop/v2.6")[0];
  assert.ok(branchInput, `找不到分支输入框；输入框值=${JSON.stringify(findAll(tree, (n) => n.type === "input").map((n) => n.props.value).filter(Boolean))}`);
  branchInput.props.onChange({ target: { value: "develop/v2.6.3" } });

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, async json() { return { ok: true, value: { revision: 8 } }; } };
  };
  const saved = rerender(react, Page, { view: "page", form });
  const saveButton = findAll(saved, (node) => node.type === "button" && (node.children ?? []).includes("保存")).pop();
  assert.ok(saveButton, "找不到保存按钮");
  await saveButton.props.onClick();

  const configSet = requests.find((item) => item.url.endsWith("/config-set"));
  assert.ok(configSet, `改动没有提交；页面文案=${textOf(saved)}`);
  const op = (configSet.body.ops ?? []).find((item) => JSON.stringify(item.path).includes("targets"));
  assert.ok(op, `提交里没有 targets：${JSON.stringify(configSet.body)}`);
  assert.equal(typeof op.value, "string", `targets 必须以字符串提交，实际是 ${typeof op.value}`);
  const parsed = JSON.parse(op.value);
  assert.equal(parsed[0].repos[0].branches[0], "develop/v2.6.3", "改过的分支没进提交内容");
});
