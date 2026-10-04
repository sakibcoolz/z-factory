/**
 * STruC++ compile worker. Runs as a separate Node.js process, never inside the
 * Z-Factory server: it reads Structured Text from stdin and prints one JSON document
 * with the generated C++ sources (or the diagnostics) to stdout.
 *
 * STruC++ is GPL-3.0-or-later. Keeping it behind this process boundary means the server
 * only exchanges data with it (ADR-0008).
 *
 * The compile options mirror the OpenPLC Editor's runtime-v4 build pipeline
 * (`runProgramBuildPipeline` / `composeRuntimeV4Bundle`); the runtime will not load a
 * program built without the debug tables.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const STANDARD_LIBRARIES = ["iec-std-functions.stlib", "iec-standard-fb.stlib", "additional-function-blocks.stlib"];

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const toDiagnostic = (diagnostic) => ({
  message: String(diagnostic.message ?? ""),
  line: Number(diagnostic.line ?? 0),
  column: Number(diagnostic.column ?? 0),
  severity: diagnostic.severity === "warning" ? "warning" : "error",
});

async function main() {
  const source = await readStdin();
  const strucpp = await import("strucpp");
  const packageDir = dirname(createRequire(import.meta.url).resolve("strucpp/package.json"));

  const libraries = STANDARD_LIBRARIES.map((file) =>
    strucpp.loadStlibFromBuffer(readFileSync(join(packageDir, "libs", file))),
  );
  const md5 = createHash("md5").update(source).digest("hex");

  const result = strucpp.compile(source, {
    headerFileName: "generated.hpp",
    fileName: "program.st",
    debug: true,
    lineMapping: true,
    libraries,
    md5,
    pouIncludes: [],
  });

  const output = {
    success: Boolean(result.success),
    compilerVersion: strucpp.getVersion(),
    md5,
    errors: (result.errors ?? []).map(toDiagnostic),
    warnings: (result.warnings ?? []).map(toDiagnostic),
    files: {},
  };

  if (result.success) {
    if (result.cppFiles?.length) {
      for (const file of result.cppFiles) output.files[file.name] = file.content;
    } else {
      output.files["generated.cpp"] = result.cppCode;
    }
    output.files["generated.hpp"] = result.headerCode;
    if (result.debugTableCpp !== undefined) output.files["generated_debug.cpp"] = result.debugTableCpp;
    if (result.debugMap !== undefined) output.files["debug-map.json"] = JSON.stringify(result.debugMap, null, 2);

    const includeDir = join(packageDir, "src/runtime/include");
    for (const header of readdirSync(includeDir)) {
      output.files[`strucpp_runtime/include/${header}`] = readFileSync(join(includeDir, header), "utf8");
    }
  }

  process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      success: false,
      compilerVersion: null,
      md5: null,
      errors: [
        { message: `Compiler failure: ${String(error?.message ?? error)}`, line: 0, column: 0, severity: "error" },
      ],
      warnings: [],
      files: {},
    }),
  );
  process.exitCode = 1;
});
