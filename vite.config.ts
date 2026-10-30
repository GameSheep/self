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
  build: {
    rollupOptions: {
      output: {
        /**
         * Keep the migration stack out of the first load.
         *
         * This project builds with **Vite 8 / Rolldown**, which merges a dynamically
         * imported chunk back into its importer when there is only one importer — so the
         * migration runner (reached by `await import()` from the settings action) used to
         * end up inside the entry chunk and cost ~10 KB gzip of first-load JavaScript for
         * code that cannot run until a user switches storage mode.
         *
         * `manualChunks` is the legacy Rollup hook and did not hold the boundary here (two
         * attempts made things worse: see docs/SELF_HUB_PROGRESS.md, round 21). Rolldown's
         * `advancedChunks` does: the migration *code* is out of the entry chunk (entry
         * 184.35 → 174.68 KB gzip).
         *
         * Known remainder, measured rather than assumed: `index.html` still links the
         * migration chunk with a bare side-effect `import`, so the static-graph total stays
         * ~209 KB. The code is no longer in the entry, but the browser still fetches the
         * chunk at startup. Closing that is the next step (candidate: side-effect metadata
         * for these modules) — `npm run measure:first-load` is the check.
         */
        advancedChunks: {
          groups: [
            /**
             * The eager core, claimed **first**.
             *
             * A chunk group takes its dependencies with it, so a `migration` group on its
             * own swallowed `lib/storage`, `idbV3`, `repositories/schema` and `lib/crypto`
             * — modules the entry needs anyway — and then the entry had to statically
             * import the migration chunk (and `index.html` `modulepreload`ed it), which put
             * the whole thing back into the first load. Naming the core first keeps those
             * modules in the eager graph so the migration group can only hold the code that
             * is genuinely lazy.
             */
            {
              name: 'core',
              test: /[\\/]src[\\/](lib[\\/](storage|hubState|crypto|schemaGeneration|migrationGate)|infrastructure[\\/]storage[\\/]idbV3|repositories[\\/]schema)\.ts$/
            },
            { name: 'migration', test: /[\\/]repositories[\\/]migration[\\/]/ }
          ]
        }
      }
    }
  },
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
