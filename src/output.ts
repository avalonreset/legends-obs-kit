import type { ParsedArgs } from "./types.js";
import { redactUnknown } from "./redact.js";

export function output(value: unknown, args: ParsedArgs): void {
  const pretty = args.flags.pretty === true;
  process.stdout.write(`${JSON.stringify(redactUnknown(value), null, pretty ? 2 : 0)}\n`);
}
