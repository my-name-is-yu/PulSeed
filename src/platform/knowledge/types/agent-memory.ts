import { z } from "zod";

// --- AgentMemoryType ---

export const AgentMemoryTypeEnum = z.enum([
  "fact",
  "procedure",
  "preference",
  "observation",
]);
export type AgentMemoryType = z.infer<typeof AgentMemoryTypeEnum>;

// --- AgentMemoryStatus ---

export const AgentMemoryStatusEnum = z.enum(["raw", "compiled", "archived"]);
export type AgentMemoryStatus = z.infer<typeof AgentMemoryStatusEnum>;

// --- AgentMemoryEntry ---

export const AgentMemoryEntrySchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  memory_type: AgentMemoryTypeEnum.default("fact"),
  status: AgentMemoryStatusEnum.default("raw"),
  compiled_from: z.array(z.string()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AgentMemoryEntry = z.infer<typeof AgentMemoryEntrySchema>;

// --- AgentMemoryStore (file-level schema) ---

export const AgentMemoryStoreSchema = z.object({
  entries: z.array(AgentMemoryEntrySchema),
  last_consolidated_at: z.string().nullable().default(null),
});
export type AgentMemoryStore = z.infer<typeof AgentMemoryStoreSchema>;
