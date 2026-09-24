// The board an empty tab offers to start from: an online shop's order,
// from the customer placing it to the parcel leaving the warehouse, at the
// process level — each command with its actor, the aggregate deciding,
// the event, the policy reacting — split into two bounded contexts at the
// pivotal event, with a hotspot left for later.

import { normalizeStormFile } from "./serialize";
import type { StormFile } from "./types";

const col = (i: number) => i * 176;

export function exampleStorm(name: string): StormFile {
  return normalizeStormFile(
    {
      name,
      stickies: [
        { id: "customer", kind: "actor", text: "Customer", x: col(0) + 16, y: 96 },
        { id: "place-order", kind: "command", text: "Place order", x: col(0), y: 176 },
        { id: "order", kind: "aggregate", text: "Order", x: col(1), y: 160 },
        { id: "order-placed", kind: "event", text: "Order placed", x: col(2) + 16, y: 176 },
        { id: "take-payment-policy", kind: "policy", text: "Whenever an order is placed, take payment", x: col(3) + 16, y: 176 },
        { id: "payment-provider", kind: "external", text: "Payment provider", x: col(4), y: 40 },
        { id: "take-payment", kind: "command", text: "Take payment", x: col(4) + 16, y: 176 },
        { id: "payment-received", kind: "event", text: "Payment received", x: col(5) + 16, y: 176, pivotal: true },
        { id: "payment-fails", kind: "hotspot", text: "What if the payment fails?", x: col(5) + 16, y: 352 },
        { id: "orders-to-pack", kind: "readmodel", text: "Orders to pack", x: col(6) + 24, y: 176 },
        { id: "clerk", kind: "actor", text: "Warehouse clerk", x: col(7) + 16, y: 96 },
        { id: "ship-order", kind: "command", text: "Ship order", x: col(7), y: 176 },
        { id: "order-shipped", kind: "event", text: "Order shipped", x: col(8), y: 176 },
        { id: "carrier", kind: "external", text: "Carrier", x: col(8) - 24, y: 352 },
      ],
      areas: [
        { id: "sales", label: "Sales", x: -32, y: 16, width: 1080, height: 512 },
        { id: "fulfilment", label: "Fulfilment", x: 1064, y: 16, width: 520, height: 512 },
      ],
      arrows: [
        { id: "r1", from: "customer", to: "place-order" },
        { id: "r2", from: "place-order", to: "order" },
        { id: "r3", from: "order", to: "order-placed" },
        { id: "r4", from: "order-placed", to: "take-payment-policy" },
        { id: "r5", from: "take-payment-policy", to: "take-payment" },
        { id: "r6", from: "take-payment", to: "payment-received" },
        { id: "r7", from: "payment-received", to: "orders-to-pack" },
        { id: "r8", from: "orders-to-pack", to: "ship-order" },
        { id: "r9", from: "clerk", to: "ship-order" },
        { id: "r10", from: "ship-order", to: "order-shipped" },
      ],
    },
    name,
  );
}
