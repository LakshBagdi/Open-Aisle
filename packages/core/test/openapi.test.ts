/**
 * The Merchant API's OpenAPI file is what APIMatic generates SDKs from, so it
 * must be valid and must match the real routes, method for method.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const web = join(__dirname, "../../../apps/web");
const specPath = join(web, "public/openapi.yaml");

describe("openapi.yaml", () => {
  it("is a valid OpenAPI document", async () => {
    await expect(SwaggerParser.validate(specPath)).resolves.toBeTruthy();
  });

  it("every path and method has a route handler, and every v1 route is documented", () => {
    const spec = parse(readFileSync(specPath, "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      const file = join(web, "app/api/v1", path.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
      expect(existsSync(file), `${path} → ${file}`).toBe(true);
      const src = readFileSync(file, "utf8");
      for (const method of Object.keys(ops)) {
        expect(src, `${method.toUpperCase()} ${path}`).toMatch(new RegExp(`export async function ${method.toUpperCase()}\\b`));
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(documented.size).toBe(10);
  });
});

describe("APIMatic copy", () => {
  it("apimatic/src/spec/openapi.yaml is the same file the app serves", () => {
    const copy = readFileSync(join(__dirname, "../../../apimatic/src/spec/openapi.yaml"), "utf8");
    expect(copy, "run: cp apps/web/public/openapi.yaml apimatic/src/spec/openapi.yaml").toBe(readFileSync(specPath, "utf8"));
  });
});
