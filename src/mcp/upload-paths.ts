import { homedir } from "node:os";
import path from "node:path";

/* The two pure upload-path functions live in their own module and are not exported from the package
   entry point: they are implementation details of `spicyapi_upload_file`, split out only so the
   Windows path can be tested on macOS through `path.win32`. */

type PathApi = Pick<typeof path, "delimiter" | "sep" | "resolve">;

/**
 * Parses `SPICY_MCP_UPLOAD_ROOTS`.
 *
 * The separator is the platform's `path.delimiter` - `:` on POSIX, `;` on Windows - the same
 * convention as `PATH`. It used to be a hard-coded `:`, so on Windows `C:\Users\me\Pictures` was
 * cut into `C` and `\Users\me\Pictures`, neither of which matches any file: configuring it was the
 * same as not configuring it, and nothing reported that.
 */
export function splitUploadRoots(value: string, pathApi: PathApi = path): string[] {
  return value
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Expands a leading `~`.
 *
 * `~/` is expanded on every platform; `~\` only where the separator is a backslash, which is to say
 * on Windows - on POSIX a backslash is a legal filename character, and `~\x` does not mean "x in
 * the home directory".
 */
export function expandHomePath(
  input: string,
  home: string = homedir(),
  pathApi: PathApi = path,
): string {
  if (input.startsWith("~/") || (pathApi.sep === "\\" && input.startsWith("~\\"))) {
    return pathApi.resolve(home, input.slice(2));
  }
  return input;
}
