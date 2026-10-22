// PM2 process config. Start with: pm2 start ecosystem.config.cjs
// Secrets stay in .env; the bot reads it from this folder at startup.
module.exports = {
  apps: [
    {
      name: "pharmacy-bot",
      cwd: __dirname,
      script: "src/index.ts",
      // tsx compiles the TypeScript at startup. Node's built-in type stripping can't run this code.
      node_args: "--import tsx",

      // Exactly one instance. The JSON data files and Telegram long polling both break with two
      // (Telegram answers "409 Conflict" if the same token polls from two places, including a laptop).
      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      // A crash within 20s of starting counts as a failed start; after 10 in a row PM2 gives up
      // instead of hammering Telegram with a bad token.
      min_uptime: "20s",
      max_restarts: 10,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "300M",
      // Time to stop polling and finish file writes before PM2 force-kills on stop/restart.
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
