const http = require("http");
const WebSocket = require("ws");
const app = require("../src/app");
const { setupWebSocket } = require("../src/socket/socketServer");
const { resolveQrunPath } = require("../src/services/qrun.service");

const describeWithQrun = resolveQrunPath() ? describe : describe.skip;

describeWithQrun("WebSocket execution", () => {
  let server;
  let url;

  beforeAll((done) => {
    server = http.createServer(app);
    setupWebSocket(server);
    server.listen(0, () => {
      url = `ws://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  // Opens a connection, runs `code`, answers prompts from `replies`
  // (output substring -> stdin line) and resolves with what came back.
  function runOver(ext, code, { name, replies = {}, stopOn } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let stdout = "";
      let stderr = "";
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ type: "run", ext, payload: code, name })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === "stdout") {
          stdout += msg.payload;
          for (const [prompt, line] of Object.entries(replies)) {
            if (msg.payload.includes(prompt)) ws.send(JSON.stringify({ type: "input", payload: line }));
          }
          if (stopOn && msg.payload.includes(stopOn)) ws.send(JSON.stringify({ type: "stop" }));
        } else if (msg.type === "stderr") {
          stderr += msg.payload;
        } else if (msg.type === "process_completion") {
          ws.close();
          resolve({ stdout, stderr, exit: msg });
        }
      });
    });
  }

  it("feeds typed input to the program", async () => {
    const r = await runOver(
      ".cpp",
      '#include <iostream>\n#include <string>\nint main() {\n    std::string n;\n    std::cout << "Name?" << std::endl;\n    std::cin >> n;\n    std::cout << "Hi " << n << std::endl;\n}\n',
      { replies: { "Name?": "Ada\n" } }
    );
    expect(r.stdout).toContain("Hi Ada");
    expect(r.exit).toMatchObject({ exitCode: 0, stage: null });
  });

  it("reports a strict C++ compile error under the file's own name", async () => {
    const r = await runOver(".cpp", "#include <iostream>\nint main() {\n    int x = 5\n    std::cout << x;\n}\n", {
      name: "main.cpp",
    });
    expect(r.exit).toMatchObject({ exitCode: 1, stage: "compile" });
    expect(r.stderr).toContain("main.cpp:4:5: error: expected ';' before 'std'");
    expect(r.stderr).not.toMatch(/sandbox_|quantum:compiled/);
  });

  it("reports a runtime failure as stage 'runtime'", async () => {
    const r = await runOver(
      ".cpp",
      '#include <iostream>\n#include <stdexcept>\nint main() {\n    std::cout << "before" << std::endl;\n    throw std::runtime_error("boom");\n}\n'
    );
    expect(r.stdout).toContain("before");
    expect(r.exit.stage).toBe("runtime");
    expect(r.stderr).toContain("boom");
  });

  it("stops a running program on request", async () => {
    const r = await runOver(".cpp", '#include <iostream>\nint main() {\n    std::cout << "looping" << std::endl;\n    while (true) {}\n}\n', {
      stopOn: "looping",
    });
    expect(r.exit).toMatchObject({ stopped: true });
  });

  it("keeps connections independent", async () => {
    const program = (word) => `#include <iostream>\nint main() {\n    std::cout << "${word}" << std::endl;\n}\n`;
    const [a, b] = await Promise.all([runOver(".cpp", program("alpha")), runOver(".cpp", program("beta"))]);
    expect(a.stdout).toContain("alpha");
    expect(b.stdout).toContain("beta");
    expect(a.exit.exitCode).toBe(0);
    expect(b.exit.exitCode).toBe(0);
  });
});
