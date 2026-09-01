import { build } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const aliases = {
  '@shared': resolve(root, 'src/shared'),
  '@capabilities': resolve(root, 'src/capabilities/index.ts'),
  '@application': resolve(root, 'src/application/index.ts')
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function bundle(entry, fileName) {
  await build({
    configFile: false,
    resolve: { alias: aliases },
    build: {
      outDir: resolve(root, 'out/agent'),
      emptyOutDir: false,
      target: 'node22',
      ssr: resolve(root, entry),
      rollupOptions: {
        external: ['electron', 'better-sqlite3'],
        output: { format: 'cjs', entryFileNames: fileName }
      },
      minify: false
    }
  })
}

await bundle('src/cli/entry.ts', 'canvas.cjs')
await bundle('src/mcp/entry.ts', 'canvas-mcp.cjs')
await bundle('src/capabilities/generate-entry.ts', 'contract-generator.cjs')
