/**
 * Next invokes this before a server instance accepts requests. Keep it small:
 * configuration validation is deterministic and does not perform network I/O.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntimeConfig } = await import("./lib/runtime-config");
    getRuntimeConfig();
  }
}
