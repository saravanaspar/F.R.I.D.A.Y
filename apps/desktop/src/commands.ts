export interface DesktopCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void | Promise<void>;
}

export function filterDesktopCommands(commands: readonly DesktopCommand[], query: string): readonly DesktopCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  return commands.filter((command) => `${command.label} ${command.hint} ${command.id}`.toLowerCase().includes(normalized));
}
