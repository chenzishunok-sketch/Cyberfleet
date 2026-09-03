import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
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
      "/api": `http://127.0.0.1:${Number(process.env.API_PORT ?? 8795)}`,
    },
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  },
});
