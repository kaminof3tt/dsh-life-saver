/**
 * 工具规格：名字、中文描述、参数表。
 *
 * 为什么在 core 而不在各壳里：这段中文是**模型真正读的提示词**。两个壳（DSH 插件 /
 * MCP 服务器）各写一份的话，改一个忘一个，模型看到的就是两套互相矛盾的说法——历史上
 * 就发生过「fixed 在工具描述里叫已修复、在历史记录里叫已解决」。
 *
 * 这里只放「说什么」，不放「怎么做」：两个壳各自把 spec 翻译成自己的注册格式
 * （DSH 的 `parameters`、MCP 的 `inputSchema`），执行逻辑在各自的 execute 里。
 */

/** 参数的类型。够用即可，不追求 JSON Schema 全集。 */
export type ToolPropertyType = "string" | "number" | "integer" | "boolean";

/** 一个参数的声明。`required` 只在为 true 时出现，方便壳直接展开。 */
export interface ToolPropertySpec {
  readonly type: ToolPropertyType;
  readonly description: string;
  readonly enum?: readonly string[];
  readonly required?: boolean;
}

/** 一个工具的规格。`properties` 保持声明顺序：MCP 客户端按这个顺序给模型看。 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, ToolPropertySpec>>;
}

/** 必填参数名，按声明顺序。 */
export function requiredOf(spec: ToolSpec): string[] {
  return Object.entries(spec.properties)
    .filter(([, property]) => property.required === true)
    .map(([name]) => name);
}

/**
 * 转成 MCP 的 `inputSchema`。
 *
 * 返回可变副本：SDK 会把它原样 JSON 序列化发给客户端，只读类型在那边不好用。
 */
export function jsonSchemaOf(spec: ToolSpec): {
  type: "object";
  properties: Record<string, { type: ToolPropertyType; description: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
} {
  const properties: Record<string, { type: ToolPropertyType; description: string; enum?: string[] }> = {};
  for (const [name, property] of Object.entries(spec.properties)) {
    properties[name] = property.enum
      ? { type: property.type, description: property.description, enum: [...property.enum] }
      : { type: property.type, description: property.description };
  }
  const required = requiredOf(spec);
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * 转成 DSH `defineTool` 的 `parameters` 形状。
 *
 * 那个形状就是「参数名 → 声明」的平表，`required` 作为布尔字段挂在声明上，
 * 与这里的 `ToolPropertySpec` 结构一致，所以只需要做一次可变拷贝。
 */
export function parametersOf(spec: ToolSpec): Record<string, ToolPropertySpec> {
  return { ...spec.properties };
}
