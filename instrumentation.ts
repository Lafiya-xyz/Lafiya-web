/**
 * Next invokes this before a server instance accepts requests. Keep it small:
 * configuration validation is deterministic; the only network I/O is the
 * one-time DNS check of the configured Stellar endpoints, which fails boot if
 * an allowlisted deployment's RPC/Horizon host resolves to a private address.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntimeConfig, verifyRpcHostResolution } =
      await import("./lib/runtime-config");
    getRuntimeConfig();
    await verifyRpcHostResolution();
  }
}
