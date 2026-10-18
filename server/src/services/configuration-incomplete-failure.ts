/** A pre-dispatch configuration gate, not a failed provider execution. */
export class ConfigurationIncompleteFailure extends Error {
  code = "configuration_incomplete";
  constructor(message: string, public resultJson: Record<string, unknown>) {
    super(message);
    this.name = "ConfigurationIncompleteFailure";
  }
}
