import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  // 部署在 pangjian.xyz/cyberfleet/ 子路径下：静态资源以 /cyberfleet/ 为 base，
  // 配合 Nginx 剥离前缀反向代理到 Express（API/静态/SPA fallback 仍按根路径服务）。
  base: process.env.VITE_BASE ?? "/cyberfleet/",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        // rolldown 要求 manualChunks 为函数形式：将大型依赖拆分到独立 chunk
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("pixi.js") || id.includes("@esotericsoftware/spine-pixi")) return "pixi";
          if (id.includes("recharts")) return "recharts";
          if (id.includes("lucide-react")) return "lucide";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) return "react-vendor";
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "pixi.js", "recharts", "lucide-react"],
  },
  server: {
    // 端口与 API 代理可用 WEB_PORT / API_PORT 覆盖，默认与既有实例(5182→8795)一致
    port: Number(process.env.WEB_PORT ?? 5182),
    proxy: {
      // 开发时前端 BASE_URL 是 /cyberfleet/，API_BASE 带上 /cyberfleet 前缀，
      // 请求落在 /cyberfleet/api/*。这里同样剥离前缀转发到 Express，
      // 与生产环境 Nginx「剥离子路径前缀」的行为保持一致。
      // （之前只代理 /api，导致 /cyberfleet/api/* 返回 SPA 的 index.html，
      //  前端 JSON 解析失败，报「服务器响应格式异常」。）
      "/cyberfleet/api": {
        target: `http://127.0.0.1:${Number(process.env.API_PORT ?? 8795)}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cyberfleet/, ""),
      },
      // 兜底：BASE_URL="/"（VITE_BASE=/）时请求仍是根路径 /api/*
      "/api": `http://127.0.0.1:${Number(process.env.API_PORT ?? 8795)}`,
    },
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  },
});
