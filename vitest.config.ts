import { defineConfig } from "vitest/config";

export default defineConfig({
  // The components are .tsx; compile their JSX with the automatic runtime
  // (the tests themselves use createElement, so they don't depend on this).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    // The hook tests use @testing-library/react's renderHook, which renders
    // into a DOM. The component tests use renderToStaticMarkup and work in
    // either environment.
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/hooks/**", "src/components/**"],
      exclude: ["src/lib/mips-parser/generated-parser.ts", "**/*.css"],
      reporter: ["text", "html"],
    },
  },
});
