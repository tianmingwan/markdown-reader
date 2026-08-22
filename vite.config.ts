import { defineConfig } from "vite";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 项目真实路径（兼容「经 junction 打开项目」的场景：
// 例如 C:\mdrbuild → C:\Users\...\markdown 阅读器）
const realRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const cwdRoot = process.cwd();
const cwdRealRoot = realpathSync(cwdRoot);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: {
      // 默认只信任虚拟根；junction 打开时会拒绝真实路径下的资源（如 KaTeX 字体）。
      // 同时放行：配置所在真实路径、当前启动路径（junction 或真实目录）
      allow: [realRoot, cwdRoot, cwdRealRoot],
    },
    watch: {
      // Tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
}));