// A built bundle without the lines that change when the plugin has not:
// the module path comments, which follow the folder the build ran from; the
// `var x = m.x;` shim lines, which list every export of the building app's
// SDK; and the debug id. What is left is what the plugin's own source
// builds to, so two builds of the same source compare equal.

const NOISE = [
  /^\/\/ \S+$/, // module path comment
  /^\s*(var )?[\w$]+ = m\d*\.[\w$]+;$/, // shim export: `var x = m.x;`, `  x = m.x;`, `var x = m2.x;`
  /^var m\d*(, [\w$]+)*;$/, // the client shim's declaration list
  /^\/\/# debugId=/,
];

export const normalize = (code: string): string =>
  code
    .split("\n")
    .filter((line) => !NOISE.some((re) => re.test(line)))
    .join("\n");
