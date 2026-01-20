module.exports = {
  apps: [
    {
      name: "whatsapp-web-service",
      script: "src/index.js",
      cwd: "/home/aldair/whatsapp-web-service",
      env_file: "/home/aldair/whatsapp-web-service/.env",
      exec_mode: "fork"
    }
  ]
};
