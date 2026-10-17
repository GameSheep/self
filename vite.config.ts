import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 3000 is inside a Windows "excluded port range" on some machines
// (netsh interface ipv4 show excludedportrange protocol=tcp), where binding
// fails with EACCES instead of EADDRINUSE — vite cannot auto-increment on that,
// so `npm run dev` died before the server started. Override with PORT=xxxx.
const envPort = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PORT;
const port = Number(envPort) || 5173;

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port,
    strictPort: false,
    host: '127.0.0.1',
    open: false
  },
  preview: {
    port,
    strictPort: false,
    host: '127.0.0.1'
  }
});
