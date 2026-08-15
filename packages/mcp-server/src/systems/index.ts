/**
 * System Adapter Architecture
 *
 * Exports the character-oriented adapter types and registry.
 */

// Core types and interfaces
export type { SystemId, SystemMetadata, SystemAdapter } from './types.js';

// System registry (MCP server context)
export { SystemRegistry, getSystemRegistry, resetSystemRegistry } from './system-registry.js';
