import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Serve the production build locally without Next.js development tooling.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(webRoot, ".next", "required-server-files.json");
if (!existsSync(manifestPath)) throw new Error("请先运行 pnpm build，再运行 pnpm preview。");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const standaloneRoot = path.join(webRoot, ".next", "standalone");
const serverRoot = path.resolve(standaloneRoot, manifest.relativeAppDir || "");
const relativeServerRoot = path.relative(standaloneRoot, serverRoot);
if (relativeServerRoot.startsWith("..") || path.isAbsolute(relativeServerRoot)) throw new Error("无效的 standalone 输出目录。");

const serverFile = path.join(serverRoot, "server.js");
if (!existsSync(serverFile)) throw new Error("未找到 standalone 服务入口，请重新运行 pnpm build。");

for (const directory of ["public", ".next/static"]) {
    cpSync(path.join(webRoot, directory), path.join(serverRoot, directory), { recursive: true, force: true });
}

const server = spawn(process.execPath, [serverFile], {
    cwd: serverRoot,
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: process.env.PORT || "5555" },
    stdio: "inherit",
    windowsHide: true,
});
server.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
});
server.on("exit", (code) => {
    process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
