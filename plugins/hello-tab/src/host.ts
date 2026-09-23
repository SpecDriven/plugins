// The host half: runs inside the SpecDriven server (or the desktop app's
// main process). Everything it registers is an effect, unwound when the
// plugin is switched off — its routes answer 404 from then on.

type Disposer = () => void | Promise<void>;
type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

/** The services this plugin asks for (see src/plugins/host/services.ts in the app). */
interface Ctx {
  need(key: "routes"): { add(method: string, pattern: string, handler: Handler): Disposer };
  need(key: "data"): {
    withDir(handler: (dir: string, req: Request, params: Record<string, string>) => Response | Promise<Response>): Handler;
  };
  effect(run: () => Disposer): Disposer;
}

export default {
  name: "hello-tab",
  inject: ["routes", "data"],
  apply(ctx: Ctx) {
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    ctx.effect(() =>
      routes.add(
        "GET",
        "/api/hello-tab",
        data.withDir(async (dir) => Response.json({ plugin: "hello-tab", dataDir: dir })),
      ),
    );
  },
};
