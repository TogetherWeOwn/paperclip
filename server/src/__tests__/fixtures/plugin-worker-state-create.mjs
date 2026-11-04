import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

runWorker(
  definePlugin({
    async setup(ctx) {
      ctx.actions.register(
        "available",
        async () => typeof ctx.state.create === "function",
      );
      ctx.actions.register("create", async () => {
        if (!ctx.state.create) throw new Error("atomic create unavailable");
        return ctx.state.create(
          { scopeKind: "instance", stateKey: "test" },
          null,
        );
      });
    },
  }),
  import.meta.url,
);
