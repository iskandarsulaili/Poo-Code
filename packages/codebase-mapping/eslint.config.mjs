import { config as baseConfig } from "@roo-code/config-eslint/base"

export default [
  ...baseConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
