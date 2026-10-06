import next from "eslint-config-next";
export default [
  ...next,
  { ignores: [".next/**", "drizzle/**", "node_modules/**"] },
];
