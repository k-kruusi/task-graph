import type { NodeHandler } from "./types.js";

export class NodeRegistry {
  private handlers = new Map<string, NodeHandler>();

  register(type: string, handler: NodeHandler): void {
    this.handlers.set(type, handler);
  }

  get(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
