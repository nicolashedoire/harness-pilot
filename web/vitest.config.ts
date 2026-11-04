// Component tests (tests/components/*.test.tsx): Vitest with this app's Vite config (aliases, i18n chunks), in
// happy-dom, with Testing Library. The plain unit tests of tests/*.test.ts keep running on Node (`npm test` runs both).
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      environment: 'happy-dom',
      include: ['tests/components/**/*.test.tsx'],
      setupFiles: ['tests/components/setup.ts'],
    },
  }),
)
