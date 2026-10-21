import type { Env } from "./env";

// The loader cache is keyed by content hash, not by a mutable version label.
export async function loadApp(env: Env, hash: string) {
  const worker = env.LOADER.get(hash, async () => {
    const object = await env.CODE.get("code/" + hash + ".js");
    if (!object) throw new Error("Missing code " + hash);
    return {
      compatibilityDate: "2026-10-21",
      mainModule: "app.js",
      modules: { "app.js": await object.text() },
      env: { HASH: hash },
      globalOutbound: null,
    };
  });
  return { class: worker.getDurableObjectClass("App") };
}
