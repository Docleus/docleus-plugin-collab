import { HocuspocusProvider } from "@hocuspocus/provider";
import { definePlugin } from "@docleus/sdk";
import { PLUGIN_NAME } from "../shared/index.ts";
import {
  collabUrlOf,
  createCollabProvider,
  type CollabConnectOptions,
  type CollabConnection,
} from "./provider.ts";

export {
  collabUrlOf,
  createCollabProvider,
  type CollabConnectOptions,
  type CollabConnection,
  type CollabConnectionEvents,
  type CollabProviderOptions,
} from "./provider.ts";

/** The browser sends the session cookie with the WebSocket handshake. */
function connectHocuspocus(options: CollabConnectOptions): CollabConnection {
  const provider = new HocuspocusProvider({
    url: options.url,
    name: options.name,
    document: options.document,
    token: options.token,
    onSynced: ({ state }) => {
      if (state) options.onSynced();
    },
    onAuthenticationFailed: ({ reason }) =>
      options.onAuthenticationFailed(reason),
    onStateless: ({ payload }) => options.onStateless(payload),
  });
  return {
    provider,
    sendStateless: (payload) => provider.sendStateless(payload),
    destroy: () => provider.destroy(),
  };
}

/** Lets editors of pages the user can write edit them together. */
export const plugin = definePlugin({
  name: PLUGIN_NAME,
  inject: ["ui", "editor"],
  apply(ctx) {
    ctx.editor.registerCollaboration(
      createCollabProvider({
        ui: ctx.ui,
        url: collabUrlOf(window.location),
        connect: connectHocuspocus,
      }),
    );
  },
});
