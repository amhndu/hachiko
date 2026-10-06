// Values that cross a durable boundary (workflow steps, SQLite, RPC) are JSON.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
