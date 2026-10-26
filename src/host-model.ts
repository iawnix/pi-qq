import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HostModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;
export type ChatModel = NonNullable<ExtensionContext["model"]>;

/** A session-local transport: the host owns providers, credentials and routing. */
export async function hostSessionRuntime(model: ChatModel, registry: HostModelContext["modelRegistry"]): Promise<{ model: ChatModel; runtime: ModelRuntime }> {
  const runtime = await ModelRuntime.create({
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error("Host credentials are managed by Pi"); },
      delete: async () => { throw new Error("Host credentials are managed by Pi"); },
    },
  });
  // Keep host routing (including virtual models) in the host registry. This local
  // model only carries the context limits; no host conversation or tools cross over.
  const localModel: ChatModel = { ...model, api: "pi-qq-host" };
  runtime.registerNativeProvider({
    id: model.provider, name: "Pi host",
    auth: { apiKey: {
      name: "Pi host authentication",
      // The transport itself needs no credential. The registry resolves current
      // host auth at request time, including OAuth refresh and runtime-only keys.
      resolve: async () => ({ auth: {} }),
    } },
    getModels: () => [localModel],
    stream: (_model, context, options) => registry.stream(model, context, options),
    streamSimple: (_model, context, options) => registry.streamSimple(model, context, options),
  });
  return { model: localModel, runtime };
}
