export interface CommandReply {
  content: string;
  format: "markdown";
}

export type CommandResult = string | CommandReply;
