/**
 * 把 core 的工具规格翻译成 DSH 的 `parameters` 形状。
 *
 * core 里的 `ToolPropertySpec` 是中立描述（type/description/enum/required），
 * 这里按判别字段逐支收窄成 `ParameterPropertySpec`——一个 `as` 都不用写，
 * 类型错了编译器直接报出来。MCP 侧走的是 `jsonSchemaOf`，另一条路。
 */

import type {
  BooleanValueSchemaSpec,
  IntegerValueSchemaSpec,
  NumberValueSchemaSpec,
  ParameterSchemaSpec,
  StringValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import type { ToolSpec } from "life-saver-core";

type Property = StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec | BooleanValueSchemaSpec;

function propertyOf(source: ToolSpec["properties"][string]): Property {
  const required = source.required === true ? { required: true as const } : {};
  switch (source.type) {
    case "string":
      return { type: "string", description: source.description, ...(source.enum ? { enum: source.enum } : {}), ...required };
    case "number":
      return { type: "number", description: source.description, ...required };
    case "integer":
      return { type: "integer", description: source.description, ...required };
    case "boolean":
      return { type: "boolean", description: source.description, ...required };
  }
}

export function parametersOf(spec: ToolSpec): ParameterSchemaSpec {
  const parameters: Record<string, Property> = {};
  for (const [name, property] of Object.entries(spec.properties)) parameters[name] = propertyOf(property);
  return parameters;
}
