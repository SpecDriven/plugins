// src/host.ts
var host_default = {
  name: "hello-tab",
  inject: ["routes", "data"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    ctx.effect(() => routes.add("GET", "/api/hello-tab", data.withDir(async (dir) => Response.json({ plugin: "hello-tab", dataDir: dir }))));
  }
};
export {
  host_default as default
};

//# debugId=C51264266027B94364756E2164756E21
//# sourceMappingURL=host.js.map
