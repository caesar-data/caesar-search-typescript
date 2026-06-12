import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./spec/openapi-public.json",
  output: "src/generated",
  plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"],
});
