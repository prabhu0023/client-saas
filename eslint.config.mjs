// Next 16's eslint-config-next ships native flat-config exports
// (./core-web-vitals and ./typescript resolve to flat config arrays),
// so we import and spread them directly. The older FlatCompat bridge is
// not needed here and in fact crashes with a circular-structure error
// against these configs.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
]

export default eslintConfig
