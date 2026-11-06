/**
 * 把三个禅道 skill 作为**随插件发布的 bundled skill** 注册进 DSH 技能表。
 *
 * 为什么不是让用户自己往 `~/.dsh/skills/` 里拷：那样装一次插件还得手工搬 7 个文件，
 * 而这三个 skill 依赖的正是本插件的 `zentao_*` 工具。打进包里之后 `npm i dsh-life-saver`
 * 就有全套。
 *
 * 三份 SKILL.md 放在包内 `assets/skills/<name>/SKILL.md`，随 `files` 字段一起发布；
 * `resourceBase` 指向该目录，模型拿到的 `<skill_resources>` 就是它，脚本于是能用
 * `<base>/scripts/xxx.py` 这种路径直接跑。
 *
 * 优先级：`BUNDLED_SKILL_RANK`（600）比用户级 `~/.dsh/skills`（400）**低**，
 * 所以本机已经存过同名 skill 的用户，用的还是他自己那份——插件版只是给人一个
 * 开箱可用的默认值，不会顶掉用户的改动。
 */

import { readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/** 随包发布的 skill 名（kebab-case，必须与 `assets/skills/` 下的目录同名）。 */
const SKILL_NAMES = [
  "zentao-extract",
  "zentao-change-assignee-scrub-trace",
  "zentao-weekly-report",
] as const;

/** 本 provider 在技能表里的名字（同一层内唯一，`candidate.provider` 必须与它一致）。 */
const PROVIDER_NAME = "dsh-life-saver";

/**
 * 打包技能的固定优先级。
 *
 * 等同 `@deepseek-ai/dsh-skill` 导出的 `BUNDLED_SKILL_RANK`；这里写字面量是为了
 * **不在运行期 import 那个包**——插件在 profile 里是 link 安装，宿主把 dsh-skill
 * 打在 app.asar 内部，import 进来反而可能解析不到。数字变了也不影响语义：
 * 只要它大于用户级 400，用户自己的同名 skill 就继续优先。
 */
const BUNDLED_RANK = 600;

/** 技能表 registry 的窄接口（类型由 dsh-skill 声明，本插件不依赖它做编译检查）。 */
export interface SkillCandidateLike {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  provider: string;
  source: string;
  rank: number;
  resourceBase: { kind: "directory"; path: string };
  locator: string;
}

interface SkillDefinitionLike {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  provider: string;
  source: string;
  resourceBase?: { kind: "directory"; path: string };
  content: string;
}

interface SkillProviderLike {
  name: string;
  list(options: { signal?: AbortSignal }): Promise<SkillCandidateLike[]>;
  get(candidate: SkillCandidateLike, options: { signal?: AbortSignal }): Promise<SkillDefinitionLike>;
}

/** `ctx.skills` 的最小形状。 */
export interface SkillRegistryLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => SkillProviderLike): () => void;
}

/** frontmatter 解析结果。 */
interface ParsedSkill {
  description: string;
  whenToUse?: string;
  content: string;
}

/**
 * 切 frontmatter 取 `description` / `whenToUse`，正文即 frontmatter 之后的部分。
 *
 * 正则和取值口径与官方 `dsh-skill-office` 的实现保持一致（它也只认 `description`），
 * 免得两边对同一份 SKILL.md 解析出不同结果。
 */
export function parseSkill(raw: string, path: string): ParsedSkill {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (frontmatter?.[1] === undefined) {
    throw new Error(`dsh-life-saver: ${path} 缺少 YAML frontmatter`);
  }
  const metadata: unknown = parseYaml(frontmatter[1]);
  const record = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const description = record.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`dsh-life-saver: ${path} 缺少 description`);
  }
  const whenToUse = typeof record.whenToUse === "string" ? record.whenToUse : undefined;
  const content = raw.slice(frontmatter[0].length).trim();
  return whenToUse === undefined ? { description, content } : { description, whenToUse, content };
}

/**
 * 扫描 `assets/skills/` 生成 candidate 列表。
 *
 * 某个 skill 目录缺失/坏掉只跳过它自己并记一条 warn，不连累其它 skill，更不连累插件本身
 * （少一个技能不该让整插件起不来）。
 */
export function buildCandidates(
  assetRoot: string,
  logger: { warn(message: string): void },
): SkillCandidateLike[] {
  const candidates: SkillCandidateLike[] = [];
  for (const skillName of SKILL_NAMES) {
    const directory = join(assetRoot, skillName);
    const locator = join(directory, "SKILL.md");
    try {
      if (!statSync(locator).isFile()) throw new Error("不是文件");
      const parsed = parseSkill(readFileSync(locator, "utf8"), locator);
      candidates.push({
        name: skillName,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: "bundled",
        rank: BUNDLED_RANK,
        // 技能资源目录统一用 `/`：Windows 反斜杠会让模型拼出来的路径看着像转义。
        resourceBase: { kind: "directory", path: directory.split(sep).join("/") },
        locator,
      });
    } catch (error) {
      logger.warn(`跳过 skill ${skillName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return candidates;
}

/**
 * 造一个 provider 对象（`registerProvider` 的工厂返回值）。
 *
 * `list()` 返回上面扫出来的 candidate；`get()` 现读 SKILL.md 正文——candidate 里只有
 * 摘要，正文按需加载，列表刷新时不用把三份文档都读一遍。
 */
export function makeSkillProvider(
  assetRoot: string,
  logger: { warn(message: string): void },
): SkillProviderLike {
  const candidates = buildCandidates(assetRoot, logger);
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      const { rank: _rank, locator, ...summary } = candidate;
      const { content } = parseSkill(readFileSync(locator, "utf8"), locator);
      return { ...summary, content };
    },
  };
}

/** 技能资产根目录的绝对路径（`lib/skills/index.js` → 包根 `assets/skills/`）。 */
export function defaultAssetRoot(): string {
  return fileURLToPath(new URL("../../assets/skills/", import.meta.url));
}

/**
 * 注册 provider。
 *
 * @param ctx 带 `skills` 的上下文
 * @param assetRoot 可选：打包应用里用外部资源目录覆盖
 */
export function registerSkills(
  ctx: { skills: SkillRegistryLike },
  logger: { warn(message: string): void },
  assetRoot: string = defaultAssetRoot(),
): () => void {
  return ctx.skills.registerProvider(() => makeSkillProvider(assetRoot, logger));
}
