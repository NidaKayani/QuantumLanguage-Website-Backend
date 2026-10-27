# QuantumLanguage execution API.
#
# qrun.exe is a Windows x86-64 binary that only imports core system DLLs
# (kernel32, ucrtbase, advapi32, shell32), so it runs under Wine on any
# Linux host. Copy the engine in before building:
#
#   cp ../compiler/build/qrun.exe bin/qrun.exe
#   docker build -t quantum-backend .
#   docker run -p 5000:5000 quantum-backend

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends wine wine64 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5000 \
    WINEDEBUG=-all \
    WINEPREFIX=/home/node/.wine \
    QRUN_LAUNCHER=wine \
    QRUN_PATH=/app/bin/qrun.exe

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

USER node

# Create the Wine prefix at build time so the first request isn't slow.
RUN wineboot --init && wineserver --wait

EXPOSE 5000

# A persistent wineserver keeps each execution from paying Wine's startup
# cost; the warm-up run boots Wine's services (~10s) before the API accepts
# requests, so the first one doesn't hit EXEC_TIMEOUT_MS.
CMD ["sh", "-c", "wineserver --persistent && wine \"$QRUN_PATH\" --version && exec node server.js"]
