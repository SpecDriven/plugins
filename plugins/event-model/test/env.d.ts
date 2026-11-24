// The app's server, which the tests run this plugin inside, bundles text
// assets in (`import x from "./file.md" with { type: "text" }`); the app
// declares them in its own src/textImports.d.ts, outside this program.
declare module "*.md" {
  const text: string;
  export default text;
}
