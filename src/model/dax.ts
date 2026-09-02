export type DaxSeverity = "error" | "warning" | "info";

export interface DaxToken {
  readonly type:
    | "column"
    | "identifier"
    | "number"
    | "operator"
    | "punctuation"
    | "quotedTable"
    | "string"
    | "other";
  readonly value: string;
  readonly position: number;
  readonly line: number;
}

export interface DaxFinding {
  readonly ruleId: "DL001" | "DL002" | "DL003" | "DL004" | "DL005" | "DL006" | "DL007" | "DL008";
  readonly severity: DaxSeverity;
  readonly blocking: boolean;
  readonly message: string;
  readonly suggestion: string;
  readonly line: number;
  readonly object: string | undefined;
}

export interface DaxReference {
  readonly table: string | undefined;
  readonly name: string | undefined;
  readonly kind: "table" | "qualified" | "unqualified";
  readonly line: number;
}

const severityRank: Readonly<Record<DaxSeverity, number>> = {
  error: 3,
  warning: 2,
  info: 1,
};

const daxKeywords = new Set([
  "ASC",
  "AT",
  "BLANK",
  "BY",
  "COLUMN",
  "DEFINE",
  "DESC",
  "EVALUATE",
  "FALSE",
  "IN",
  "MEASURE",
  "NOT",
  "ORDER",
  "RETURN",
  "START",
  "TABLE",
  "TRUE",
  "VAR",
]);

const knownDaxFunctions = new Set([
  "ABS",
  "ADDCOLUMNS",
  "ALL",
  "ALLEXCEPT",
  "ALLSELECTED",
  "AVERAGE",
  "AVERAGEX",
  "CALCULATE",
  "CALCULATETABLE",
  "CALENDAR",
  "CALENDARAUTO",
  "COALESCE",
  "CONCATENATE",
  "CONCATENATEX",
  "CONTAINS",
  "CONVERT",
  "COUNT",
  "COUNTA",
  "COUNTAX",
  "COUNTBLANK",
  "COUNTROWS",
  "COUNTX",
  "CROSSFILTER",
  "CROSSJOIN",
  "CURRENTGROUP",
  "DATE",
  "DATEADD",
  "DATEDIFF",
  "DATESBETWEEN",
  "DATESINPERIOD",
  "DATESMTD",
  "DATESQTD",
  "DATESYTD",
  "DAY",
  "DISTINCT",
  "DISTINCTCOUNT",
  "DIVIDE",
  "EARLIER",
  "EARLIEST",
  "ENDOFMONTH",
  "ENDOFQUARTER",
  "ENDOFYEAR",
  "ERROR",
  "EXCEPT",
  "FILTER",
  "FIRSTDATE",
  "FIRSTNONBLANK",
  "FORMAT",
  "GENERATE",
  "GENERATEALL",
  "GENERATESERIES",
  "GROUPBY",
  "HASONEFILTER",
  "HASONEVALUE",
  "IF",
  "IF.EAGER",
  "IFERROR",
  "INDEX",
  "INTERSECT",
  "ISBLANK",
  "ISERROR",
  "ISFILTERED",
  "ISINSCOPE",
  "ISNUMBER",
  "ISTEXT",
  "KEEPFILTERS",
  "LASTDATE",
  "LEFT",
  "LEN",
  "LOOKUPVALUE",
  "LOWER",
  "MAX",
  "MAXX",
  "MEDIAN",
  "MEDIANX",
  "MID",
  "MIN",
  "MINX",
  "MONTH",
  "NAMEOF",
  "NATURALINNERJOIN",
  "NATURALLEFTOUTERJOIN",
  "OFFSET",
  "PARALLELPERIOD",
  "PATH",
  "PATHCONTAINS",
  "PATHITEM",
  "PERCENTILE.EXC",
  "PERCENTILE.INC",
  "PERCENTILEX.EXC",
  "PERCENTILEX.INC",
  "PRODUCT",
  "PRODUCTX",
  "RANK",
  "RANK.EQ",
  "RANKX",
  "RELATED",
  "RELATEDTABLE",
  "REMOVEFILTERS",
  "REPLACE",
  "RIGHT",
  "ROLLUP",
  "ROUND",
  "ROW",
  "ROWNUMBER",
  "SAMEPERIODLASTYEAR",
  "SEARCH",
  "SELECTCOLUMNS",
  "SELECTEDMEASURE",
  "SELECTEDMEASUREFORMATSTRING",
  "SELECTEDMEASURENAME",
  "SELECTEDVALUE",
  "SUBSTITUTE",
  "SUM",
  "SUMMARIZE",
  "SUMMARIZECOLUMNS",
  "SUMX",
  "SWITCH",
  "TIME",
  "TODAY",
  "TOPN",
  "TOTALMTD",
  "TOTALQTD",
  "TOTALYTD",
  "TREATAS",
  "TRIM",
  "UNION",
  "UPPER",
  "USERELATIONSHIP",
  "USERNAME",
  "USEROBJECTID",
  "USERPRINCIPALNAME",
  "VALUE",
  "VALUES",
  "WINDOW",
  "YEAR",
]);

const aggregators = new Set([
  "AVERAGE",
  "AVERAGEX",
  "COUNT",
  "COUNTA",
  "COUNTROWS",
  "COUNTX",
  "DISTINCTCOUNT",
  "MAX",
  "MAXX",
  "MEDIAN",
  "MIN",
  "MINX",
  "PRODUCT",
  "SUM",
  "SUMX",
]);

const tmdlReservedWords = new Set([
  "annotation",
  "column",
  "expression",
  "false",
  "from",
  "hierarchy",
  "level",
  "measure",
  "null",
  "partition",
  "relationship",
  "table",
  "to",
  "true",
]);

const tmdlSimpleNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function needsTmdlQuoting(name: string): boolean {
  return !tmdlSimpleNamePattern.test(name) || tmdlReservedWords.has(name.toLowerCase());
}

export function quoteTmdlName(name: string): string {
  return needsTmdlQuoting(name) ? `'${name.replaceAll("'", "''")}'` : name;
}

export function unquoteTmdlName(name: string): string {
  return name.startsWith("'") && name.endsWith("'")
    ? name.slice(1, -1).replaceAll("''", "'")
    : name;
}

export function quoteDaxTableName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

export function quoteDaxObjectName(name: string): string {
  return `[${name.replaceAll("]", "]]")}]`;
}

export function daxColumnReference(table: string, column: string): string {
  return `${quoteDaxTableName(table)}${quoteDaxObjectName(column)}`;
}

export function daxMeasureReference(measure: string): string {
  return quoteDaxObjectName(measure);
}

const maskComments = (expression: string): string => {
  const characters = [...expression];
  let index = 0;
  while (index < characters.length) {
    if (characters[index] === '"') {
      index += 1;
      while (index < characters.length) {
        if (characters[index] === '"' && characters[index + 1] === '"') {
          index += 2;
        } else if (characters[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (characters[index] === "'") {
      index += 1;
      while (index < characters.length) {
        if (characters[index] === "'" && characters[index + 1] === "'") {
          index += 2;
        } else if (characters[index] === "'") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    const lineComment =
      (characters[index] === "/" && characters[index + 1] === "/") ||
      (characters[index] === "-" && characters[index + 1] === "-");
    if (lineComment) {
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }
    if (characters[index] === "/" && characters[index + 1] === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (
        index < characters.length &&
        !(characters[index] === "*" && characters[index + 1] === "/")
      ) {
        if (characters[index] !== "\n") {
          characters[index] = " ";
        }
        index += 1;
      }
      if (index < characters.length) {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    index += 1;
  }
  return characters.join("");
};

const tokenPattern =
  /"(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|\d+\.?\d*(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*|<=|>=|<>|\|\||&&|[-+*/^=<>&]|[(),]|\s+|./gu;

const tokenType = (value: string): DaxToken["type"] => {
  if (/^\s+$/u.test(value)) return "other";
  if (value.startsWith('"')) return "string";
  if (value.startsWith("'")) return "quotedTable";
  if (value.startsWith("[")) return "column";
  if (/^\d/u.test(value)) return "number";
  if (/^[A-Za-z_]/u.test(value)) return "identifier";
  if (/^(?:<=|>=|<>|\|\||&&|[-+*/^=<>&])$/u.test(value)) return "operator";
  if (/^[(),]$/u.test(value)) return "punctuation";
  return "other";
};

export function tokenizeDax(expression: string): readonly DaxToken[] {
  const text = maskComments(expression);
  const tokens: DaxToken[] = [];
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const type = tokenType(value);
    if (type === "other" && /^\s+$/u.test(value)) {
      continue;
    }
    const position = match.index;
    tokens.push({
      type,
      value,
      position,
      line: text.slice(0, position).split("\n").length,
    });
  }
  return tokens;
}

const isCall = (tokens: readonly DaxToken[], index: number): boolean =>
  tokens[index]?.type === "identifier" && tokens[index + 1]?.value === "(";

const argumentSpan = (
  tokens: readonly DaxToken[],
  openParenthesisIndex: number,
): readonly [number, number] => {
  let depth = 0;
  for (let index = openParenthesisIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") {
      depth -= 1;
      if (depth === 0) return [openParenthesisIndex + 1, index];
    }
  }
  return [openParenthesisIndex + 1, tokens.length];
};

const finding = (
  ruleId: DaxFinding["ruleId"],
  severity: DaxSeverity,
  message: string,
  suggestion: string,
  line: number,
  object: string | undefined,
  blocking = severity === "error",
): DaxFinding => ({ ruleId, severity, blocking, message, suggestion, line, object });

export function lintDax(expression: string, object?: string): readonly DaxFinding[] {
  if (expression.trim().length === 0) return [];
  const tokens = tokenizeDax(expression);
  const variableNames = new Set<string>();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index]?.type === "identifier" && tokens[index]?.value.toUpperCase() === "VAR") {
      const variable = tokens[index + 1];
      if (variable?.type === "identifier") variableNames.add(variable.value.toUpperCase());
    }
  }

  const findings: DaxFinding[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.type !== "identifier") {
      if (token.type === "operator" && token.value === "/") {
        findings.push(
          finding(
            "DL003",
            "warning",
            "Division with '/' does not guard against divide-by-zero.",
            "Use DIVIDE(numerator, denominator).",
            token.line,
            object,
          ),
        );
      }
      continue;
    }

    const functionName = token.value.toUpperCase();
    if (!isCall(tokens, index)) continue;
    const [start, end] = argumentSpan(tokens, index + 1);

    if (functionName === "CALCULATE" || functionName === "CALCULATETABLE") {
      for (let inner = start; inner < end; inner += 1) {
        const candidate = tokens[inner];
        if (!candidate) continue;
        if (
          candidate.type === "identifier" &&
          candidate.value.toUpperCase() === "FILTER" &&
          isCall(tokens, inner)
        ) {
          const [filterStart, filterEnd] = argumentSpan(tokens, inner + 1);
          if (
            filterStart < filterEnd &&
            ["identifier", "quotedTable"].includes(tokens[filterStart]?.type ?? "") &&
            tokens[filterStart + 1]?.value === ","
          ) {
            findings.push(
              finding(
                "DL001",
                "warning",
                "FILTER over an entire table inside CALCULATE materializes the table.",
                "Use a boolean predicate directly or filter a reduced column set.",
                candidate.line,
                object,
              ),
            );
          }
        }
        if (
          candidate.type === "identifier" &&
          ["CALCULATE", "CALCULATETABLE"].includes(candidate.value.toUpperCase()) &&
          isCall(tokens, inner)
        ) {
          findings.push(
            finding(
              "DL002",
              "info",
              "Nested CALCULATE introduces another context transition.",
              "Move reusable logic into variables or confirm the transition is intentional.",
              candidate.line,
              object,
            ),
          );
          break;
        }
      }
    }

    if (functionName === "IFERROR") {
      findings.push(
        finding(
          "DL004",
          "info",
          "IFERROR can hide the underlying calculation error.",
          "Prefer DIVIDE, COALESCE, or fix the root cause.",
          token.line,
          object,
        ),
      );
    }
    if (functionName === "EARLIER") {
      findings.push(
        finding(
          "DL006",
          "info",
          "EARLIER depends on an outer row context and can be difficult to reason about.",
          "Capture the outer value in a variable.",
          token.line,
          object,
        ),
      );
    }
    if (functionName === "SUMMARIZE") {
      for (let inner = start; inner < end; inner += 1) {
        const candidate = tokens[inner];
        if (
          candidate?.type === "identifier" &&
          aggregators.has(candidate.value.toUpperCase()) &&
          isCall(tokens, inner)
        ) {
          findings.push(
            finding(
              "DL007",
              "warning",
              "SUMMARIZE is being used to host an aggregation.",
              "Use SUMMARIZECOLUMNS or ADDCOLUMNS with an explicit context transition.",
              candidate.line,
              object,
            ),
          );
          break;
        }
      }
    }
    if (
      !knownDaxFunctions.has(functionName) &&
      !daxKeywords.has(functionName) &&
      !variableNames.has(functionName)
    ) {
      findings.push(
        finding(
          "DL008",
          "info",
          `'${token.value}' is not present in the local advisory DAX function catalog.`,
          "Check for a typo, then validate newer or user-defined functions against Fabric or Power BI.",
          token.line,
          object,
          false,
        ),
      );
    }
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current?.value === "+" && next?.type === "number" && Number(next.value) === 0) {
      findings.push(
        finding(
          "DL005",
          "info",
          "Adding zero forces BLANK results to zero.",
          "Remove '+ 0' unless zero output is explicitly required.",
          current.line,
          object,
        ),
      );
    }
  }

  return findings.sort(
    (left, right) =>
      severityRank[right.severity] - severityRank[left.severity] ||
      left.line - right.line ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

const unquoteTableToken = (value: string): string =>
  value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value;

const unquoteObjectToken = (value: string): string => value.slice(1, -1).replaceAll("]]", "]");

export function extractDaxReferences(
  expression: string,
  tableNames: readonly string[],
): readonly DaxReference[] {
  const tokens = tokenizeDax(expression);
  const knownTables = new Map(tableNames.map((name) => [name.toLowerCase(), name]));
  const references: DaxReference[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.type === "quotedTable") {
      const table = unquoteTableToken(token.value);
      const columnToken = tokens[index + 1];
      references.push({
        table,
        name: columnToken?.type === "column" ? unquoteObjectToken(columnToken.value) : undefined,
        kind: columnToken?.type === "column" ? "qualified" : "table",
        line: token.line,
      });
      continue;
    }
    if (token.type === "identifier") {
      const table = knownTables.get(token.value.toLowerCase());
      const columnToken = tokens[index + 1];
      if (table || columnToken?.type === "column") {
        references.push({
          table: table ?? token.value,
          name: columnToken?.type === "column" ? unquoteObjectToken(columnToken.value) : undefined,
          kind: columnToken?.type === "column" ? "qualified" : "table",
          line: token.line,
        });
      }
      continue;
    }
    if (
      token.type === "column" &&
      tokens[index - 1]?.type !== "quotedTable" &&
      tokens[index - 1]?.type !== "identifier"
    ) {
      references.push({
        table: undefined,
        name: unquoteObjectToken(token.value),
        kind: "unqualified",
        line: token.line,
      });
    }
  }

  return references;
}
