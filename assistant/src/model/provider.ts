import { customProvider } from "ai";
import type { LanguageModel } from "ai";

import { scriptedModel } from "./fake.js";

// Which model answers (ADR 0009): chosen by name in config (`ASSISTANT_MODEL`), through the AI SDK's provider
// layer, the only place a provider is named. This slice enables the scripted model alone, so nothing here holds
// a key or reaches a model provider. A model is always passed as an object: a bare model id would send the call
// to the AI SDK's default gateway, a host this Worker does not allow.

const enabled = customProvider({ languageModels: { fake: scriptedModel() } });

/** The model `name` selects, or null when it is not enabled: the turn is then refused. */
export function modelFor(name: string | undefined): LanguageModel | null {
  if (name === "fake") return enabled.languageModel("fake");
  // ponytail: the seam for Gemini on Vertex and Claude on Bedrock (ADR 0009). Each becomes one more name here,
  // with its provider package, its pinned model id, its exact hosts on the outbound list and its key as a Worker
  // secret, once the lead has recorded the region, retention and price for it. None of that exists yet.
  return null;
}
