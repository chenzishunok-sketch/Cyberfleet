module.exports = {
  apps: [
    {
      name: "kuajing-multi-agent-api",
      script: "npx",
      args: "tsx watch server/index.ts",
      cwd: __dirname,
      interpreter: "none",
      watch: false,
      max_memory_restart: "1G",
      restart_delay: 3000,
      max_restarts: 10,
      env: { NODE_ENV: "development" },
    },
    {
      name: "kuajing-multi-agent-web",
      script: "npx",
      args: "vite --host 127.0.0.1 --port 5182 --strictPort",
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
