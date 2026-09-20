import fs from "node:fs/promises";
import { URL } from "node:url";

// The version is maintained in package.json alone; the build emits a constant so the client never
// reads a file at runtime.
const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
  throw new Error("package.json must declare a version");
}

const directory = new URL("../src/generated/", import.meta.url);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(
  new URL("package-version.ts", directory),
  "// Generated from package.json at build time. Not maintained by hand, and not committed.\n" +
    `export const MCP_VERSION = ${JSON.stringify(manifest.version)};\n`,
);
