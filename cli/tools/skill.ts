// skill 工具(Q80,skills.load = tool 时装上):模型点名一个技能,正文作为工具结果返回。
// 与缺省的 read 路线相比,多一个工具定义占 token,少一次"猜路径"的往返;哪种更好留给对照实验。
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { expandSkill, type Skill } from "../prompt.js";

export function createSkillTool(skills: Skill[]) {
  const usable = skills.filter((s) => !s.disableModelInvocation);
  const names = usable.map((s) => s.name);
  const lines = usable.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  return defineTool({
    name: "skill",
    description: `Load a skill's instructions (its SKILL.md) into context and follow them. Available:\n${lines.join("\n")}`,
    parameters: Type.Object({
      name: Type.Union(
        names.map((n) => Type.Literal(n)),
        { description: "skill name" },
      ),
      args: Type.Optional(Type.String({ description: "arguments for the skill, if it takes any" })),
    }),
    concurrency: "parallel",
    async execute(a) {
      const s = usable.find((x) => x.name === a.name);
      if (!s) throw new Error(`unknown skill "${a.name}"; available: ${names.join(", ")}`);
      return expandSkill(s, a.args ?? "");
    },
  });
}
