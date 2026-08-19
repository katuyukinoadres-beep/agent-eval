import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// The path alias exists in tsconfig for the editor, but tsc does not rewrite
// imports and Node cannot resolve @/ at runtime. src/ therefore uses relative
// imports; this alias is for test files only, and is declared here so the two
// resolvers cannot drift apart silently.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
