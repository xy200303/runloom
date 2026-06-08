import type { Writable } from "node:stream";
import {
  formatActiveModelState,
  formatModelCommandHelp
} from "./view-formatters.js";
import type { TuiViewContext } from "./view-model.js";

export interface TuiModelCommandControllerOptions {
  output: Writable;
}

export interface TuiModelSubmitOptions {
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

export class TuiModelCommandController {
  private activeModel?: string;
  private activeProfile?: string;
  private activeTaskType?: string;
  private activeLanguage?: string;

  constructor(private readonly options: TuiModelCommandControllerOptions) {}

  submitOptions(): TuiModelSubmitOptions {
    return {
      model: this.activeModel,
      profile: this.activeProfile,
      taskType: this.activeTaskType,
      language: this.activeLanguage
    };
  }

  viewContext(): Pick<TuiViewContext, "activeModel" | "activeProfile" | "activeTaskType" | "activeLanguage"> {
    return {
      activeModel: this.activeModel,
      activeProfile: this.activeProfile,
      activeTaskType: this.activeTaskType,
      activeLanguage: this.activeLanguage
    };
  }

  handleReviewCommand(command: string): void {
    const output = this.options.output;
    if (command === "/review off") {
      if (this.activeTaskType === "code_review") {
        this.activeTaskType = undefined;
      }
      output.write("Review mode disabled\n");
      return;
    }
    this.activeTaskType = "code_review";
    output.write("Review mode enabled\n");
  }

  handleModelCommand(command: string): void {
    const output = this.options.output;
    const [, action, ...rest] = command.split(/\s+/);
    const value = rest.join(" ").trim();

    if (!action) {
      output.write(formatActiveModelState(this.activeModel, this.activeProfile, this.activeTaskType, this.activeLanguage));
      output.write(formatModelCommandHelp());
      return;
    }

    if (action === "clear") {
      this.activeModel = undefined;
      this.activeProfile = undefined;
      this.activeTaskType = undefined;
      this.activeLanguage = undefined;
      output.write("Model overrides cleared\n");
      return;
    }

    if (!value) {
      output.write(`Missing value for /model ${action}\n`);
      output.write(formatModelCommandHelp());
      return;
    }

    if (action === "set") {
      this.activeModel = value;
      this.activeProfile = undefined;
      output.write(`Model override set to ${value}\n`);
      return;
    }

    if (action === "profile") {
      this.activeProfile = value;
      this.activeModel = undefined;
      output.write(`Model profile set to ${value}\n`);
      return;
    }

    if (action === "task") {
      this.activeTaskType = value;
      output.write(`Model task type set to ${value}\n`);
      return;
    }

    if (action === "language") {
      this.activeLanguage = value;
      output.write(`Model language set to ${value}\n`);
      return;
    }

    output.write(`Unknown /model action: ${action}\n`);
    output.write(formatModelCommandHelp());
  }
}
