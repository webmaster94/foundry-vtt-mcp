// Zod schemas for validation of shared types

import { z } from 'zod';

/**
 * MCP Query schemas
 */
export const MCPQuerySchema = z.object({
  method: z.string(),
  data: z.unknown().optional(),
});

export const MCPResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

/**
 * Character schemas
 */
export const CharacterItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  img: z.string().optional(),
  system: z.record(z.unknown()),
});

export const CharacterEffectSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  disabled: z.boolean(),
  duration: z.object({
    type: z.string(),
    duration: z.number().optional(),
    remaining: z.number().optional(),
  }).optional(),
});

export const CharacterInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  img: z.string().optional(),
  system: z.record(z.unknown()),
  items: z.array(CharacterItemSchema),
  effects: z.array(CharacterEffectSchema),
});

/**
 * Compendium schemas
 */
export const CompendiumSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  img: z.string().optional(),
  pack: z.string(),
  packLabel: z.string(),
  system: z.record(z.unknown()).optional(),
});

export const CompendiumPackSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  system: z.string(),
  private: z.boolean(),
});

/**
 * Scene schemas
 */
export const SceneTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  actorId: z.string().optional(),
  img: z.string(),
  hidden: z.boolean(),
  disposition: z.number(),
});

export const SceneNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  x: z.number(),
  y: z.number(),
});

export const SceneInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  img: z.string().optional(),
  background: z.string().optional(),
  width: z.number(),
  height: z.number(),
  padding: z.number(),
  active: z.boolean(),
  navigation: z.boolean(),
  tokens: z.array(SceneTokenSchema),
  walls: z.number(),
  lights: z.number(),
  sounds: z.number(),
  notes: z.array(SceneNoteSchema),
});

/**
 * Token Manipulation schemas
 */
export const TokenUpdateSchema = z.object({
  tokenId: z.string(),
  updates: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().min(0).max(360).optional(),
    hidden: z.boolean().optional(),
    disposition: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    name: z.string().optional(),
    elevation: z.number().optional(),
    lockRotation: z.boolean().optional(),
  }),
});

export const TokenMoveRequestSchema = z.object({
  tokenId: z.string(),
  x: z.number(),
  y: z.number(),
  animate: z.boolean().optional().default(false),
});

export const TokenUpdateResultSchema = z.object({
  success: z.boolean(),
  tokenId: z.string(),
  updated: z.boolean(),
  error: z.string().optional(),
});

export const TokenDeleteResultSchema = z.object({
  success: z.boolean(),
  deletedCount: z.number(),
  tokenIds: z.array(z.string()),
  errors: z.array(z.string()).optional(),
});

export const TokenDetailsSchema = SceneTokenSchema.extend({
  rotation: z.number(),
  elevation: z.number(),
  lockRotation: z.boolean(),
  scale: z.number(),
  alpha: z.number(),
  actorLink: z.boolean(),
  actorData: z.object({
    name: z.string(),
    type: z.string(),
    img: z.string().optional(),
  }).optional(),
});

/**
 * Configuration schemas
 */
export const FoundryMCPConfigSchema = z.object({
  enabled: z.boolean(),
  mcpHost: z.string(),
  mcpPort: z.number().min(1024).max(65535),
  connectionTimeout: z.number().min(5).max(60),
  debugLogging: z.boolean(),
});

export const MCPServerConfigSchema = z.object({
  logLevel: z.enum(['error', 'warn', 'info', 'debug']),
  foundry: z.object({
    host: z.string(),
    port: z.number().min(1024).max(65535),
    namespace: z.string(),
    reconnectAttempts: z.number().min(1).max(10),
    reconnectDelay: z.number().min(100).max(10000),
  }),
});

/**
 * World info schemas
 */
export const WorldUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  isGM: z.boolean(),
});

export const WorldInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  system: z.string(),
  systemVersion: z.string(),
  foundryVersion: z.string(),
  users: z.array(WorldUserSchema),
});

/**
 * Bridge status schema
 */
export const BridgeStatusSchema = z.object({
  isRunning: z.boolean(),
  config: FoundryMCPConfigSchema,
  timestamp: z.number(),
});

/**
 * Multipart Campaign schemas
 */
export const CampaignPartStatusSchema = z.enum([
  'not_started',
  'in_progress', 
  'completed',
  'skipped'
]);

export const CampaignPartTypeSchema = z.enum([
  'main_part',
  'sub_part', 
  'chapter',
  'session',
  'optional'
]);

export const LevelRecommendationSchema = z.object({
  start: z.number().min(1).max(20),
  end: z.number().min(1).max(20),
});

export const NPCReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  actorId: z.string().optional(),
});

export const ScalingOptionsSchema = z.object({
  adjustForPartySize: z.boolean().default(true),
  adjustForLevel: z.boolean().default(true),
  difficultyModifier: z.number().min(-2).max(2).default(0),
});

// Sub-part schema (no further nesting)
export const CampaignSubPartSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  type: CampaignPartTypeSchema,
  status: CampaignPartStatusSchema.default('not_started'),
  journalId: z.string().optional(),
  createdAt: z.number().optional(),
  completedAt: z.number().optional(),
});

// Main campaign part schema with optional sub-parts
export const CampaignPartSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  type: CampaignPartTypeSchema,
  status: CampaignPartStatusSchema.default('not_started'),
  dependencies: z.array(z.string()).default([]),
  subParts: z.array(CampaignSubPartSchema).optional(),
  questGiver: NPCReferenceSchema.optional(),
  levelRecommendation: LevelRecommendationSchema,
  gmNotes: z.string().default(''),
  playerContent: z.string().default(''),
  scaling: ScalingOptionsSchema.default({}),
  journalId: z.string().optional(),
  createdAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export const CampaignMetadataSchema = z.object({
  defaultQuestGiver: NPCReferenceSchema.optional(),
  defaultLocation: z.string().optional(),
  theme: z.string().optional(),
  estimatedSessions: z.number().optional(),
  targetLevelRange: LevelRecommendationSchema.optional(),
  tags: z.array(z.string()).default([]),
});

export const CampaignStructureSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  parts: z.array(CampaignPartSchema),
  metadata: CampaignMetadataSchema,
  dashboardJournalId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CampaignTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  parts: z.array(z.object({
    title: z.string(),
    description: z.string(),
    type: CampaignPartTypeSchema,
    dependencies: z.array(z.string()).default([]),
    subParts: z.array(z.object({
      title: z.string(),
      description: z.string(),
      type: CampaignPartTypeSchema,
    })).optional(),
    levelRecommendation: LevelRecommendationSchema,
  })),
  metadata: CampaignMetadataSchema.partial(),
});

/**
 * Generic Foundry document management schemas
 */
export const DocumentMutationPolicySchema = z.enum(['full', 'read-only', 'unsupported']);

export const DocumentTypeSchema = z.object({
  documentType: z.string().min(1),
  collection: z.string().optional(),
  mutationPolicy: DocumentMutationPolicySchema,
  embeddedTypes: z.array(z.string()).default([]),
  risk: z.enum(['normal', 'high']).default('normal'),
});

export const DocumentProjectionSchema = z.object({
  fields: z.array(z.string()).optional(),
  includeSystem: z.boolean().default(true),
  includeFlags: z.boolean().default(false),
  includeSource: z.boolean().default(false),
  includeEmbedded: z.boolean().default(false),
  maxBytes: z.number().int().positive().max(2_000_000).default(256_000),
});

export const DocumentReferenceSchema = z.object({
  uuid: z.string().optional(),
  documentType: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  packId: z.string().optional(),
});

export const EmbeddedDocumentReferenceSchema = z.object({
  parentUuid: z.string(),
  embeddedType: z.string(),
  embeddedId: z.string().optional(),
  embeddedName: z.string().optional(),
});

export const SerializedDocumentSchema = z.object({
  id: z.string().optional(),
  uuid: z.string().optional(),
  documentName: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  truncated: z.boolean().default(false),
  truncatedPaths: z.array(z.string()).default([]),
});

export const ListDocumentsRequestSchema = DocumentProjectionSchema.extend({
  documentType: z.string().min(1),
  packId: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const GetDocumentRequestSchema = DocumentProjectionSchema.extend({
  ref: DocumentReferenceSchema,
});

export const CreateDocumentRequestSchema = DocumentProjectionSchema.extend({
  documentType: z.string().min(1),
  data: z.record(z.unknown()),
  confirmBulkOperation: z.boolean().default(false),
});

export const UpdateDocumentRequestSchema = DocumentProjectionSchema.extend({
  ref: DocumentReferenceSchema,
  updates: z.record(z.unknown()),
});

export const DeleteDocumentRequestSchema = z.object({
  ref: DocumentReferenceSchema,
  confirmDeletion: z.boolean().default(false),
});

export const DocumentSchemaRequestSchema = z.object({
  documentType: z.string().min(1),
});

export const ListEmbeddedDocumentsRequestSchema = DocumentProjectionSchema.extend({
  parentUuid: z.string(),
  embeddedType: z.string(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const GetEmbeddedDocumentRequestSchema = DocumentProjectionSchema.extend({
  ref: EmbeddedDocumentReferenceSchema,
});

export const CreateEmbeddedDocumentRequestSchema = DocumentProjectionSchema.extend({
  parentUuid: z.string(),
  embeddedType: z.string(),
  data: z.record(z.unknown()),
  confirmBulkOperation: z.boolean().default(false),
});

export const UpdateEmbeddedDocumentRequestSchema = DocumentProjectionSchema.extend({
  ref: EmbeddedDocumentReferenceSchema,
  updates: z.record(z.unknown()),
});

export const DeleteEmbeddedDocumentRequestSchema = z.object({
  ref: EmbeddedDocumentReferenceSchema,
  confirmDeletion: z.boolean().default(false),
});

export const QueryFoundryDataRequestSchema = DocumentProjectionSchema.extend({
  root: z.enum([
    'game.actors',
    'game.items',
    'game.scenes',
    'game.journal',
    'game.macros',
    'game.tables',
    'game.playlists',
    'game.cards',
    'game.combats',
    'game.folders',
    'game.users',
    'game.messages',
    'game.settings.storage',
  ]),
  filters: z.record(z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
  sort: z.object({
    field: z.string(),
    direction: z.enum(['asc', 'desc']).default('asc'),
  }).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const MacroCreateRequestSchema = DocumentProjectionSchema.extend({
  name: z.string().min(1),
  type: z.enum(['script', 'chat']).default('script'),
  command: z.string().default(''),
  img: z.string().optional(),
  folderId: z.string().optional(),
  ownership: z.record(z.number()).optional(),
});

export const MacroExecuteRequestSchema = z.object({
  uuid: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  actorUuid: z.string().optional(),
  tokenId: z.string().optional(),
  speaker: z.record(z.unknown()).optional(),
});

export const FoundryScriptExecuteRequestSchema = z.object({
  code: z.string().min(1),
  mode: z.enum(['script', 'expression']).default('script'),
  timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  resultLimitBytes: z.number().int().min(1_000).max(2_000_000).default(256_000),
  description: z.string().optional(),
});

export const AuditLogEntrySchema = z.object({
  id: z.number(),
  timestamp: z.string(),
  operation: z.string(),
  toolName: z.string(),
  executionId: z.string().optional(),
  userId: z.string(),
  userName: z.string(),
  worldId: z.string(),
  documentRefs: z.array(z.record(z.unknown())).default([]),
  payloadSummary: z.unknown().optional(),
  resultSummary: z.unknown().optional(),
  durationMs: z.number().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});
