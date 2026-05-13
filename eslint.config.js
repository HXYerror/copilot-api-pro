import config from "@echristian/eslint-config"

export default config({
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
  ignores: ["src/admin/assets/**/*.js"],
})
