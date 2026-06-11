import type {
  TerminalAdapter,
  ToolDefinition
} from "../types.js";
import {
  createDeliverySummaryTool,
  createEditPlanTool,
  createReviewFindingsTool
} from "./artifact-tools.js";
import {
  createListFilesTool,
  createPatchFileTool,
  createReadFileTool,
  createSearchFilesTool,
  createWriteFileTool
} from "./filesystem-tools.js";
import {
  createGitDiffTool,
  createGitStatusTool
} from "./git-tools.js";
import { createDiffTextTool } from "./text-diff-tools.js";
import { createVerifyCommandTool } from "./verification-tools.js";

export interface CreateBuiltInCodingToolsOptions {
  terminal?: TerminalAdapter;
}

export function createBuiltInCodingTools(options: CreateBuiltInCodingToolsOptions = {}): ToolDefinition[] {
  return [
    createListFilesTool(),
    createReadFileTool(),
    createSearchFilesTool(),
    createEditPlanTool(),
    createWriteFileTool(),
    createPatchFileTool(),
    createDiffTextTool(),
    createVerifyCommandTool(options.terminal),
    createGitStatusTool(),
    createGitDiffTool(),
    createReviewFindingsTool(),
    createDeliverySummaryTool()
  ];
}
