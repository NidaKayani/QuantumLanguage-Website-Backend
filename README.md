# QuantumLanguage Backend

Remote execution API that powers the QuantumLanguage web IDE. It accepts source
code from the frontend, runs it through the `qrun` compiler/interpreter, and
returns the result as JSON.

Expected folder layout (monorepo):

```
QuantumLanguage/
├── backend/     (this project)
├── compiler/    # C++ source; build.bat / build-fast.bat produce qrun.exe here
└── frontend/
```

`resolveQrunPath()` looks for the built binary at `QRUN_PATH`, then
`bin/qrun.exe`, `../compiler/build/qrun.exe` and `../compiler/qrun.exe`.

## Requirements

- Node.js 18+
- A built `qrun` executable from the QuantumLanguage compiler (optional — see
  [Demo mode](#demo-mode) below if you don't have one yet)

## Setup

```bash
npm install
cp .env.example .env
npm run dev   # nodemon, restarts on file changes
# or
npm start     # plain node
```

The server listens on `PORT` (default `5000`).

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5000` | HTTP port |
| `NODE_ENV` | `development` | Environment name, echoed by `/api/health` |
| `ALLOWED_ORIGINS` | *(empty = allow all)* | Comma-separated list of allowed CORS origins |
| `QRUN_PATH` | *(auto-detected)* | Absolute path to the `qrun` executable |
| `QRUN_LAUNCHER` | *(empty)* | Program that runs `qrun.exe`, e.g. `wine` on Linux |
| `EXEC_TIMEOUT_MS` | `10000` | Kill a running program after this many ms |
| `WS_EXEC_TIMEOUT_MS` | `300000` | Same, for interactive IDE runs over the WebSocket |
| `MAX_CODE_LENGTH` | `20000` | Reject submissions with more characters than this |
| `MAX_STDIN_LENGTH` | `65536` | Reject `stdin` longer than this |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for `/api/execute` |
| `RATE_LIMIT_MAX` | `20` | Max requests per window per IP |

## Strict C/C++ vs. reflexive `.sa`

`.cpp` and `.c` submissions run under `qrun --strict`: anything g++/gcc would
reject — a missing `;`, `cout` without `std::`, an undeclared name, Python or
JavaScript syntax — is a compile error with a gcc-style message, and the
program never runs. Only `.sa` files get Quantum's reflexive mixed-syntax
mode, where Python, JavaScript, Ruby and C++ can share one file.

## API

### `GET /api/health`

```json
{ "status": "ok", "qrunAvailable": true, "environment": "development" }
```

### `POST /api/execute`

Request body:

```json
{
  "ext": ".cpp",
  "code": "#include <iostream>\nint main() {\n    int a, b;\n    std::cin >> a >> b;\n    std::cout << a + b << std::endl;\n}\n",
  "stdin": "3 4\n"
}
```

`ext` must be one of `.sa`, `.js`, `.py`, `.rb`, `.cpp`, `.c`. `code` is the raw
source text (capped at `MAX_CODE_LENGTH`). `stdin` is optional; the program
reads it and then gets end-of-file.

Success:

```json
{
  "success": true,
  "stage": null,
  "strict": true,
  "exitCode": 0,
  "hasWarnings": false,
  "output": "7",
  "error": null,
  "compiledOutput": "7",
  "compilerError": null
}
```

Compile error (the program did not run):

```json
{
  "success": false,
  "stage": "compile",
  "strict": true,
  "exitCode": 1,
  "output": "",
  "error": "script.cpp:5:5: error: expected ';' before 'cout'\n    5 |     cout << x << endl;\n      |     ^~~~",
  "compilerError": "script.cpp:5:5: error: expected ';' before 'cout'\n    5 |     cout << x << endl;\n      |     ^~~~"
}
```

Runtime error (it compiled, then failed): `stage` is `"runtime"`, `output`
holds whatever it printed first, `error` its stderr, and `compilerError` is
`null`. A timeout returns HTTP 504 with `error: "Execution timed out after
…ms."`.

`compiledOutput`/`compilerError` mirror `output`/`error` for older clients.
This endpoint is rate-limited per IP via `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`.

```bash
curl -X POST https://your-host/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"ext":".cpp","code":"#include <iostream>\nint main(){ std::cout << 42; }"}'
```

### WebSocket (the IDE terminal)

Connect to `ws://host:PORT`. Each connection runs at most one program at a
time, independently of other connections. Messages are JSON:

| Direction | Message |
| --- | --- |
| → | `{ "type": "run", "ext": ".cpp", "payload": "<code>", "name": "main.cpp" }` (starting a run replaces the current one; `name` is used in compiler messages) |
| → | `{ "type": "input", "payload": "Ada\n" }` — written to the program's stdin |
| → | `{ "type": "stop" }` |
| ← | `{ "type": "stdout" \| "stderr", "payload": "..." }` |
| ← | `{ "type": "process_completion", "exitCode": 0, "stage": null }` — `stage` is `"compile"`, `"runtime"` or `null`; `"stopped": true` after a stop |

## Deploying

`qrun.exe` is a Windows binary, but it only imports core system DLLs, so the
included `Dockerfile` runs it under Wine on Linux. That image works on any
Docker host (Render, Railway, Fly.io, a VPS, ...):

```bash
cp ../compiler/build/qrun.exe bin/qrun.exe   # refresh after each compiler build
docker build -t quantum-backend .
docker run -p 5000:5000 -e ALLOWED_ORIGINS=https://your-frontend.example quantum-backend
```

For a platform that builds from the git repo, `bin/qrun.exe` must be
committed. On a Windows host, skip Docker: `npm ci --omit=dev && npm start`
with `QRUN_PATH` pointing at `qrun.exe` and `QRUN_LAUNCHER` empty.

## Demo mode

If `qrun` hasn't been built yet, the two sample programs shipped in the
frontend IDE (the `SecureServer`/`socket` example and the
`checkSimilarity`/`levenshtein` example) still produce correct output — the
server computes them directly instead of shelling out. Everything else
requires a real `qrun` binary and returns a 500 explaining how to configure
`QRUN_PATH`.

## Security notes

This endpoint executes arbitrary submitted code via `execFile`. Current
mitigations: per-request execution timeout, output size cap, request body
size cap, source length cap, and IP-based rate limiting. There is **no**
process sandboxing (no container, no seccomp, no resource/network isolation)
beyond what `qrun` itself does — do not expose this service to the public
internet without adding one (e.g. run `qrun` inside a locked-down container
or VM with no network access and a CPU/memory ceiling).
