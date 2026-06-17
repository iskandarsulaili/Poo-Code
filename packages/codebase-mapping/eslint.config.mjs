import baseConfig from "../../packages/config-eslint/base.js";

export default [
  ...baseConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
