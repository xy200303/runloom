import type { RunloomEvent, RunloomEventListener, SubscribeOptions, Unsubscribe } from "../types.js";

export class RunloomEventBus {
  private readonly events: RunloomEvent[] = [];
  private readonly listeners = new Set<RunloomEventListener>();

  emit(event: RunloomEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: RunloomEventListener, options: SubscribeOptions = {}): Unsubscribe {
    this.listeners.add(listener);

    if (options.replay) {
      for (const event of this.events) {
        if (!options.sessionId || event.sessionId === options.sessionId) {
          listener(event);
        }
      }
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  listEvents(sessionId?: string): RunloomEvent[] {
    if (!sessionId) {
      return [...this.events];
    }
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}
