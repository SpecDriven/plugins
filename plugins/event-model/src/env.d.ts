// A stylesheet imported `with { type: "text" }` is its text: the canvas's
// styles go on the page as the plugin mounts (src/client.tsx).
declare module "*.css" {
  const text: string;
  export default text;
}
