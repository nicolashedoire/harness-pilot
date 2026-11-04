// Lets plain Node run the TypeScript unit tests in web/tests (type stripping, Node >= 22.18): extensionless
// relative imports resolve to their .ts file. Usage: npm test.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})
