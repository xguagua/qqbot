export interface LogFields {
  outcome: string;
  code?: string;
  detail?: string;
  durationMs?: number;
}

export interface Logger {
  info(fields: LogFields): void;
  error(fields: LogFields): void;
}

export class ConsoleLogger implements Logger {
  info(fields: LogFields): void {
    console.log(JSON.stringify({ service: "qqbot", level: "info", ...fields }));
  }

  error(fields: LogFields): void {
    console.error(JSON.stringify({ service: "qqbot", level: "error", ...fields }));
  }
}
