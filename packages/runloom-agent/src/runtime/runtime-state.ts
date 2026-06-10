import type { RunloomEventBus } from "../events/event-bus.js";
import type {
  FileRuntimeStateStore,
  RuntimeStateSnapshot,
  StoredModelToolCall,
  StoredPendingModelContinuation,
  StoredRunInput,
  StoredRunRecord
} from "../sessions/file-runtime-state-store.js";
import type { InMemorySessionStore } from "../sessions/in-memory-store.js";
import type { RunloomModelInputItem, RunloomModelTool, RunloomRun } from "../types.js";

export interface RuntimeRunRecord {
  run: RunloomRun;
  input: StoredRunInput;
}

export type PendingModelContinuation = StoredPendingModelContinuation;

export interface RuntimeStateManagerOptions {
  store: InMemorySessionStore;
  bus: RunloomEventBus;
  runs: Map<string, RuntimeRunRecord>;
  pendingModelContinuations: Map<string, PendingModelContinuation>;
  runtimeStateStore?: FileRuntimeStateStore;
}

export class RuntimeStateManager {
  constructor(private readonly options: RuntimeStateManagerOptions) {}

  loadSnapshot(snapshot?: RuntimeStateSnapshot): void {
    if (!snapshot) {
      return;
    }
    for (const storedRun of snapshot.runs) {
      this.options.runs.set(storedRun.run.id, {
        run: cloneRun(storedRun.run),
        input: { ...storedRun.input }
      });
    }
    for (const pending of snapshot.pendingModelContinuations) {
      this.options.pendingModelContinuations.set(pending.approvalId, clonePendingModelContinuation(pending));
    }
  }

  saveSnapshot(sequence: number): void {
    this.options.runtimeStateStore?.save({
      store: this.options.store.snapshot(),
      runs: [...this.options.runs.values()].map(cloneStoredRun),
      events: this.options.bus.snapshot(),
      sequence,
      pendingModelContinuations: [...this.options.pendingModelContinuations.values()].map(
        clonePendingModelContinuation
      )
    });
  }
}

function cloneRun(run: RunloomRun): RunloomRun {
  return {
    ...run
  };
}

function cloneStoredRun(storedRun: RuntimeRunRecord): StoredRunRecord {
  return {
    run: cloneRun(storedRun.run),
    input: { ...storedRun.input }
  };
}

function clonePendingModelContinuation(pending: StoredPendingModelContinuation): StoredPendingModelContinuation {
  return {
    ...pending,
    modelSelection: { ...pending.modelSelection },
    input: pending.input.map(cloneModelInputItem),
    tools: pending.tools.map(cloneModelTool),
    output: [...pending.output],
    pendingToolCall: cloneModelToolCall(pending.pendingToolCall),
    remainingToolCalls: pending.remainingToolCalls.map(cloneModelToolCall)
  };
}

function cloneModelInputItem(item: RunloomModelInputItem): RunloomModelInputItem {
  if (item.type === "message") {
    return {
      ...item,
      content: item.content.map((part) => ({ ...part }))
    };
  }
  if (item.type === "function_call") {
    return {
      ...item
    };
  }
  return {
    ...item
  };
}

function cloneModelTool(tool: RunloomModelTool): RunloomModelTool {
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema }
  };
}

function cloneModelToolCall(toolCall: StoredModelToolCall): StoredModelToolCall {
  return {
    ...toolCall
  };
}
