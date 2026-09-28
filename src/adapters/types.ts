/**
 * Adapters translate a charter Edge into platform-native calls.
 *
 * Note the signatures: every method takes an `Edge`, never a channel string.
 * An adapter has no way to be pointed at a channel that is not in the
 * charter, because the only object that carries a channel address is one
 * that Charter.resolve() produced. The wall is structural, not a check
 * someone remembered to write.
 */

import type { Edge } from "../charter";

export interface InboundMessage {
  id: string;
  author: string;
  title: string;
  body: string;
  at: string;
  url?: string;
  signal?: number;
}

export interface Adapter {
  readonly platform: string;
  read(edge: Edge, limit?: number): Promise<InboundMessage[]>;
  write(edge: Edge, title: string, body: string): Promise<string>;
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export class NoAdapter extends Error {
  constructor(platform: string, known: string[]) {
    super(
      `no adapter for platform '${platform}' — registered: ${known.join(", ") || "none"}`
    );
    this.name = "NoAdapter";
  }
}
