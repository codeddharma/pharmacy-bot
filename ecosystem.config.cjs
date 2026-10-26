// PM2 process config. Start with: pm2 start ecosystem.config.cjs
// Build the dashboard first (npm run build); the server serves it from dashboard/dist.
// Secrets stay in .env; the server reads it from this folder at startup.
module.exports = {
  apps: [
    {
      name: "dawadesk",
      cwd: __dirname,
      script: "src/index.ts",
      // tsx compiles the TypeScript at startup. Node's built-in type stripping can't run this code.
      node_args: "--import tsx",

      // Exactly one instance: live updates, login lockouts and Telegram polling are kept in
      // memory, and Telegram answers "409 Conflict" if the same token polls from two places.
      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      // A crash within 20s of starting counts as a failed start; after 10 in a row PM2 gives up
      // instead of hammering Telegram or the database with a bad configuration.
      min_uptime: "20s",
      max_restarts: 10,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "500M",
      // Time to finish in-flight requests and close the database before PM2 force-kills.
      kill_timeout: 10000,
      watch: false,

      time: true,
      merge_logs: true,
      out_file: "logs/out.log",
      error_file: "logs/error.log",

      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
      },
    },
  ],
};
