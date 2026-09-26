import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Fail the production build on type errors (this is the default; kept
  // explicit). Next 16 removed the top-level `eslint` config key that
  // earlier versions had, so lint behavior is controlled via the lint
  // step / eslint config rather than here.
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
