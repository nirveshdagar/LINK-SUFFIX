import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/.gstack/**',
      '**/.browse-state/**',
      '**/New folder/**',
      '**/dist/**',
      'web/tests/**',
      'tooling/tests/evomi-*.test.mjs',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
});
