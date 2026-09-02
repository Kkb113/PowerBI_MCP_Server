import { describe, expect, it } from "vitest";
import {
  daxColumnReference,
  daxMeasureReference,
  extractDaxReferences,
  lintDax,
  needsTmdlQuoting,
  quoteDaxObjectName,
  quoteDaxTableName,
  quoteTmdlName,
  tokenizeDax,
  unquoteTmdlName,
} from "../../../src/model/index.js";

describe("DAX and TMDL name quoting", () => {
  it("escapes apostrophes, closing brackets, spaces, Unicode, and reserved words", () => {
    expect(quoteDaxTableName("Customer's")).toBe("'Customer''s'");
    expect(quoteDaxObjectName("Margin] Δ")).toBe("[Margin]] Δ]");
    expect(daxColumnReference("Sales Data", "Net Amount")).toBe("'Sales Data'[Net Amount]");
    expect(daxMeasureReference("Revenue Δ")).toBe("[Revenue Δ]");
    expect(needsTmdlQuoting("table")).toBe(true);
    expect(needsTmdlQuoting("Sales Data")).toBe(true);
    expect(needsTmdlQuoting("Sales_Data")).toBe(false);
    expect(quoteTmdlName("Customer's")).toBe("'Customer''s'");
    expect(unquoteTmdlName("'Customer''s'")).toBe("Customer's");
    expect(unquoteTmdlName("Sales")).toBe("Sales");
  });
});

describe("DAX tokenizer and reference extraction", () => {
  it("preserves real references while ignoring comments and strings", () => {
    const dax = `// 'Ignored'[Value]\nVAR Label = "[Also Ignored]"\nRETURN SUM('Customer''s'[Amount]) + Missing[Value] + [Revenue Δ]`;
    const tokens = tokenizeDax(dax);
    expect(tokens.some((token) => token.value === "'Customer''s'")).toBe(true);
    expect(
      tokens.some((token) => token.type === "quotedTable" && token.value.includes("Ignored")),
    ).toBe(false);

    expect(extractDaxReferences(dax, ["Customer's"])).toEqual([
      { kind: "qualified", line: 3, name: "Amount", table: "Customer's" },
      { kind: "qualified", line: 3, name: "Value", table: "Missing" },
      { kind: "unqualified", line: 3, name: "Revenue Δ", table: undefined },
    ]);
  });

  it("recognizes known bare table references and block comments", () => {
    const references = extractDaxReferences("/* Sales[Ignored] */ COUNTROWS(Sales)", ["Sales"]);
    expect(references).toEqual([{ kind: "table", line: 1, name: undefined, table: "Sales" }]);
  });
});

describe("DAX lint", () => {
  it.each([
    ["DL001", "CALCULATE([Revenue], FILTER('Sales Data', 'Sales Data'[Amount] > 0))"],
    ["DL002", "CALCULATE(CALCULATE([Revenue]))"],
    ["DL003", "[Revenue] / [Orders]"],
    ["DL004", "IFERROR([Revenue], 0)"],
    ["DL005", "[Revenue] + 0"],
    ["DL006", "EARLIER('Sales Data'[Amount])"],
    ["DL007", "SUMMARIZE('Sales Data', 'Sales Data'[Order ID], \"R\", SUM('Sales Data'[Amount]))"],
    ["DL008", "SUUM('Sales Data'[Amount])"],
  ] as const)("reports %s", (ruleId, expression) => {
    expect(lintDax(expression, "Test").map((finding) => finding.ruleId)).toContain(ruleId);
  });

  it("does not lint operators or function names inside comments and strings", () => {
    expect(lintDax('VAR Text = "IFERROR / + 0"\n// SUUM()\nRETURN DIVIDE(4, 2)')).toEqual([]);
  });

  it.each([
    ["newer Microsoft function", "TABLEOF('Sales Data'[Amount])"],
    ["user-defined function", "Contoso.Analytics.Adjust([Revenue])"],
  ])("keeps DL008 non-blocking for a %s", (_description, expression) => {
    const findings = lintDax(expression);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "DL008", severity: "info", blocking: false });
    expect(findings[0]?.message).toContain("local advisory DAX function catalog");
  });

  it("sorts findings by severity and handles incomplete calls", () => {
    const findings = lintDax("IFERROR([Revenue] / 0, 0) + 0\nCALCULATE(");
    expect(findings.map((finding) => finding.ruleId)).toEqual(["DL003", "DL004", "DL005"]);
    expect(findings.every((finding) => !finding.blocking)).toBe(true);
    expect(lintDax("   ")).toEqual([]);
  });
});
