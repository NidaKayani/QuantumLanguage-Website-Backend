const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

fs.mkdirSync(config.SANDBOX_DIR, { recursive: true });

// Written to stderr by `qrun --stage-marker` once the program has compiled
// (src/include/Cli.h.sa in the compiler). Anything before it is compiler
// output; anything after comes from the running program.
const STAGE_MARKER = "\u001e[quantum:compiled]\u001e";

let cachedQrunPath = null;

// Search known locations for the qrun binary. Cached once found.
function resolveQrunPath() {
  if (cachedQrunPath && fs.existsSync(cachedQrunPath)) return cachedQrunPath;

  const candidates = [
    process.env.QRUN_PATH,
    path.resolve(__dirname, "..", "..", "bin", "qrun.exe"),
    // build\ first, like compiler/qrun.bat: it holds the freshest build.
    path.resolve(__dirname, "..", "..", "..", "compiler", "build", "qrun.exe"),
    path.resolve(__dirname, "..", "..", "..", "compiler", "qrun.exe"),
    path.resolve(__dirname, "..", "..", "..", "QuantumLanguage", "build", "qrun.exe"),
    path.resolve(__dirname, "..", "..", "..", "QuantumLanguage", "build", "qrun.bat"),
    path.resolve(__dirname, "..", "..", "..", "QuantumLanguage", "build", "qrun"),
    path.resolve(__dirname, "..", "..", "..", "QuantumLanguage", "qrun.exe"),
    path.resolve(__dirname, "..", "..", "..", "QuantumLanguage", "qrun.bat"),
    path.resolve(__dirname, "..", "..", "qrun.exe"),
    path.resolve(__dirname, "..", "..", "qrun.bat"),
    path.resolve(__dirname, "..", "..", "qrun"),
  ].filter(Boolean);

  cachedQrunPath = candidates.find((candidate) => fs.existsSync(candidate)) || null;
  return cachedQrunPath;
}

function stripAnsi(text) {
  return text ? text.replace(/\u001b\[[0-9;]*m/g, "").trim() : null;
}

// Remove the internal sandbox temp path from messages so users never see
// server-side file paths. Replaces any sandbox_<hash><ext> filename with a
// neutral "script<ext>".
function cleanSandboxPath(text) {
  if (!text) return text;
  return text.replace(/sandbox_[a-f0-9]+(\.\w+)/gi, "script$1");
}

function isStrict(extension) {
  return config.STRICT_EXTENSIONS.includes(extension);
}

// The command line for running `file`: C/C++ get --strict so the compiler
// rejects whatever g++/gcc would, instead of accepting Quantum's mixed syntax.
function buildCommand(qrunPath, extension, file) {
  const args = ["--stage-marker", ...(isStrict(extension) ? ["--strict"] : []), file];
  return config.QRUN_LAUNCHER
    ? { command: config.QRUN_LAUNCHER, args: [qrunPath, ...args] }
    : { command: qrunPath, args };
}

// Splits qrun's stderr at the stage marker. Without a marker the program
// never compiled, so all of stderr is compiler diagnostics.
function splitStages(stderr) {
  const at = stderr.indexOf(STAGE_MARKER);
  if (at === -1) {
    return { compiled: false, compileLog: stderr, runtimeError: "" };
  }
  return {
    compiled: true,
    compileLog: stderr.slice(0, at),
    runtimeError: stderr.slice(at + STAGE_MARKER.length).replace(/^\r?\n/, ""),
  };
}

// Runs code through qrun, feeding `stdin` to the program. Resolves with the
// raw execFile result so the controller can shape the response. Never rejects.
function runCode(code, extension, stdin = "") {
  return new Promise((resolve) => {
    const qrunPath = resolveQrunPath();
    if (!qrunPath) {
      return resolve({ noBinary: true });
    }

    const fileName = `sandbox_${crypto.randomBytes(8).toString("hex")}${extension}`;
    const tempFilePath = path.join(config.SANDBOX_DIR, fileName);

    fs.writeFile(tempFilePath, code, (writeErr) => {
      if (writeErr) {
        return resolve({ writeError: true });
      }

      // Run from the sandbox with a bare file name so diagnostics never
      // contain the server's directory layout.
      const { command, args } = buildCommand(qrunPath, extension, fileName);
      const child = execFile(
        command,
        args,
        {
          cwd: config.SANDBOX_DIR,
          timeout: config.EXEC_TIMEOUT_MS,
          maxBuffer: config.MAX_BUFFER_BYTES,
        },
        (execError, stdout, stderr) => {
          fs.unlink(tempFilePath, () => {});
          resolve({
            execError,
            stdout: (stdout || "").replace(/\r\n/g, "\n"),
            stderr: (stderr || "").replace(/\r\n/g, "\n"),
          });
        }
      );
      // Always close stdin so a program reading input gets EOF instead of
      // hanging until the timeout.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });
  });
}

module.exports = {
  resolveQrunPath,
  runCode,
  stripAnsi,
  cleanSandboxPath,
  splitStages,
  buildCommand,
  isStrict,
  STAGE_MARKER,
};
