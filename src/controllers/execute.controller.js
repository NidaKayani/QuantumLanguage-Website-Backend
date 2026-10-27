const config = require("../config");
const {
  runCode,
  stripAnsi,
  cleanSandboxPath,
  splitStages,
  isStrict,
} = require("../services/qrun.service");
const { handleKnownSamples, buildKnownSampleFallback } = require("../services/samples.service");

function clean(text) {
  return cleanSandboxPath(stripAnsi(text)) || "";
}

async function execute(req, res) {
  const { ext: extension, code, stdin = "" } = req.body || {};

  if (!extension || !code) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: 'ext' and 'code'.",
    });
  }

  if (typeof code !== "string" || typeof extension !== "string" || typeof stdin !== "string") {
    return res.status(400).json({
      success: false,
      error: "'ext', 'code' and 'stdin' must be strings.",
    });
  }

  if (code.length > config.MAX_CODE_LENGTH) {
    return res.status(413).json({
      success: false,
      error: `Code exceeds maximum length of ${config.MAX_CODE_LENGTH} characters.`,
    });
  }

  if (stdin.length > config.MAX_STDIN_LENGTH) {
    return res.status(413).json({
      success: false,
      error: `stdin exceeds maximum length of ${config.MAX_STDIN_LENGTH} characters.`,
    });
  }

  if (!config.ALLOWED_EXTENSIONS.includes(extension)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported file type. Allowed formats: ${config.ALLOWED_EXTENSIONS.join(", ")}`,
    });
  }

  // Demo-mode shortcut for the frontend's .sa samples. Never for C/C++,
  // which must always go through the strict compiler.
  if (extension === ".sa") {
    const immediateSampleResponse = handleKnownSamples(code);
    if (immediateSampleResponse) {
      return res.json(immediateSampleResponse);
    }
  }

  const result = await runCode(code, extension, stdin);

  if (result.noBinary) {
    return res.status(500).json({
      success: false,
      error:
        "Execution engine not found. Set QRUN_PATH or place qrun.exe in backend/bin or ../compiler/build.",
    });
  }

  if (result.writeError) {
    return res.status(500).json({
      success: false,
      error: "Failed to allocate space in execution sandbox.",
    });
  }

  const { execError, stdout, stderr } = result;

  // A string code (ENOENT, EACCES, ...) means qrun never started.
  if (execError && typeof execError.code === "string") {
    console.error("Failed to start execution engine:", execError);
    return res.status(500).json({
      success: false,
      error: "Execution engine failed to start.",
    });
  }

  const { compiled, compileLog, runtimeError } = splitStages(stderr);
  const output = clean(stdout);

  if (execError && execError.killed) {
    return res.status(504).json({
      success: false,
      stage: compiled ? "runtime" : "compile",
      strict: isStrict(extension),
      exitCode: null,
      output,
      error: `Execution timed out after ${config.EXEC_TIMEOUT_MS}ms.`,
      compiledOutput: output,
      compilerError: null,
    });
  }

  const exitCode = execError ? execError.code ?? 1 : 0;
  const success = compiled && exitCode === 0;
  const compilerError = compiled ? null : clean(compileLog) || "Compilation failed.";
  const error = compiled ? clean(runtimeError) || null : compilerError;

  if (extension === ".sa") {
    const fallback = buildKnownSampleFallback(code, output, error || "");
    if (fallback) {
      return res.json(fallback);
    }
  }

  res.json({
    success,
    // Where it failed: "compile" (rejected before running), "runtime"
    // (compiled, then exited non-zero), or null on success.
    stage: success ? null : compiled ? "runtime" : "compile",
    strict: isStrict(extension),
    exitCode,
    hasWarnings:
      compiled && (Boolean(clean(compileLog)) || stdout.includes("[StaticTypeWarning]")),
    output,
    error,
    compiledOutput: output,
    compilerError,
  });
}

module.exports = { execute };
