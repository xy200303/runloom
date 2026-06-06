import { describe, expect, it } from "vitest";
import { RunloomError, SecurityError } from "../src/index.js";
import { emitLog } from "../src/observability/logger.js";
import type { RunloomLogRecord } from "../src/index.js";

describe("observability", () => {
  it("serializes categorized runloom errors", () => {
    const error = new SecurityError("Path is outside the workspace: ../secret.txt", {
      code: "security.path.outside_workspace",
      details: {
        requestedPath: "../secret.txt"
      }
    });

    expect(error).toBeInstanceOf(RunloomError);
    expect(error.category).toBe("security");
    expect(error.code).toBe("security.path.outside_workspace");
    expect(error.toJSON()).toMatchObject({
      name: "SecurityError",
      category: "security",
      code: "security.path.outside_workspace",
      message: "Path is outside the workspace: ../secret.txt"
    });
  });

  it("redacts structured log records before handing them to the logger", () => {
    const workspace = "C:\\Users\\tester\\project";
    const records: RunloomLogRecord[] = [];

    emitLog(
      {
        log(record) {
          records.push(record);
        }
      },
      {
        level: "info",
        code: "test.log",
        message: "A structured log record.",
        details: {
          workspace,
          apiKey: "plain-json-secret",
          output: `OPENAI_API_KEY=sk-unitsecret1234567890 in ${workspace}`
        }
      },
      workspace
    );

    const serialized = JSON.stringify(records);
    expect(records[0]?.source).toBe("runtime");
    expect(serialized).not.toContain("plain-json-secret");
    expect(serialized).not.toContain("sk-unitsecret1234567890");
    expect(serialized).not.toContain(workspace);
    expect(serialized).toContain("[workspace]");
    expect(serialized).toContain("[redacted:secret]");
  });
});
