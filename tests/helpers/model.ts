import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bimToModelSpec,
  modelBimSchema,
  type ModelBim,
  type ModelSpec,
} from "../../src/model/index.js";

const fixtureUrl = new URL("../fixtures/semantic-model/model.bim", import.meta.url);

export function loadModelBimFixture(): ModelBim {
  return modelBimSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as unknown,
  );
}

export function loadModelFixture(): ModelSpec {
  return bimToModelSpec(loadModelBimFixture());
}
