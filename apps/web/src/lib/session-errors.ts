/** Thrown by public commands used against an illegal origin/state — a
 *  programming error the UI prevents and tests surface loudly. */
export class SessionCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCommandError';
  }
}
