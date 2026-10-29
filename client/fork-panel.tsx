import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { store } from "./store";

// Paseo gives a plugin no row menu, so the cut point is picked here: one row per prompt in
// the copied window. The fork opens idle, like Paseo's own Fork, waiting for the next message.
export function ForkPanel({ params, navigation, theme }: PluginAgentPanelProps) {
  useSyncExternalStore(store.subscribe, store.version);
  const state = store.anchors(params.agentId);
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };

  if (state.status === "idle") void store.loadAnchors(params.agentId);

  const fork = async (anchorId: string, preview: string) => {
    const created = await store.forkAt(params.agentId, anchorId, preview);
    if (!created) return;
    // The desktop opens the tab itself; other clients fall back to the panel's navigation.
    if (!created.opened && navigation) navigation.openAgent({ agentId: created.agentId });
  };

  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={[text, { fontWeight: "600" }]}>Fork at a message</Text>
        <Pressable onPress={() => void store.loadAnchors(params.agentId)}>
          <Text style={muted}>Reload</Text>
        </Pressable>
      </View>
      <Text style={[muted, { fontSize: 11 }]}>
        The session is forked up to the message you pick: the new tab keeps the history and waits for your next message.
      </Text>
      {state.status === "error" ? <Text style={{ color: colors.statusDanger }}>{state.error}</Text> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }}>
        {state.anchors.length ? (
          state.anchors.map((anchor) => (
            <Pressable
              key={anchor.id}
              onPress={() => void fork(anchor.id, anchor.preview)}
              disabled={state.busyId !== null}
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 6,
                padding: 8,
                opacity: state.busyId && state.busyId !== anchor.id ? 0.4 : 1,
              }}
            >
              <Text style={[text, { fontSize: 12 }]} selectable>
                {anchor.preview}
              </Text>
              <Text style={[muted, { fontSize: 11 }]}>
                {state.busyId === anchor.id ? "Forking..." : "Fork from here"}
              </Text>
            </Pressable>
          ))
        ) : (
          <Text style={muted}>
            {state.status === "loading" ? "Loading prompts..." : "No prompts with an id in the last 200 entries."}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
