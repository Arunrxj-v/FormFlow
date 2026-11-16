import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

function autoBackendPlugin(): Plugin {
  let backendProc: ChildProcess | null = null;
  return {
    name: 'auto-backend-starter',
    configureServer(server) {
      const check = http.get('http://localhost:8787/api/health', () => {
        // Backend is already running
      });
      check.on('error', () => {
        console.log('\n[FormFlow] Starting backend server on http://localhost:8787...');
        backendProc = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], {
          stdio: 'inherit',
          cwd: process.cwd(),
        });
      });
      server.httpServer?.on('close', () => {
        if (backendProc) {
          backendProc.kill('SIGTERM');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), autoBackendPlugin()],
  resolve: {
    alias: [
      // Localhost development uses a direct client. The extension build
      // aliases this module to the background-only client instead.
      { find: '@/services/vaultClient', replacement: path.resolve(__dirname, 'src/dev/directVaultClient.ts') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      { find: '@shared', replacement: path.resolve(__dirname, 'shared') },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if (!res.headersSent) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: 'Cannot connect to FormFlow backend server on port 8787. Please verify it is running.',
              }));
            }
          });
        },
      },
    },
  },
});
