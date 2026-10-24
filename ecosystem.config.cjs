module.exports = {
  apps: [
    {
      name: "cyberfleet-api",
      // 用绝对路径的 node + 项目内 tsx，避免 PM2 进程 PATH 里没有托管版 node
      script: "/Users/jy/.workbuddy/binaries/node/versions/22.22.2-6/bin/node",
      args: "node_modules/tsx/dist/cli.mjs watch server/index.ts",
      cwd: __dirname,
      interpreter: "none",
      watch: false,
      max_memory_restart: "1G",
      restart_delay: 3000,
      max_restarts: 10,
      env: { NODE_ENV: "development" },
    },
    {
      name: "cyberfleet-web",
      script: "/Users/jy/.workbuddy/binaries/node/versions/22.22.2-6/bin/node",
      args: "node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5182 --strictPort",
      cwd: __dirname,
      interpreter: "none",
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 5000,
      max_restarts: 10,
      env: { NODE_ENV: "development" },
    },
  ],
};
