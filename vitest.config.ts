import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
  resolve: {
    alias: [
      // Session-manage-store imports createSnapshotStore/SnapshotStore at
      // runtime. In a clean environment the @deepseek-ai peers are not
      // installed (they come from the dsh application closure), so route the
      // runtime face to a local, dependency-free stub. The store's own
      // type-only imports are erased by verbatimModuleSyntax and need no alias.
      { find: /^@deepseek-ai\/dsh-client-runtime\/client$/, replacement: '/Users/vim0x3c/Documents/dsh-plugin/dsh-session-manager/tests/stubs/runtime-store-stub.ts' },
    ],
  },
  plugins: [
    {
      name: 'stub-css',
      enforce: 'pre',
      resolveId(source: string) {
        if (source.endsWith('.css') || source.endsWith('.module.css')) return '\0css:' + source
        return null
      },
      load(id: string) {
        if (id.startsWith('\0css:')) return 'export default {}'
        return null
      },
    },
  ],
})
