import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ai.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["ai"],
});
