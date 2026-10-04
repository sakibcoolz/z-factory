import "server-only";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { DomainError } from "@/lib/domain/errors";

/**
 * Compiles IEC 61131-3 Structured Text to the C++ sources the OpenPLC Runtime v4 builds.
 * The STruC++ compiler runs in a short-lived child process with a time and memory cap;
 * program text is untrusted input and never reaches a shell.
 */

const WORKER_PATH = join(process.cwd(), "lib/runtimes/openplc/strucpp-worker.mjs");
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Programs are text; anything beyond this is not a PLC program. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

const diagnosticSchema = z.object({
  message: z.string(),
  line: z.number(),
  column: z.number(),
  severity: z.enum(["error", "warning"]),
});

const workerOutputSchema = z.object({
  success: z.boolean(),
  compilerVersion: z.string().nullable(),
  md5: z.string().nullable(),
  errors: z.array(diagnosticSchema),
  warnings: z.array(diagnosticSchema),
  files: z.record(z.string(), z.string()),
});

export type CompileDiagnostic = z.infer<typeof diagnosticSchema>;

export type CompileResult =
  | {
      success: true;
      compilerVersion: string;
      /** MD5 of the source; the runtime reports it back for the loaded program. */
      md5: string;
      /** Generated sources and runtime headers, keyed by path inside the upload bundle. */
      files: Record<string, string>;
      warnings: CompileDiagnostic[];
    }
  | { success: false; errors: CompileDiagnostic[]; warnings: CompileDiagnostic[] };

function runWorker(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--max-old-space-size=512", WORKER_PATH],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        // The worker reports compile failures as JSON on stdout with a non-zero exit code.
        if (stdout) resolve(stdout);
        else reject(error ?? new Error("empty compiler output"));
      },
    );
    child.stdin?.end(source);
  });
}

export async function compileStructuredText(source: string): Promise<CompileResult> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new DomainError("VALIDATION", "The program source is too large.", { rule: "program-size" });
  }

  let raw: string;
  try {
    raw = await runWorker(source);
  } catch {
    throw new DomainError("RUNTIME_FAILURE", "The Structured Text compiler could not be run.", {
      rule: "compiler-unavailable",
    });
  }

  const parsed = workerOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new DomainError("RUNTIME_FAILURE", "The Structured Text compiler returned an unexpected result.", {
      rule: "compiler-output",
    });
  }
  const output = parsed.data;
  if (!output.success || !output.md5 || !output.compilerVersion) {
    return { success: false, errors: output.errors, warnings: output.warnings };
  }
  return {
    success: true,
    compilerVersion: output.compilerVersion,
    md5: output.md5,
    files: output.files,
    warnings: output.warnings,
  };
}
