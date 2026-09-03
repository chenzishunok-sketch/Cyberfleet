import { describe, expect, it } from "vitest";
import { AGENT_CONTEXTS, DIGITAL_EMPLOYEES, getDigitalEmployee, isAgentContext } from "../shared/digital-employees.ts";

describe("Digital employees", () => {
  it("keeps one complete registry for chat contexts and employee cards", () => {
    expect(new Set(AGENT_CONTEXTS).size).toBe(AGENT_CONTEXTS.length);
    expect(DIGITAL_EMPLOYEES.map((employee) => employee.id)).toEqual([...AGENT_CONTEXTS]);
    expect(DIGITAL_EMPLOYEES.filter((employee) => employee.status !== "planned").every((employee) => employee.capabilities.length >= 3)).toBe(true);
  });

  it("recognizes every supported agent conversation context", () => {
    for (const context of AGENT_CONTEXTS) {
      expect(isAgentContext(context)).toBe(true);
      expect(getDigitalEmployee(context).id).toBe(context);
    }
  });

  it("rejects unknown legacy workspace names", () => {
    expect(isAgentContext("unknown")).toBe(false);
  });
});
