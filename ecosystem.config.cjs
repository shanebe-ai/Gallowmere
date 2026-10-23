// Production process for server 1. Managed with:
//   pm2 startOrRestart ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'gallowmere',
      cwd: '/home/gallowmere',
      script: 'dist/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: '3004',
      },
    },
  ],
};
