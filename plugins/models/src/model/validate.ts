// Validation against the published Event Modeling Specification schema
// (eventmodeling.schema.json, github.com/dilgerma/event-modeling-spec): what
// an export must pass, and what an import is checked against before it
// becomes a model. Compiled once — Ajv's compile is the slow part.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import schema from "./eventmodeling.schema.json";
import type { EventModel } from "./types";

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (compiled === null) {
    // The schema is draft-07, Ajv's default. Strict mode would refuse the
    // schema's `example` oneOf (a string or an object) as ambiguous.
    const ajv = new Ajv({ allErrors: true, strict: false });
    compiled = ajv.compile(schema as object);
  }
  return compiled;
}

/** One problem, as a path and what is wrong there. */
export interface SchemaProblem {
  path: string;
  message: string;
}

function describe(error: ErrorObject): SchemaProblem {
  const path = error.instancePath || "/";
  const extra =
    error.keyword === "additionalProperties"
      ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
      : error.keyword === "enum"
        ? ` (${(error.params as { allowedValues?: unknown[] }).allowedValues?.join(", ")})`
        : "";
  return { path, message: `${error.message ?? "invalid"}${extra}` };
}

/**
 * Every way `model` strays from the schema, empty when it is valid. A file's
 * `model` half is what this checks — the layout and links beside it are
 * SpecDriven's own.
 */
export function schemaProblems(model: unknown): SchemaProblem[] {
  const validate = validator();
  if (validate(model)) return [];
  return (validate.errors ?? []).map(describe);
}

export function isSchemaValid(model: unknown): model is EventModel {
  return schemaProblems(model).length === 0;
}
