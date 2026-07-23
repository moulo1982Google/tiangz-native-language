import path from "node:path";

const MAX_COMMAND_LENGTH = 4_096;

export interface CodegenSettings {
  readonly command: string;
  readonly workingDirectory: string;
}

export function normalizeCodegenSettings(command: unknown, workingDirectory: unknown): CodegenSettings {
  return {
    command: normalizeCommand(command),
    workingDirectory: normalizeWorkingDirectory(workingDirectory),
  };
}

export function resolveCodegenWorkingDirectory(
  workspaceDirectory: string,
  configuredDirectory: string,
): string | undefined {
  if (path.isAbsolute(configuredDirectory)) return undefined;
  const workspace = path.resolve(workspaceDirectory);
  const target = path.resolve(workspace, configuredDirectory);
  const relative = path.relative(workspace, target);
  if (relative === "") return target;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return target;
}

function normalizeCommand(value: unknown): string {
  if (typeof value !== "string") return "";
  const command = value.trim();
  if (command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(command)) return "";
  return command;
}

function normalizeWorkingDirectory(value: unknown): string {
  if (typeof value !== "string") return ".";
  const directory = value.trim();
  if (!directory || /[\r\n\0]/.test(directory)) return ".";
  return directory;
}
