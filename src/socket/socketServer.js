const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require("../config");
const { resolveQrunPath, buildCommand, STAGE_MARKER } = require("../services/qrun.service");

// The stage marker is for the API; the terminal never shows it.
const MARKER_LINE = new RegExp(`${STAGE_MARKER.replace(/[[\]]/g, '\\$&')}\\r?\\n?`);

function setupWebSocket(server) {
    const wss = new WebSocketServer({ server });

    // Each connection runs at most one program at a time; connections are
    // independent, so visitors never interrupt each other.
    wss.on('connection', (ws) => {
        let activeProcess = null;

        const send = (message) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        };

        // Ends the running program without reporting its exit (a newer run or
        // the user replaced it).
        const discardActive = () => {
            if (!activeProcess) return;
            const proc = activeProcess;
            activeProcess = null;
            proc.kill();
        };

        const run = (code, requestedExt, requestedName) => {
            discardActive();

            const ext = config.ALLOWED_EXTENSIONS.includes(requestedExt) ? requestedExt : '.sa';
            const fileName = `sandbox_${crypto.randomBytes(8).toString('hex')}${ext}`;
            const tempFilePath = path.join(config.SANDBOX_DIR, fileName);
            // Diagnostics name the file as the user knows it (main.cpp:3:2),
            // never the sandbox copy.
            const baseName = typeof requestedName === 'string' ? path.basename(requestedName) : '';
            const shownName = /^[\w.\- ]{1,100}$/.test(baseName) ? baseName : `script${ext}`;
            const rename = (text) => text.split(fileName).join(shownName);

            fs.writeFile(tempFilePath, typeof code === 'string' ? code : '', (err) => {
                if (err) {
                    send({ type: 'stderr', payload: 'System Error: Failed to allocate sandbox space.\r\n' });
                    send({ type: 'process_completion', exitCode: null, stage: null });
                    return;
                }

                const qrunPath = resolveQrunPath();
                if (!qrunPath) {
                    send({ type: 'stderr', payload: 'Execution engine (qrun) not found in backend.\r\n' });
                    send({ type: 'process_completion', exitCode: null, stage: null });
                    fs.unlink(tempFilePath, () => {});
                    return;
                }

                const { command, args } = buildCommand(qrunPath, ext, fileName);
                const proc = spawn(command, args, { cwd: config.SANDBOX_DIR });
                activeProcess = proc;
                let compiled = false;
                let timedOut = false;

                const timer = setTimeout(() => {
                    timedOut = true;
                    proc.kill();
                }, config.WS_EXEC_TIMEOUT_MS);

                proc.stdout.on('data', (chunk) => {
                    if (activeProcess !== proc) return;
                    send({ type: 'stdout', payload: rename(chunk.toString()).replace(/\r?\n/g, '\r\n') });
                });

                proc.stderr.on('data', (chunk) => {
                    if (activeProcess !== proc) return;
                    let text = chunk.toString();
                    if (MARKER_LINE.test(text)) {
                        compiled = true;
                        text = text.replace(MARKER_LINE, '');
                    }
                    if (text) send({ type: 'stderr', payload: rename(text).replace(/\r?\n/g, '\r\n') });
                });

                proc.stdin.on('error', () => {});

                proc.on('error', (spawnErr) => {
                    console.error('Failed to start execution engine:', spawnErr);
                });

                proc.on('close', (exitCode) => {
                    clearTimeout(timer);
                    fs.unlink(tempFilePath, () => {});
                    if (activeProcess !== proc) return;
                    activeProcess = null;
                    if (timedOut) {
                        send({
                            type: 'stderr',
                            payload: `Execution timed out after ${config.WS_EXEC_TIMEOUT_MS / 1000}s.\r\n`,
                        });
                    }
                    send({
                        type: 'process_completion',
                        exitCode,
                        // Where it failed: "compile", "runtime", or null on success.
                        stage: exitCode === 0 && !timedOut ? null : compiled ? 'runtime' : 'compile',
                    });
                });
            });
        };

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.type) {
                    case 'run':
                        run(data.payload, data.ext, data.name);
                        break;

                    case 'input':
                        if (activeProcess && activeProcess.stdin.writable && typeof data.payload === 'string') {
                            activeProcess.stdin.write(data.payload);
                        }
                        break;

                    case 'stop':
                        if (activeProcess) {
                            discardActive();
                            send({ type: 'process_completion', exitCode: null, stage: null, stopped: true });
                        }
                        break;
                }
            } catch (err) {
                console.error("WebSocket Error:", err);
            }
        });

        ws.on('close', discardActive);
    });

    return wss;
}

module.exports = { setupWebSocket };
