/**
 * Validates that all required environment variables are present at startup.
 * Called before NestFactory.create() in each app's main.ts.
 *
 * If any variable is missing, logs a descriptive error for each one and
 * exits the process with code 1.
 */
export function validateRequiredEnv(vars: string[]): void {
  const missing = vars.filter(
    (v) => !process.env[v] || process.env[v]!.trim() === '',
  );

  if (missing.length > 0) {
    for (const v of missing) {
      console.error(`[Bootstrap] ${v} is required but not set. Exiting.`);
    }
    process.exit(1);
  }
}
