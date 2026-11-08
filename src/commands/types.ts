export interface CommandReply {
  content: string;
  format: "markdown" | "mention";
}

export type CommandResult = string | CommandReply;
