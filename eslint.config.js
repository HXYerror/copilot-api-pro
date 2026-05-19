import config from "@echristian/eslint-config"

export default config({
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
  ignores: [
    "src/admin/assets/**/*.js",
    // Stale agent worktrees (created by EnterWorktree / Agent isolation) leave
    // a full source copy under .claude/worktrees/. Don't relint them.
    ".claude/worktrees/**",
    // Built artifacts. Vite + tsdown outputs are minified/bundled and not
    // worth linting; eslint on dist/main.js was hanging pre-commit.
    "dist/**",
  ],
})
