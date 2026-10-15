export type SqliteReadOnlyOperationContext = { path: string; env: NodeJS.ProcessEnv };
export type SqliteReadOnlyOperationCommand = { type: string; serialized: string };
export type SqliteReadOnlyOperationResult = { operation: string; value: unknown };
