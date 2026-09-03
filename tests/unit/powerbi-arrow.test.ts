import { CompressionType, tableFromArrays, tableToIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { parseExecuteDaxArrowResponse } from "../../src/clients/powerbi-arrow.js";

const concatenate = (...values: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
};

const encode = (columns: Record<string, readonly unknown[]>): Uint8Array =>
  tableToIPC(tableFromArrays(columns), "stream", CompressionType.LZ4_FRAME);

describe("Power BI Arrow response parser", () => {
  it("decodes compressed concatenated rowsets and applies null projection", () => {
    const bytes = concatenate(
      encode({ "[Count]": [1, 2], "[Optional]": [null, "present"] }),
      encode({ "[Label]": ["second"] }),
    );

    expect(parseExecuteDaxArrowResponse(bytes, false)).toEqual({
      results: [
        { tables: [{ rows: [{ "[Count]": 1 }, { "[Count]": 2, "[Optional]": "present" }] }] },
        { tables: [{ rows: [{ "[Label]": "second" }] }] },
      ],
    });
  });

  it("preserves requested nulls and converts unsafe integers to lossless strings", () => {
    const bytes = encode({
      "[Optional]": [null],
      "[Large]": [BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    });

    expect(parseExecuteDaxArrowResponse(bytes, true)).toEqual({
      results: [
        {
          tables: [{ rows: [{ "[Optional]": null, "[Large]": "9007199254740992" }] }],
        },
      ],
    });
  });

  it("maps Arrow error rowsets into the stable DAX error contract", () => {
    const table = tableFromArrays({
      ErrorCode: ["DAXQueryFailure"],
      ErrorMessage: ["The measure does not exist."],
    });
    table.schema.metadata.set("IsError", "true");
    table.schema.metadata.set("FaultCode", "0xC1210000");
    table.schema.metadata.set("FaultString", "DAX query failed.");

    expect(
      parseExecuteDaxArrowResponse(tableToIPC(table, "stream", CompressionType.LZ4_FRAME), false),
    ).toEqual({
      results: [{ error: { code: "0xC1210000", message: "DAX query failed." } }],
    });
  });

  it("rejects an empty response", () => {
    expect(() => parseExecuteDaxArrowResponse(new Uint8Array(), false)).toThrow(
      "Power BI returned no Arrow result streams.",
    );
  });
});
