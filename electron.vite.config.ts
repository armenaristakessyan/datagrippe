import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/** WebSocket origin only the dev server's hot reload needs (src/renderer/index.html allows it). */
const DEV_CONNECT_SRC = ' ws://localhost:*'

/**
 * Production builds drop the dev-server allowance from the renderer's Content-Security-Policy, so
 * injected script cannot reach local WebSocket services. Fails the build if the CSP is not found.
 */
function productionCsp(): Plugin {
  return {
    name: 'datagrippe-production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const csp = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i
        const match = csp.exec(html)
        if (!match) throw new Error('index.html has no Content-Security-Policy meta tag')
        const policy = match[2].replace(DEV_CONNECT_SRC, '')
        if (/ws:|localhost/.test(policy)) throw new Error(`Unexpected development origin left in the production CSP: ${policy}`)
        return html.replace(csp, `$1${policy}$3`)
      },
    },
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared,
      },
    },
    plugins: [react(), tailwindcss(), productionCsp()],
    build: {
      minify: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    worker: { format: 'es' },
  },
})
