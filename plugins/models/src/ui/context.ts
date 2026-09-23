// What a band on the canvas can do beyond being selected
// (roadmap/support-event-modeling.md): open the feature file its slice is
// linked to. React Flow renders the node components itself, so the
// canvas hands them the action through a context rather than through the
// node data — which stays the model's own, so toFlow (flow.ts) stays pure.

import { createContext } from "react";

export interface SliceActions {
  openFeature: (fileName: string) => void;
}

export const SliceActionsContext = createContext<SliceActions>({ openFeature: () => {} });
